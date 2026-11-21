import CryptoKit
import Foundation
import Security

struct PetdexUserProfile: Equatable, Sendable {
    let id: String
    let name: String
    let email: String?
    let username: String?
    let imageUrl: String?

    var avatarURL: URL? {
        guard let imageUrl, !imageUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return nil
        }
        return URL(string: imageUrl)
    }

    var handleText: String? {
        guard let username, !username.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return nil
        }
        return "@\(username)"
    }
}

struct PetdexLibraryPet: Identifiable, Equatable, Sendable {
    var id: String { slug }
    let slug: String
    let displayName: String
    let thumbnailUrl: String?
    let status: String

    var thumbnailURL: URL? {
        if let thumbnailUrl {
            let trimmed = thumbnailUrl.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty, let url = URL(string: trimmed) {
                return url
            }
        }
        return URL(string: "https://assets.petdex.dev/pets/\(slug)/thumb.webp")
    }
}

struct PetdexOAuthTokens: Codable, Equatable, Sendable {
    let accessToken: String
    let refreshToken: String?

    private enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
        case refreshToken = "refresh_token"
    }
}

struct PetdexOAuthCallbackPayload: Decodable, Equatable, Sendable {
    let code: String
    let state: String
    let error: String
}

struct PetdexPKCEChallenge: Sendable {
    let codeVerifier: String
    let codeChallenge: String
    let state: String
    let authorizeURL: URL
}

struct PetdexLibraryPayload: Equatable, Sendable {
    let user: PetdexUserProfile
    let owned: [PetdexLibraryPet]
    let caught: [PetdexLibraryPet]
}

enum PetdexClerkAuthError: LocalizedError {
    case randomGenerationFailed
    case invalidURL
    case oauthError(String)
    case stateMismatch
    case missingAuthorizationCode
    case timedOut
    case unauthorized
    case httpError(Int, String)
    case invalidResponse
    case noSavedSession

    var errorDescription: String? {
        switch self {
        case .randomGenerationFailed:
            return "Failed to generate secure PKCE parameters."
        case .invalidURL:
            return "Failed to build Clerk OAuth URL."
        case .oauthError(let message):
            return "Sign-in was rejected: \(message)"
        case .stateMismatch:
            return "OAuth state mismatch. Please try signing in again."
        case .missingAuthorizationCode:
            return "OAuth callback did not include an authorization code."
        case .timedOut:
            return "Sign-in timed out after 3 minutes."
        case .unauthorized:
            return "Session expired. Please sign in again."
        case .httpError(let status, let detail):
            if detail.isEmpty {
                return "Server returned HTTP \(status)."
            }
            return "Server returned HTTP \(status): \(detail)"
        case .invalidResponse:
            return "Unexpected response from Petdex account service."
        case .noSavedSession:
            return "Not signed in."
        }
    }
}

final class PetdexClerkAuthClient: @unchecked Sendable {
    static let shared = PetdexClerkAuthClient()

    static let issuer = "https://clerk.petdex.dev"
    static let clientId = "LcThwEayl6KAA1Qm"
    static let redirectURI = "http://127.0.0.1:7777/callback"
    static let scopes = "profile email openid offline_access"
    static let libraryURLString = "https://petdex.dev/api/desktop/library"

    static let keychainService = "dev.petdex.macos"
    static let keychainAccount = "clerk-oauth"

    private let session: URLSession

    init(session: URLSession = .shared) {
        self.session = session
    }

    func beginPKCEFlow() throws -> PetdexPKCEChallenge {
        let codeVerifier = try randomBase64URLString(byteCount: 64)
        let state = try randomBase64URLString(byteCount: 32)
        let digest = SHA256.hash(data: Data(codeVerifier.utf8))
        let codeChallenge = base64URLEncode(Data(digest))

        let encodedRedirect = formURLEncode(Self.redirectURI)
        let encodedScopes = "profile%20email%20openid%20offline_access"
        let urlString = "\(Self.issuer)/oauth/authorize"
            + "?client_id=\(Self.clientId)"
            + "&redirect_uri=\(encodedRedirect)"
            + "&response_type=code"
            + "&scope=\(encodedScopes)"
            + "&code_challenge=\(codeChallenge)"
            + "&code_challenge_method=S256"
            + "&state=\(state)"

        guard let authorizeURL = URL(string: urlString) else {
            throw PetdexClerkAuthError.invalidURL
        }

        return PetdexPKCEChallenge(
            codeVerifier: codeVerifier,
            codeChallenge: codeChallenge,
            state: state,
            authorizeURL: authorizeURL
        )
    }

    func exchangeCodeForTokens(code: String, codeVerifier: String) async throws -> PetdexOAuthTokens {
        guard let url = URL(string: "\(Self.issuer)/oauth/token") else {
            throw PetdexClerkAuthError.invalidURL
        }

        let body = buildFormBody([
            ("grant_type", "authorization_code"),
            ("client_id", Self.clientId),
            ("code", code),
            ("redirect_uri", Self.redirectURI),
            ("code_verifier", codeVerifier),
        ])

        return try await postTokenRequest(url: url, formBody: body, fallbackRefreshToken: nil)
    }

    func refreshTokens(refreshToken: String) async throws -> PetdexOAuthTokens {
        guard let url = URL(string: "\(Self.issuer)/oauth/token") else {
            throw PetdexClerkAuthError.invalidURL
        }

        let body = buildFormBody([
            ("grant_type", "refresh_token"),
            ("client_id", Self.clientId),
            ("refresh_token", refreshToken),
            ("scope", Self.scopes),
        ])

        return try await postTokenRequest(url: url, formBody: body, fallbackRefreshToken: refreshToken)
    }

    func fetchLibrary(accessToken: String) async throws -> PetdexLibraryPayload {
        guard let url = URL(string: Self.libraryURLString) else {
            throw PetdexClerkAuthError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw PetdexClerkAuthError.invalidResponse
        }

        if http.statusCode == 401 {
            throw PetdexClerkAuthError.unauthorized
        }

        guard (200..<300).contains(http.statusCode) else {
            let detail = extractErrorMessage(from: data)
            throw PetdexClerkAuthError.httpError(http.statusCode, detail)
        }

        let decoded: RawLibraryResponse
        do {
            decoded = try JSONDecoder().decode(RawLibraryResponse.self, from: data)
        } catch {
            throw PetdexClerkAuthError.invalidResponse
        }

        let user = mapUser(decoded.user)
        let owned = (decoded.owned ?? []).compactMap(mapPet)
        let caught = (decoded.caught ?? []).compactMap(mapPet)
        return PetdexLibraryPayload(user: user, owned: owned, caught: caught)
    }

    func fetchLibraryWithAutoRefresh(
        tokens: PetdexOAuthTokens
    ) async throws -> (PetdexLibraryPayload, PetdexOAuthTokens) {
        do {
            let payload = try await fetchLibrary(accessToken: tokens.accessToken)
            return (payload, tokens)
        } catch PetdexClerkAuthError.unauthorized {
            guard let refreshToken = tokens.refreshToken, !refreshToken.isEmpty else {
                throw PetdexClerkAuthError.unauthorized
            }
            let refreshed = try await refreshTokens(refreshToken: refreshToken)
            _ = saveTokens(refreshed)
            let payload = try await fetchLibrary(accessToken: refreshed.accessToken)
            return (payload, refreshed)
        }
    }

    @discardableResult
    func saveTokens(_ tokens: PetdexOAuthTokens) -> Bool {
        guard let encoded = try? JSONEncoder().encode(tokens) else {
            return false
        }

        let baseQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.keychainService,
            kSecAttrAccount as String: Self.keychainAccount,
        ]

        SecItemDelete(baseQuery as CFDictionary)

        var addQuery = baseQuery
        addQuery[kSecValueData as String] = encoded
        addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock

        let status = SecItemAdd(addQuery as CFDictionary, nil)
        return status == errSecSuccess
    }

    func loadTokens() -> PetdexOAuthTokens? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.keychainService,
            kSecAttrAccount as String: Self.keychainAccount,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else {
            return nil
        }

        guard let tokens = try? JSONDecoder().decode(PetdexOAuthTokens.self, from: data),
              !tokens.accessToken.isEmpty
        else {
            return nil
        }
        return tokens
    }

    @discardableResult
    func deleteTokens() -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.keychainService,
            kSecAttrAccount as String: Self.keychainAccount,
        ]
        let status = SecItemDelete(query as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }

    private func postTokenRequest(
        url: URL,
        formBody: String,
        fallbackRefreshToken: String?
    ) async throws -> PetdexOAuthTokens {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = Data(formBody.utf8)

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw PetdexClerkAuthError.invalidResponse
        }

        if http.statusCode == 401 {
            throw PetdexClerkAuthError.unauthorized
        }

        guard (200..<300).contains(http.statusCode) else {
            let detail = extractErrorMessage(from: data)
            throw PetdexClerkAuthError.httpError(http.statusCode, detail)
        }

        guard let decoded = try? JSONDecoder().decode(RawTokenResponse.self, from: data),
              !decoded.accessToken.isEmpty
        else {
            throw PetdexClerkAuthError.invalidResponse
        }

        let resolvedRefresh: String?
        if let incoming = decoded.refreshToken, !incoming.isEmpty {
            resolvedRefresh = incoming
        } else {
            resolvedRefresh = fallbackRefreshToken
        }

        return PetdexOAuthTokens(
            accessToken: decoded.accessToken,
            refreshToken: resolvedRefresh
        )
    }

    private func mapUser(_ raw: RawLibraryUser?) -> PetdexUserProfile {
        let email = raw?.email?.trimmingCharacters(in: .whitespacesAndNewlines)
        let username = raw?.username?.trimmingCharacters(in: .whitespacesAndNewlines)
        let imageUrl = raw?.imageUrl?.trimmingCharacters(in: .whitespacesAndNewlines)
        let explicitName = raw?.name?.trimmingCharacters(in: .whitespacesAndNewlines)
        let firstName = raw?.firstName?.trimmingCharacters(in: .whitespacesAndNewlines)
        let lastName = raw?.lastName?.trimmingCharacters(in: .whitespacesAndNewlines)

        let combinedFullName: String? = {
            let parts = [firstName, lastName].compactMap { value -> String? in
                guard let value, !value.isEmpty else { return nil }
                return value
            }
            return parts.isEmpty ? nil : parts.joined(separator: " ")
        }()

        let resolvedName = [explicitName, combinedFullName, username, email]
            .compactMap { value -> String? in
                guard let value, !value.isEmpty else { return nil }
                return value
            }
            .first ?? "Petdex Trainer"

        let resolvedId = [raw?.id, username, email]
            .compactMap { value -> String? in
                guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
                    return nil
                }
                return trimmed
            }
            .first ?? "petdex-user"

        return PetdexUserProfile(
            id: resolvedId,
            name: resolvedName,
            email: (email?.isEmpty == false) ? email : nil,
            username: (username?.isEmpty == false) ? username : nil,
            imageUrl: (imageUrl?.isEmpty == false) ? imageUrl : nil
        )
    }

    private func mapPet(_ raw: RawLibraryPet) -> PetdexLibraryPet? {
        let slug = raw.slug.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !slug.isEmpty else { return nil }
        let trimmedName = raw.displayName?.trimmingCharacters(in: .whitespacesAndNewlines)
        let displayName = (trimmedName?.isEmpty == false) ? trimmedName! : slug
        let status = raw.status?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "approved"
        return PetdexLibraryPet(
            slug: slug,
            displayName: displayName,
            thumbnailUrl: raw.thumbnailUrl,
            status: status
        )
    }

    private func randomBase64URLString(byteCount: Int) throws -> String {
        var bytes = [UInt8](repeating: 0, count: byteCount)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        guard status == errSecSuccess else {
            throw PetdexClerkAuthError.randomGenerationFailed
        }
        return base64URLEncode(Data(bytes))
    }

    private func base64URLEncode(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private func buildFormBody(_ items: [(String, String)]) -> String {
        items
            .map { "\(formURLEncode($0.0))=\(formURLEncode($0.1))" }
            .joined(separator: "&")
    }

    private func formURLEncode(_ value: String) -> String {
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }

    private func extractErrorMessage(from data: Data) -> String {
        if let decoded = try? JSONDecoder().decode(RawErrorResponse.self, from: data) {
            if let desc = decoded.errorDescription, !desc.isEmpty {
                return desc
            }
            if let message = decoded.message, !message.isEmpty {
                return message
            }
            if let error = decoded.error, !error.isEmpty {
                return error
            }
        }
        return ""
    }
}

private struct RawTokenResponse: Decodable {
    let accessToken: String
    let refreshToken: String?

    private enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
        case refreshToken = "refresh_token"
    }
}

private struct RawLibraryResponse: Decodable {
    let user: RawLibraryUser?
    let owned: [RawLibraryPet]?
    let caught: [RawLibraryPet]?
}

private struct RawLibraryUser: Decodable {
    let id: String?
    let name: String?
    let email: String?
    let username: String?
    let firstName: String?
    let lastName: String?
    let imageUrl: String?
}

private struct RawLibraryPet: Decodable {
    let slug: String
    let displayName: String?
    let thumbnailUrl: String?
    let status: String?
}

private struct RawErrorResponse: Decodable {
    let error: String?
    let errorDescription: String?
    let message: String?

    private enum CodingKeys: String, CodingKey {
        case error
        case errorDescription = "error_description"
        case message
    }
}
