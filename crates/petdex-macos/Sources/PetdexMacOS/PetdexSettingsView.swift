import AppKit
import SwiftUI

struct PetdexSettingsActions {
    let onSelectPet: (InstalledPet?) -> Void
    let onReloadPets: () -> Void
    let onOpenPetsFolder: () -> Void
    let onBrowsePetdex: () -> Void
    let onScaleChanged: (Double) -> Void
    let onAlwaysOnTopChanged: (Bool) -> Void
    let onBubblesEnabledChanged: (Bool) -> Void
    let onSelectState: (UInt8) -> Void
    let onSendTestBubble: () -> Void
    let onRefreshAgents: () -> Void
}

private enum PetdexSettingsTab: String, CaseIterable, Identifiable {
    case pets = "Pets"
    case appearance = "Appearance"
    case agents = "Agents"

    var id: String { rawValue }

    var symbolName: String {
        switch self {
        case .pets:
            return "pawprint.fill"
        case .appearance:
            return "slider.horizontal.3"
        case .agents:
            return "bolt.horizontal.circle.fill"
        }
    }
}

private final class PetPreviewCache {
    static let shared = PetPreviewCache()
    private var cache: [String: NSImage] = [:]

    func previewImage(for pet: InstalledPet) -> NSImage? {
        let key = "\(pet.id)|\(pet.spritesheetURL.path)"
        if let cached = cache[key] {
            return cached
        }
        guard
            let atlas = PetSpriteAtlas(pet: pet),
            let cgImage = atlas.frameImage(row: 0, col: 0)
        else {
            return nil
        }
        let image = NSImage(
            cgImage: cgImage,
            size: NSSize(width: atlas.frameWidth, height: atlas.frameHeight)
        )
        cache[key] = image
        return image
    }

    func invalidate() {
        cache.removeAll()
    }
}

struct PetdexSettingsView: View {
    @ObservedObject var store: PetdexSettingsStore
    let actions: PetdexSettingsActions

    @State private var selectedTab: PetdexSettingsTab = .pets
    @State private var copiedCurl = false

    var body: some View {
        VStack(spacing: 0) {
            headerBar
            Divider()
            TabView(selection: $selectedTab) {
                petsTab
                    .tabItem {
                        Label("Pets", systemImage: PetdexSettingsTab.pets.symbolName)
                    }
                    .tag(PetdexSettingsTab.pets)

                appearanceTab
                    .tabItem {
                        Label("Appearance", systemImage: PetdexSettingsTab.appearance.symbolName)
                    }
                    .tag(PetdexSettingsTab.appearance)

                agentsTab
                    .tabItem {
                        Label("Agents", systemImage: PetdexSettingsTab.agents.symbolName)
                    }
                    .tag(PetdexSettingsTab.agents)
            }
            .tabViewStyle(.automatic)
            .padding(16)
        }
        .frame(width: 520, height: 420)
    }

    private var headerBar: some View {
        HStack(spacing: 10) {
            ZStack {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(
                        LinearGradient(
                            colors: [
                                Color(red: 0.23, green: 0.51, blue: 0.98),
                                Color(red: 0.11, green: 0.31, blue: 0.82),
                            ],
                            startPoint: .top,
                            endPoint: .bottom
                        )
                    )
                    .frame(width: 28, height: 28)
                Image(systemName: "pawprint.fill")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(.white)
            }

            VStack(alignment: .leading, spacing: 1) {
                Text("Petdex")
                    .font(.system(size: 14, weight: .semibold, design: .rounded))
                Text(activePetTitle)
                    .font(.system(size: 11))
                    .foregroundColor(.secondary)
            }

            Spacer()

            HStack(spacing: 6) {
                Circle()
                    .fill(store.hookServerPort > 0 ? Color.green : Color.red)
                    .frame(width: 7, height: 7)
                Text(store.hookServerPort > 0 ? "127.0.0.1:\(store.hookServerPort)" : "Hook Offline")
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundColor(.secondary)
            }
            .padding(.horizontal, 9)
            .padding(.vertical, 4)
            .background(
                Capsule()
                    .fill(Color.secondary.opacity(0.1))
            )
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    private var activePetTitle: String {
        if let activeId = store.activePetId,
           let pet = store.installedPets.first(where: { $0.id == activeId })
        {
            return "Active: \(pet.displayName)"
        }
        return "Active: Cobalt Squircle"
    }

    private var petsTab: some View {
        VStack(alignment: .leading, spacing: 12) {
            ScrollView {
                LazyVGrid(
                    columns: [
                        GridItem(.flexible(), spacing: 12),
                        GridItem(.flexible(), spacing: 12),
                        GridItem(.flexible(), spacing: 12),
                    ],
                    spacing: 12
                ) {
                    ForEach(store.installedPets) { pet in
                        petCard(
                            title: pet.displayName,
                            subtitle: pet.id,
                            selected: store.activePetId == pet.id,
                            preview: {
                                if let image = PetPreviewCache.shared.previewImage(for: pet) {
                                    Image(nsImage: image)
                                        .interpolation(.none)
                                        .resizable()
                                        .aspectRatio(contentMode: .fit)
                                        .frame(width: 64, height: 64)
                                } else {
                                    Image(systemName: "photo")
                                        .font(.system(size: 24))
                                        .foregroundColor(.secondary)
                                        .frame(width: 64, height: 64)
                                }
                            },
                            action: {
                                actions.onSelectPet(pet)
                            }
                        )
                    }

                    petCard(
                        title: "Cobalt Squircle",
                        subtitle: "Built-in fallback",
                        selected: store.activePetId == nil,
                        preview: {
                            cobaltSquirclePreview
                        },
                        action: {
                            actions.onSelectPet(nil)
                        }
                    )
                }
                .padding(2)
            }

            HStack(spacing: 8) {
                Button("Reload Pets") {
                    PetPreviewCache.shared.invalidate()
                    actions.onReloadPets()
                }

                Button("Open Folder") {
                    actions.onOpenPetsFolder()
                }

                Spacer()

                Button("Browse petdex.dev") {
                    actions.onBrowsePetdex()
                }
                .buttonStyle(.borderedProminent)
            }
        }
    }

    private func petCard<Preview: View>(
        title: String,
        subtitle: String,
        selected: Bool,
        @ViewBuilder preview: () -> Preview,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            VStack(spacing: 6) {
                ZStack(alignment: .topTrailing) {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(Color.secondary.opacity(0.08))
                        .frame(height: 82)
                        .overlay(preview())

                    if selected {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.system(size: 14))
                            .foregroundColor(.accentColor)
                            .padding(6)
                    }
                }

                VStack(spacing: 1) {
                    Text(title)
                        .font(.system(size: 12, weight: .semibold, design: .rounded))
                        .foregroundColor(.primary)
                        .lineLimit(1)
                    Text(subtitle)
                        .font(.system(size: 10))
                        .foregroundColor(.secondary)
                        .lineLimit(1)
                }
            }
            .padding(8)
            .frame(maxWidth: .infinity)
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(selected ? Color.accentColor.opacity(0.10) : Color(nsColor: .controlBackgroundColor))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(
                        selected ? Color.accentColor : Color.secondary.opacity(0.20),
                        lineWidth: selected ? 2 : 1
                    )
            )
        }
        .buttonStyle(.plain)
    }

    private var cobaltSquirclePreview: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [
                            Color(red: 0.23, green: 0.51, blue: 0.98),
                            Color(red: 0.11, green: 0.31, blue: 0.82),
                        ],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                )
                .frame(width: 48, height: 48)
                .overlay(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .strokeBorder(Color(red: 0.07, green: 0.19, blue: 0.54), lineWidth: 1.5)
                )

            HStack(spacing: 8) {
                RoundedRectangle(cornerRadius: 2)
                    .fill(Color.white)
                    .frame(width: 5, height: 8)
                RoundedRectangle(cornerRadius: 2)
                    .fill(Color.white)
                    .frame(width: 5, height: 8)
            }
        }
        .frame(width: 64, height: 64)
    }

    private var appearanceTab: some View {
        let scaleBinding = Binding<Double>(
            get: { store.scale },
            set: { newValue in
                store.scale = newValue
                actions.onScaleChanged(store.scale)
            }
        )
        let alwaysOnTopBinding = Binding<Bool>(
            get: { store.alwaysOnTop },
            set: { newValue in
                store.alwaysOnTop = newValue
                actions.onAlwaysOnTopChanged(newValue)
            }
        )
        let bubblesBinding = Binding<Bool>(
            get: { store.bubblesEnabled },
            set: { newValue in
                store.bubblesEnabled = newValue
                actions.onBubblesEnabledChanged(newValue)
            }
        )
        let stateBinding = Binding<UInt8>(
            get: { store.currentState },
            set: { newValue in
                actions.onSelectState(newValue)
            }
        )

        return VStack(alignment: .leading, spacing: 14) {
            GroupBox("Pet Window") {
                VStack(alignment: .leading, spacing: 12) {
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text("Scale")
                                .font(.system(size: 13, weight: .medium))
                            Spacer()
                            Text(String(format: "%.2fx", store.scale))
                                .font(.system(size: 12, design: .monospaced))
                                .foregroundColor(.secondary)
                        }
                        Slider(
                            value: scaleBinding,
                            in: PetdexSettingsStore.minScale...PetdexSettingsStore.maxScale,
                            step: 0.05
                        )
                    }

                    Toggle("Always on top", isOn: alwaysOnTopBinding)
                    Toggle("Speech bubbles", isOn: bubblesBinding)
                }
                .padding(8)
            }

            GroupBox("Preview & Testing") {
                VStack(alignment: .leading, spacing: 12) {
                    HStack {
                        Text("State")
                            .font(.system(size: 13, weight: .medium))
                        Spacer()
                        Picker("State", selection: stateBinding) {
                            ForEach(PetdexStateCatalog.allStates, id: \.0) { stateValue, label in
                                Text(label).tag(stateValue)
                            }
                        }
                        .labelsHidden()
                        .frame(width: 180)
                    }

                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Floating Bubble Preview")
                                .font(.system(size: 12, weight: .medium))
                            Text("Sends a sample agent alert above your pet.")
                                .font(.system(size: 11))
                                .foregroundColor(.secondary)
                        }
                        Spacer()
                        Button("Send Test Bubble") {
                            actions.onSendTestBubble()
                        }
                        .buttonStyle(.borderedProminent)
                    }
                }
                .padding(8)
            }

            Spacer()
        }
    }

    private var agentsTab: some View {
        VStack(alignment: .leading, spacing: 12) {
            GroupBox {
                HStack(spacing: 10) {
                    Circle()
                        .fill(store.hookServerPort > 0 ? Color.green : Color.red)
                        .frame(width: 9, height: 9)

                    VStack(alignment: .leading, spacing: 2) {
                        Text(store.hookServerPort > 0 ? "Hook Server Running" : "Hook Server Offline")
                            .font(.system(size: 12, weight: .semibold))
                        Text(store.hookServerPort > 0 ? "http://127.0.0.1:\(store.hookServerPort)/bubble" : "Not listening")
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundColor(.secondary)
                    }

                    Spacer()

                    Button(copiedCurl ? "Copied!" : "Copy curl test") {
                        copyCurlTestCommand()
                    }
                    .disabled(store.hookServerPort == 0)
                }
                .padding(6)
            }

            HStack {
                Text("Detected Coding Agents (\(store.detectedAgents.filter(\.installed).count)/\(store.detectedAgents.count))")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(.secondary)
                Spacer()
                Button("Rescan") {
                    actions.onRefreshAgents()
                }
                .controlSize(.small)
            }

            ScrollView {
                VStack(spacing: 6) {
                    ForEach(store.detectedAgents) { agent in
                        HStack(spacing: 10) {
                            VStack(alignment: .leading, spacing: 1) {
                                Text(agent.name)
                                    .font(.system(size: 12, weight: .medium))
                                Text(agent.configPath)
                                    .font(.system(size: 10.5, design: .monospaced))
                                    .foregroundColor(.secondary)
                            }

                            Spacer()

                            Text(agent.installed ? "Installed" : "Not found")
                                .font(.system(size: 10.5, weight: .semibold))
                                .foregroundColor(agent.installed ? Color(red: 0.10, green: 0.55, blue: 0.30) : .secondary)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 3)
                                .background(
                                    Capsule()
                                        .fill(agent.installed ? Color.green.opacity(0.14) : Color.secondary.opacity(0.10))
                                )
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 7)
                        .background(
                            RoundedRectangle(cornerRadius: 8, style: .continuous)
                                .fill(Color(nsColor: .controlBackgroundColor))
                        )
                    }
                }
                .padding(1)
            }
        }
    }

    private func copyCurlTestCommand() {
        let port = store.hookServerPort > 0 ? store.hookServerPort : 7777
        let token = store.hookToken
        let command = """
        curl -X POST http://127.0.0.1:\(port)/bubble -H "Content-Type: application/json" -H "x-petdex-update-token: \(token)" -d '{"session_id":"curl-test","agent":"claude-code","status":"needs-input","summary":"Waiting for your review"}'
        """
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(command, forType: .string)
        copiedCurl = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
            copiedCurl = false
        }
    }
}
