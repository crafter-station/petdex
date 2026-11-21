import Foundation

struct RemotePetItem: Identifiable, Equatable, Sendable {
    var id: String { slug }
    let slug: String
    let displayName: String
    let thumbnailURL: URL?
    let spritesheetURL: URL?
    let petJsonURL: URL?
    let description: String?
}

enum PetdexCatalogError: LocalizedError {
    case invalidSlug(String)
    case invalidURL
    case httpError(Int)
    case emptyDownload(String)
    case missingSpritesheetURL(String)

    var errorDescription: String? {
        switch self {
        case .invalidSlug(let slug):
            return "Invalid pet slug: \(slug)"
        case .invalidURL:
            return "Invalid catalog URL."
        case .httpError(let code):
            return "Server returned HTTP \(code)."
        case .emptyDownload(let file):
            return "Downloaded \(file) was empty."
        case .missingSpritesheetURL(let slug):
            return "No spritesheet URL found for \(slug)."
        }
    }
}

final class PetdexCatalogClient: Sendable {
    static let shared = PetdexCatalogClient()

    private let baseURL: URL
    private let session: URLSession

    init(
        baseURL: URL = URL(string: "https://petdex.dev")!,
        session: URLSession = .shared
    ) {
        self.baseURL = baseURL
        self.session = session
    }

    func fetchCatalog(query: String? = nil, bearerToken: String? = nil) async throws -> [RemotePetItem] {
        let trimmedQuery = query?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let token = bearerToken ?? ProcessInfo.processInfo.environment["PETDEX_API_TOKEN"]

        if trimmedQuery.isEmpty, let token, !token.isEmpty {
            if let libraryItems = try? await fetchDesktopLibrary(bearerToken: token), !libraryItems.isEmpty {
                return libraryItems
            }
        }

        return try await fetchPublicCatalog(query: trimmedQuery.isEmpty ? nil : trimmedQuery)
    }

    func fetchDesktopLibrary(bearerToken: String? = nil) async throws -> [RemotePetItem] {
        let url = baseURL.appendingPathComponent("api/desktop/library")
        var request = URLRequest(url: url)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let bearerToken, !bearerToken.isEmpty {
            request.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "Authorization")
        }

        let (data, response) = try await session.data(for: request)
        try validateHTTPResponse(response)
        return try decodeCatalogPayload(from: data)
    }

    func fetchPublicCatalog(query: String? = nil, limit: Int = 60) async throws -> [RemotePetItem] {
        guard var components = URLComponents(
            url: baseURL.appendingPathComponent("api/pets/search"),
            resolvingAgainstBaseURL: false
        ) else {
            throw PetdexCatalogError.invalidURL
        }

        var items: [URLQueryItem] = [
            URLQueryItem(name: "sort", value: query == nil ? "popular" : "curated"),
            URLQueryItem(name: "limit", value: String(limit)),
            URLQueryItem(name: "includeMeta", value: "0"),
        ]
        if let query, !query.isEmpty {
            items.append(URLQueryItem(name: "q", value: query))
        }
        components.queryItems = items

        guard let url = components.url else {
            throw PetdexCatalogError.invalidURL
        }

        var request = URLRequest(url: url)
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        let (data, response) = try await session.data(for: request)
        try validateHTTPResponse(response)
        return try decodeCatalogPayload(from: data)
    }

    func resolveInstallMetadata(slug rawSlug: String) async throws -> RemotePetItem {
        let slug = try sanitizeSlug(rawSlug)
        let url = baseURL
            .appendingPathComponent("api/install-pet")
            .appendingPathComponent(slug)

        var request = URLRequest(url: url)
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        let (data, response) = try await session.data(for: request)
        try validateHTTPResponse(response)

        let decoded = try JSONDecoder().decode(InstallPetEnvelope.self, from: data)
        guard decoded.ok, let pet = decoded.pet else {
            throw PetdexCatalogError.missingSpritesheetURL(slug)
        }

        return RemotePetItem(
            slug: pet.slug,
            displayName: pet.displayName.isEmpty ? pet.slug : pet.displayName,
            thumbnailURL: defaultThumbnailURL(for: pet.slug),
            spritesheetURL: resolveURL(pet.spritesheetUrl),
            petJsonURL: resolveURL(pet.petJsonUrl),
            description: nil
        )
    }

    func installPet(slug rawSlug: String) async throws -> InstalledPet {
        let metadata = try await resolveInstallMetadata(slug: rawSlug)
        return try await installPet(metadata)
    }

    func installPet(_ item: RemotePetItem) async throws -> InstalledPet {
        let slug = try sanitizeSlug(item.slug)

        var resolvedDisplayName = item.displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        if resolvedDisplayName.isEmpty {
            resolvedDisplayName = slug
        }
        var resolvedSpritesheetURL = item.spritesheetURL
        var resolvedPetJsonURL = item.petJsonURL

        if resolvedSpritesheetURL == nil || resolvedPetJsonURL == nil {
            if let metadata = try? await resolveInstallMetadata(slug: slug) {
                if resolvedSpritesheetURL == nil {
                    resolvedSpritesheetURL = metadata.spritesheetURL
                }
                if resolvedPetJsonURL == nil {
                    resolvedPetJsonURL = metadata.petJsonURL
                }
                if !metadata.displayName.isEmpty {
                    resolvedDisplayName = metadata.displayName
                }
            }
        }

        guard let spritesheetURL = resolvedSpritesheetURL else {
            throw PetdexCatalogError.missingSpritesheetURL(slug)
        }

        let (sheetData, sheetResponse) = try await session.data(from: spritesheetURL)
        try validateHTTPResponse(sheetResponse)
        guard !sheetData.isEmpty else {
            throw PetdexCatalogError.emptyDownload("spritesheet.webp")
        }

        let fm = FileManager.default
        let petDir = fm.homeDirectoryForCurrentUser
            .appendingPathComponent(".petdex/pets", isDirectory: true)
            .appendingPathComponent(slug, isDirectory: true)
        try fm.createDirectory(at: petDir, withIntermediateDirectories: true)

        let spritesheetDest = petDir.appendingPathComponent("spritesheet.webp", isDirectory: false)
        try sheetData.write(to: spritesheetDest, options: [.atomic])

        let petJsonDest = petDir.appendingPathComponent("pet.json", isDirectory: false)
        var wrotePetJson = false
        if let petJsonURL = resolvedPetJsonURL {
            if let (jsonData, jsonResponse) = try? await session.data(from: petJsonURL),
               let http = jsonResponse as? HTTPURLResponse,
               (200..<300).contains(http.statusCode),
               !jsonData.isEmpty
            {
                try? jsonData.write(to: petJsonDest, options: [.atomic])
                wrotePetJson = true
            }
        }

        if !wrotePetJson {
            let fallbackPayload = ["name": resolvedDisplayName]
            if let encoded = try? JSONSerialization.data(withJSONObject: fallbackPayload, options: [.prettyPrinted]) {
                try? encoded.write(to: petJsonDest, options: [.atomic])
            }
        }

        return InstalledPet(
            id: slug,
            displayName: resolvedDisplayName,
            directoryURL: petDir,
            spritesheetURL: spritesheetDest
        )
    }

    private func validateHTTPResponse(_ response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse else { return }
        guard (200..<300).contains(http.statusCode) else {
            throw PetdexCatalogError.httpError(http.statusCode)
        }
    }

    private func sanitizeSlug(_ raw: String) throws -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !trimmed.isEmpty, trimmed.count <= 64 else {
            throw PetdexCatalogError.invalidSlug(raw)
        }
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyz0123456789-")
        guard trimmed.unicodeScalars.allSatisfy({ allowed.contains($0) }),
              !trimmed.hasPrefix("-"),
              !trimmed.hasSuffix("-")
        else {
            throw PetdexCatalogError.invalidSlug(raw)
        }
        return trimmed
    }

    private func resolveURL(_ raw: String?) -> URL? {
        guard let raw else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if let direct = URL(string: trimmed), direct.scheme != nil {
            return direct
        }
        return URL(string: trimmed, relativeTo: baseURL)?.absoluteURL
    }

    private func defaultThumbnailURL(for slug: String) -> URL? {
        URL(string: "https://assets.petdex.dev/pets/\(slug)/thumb.webp")
    }

    private func decodeCatalogPayload(from data: Data) throws -> [RemotePetItem] {
        let decoder = JSONDecoder()

        if let library = try? decoder.decode(DesktopLibraryResponse.self, from: data),
           library.owned != nil || library.caught != nil
        {
            let combined = (library.owned ?? []) + (library.caught ?? [])
            return deduplicate(combined.compactMap { mapRecord($0) })
        }

        if let search = try? decoder.decode(SearchCatalogResponse.self, from: data),
           let pets = search.pets
        {
            return deduplicate(pets.compactMap { mapRecord($0) })
        }

        if let array = try? decoder.decode([RawPetRecord].self, from: data) {
            return deduplicate(array.compactMap { mapRecord($0) })
        }

        return []
    }

    private func mapRecord(_ record: RawPetRecord) -> RemotePetItem? {
        let slug = record.slug.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !slug.isEmpty else { return nil }
        if let status = record.status?.lowercased(), status == "rejected" || status == "pending" {
            return nil
        }

        let displayName = record.displayName?.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedName = (displayName?.isEmpty == false) ? displayName! : slug
        let spritesheetURL = resolveURL(record.spritesheetUrl ?? record.spritesheetPath)
        let thumbnailURL = resolveURL(record.thumbnailUrl) ?? defaultThumbnailURL(for: slug) ?? spritesheetURL
        let petJsonURL = resolveURL(record.petJsonUrl)

        return RemotePetItem(
            slug: slug,
            displayName: resolvedName,
            thumbnailURL: thumbnailURL,
            spritesheetURL: spritesheetURL,
            petJsonURL: petJsonURL,
            description: record.description
        )
    }

    private func deduplicate(_ items: [RemotePetItem]) -> [RemotePetItem] {
        var seen = Set<String>()
        var result: [RemotePetItem] = []
        for item in items {
            let key = item.slug.lowercased()
            if seen.insert(key).inserted {
                result.append(item)
            }
        }
        return result
    }
}

private struct DesktopLibraryResponse: Decodable {
    let owned: [RawPetRecord]?
    let caught: [RawPetRecord]?
}

private struct SearchCatalogResponse: Decodable {
    let pets: [RawPetRecord]?
}

private struct RawPetRecord: Decodable {
    let slug: String
    let displayName: String?
    let status: String?
    let thumbnailUrl: String?
    let spritesheetUrl: String?
    let spritesheetPath: String?
    let petJsonUrl: String?
    let description: String?
}

private struct InstallPetEnvelope: Decodable {
    let ok: Bool
    let pet: InstallPetRecord?
}

private struct InstallPetRecord: Decodable {
    let slug: String
    let displayName: String
    let petJsonUrl: String?
    let spritesheetUrl: String?
    let spriteExt: String?
}
