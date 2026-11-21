import Foundation

struct RemoteHostEntry: Identifiable, Equatable {
    let id: String
    let name: String
    let host: String
    let port: Int
    let enabled: Bool
    let enabledAgents: [String]
}

enum PetdexRemoteAgentsLoader {
    static var configURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".petdex", isDirectory: true)
            .appendingPathComponent("remote-agents.json")
    }

    private struct ConfigFile: Decodable {
        let remotes: [RemoteItem]?
    }

    private struct RemoteItem: Decodable {
        let name: String?
        let host: String?
        let port: Int?
        let enabled: Bool?
        let agents: [String: AgentConfig]?
    }

    private struct AgentConfig: Decodable {
        let enabled: Bool?
    }

    static func load() -> [RemoteHostEntry] {
        guard let data = try? Data(contentsOf: configURL) else {
            return []
        }

        guard let config = try? JSONDecoder().decode(ConfigFile.self, from: data),
              let remotes = config.remotes
        else {
            return []
        }

        return remotes.enumerated().compactMap { index, item in
            let trimmedHost = item.host?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard !trimmedHost.isEmpty else {
                return nil
            }

            let trimmedName = item.name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let displayName = trimmedName.isEmpty ? trimmedHost : trimmedName
            let port = item.port ?? 22
            let enabled = item.enabled ?? true
            let enabledAgents = (item.agents ?? [:])
                .compactMap { key, value in
                    (value.enabled ?? false) ? key : nil
                }
                .sorted()

            let entryID = "\(index)-\(displayName)@\(trimmedHost):\(port)"
            return RemoteHostEntry(
                id: entryID,
                name: displayName,
                host: trimmedHost,
                port: port,
                enabled: enabled,
                enabledAgents: enabledAgents
            )
        }
    }
}
