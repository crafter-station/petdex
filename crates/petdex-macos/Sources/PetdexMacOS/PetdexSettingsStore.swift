import AppKit
import CPetdexCore
import Foundation
import ServiceManagement
import SwiftUI

struct ActiveBubble: Equatable, Decodable {
    let sessionId: String
    let agent: String
    let status: String
    let summary: String

    private enum CodingKeys: String, CodingKey {
        case sessionId = "session_id"
        case agent
        case status
        case summary
    }

    var agentDisplayName: String {
        AgentCatalog.displayName(for: agent)
    }

    var statusDisplayName: String {
        switch status.lowercased() {
        case "needs-input", "needs_input":
            return "Needs Input"
        case "running":
            return "Running"
        case "completed":
            return "Completed"
        case "failed":
            return "Failed"
        default:
            return "Idle"
        }
    }

    var statusColor: Color {
        switch status.lowercased() {
        case "needs-input", "needs_input":
            return Color(red: 0.94, green: 0.58, blue: 0.12)
        case "running":
            return Color(red: 0.18, green: 0.46, blue: 0.96)
        case "completed":
            return Color(red: 0.15, green: 0.68, blue: 0.42)
        case "failed":
            return Color(red: 0.86, green: 0.24, blue: 0.28)
        default:
            return Color(red: 0.45, green: 0.52, blue: 0.64)
        }
    }
}

struct DetectedAgent: Identifiable, Equatable {
    let id: String
    let name: String
    let slug: String
    let agentCode: UInt8
    let configPath: String
    let installStatus: UInt8
    let supportsHookToggle: Bool

    var installed: Bool {
        installStatus != UInt8(PETDEX_AGENT_NOT_FOUND.rawValue)
    }

    var isDetected: Bool {
        installStatus == UInt8(PETDEX_AGENT_DETECTED.rawValue)
    }

    var isConnected: Bool {
        installStatus == UInt8(PETDEX_AGENT_CONNECTED.rawValue)
    }

    var statusLabel: String {
        switch installStatus {
        case UInt8(PETDEX_AGENT_CONNECTED.rawValue):
            return "Connected"
        case UInt8(PETDEX_AGENT_DETECTED.rawValue):
            return "Detected"
        default:
            return "Not found"
        }
    }
}

enum AgentCatalog {
    struct Spec {
        let slug: String
        let name: String
        let agentCode: UInt8
        let relativePath: String
        let supportsHookToggle: Bool
    }

    static let all: [Spec] = [
        Spec(slug: "claude-code", name: "Claude Code", agentCode: UInt8(PETDEX_AGENT_CLAUDE_CODE.rawValue), relativePath: ".claude", supportsHookToggle: true),
        Spec(slug: "codex", name: "Codex", agentCode: UInt8(PETDEX_AGENT_CODEX.rawValue), relativePath: ".codex", supportsHookToggle: true),
        Spec(slug: "gemini", name: "Gemini CLI", agentCode: UInt8(PETDEX_AGENT_GEMINI.rawValue), relativePath: ".gemini", supportsHookToggle: true),
        Spec(slug: "opencode", name: "OpenCode", agentCode: UInt8(PETDEX_AGENT_OPENCODE.rawValue), relativePath: ".config/opencode", supportsHookToggle: true),
        Spec(slug: "qoder", name: "Qoder", agentCode: UInt8(PETDEX_AGENT_QODER.rawValue), relativePath: ".qoder", supportsHookToggle: false),
        Spec(slug: "kimi-code", name: "Kimi Code", agentCode: UInt8(PETDEX_AGENT_KIMI_CODE.rawValue), relativePath: ".kimi", supportsHookToggle: false),
        Spec(slug: "codebuddy", name: "CodeBuddy", agentCode: UInt8(PETDEX_AGENT_CODEBUDDY.rawValue), relativePath: ".codebuddy", supportsHookToggle: false),
        Spec(slug: "omp", name: "Oh My Pi", agentCode: UInt8(PETDEX_AGENT_OMP.rawValue), relativePath: ".omp", supportsHookToggle: false),
        Spec(slug: "hermes", name: "Hermes", agentCode: UInt8(PETDEX_AGENT_HERMES.rawValue), relativePath: ".hermes", supportsHookToggle: true),
        Spec(slug: "dsh", name: "DeepSeek", agentCode: UInt8(PETDEX_AGENT_DSH.rawValue), relativePath: "Library/Application Support/DeepSeek", supportsHookToggle: false),
    ]

    static func scanInstalled() -> [DetectedAgent] {
        all.map { spec in
            let status = petdex_agent_status(spec.agentCode)
            return DetectedAgent(
                id: spec.slug,
                name: spec.name,
                slug: spec.slug,
                agentCode: spec.agentCode,
                configPath: "~/\(spec.relativePath)",
                installStatus: status,
                supportsHookToggle: spec.supportsHookToggle
            )
        }
    }

    static func displayName(for slug: String) -> String {
        all.first(where: { $0.slug == slug })?.name ?? slug
    }

    static func agentCode(for slug: String) -> UInt8 {
        all.first(where: { $0.slug == slug })?.agentCode ?? UInt8(PETDEX_AGENT_CLAUDE_CODE.rawValue)
    }
}

extension InstalledPet: Identifiable {}

final class PetdexSettingsStore: ObservableObject {
    static let minScale: Double = 0.6
    static let maxScale: Double = 1.4

    private struct PersistedSettings: Codable {
        var activePetId: String?
        var scale: Double
        var bubblesEnabled: Bool
        var showAllSessions: Bool?
        var alwaysOnTop: Bool
        var launchAtLogin: Bool?
        var hideCrafterAnnouncements: Bool?
        var panelX: Double?
        var panelY: Double?
    }

    @Published var activePetId: String? {
        didSet { persistIfReady() }
    }

    @Published var scale: Double {
        didSet {
            let clamped = Self.clampScale(scale)
            if scale != clamped {
                scale = clamped
                return
            }
            persistIfReady()
        }
    }

    @Published var bubblesEnabled: Bool {
        didSet { persistIfReady() }
    }

    @Published var showAllSessions: Bool {
        didSet { persistIfReady() }
    }

    @Published var alwaysOnTop: Bool {
        didSet { persistIfReady() }
    }

    @Published var launchAtLogin: Bool {
        didSet { persistIfReady() }
    }

    @Published var hideCrafterAnnouncements: Bool {
        didSet { persistIfReady() }
    }

    @Published var launchAtLoginStatus: String? = nil

    @Published var panelX: Double? {
        didSet { persistIfReady() }
    }

    @Published var panelY: Double? {
        didSet { persistIfReady() }
    }

    @Published var installedPets: [InstalledPet] = []
    @Published var currentState: UInt8 = UInt8(PETDEX_STATE_IDLE.rawValue)
    @Published var hookServerPort: UInt16 = 0
    @Published var hookToken: String = ""
    @Published var activeBubbles: [ActiveBubble] = []
    @Published var detectedAgents: [DetectedAgent] = []

    var activeBubble: ActiveBubble? {
        activeBubbles.first
    }

    let settingsURL: URL
    private var isLoaded = false

    init(settingsURL: URL = PetdexSettingsStore.defaultSettingsURL) {
        self.settingsURL = settingsURL
        self.activePetId = nil
        self.scale = 1.0
        self.bubblesEnabled = true
        self.showAllSessions = true
        self.alwaysOnTop = true
        self.launchAtLogin = false
        self.hideCrafterAnnouncements = false
        self.panelX = nil
        self.panelY = nil
        load()
        isLoaded = true
        refreshDetectedAgents()
    }

    static var defaultSettingsURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".petdex", isDirectory: true)
            .appendingPathComponent("macos-settings.json", isDirectory: false)
    }

    static func clampScale(_ value: Double) -> Double {
        min(max(value, minScale), maxScale)
    }

    func refreshAgents() {
        detectedAgents = AgentCatalog.scanInstalled()
    }

    func refreshDetectedAgents() {
        refreshAgents()
    }

    @discardableResult
    func connectAgent(_ agentCode: UInt8) -> Bool {
        let ok = petdex_agent_connect(agentCode)
        refreshAgents()
        return ok
    }

    @discardableResult
    func disconnectAgent(_ agentCode: UInt8) -> Bool {
        let ok = petdex_agent_disconnect(agentCode)
        refreshAgents()
        return ok
    }

    func setLaunchAtLogin(_ enabled: Bool) {
        launchAtLoginStatus = nil
        do {
            if enabled {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
            launchAtLogin = enabled
        } catch {
            launchAtLogin = SMAppService.mainApp.status == .enabled
            launchAtLoginStatus = "Launch at login requires a bundled .app (\(error.localizedDescription))."
        }
    }

    func updatePanelOrigin(_ origin: NSPoint) {
        let nextX = Double(origin.x.rounded())
        let nextY = Double(origin.y.rounded())
        if panelX == nextX && panelY == nextY {
            return
        }
        panelX = nextX
        panelY = nextY
    }

    private func load() {
        guard
            let data = try? Data(contentsOf: settingsURL),
            let decoded = try? JSONDecoder().decode(PersistedSettings.self, from: data)
        else {
            return
        }

        activePetId = decoded.activePetId
        scale = Self.clampScale(decoded.scale)
        bubblesEnabled = decoded.bubblesEnabled
        showAllSessions = decoded.showAllSessions ?? true
        alwaysOnTop = decoded.alwaysOnTop
        launchAtLogin = decoded.launchAtLogin ?? false
        hideCrafterAnnouncements = decoded.hideCrafterAnnouncements ?? false
        panelX = decoded.panelX
        panelY = decoded.panelY
    }

    private func persistIfReady() {
        guard isLoaded else { return }
        save()
    }

    func save() {
        let payload = PersistedSettings(
            activePetId: activePetId,
            scale: Self.clampScale(scale),
            bubblesEnabled: bubblesEnabled,
            showAllSessions: showAllSessions,
            alwaysOnTop: alwaysOnTop,
            launchAtLogin: launchAtLogin,
            hideCrafterAnnouncements: hideCrafterAnnouncements,
            panelX: panelX,
            panelY: panelY
        )

        let fm = FileManager.default
        let dir = settingsURL.deletingLastPathComponent()
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let data = try? encoder.encode(payload) else { return }
        try? data.write(to: settingsURL, options: [.atomic])
    }
}
