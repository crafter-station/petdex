import Foundation

enum PetdexUpdateStatus: Equatable {
    case idle
    case checking
    case upToDate(String)
    case available(version: String, downloadURL: URL)
    case failed(String)
}

final class PetdexUpdateChecker {
    static var currentAppVersion: String {
        if let v = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String,
           !v.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        {
            return v
        }
        return "1.0.0"
    }

    private static let latestReleaseURL = URL(string: "https://petdex.dev/api/desktop/latest-release?format=json")!
    private static let fallbackDownloadURL = URL(string: "https://petdex.dev/download")!

    private struct ReleasePayload: Decodable {
        let version: String?
        let tag: String?
        let tagName: String?
        let downloadUrl: String?
        let downloadURLSnake: String?
        let htmlUrl: String?
        let url: String?

        enum CodingKeys: String, CodingKey {
            case version
            case tag
            case tagName = "tag_name"
            case downloadUrl
            case downloadURLSnake = "download_url"
            case htmlUrl = "html_url"
            case url
        }

        var resolvedVersion: String? {
            let candidates = [version, tag, tagName]
            for candidate in candidates {
                if let trimmed = candidate?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty {
                    return trimmed
                }
            }
            return nil
        }

        var resolvedDownloadURL: URL {
            let candidates = [downloadUrl, downloadURLSnake, htmlUrl, url]
            for candidate in candidates {
                if let trimmed = candidate?.trimmingCharacters(in: .whitespacesAndNewlines),
                   !trimmed.isEmpty,
                   let parsed = URL(string: trimmed)
                {
                    return parsed
                }
            }
            return PetdexUpdateChecker.fallbackDownloadURL
        }
    }

    static func checkLatestRelease() async -> PetdexUpdateStatus {
        var request = URLRequest(url: latestReleaseURL)
        request.httpMethod = "GET"
        request.timeoutInterval = 10
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            if let httpResponse = response as? HTTPURLResponse,
               !(200...299).contains(httpResponse.statusCode)
            {
                return .failed("Server returned HTTP \(httpResponse.statusCode)")
            }

            let payload = try JSONDecoder().decode(ReleasePayload.self, from: data)
            guard let latestVersion = payload.resolvedVersion else {
                return .failed("Release response did not include a version")
            }

            if isNewerVersion(latestVersion, than: currentAppVersion) {
                return .available(version: latestVersion, downloadURL: payload.resolvedDownloadURL)
            }
            return .upToDate(currentAppVersion)
        } catch {
            return .failed(error.localizedDescription)
        }
    }

    private static func normalizeVersion(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasPrefix("v") || trimmed.hasPrefix("V") {
            return String(trimmed.dropFirst())
        }
        return trimmed
    }

    private static func splitVersion(_ normalized: String) -> (core: [Int], prerelease: String?) {
        let parts = normalized.split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false)
        let coreParts = parts[0].split(separator: ".").map { Int($0) ?? 0 }
        let prerelease = parts.count > 1 ? String(parts[1]) : nil
        return (coreParts, prerelease)
    }

    private static func isNewerVersion(_ candidate: String, than current: String) -> Bool {
        let normalizedCandidate = normalizeVersion(candidate)
        let normalizedCurrent = normalizeVersion(current)
        if normalizedCandidate == normalizedCurrent {
            return false
        }

        let lhs = splitVersion(normalizedCandidate)
        let rhs = splitVersion(normalizedCurrent)
        let maxCount = max(lhs.core.count, rhs.core.count)

        for index in 0..<maxCount {
            let lVal = index < lhs.core.count ? lhs.core[index] : 0
            let rVal = index < rhs.core.count ? rhs.core[index] : 0
            if lVal != rVal {
                return lVal > rVal
            }
        }

        switch (lhs.prerelease, rhs.prerelease) {
        case (nil, .some):
            return true
        case (.some, nil):
            return false
        case let (.some(lPre), .some(rPre)):
            return lPre.compare(rPre, options: .numeric) == .orderedDescending
        case (nil, nil):
            return false
        }
    }
}
