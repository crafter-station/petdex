import AppKit
import SwiftUI

struct PetdexSettingsActions {
    let onSelectPet: (InstalledPet?) -> Void
    let onPetInstalled: (InstalledPet) -> Void
    let onReloadPets: () -> Void
    let onOpenPetsFolder: () -> Void
    let onBrowsePetdex: () -> Void
    let onScaleChanged: (Double) -> Void
    let onAlwaysOnTopChanged: (Bool) -> Void
    let onBubblesEnabledChanged: (Bool) -> Void
    let onShowAllSessionsChanged: (Bool) -> Void
    let onSelectState: (UInt8) -> Void
    let onSendTestBubble: () -> Void
    let onSendTestTwoSessions: () -> Void
    let onRefreshAgents: () -> Void
    var onShufflePet: () -> Void = {}
    var onHideDockChanged: (Bool) -> Void = { _ in }
    var onFocusModeChanged: (Bool) -> Void = { _ in }
    var onBubbleStyleChanged: () -> Void = {}
    var onCheckUpdates: () -> Void = {}
    var onOpenRemoteConfig: () -> Void = {}
}

private enum PetsSubtab: String, CaseIterable, Identifiable {
    case installed = "Installed"
    case catalog = "Browse Catalog"

    var id: String { rawValue }
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
    @State private var selectedPetsSubtab: PetsSubtab = .installed
    @State private var catalogSearch = ""
    @State private var catalogPets: [RemotePetItem] = []
    @State private var isLoadingCatalog = false
    @State private var catalogError: String?
    @State private var hasLoadedCatalog = false
    @State private var installingSlugs: Set<String> = []
    @State private var installError: String?
    @State private var catalogFetchTask: Task<Void, Never>?
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
            Picker("Pets Source", selection: $selectedPetsSubtab) {
                ForEach(PetsSubtab.allCases) { subtab in
                    Text(subtab.rawValue).tag(subtab)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()

            switch selectedPetsSubtab {
            case .installed:
                installedPetsContent
            case .catalog:
                browseCatalogContent
            }
        }
        .onChange(of: selectedPetsSubtab) { nextSubtab in
            if nextSubtab == .catalog && !hasLoadedCatalog {
                scheduleCatalogFetch(query: catalogSearch, debounceMs: 0)
            }
        }
        .onChange(of: catalogSearch) { nextQuery in
            if selectedPetsSubtab == .catalog {
                scheduleCatalogFetch(query: nextQuery, debounceMs: 280)
            }
        }
    }

    private var installedPetsContent: some View {
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

    private var browseCatalogContent: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                HStack(spacing: 6) {
                    Image(systemName: "magnifyingglass")
                        .font(.system(size: 12))
                        .foregroundColor(.secondary)
                    TextField("Search petdex.dev...", text: $catalogSearch)
                        .textFieldStyle(.plain)
                        .font(.system(size: 12))
                    if !catalogSearch.isEmpty {
                        Button {
                            catalogSearch = ""
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .font(.system(size: 12))
                                .foregroundColor(.secondary)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 5)
                .background(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(Color(nsColor: .controlBackgroundColor))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .strokeBorder(Color.secondary.opacity(0.25), lineWidth: 1)
                )

                Button {
                    scheduleCatalogFetch(query: catalogSearch, debounceMs: 0)
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .disabled(isLoadingCatalog)
                .help("Refresh catalog")
            }

            if let installError {
                HStack(spacing: 6) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundColor(.orange)
                        .font(.system(size: 11))
                    Text(installError)
                        .font(.system(size: 11))
                        .foregroundColor(.secondary)
                        .lineLimit(2)
                    Spacer()
                    Button("Dismiss") {
                        self.installError = nil
                    }
                    .controlSize(.mini)
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 5)
                .background(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(Color.orange.opacity(0.10))
                )
            }

            if isLoadingCatalog && catalogPets.isEmpty {
                VStack(spacing: 8) {
                    ProgressView()
                        .controlSize(.regular)
                    Text("Loading pets from petdex.dev...")
                        .font(.system(size: 12))
                        .foregroundColor(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let catalogError, catalogPets.isEmpty {
                VStack(spacing: 8) {
                    Image(systemName: "wifi.exclamationmark")
                        .font(.system(size: 22))
                        .foregroundColor(.secondary)
                    Text(catalogError)
                        .font(.system(size: 12))
                        .foregroundColor(.secondary)
                        .multilineTextAlignment(.center)
                    Button("Retry") {
                        scheduleCatalogFetch(query: catalogSearch, debounceMs: 0)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if catalogPets.isEmpty {
                VStack(spacing: 6) {
                    Image(systemName: "pawprint")
                        .font(.system(size: 22))
                        .foregroundColor(.secondary)
                    Text("No matching pets found.")
                        .font(.system(size: 12))
                        .foregroundColor(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVGrid(
                        columns: [
                            GridItem(.flexible(), spacing: 12),
                            GridItem(.flexible(), spacing: 12),
                            GridItem(.flexible(), spacing: 12),
                        ],
                        spacing: 12
                    ) {
                        ForEach(catalogPets) { item in
                            remotePetCard(item)
                        }
                    }
                    .padding(2)
                }
            }
        }
    }

    private func remotePetCard(_ item: RemotePetItem) -> some View {
        let installedMatch = store.installedPets.first {
            $0.id.caseInsensitiveCompare(item.slug) == .orderedSame
        }
        let isActive = installedMatch != nil && store.activePetId?.caseInsensitiveCompare(item.slug) == .orderedSame
        let isInstalling = installingSlugs.contains(item.slug)

        return VStack(spacing: 6) {
            ZStack(alignment: .topTrailing) {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(Color.secondary.opacity(0.08))
                    .frame(height: 74)
                    .overlay {
                        AsyncImage(url: item.thumbnailURL) { phase in
                            switch phase {
                            case .success(let image):
                                image
                                    .interpolation(.none)
                                    .resizable()
                                    .aspectRatio(contentMode: .fit)
                                    .frame(width: 58, height: 58)
                            case .failure:
                                Image(systemName: "pawprint.fill")
                                    .font(.system(size: 22))
                                    .foregroundColor(.secondary.opacity(0.6))
                            case .empty:
                                ProgressView()
                                    .controlSize(.small)
                            @unknown default:
                                EmptyView()
                            }
                        }
                    }

                if isActive {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 14))
                        .foregroundColor(.accentColor)
                        .padding(6)
                }
            }

            VStack(spacing: 1) {
                Text(item.displayName)
                    .font(.system(size: 12, weight: .semibold, design: .rounded))
                    .foregroundColor(.primary)
                    .lineLimit(1)
                Text(item.slug)
                    .font(.system(size: 10))
                    .foregroundColor(.secondary)
                    .lineLimit(1)
            }

            if isInstalling {
                HStack(spacing: 4) {
                    ProgressView()
                        .controlSize(.mini)
                    Text("Installing")
                        .font(.system(size: 10.5, weight: .medium))
                }
                .frame(maxWidth: .infinity)
                .frame(height: 22)
            } else if let installedMatch {
                Button(isActive ? "Active" : "Select") {
                    actions.onSelectPet(installedMatch)
                }
                .controlSize(.small)
                .disabled(isActive)
                .frame(maxWidth: .infinity)
            } else {
                Button("Install") {
                    installRemotePet(item)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .frame(maxWidth: .infinity)
            }
        }
        .padding(8)
        .frame(maxWidth: .infinity)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(isActive ? Color.accentColor.opacity(0.10) : Color(nsColor: .controlBackgroundColor))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(
                    isActive ? Color.accentColor : Color.secondary.opacity(0.20),
                    lineWidth: isActive ? 2 : 1
                )
        )
    }

    private func scheduleCatalogFetch(query: String, debounceMs: UInt64) {
        catalogFetchTask?.cancel()
        catalogFetchTask = Task { @MainActor in
            if debounceMs > 0 {
                try? await Task.sleep(nanoseconds: debounceMs * 1_000_000)
                if Task.isCancelled { return }
            }
            isLoadingCatalog = true
            catalogError = nil
            do {
                let results = try await PetdexCatalogClient.shared.fetchCatalog(query: query)
                if Task.isCancelled { return }
                catalogPets = results
                hasLoadedCatalog = true
            } catch {
                if Task.isCancelled { return }
                catalogError = error.localizedDescription
            }
            isLoadingCatalog = false
        }
    }

    private func installRemotePet(_ item: RemotePetItem) {
        guard !installingSlugs.contains(item.slug) else { return }
        installingSlugs.insert(item.slug)
        installError = nil

        Task { @MainActor in
            defer { installingSlugs.remove(item.slug) }
            do {
                let installed = try await PetdexCatalogClient.shared.installPet(item)
                PetPreviewCache.shared.invalidate()
                actions.onPetInstalled(installed)
            } catch {
                installError = "Failed to install \(item.displayName): \(error.localizedDescription)"
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
        let showAllSessionsBinding = Binding<Bool>(
            get: { store.showAllSessions },
            set: { newValue in
                store.showAllSessions = newValue
                actions.onShowAllSessionsChanged(newValue)
            }
        )
        let launchAtLoginBinding = Binding<Bool>(
            get: { store.launchAtLogin },
            set: { newValue in
                store.setLaunchAtLogin(newValue)
            }
        )
        let hideCrafterAnnouncementsBinding = Binding<Bool>(
            get: { store.hideCrafterAnnouncements },
            set: { newValue in
                store.hideCrafterAnnouncements = newValue
            }
        )
        let waitingSoundBinding = Binding<Bool>(
            get: { store.waitingSoundEnabled },
            set: { newValue in
                store.waitingSoundEnabled = newValue
            }
        )
        let focusModeBinding = Binding<Bool>(
            get: { store.focusMode },
            set: { newValue in
                store.focusMode = newValue
                actions.onFocusModeChanged(newValue)
            }
        )
        let rotatePetsBinding = Binding<Bool>(
            get: { store.rotatePets },
            set: { newValue in
                store.rotatePets = newValue
            }
        )
        let hideDockIconBinding = Binding<Bool>(
            get: { store.hideDockIcon },
            set: { newValue in
                store.hideDockIcon = newValue
                actions.onHideDockChanged(newValue)
            }
        )
        let bubbleTextSizeBinding = Binding<Double>(
            get: { store.bubbleTextSize },
            set: { newValue in
                store.bubbleTextSize = newValue
                actions.onBubbleStyleChanged()
            }
        )
        let bubbleMaxLinesBinding = Binding<Int>(
            get: { store.bubbleMaxLines },
            set: { newValue in
                store.bubbleMaxLines = newValue
                actions.onBubbleStyleChanged()
            }
        )
        let bubbleLifetimeBinding = Binding<Double>(
            get: { store.bubbleLifetimeSec },
            set: { newValue in
                store.bubbleLifetimeSec = newValue
                actions.onBubbleStyleChanged()
            }
        )
        let stateBinding = Binding<UInt8>(
            get: { store.currentState },
            set: { newValue in
                actions.onSelectState(newValue)
            }
        )

        return ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                GroupBox("Pet Window") {
                    VStack(alignment: .leading, spacing: 10) {
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
                        Toggle("Hide Dock icon", isOn: hideDockIconBinding)
                        Toggle("Waiting sound on needs_input", isOn: waitingSoundBinding)
                        Toggle("Focus mode (silence bubbles)", isOn: focusModeBinding)

                        HStack {
                            Toggle("Rotate pets automatically", isOn: rotatePetsBinding)
                            Spacer()
                            Button("Shuffle Pet") {
                                actions.onShufflePet()
                            }
                            .controlSize(.small)
                        }

                        VStack(alignment: .leading, spacing: 4) {
                            Toggle("Launch at login", isOn: launchAtLoginBinding)
                            if let statusNote = store.launchAtLoginStatus {
                                Text(statusNote)
                                    .font(.system(size: 11))
                                    .foregroundColor(.secondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                    .padding(8)
                }

                GroupBox("Bubbles") {
                    VStack(alignment: .leading, spacing: 10) {
                        Toggle("Speech bubbles", isOn: bubblesBinding)
                        Toggle("Stack all active sessions", isOn: showAllSessionsBinding)

                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Text("Text size")
                                    .font(.system(size: 13, weight: .medium))
                                Spacer()
                                Text(String(format: "%.1fpt", store.bubbleTextSize))
                                    .font(.system(size: 12, design: .monospaced))
                                    .foregroundColor(.secondary)
                            }
                            Slider(
                                value: bubbleTextSizeBinding,
                                in: PetdexSettingsStore.minBubbleTextSize...PetdexSettingsStore.maxBubbleTextSize,
                                step: 0.2
                            )
                        }

                        HStack {
                            Text("Max lines")
                                .font(.system(size: 13, weight: .medium))
                            Spacer()
                            Stepper(
                                value: bubbleMaxLinesBinding,
                                in: PetdexSettingsStore.minBubbleMaxLines...PetdexSettingsStore.maxBubbleMaxLines
                            ) {
                                Text("\(store.bubbleMaxLines)")
                                    .font(.system(size: 12, design: .monospaced))
                                    .foregroundColor(.secondary)
                            }
                        }

                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Text("Auto-hide")
                                    .font(.system(size: 13, weight: .medium))
                                Spacer()
                                Text("\(Int(store.bubbleLifetimeSec.rounded()))s")
                                    .font(.system(size: 12, design: .monospaced))
                                    .foregroundColor(.secondary)
                            }
                            Slider(
                                value: bubbleLifetimeBinding,
                                in: PetdexSettingsStore.minBubbleLifetimeSec...PetdexSettingsStore.maxBubbleLifetimeSec,
                                step: 1.0
                            )
                        }
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
                                Text("Sends sample agent alerts above your pet.")
                                    .font(.system(size: 11))
                                    .foregroundColor(.secondary)
                            }
                            Spacer()
                            HStack(spacing: 8) {
                                Button("Test 2 Sessions") {
                                    actions.onSendTestTwoSessions()
                                }
                                Button("Send Test Bubble") {
                                    actions.onSendTestBubble()
                                }
                                .buttonStyle(.borderedProminent)
                            }
                        }
                    }
                    .padding(8)
                }

                GroupBox("Crafter Station") {
                    VStack(alignment: .leading, spacing: 10) {
                        if !store.hideCrafterAnnouncements {
                            crafterLaunchpadCard
                        }
                        Toggle("Hide Crafter announcements", isOn: hideCrafterAnnouncementsBinding)
                    }
                    .padding(8)
                }
            }
            .padding(1)
        }
    }

    private var crafterLaunchpadCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("From Crafter Station")
                        .font(.system(size: 12, weight: .semibold, design: .rounded))
                    Text("Explore more open-source dev tools and React primitives built alongside Petdex.")
                        .font(.system(size: 11))
                        .foregroundColor(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Spacer(minLength: 8)

                Button {
                    store.hideCrafterAnnouncements = true
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundColor(.secondary)
                }
                .buttonStyle(.plain)
                .help("Hide Crafter announcements")
            }

            HStack(spacing: 8) {
                Button("crafter.run") {
                    if let url = URL(string: "https://crafter.run") {
                        NSWorkspace.shared.open(url)
                    }
                }
                .controlSize(.small)

                Button("ojito.dev") {
                    if let url = URL(string: "https://ojito.dev") {
                        NSWorkspace.shared.open(url)
                    }
                }
                .controlSize(.small)

                Button("muelle") {
                    if let url = URL(string: "https://muelle.crafter.run") {
                        NSWorkspace.shared.open(url)
                    }
                }
                .controlSize(.small)

                Button("maca.sh") {
                    if let url = URL(string: "https://maca.sh") {
                        NSWorkspace.shared.open(url)
                    }
                }
                .controlSize(.small)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(Color.secondary.opacity(0.08))
        )
    }

    private var agentsTab: some View {
        let autoCheckUpdatesBinding = Binding<Bool>(
            get: { store.autoCheckUpdates },
            set: { newValue in
                store.autoCheckUpdates = newValue
            }
        )
        let apiTokenBinding = Binding<String>(
            get: { store.apiToken },
            set: { newValue in
                store.apiToken = newValue
            }
        )

        return ScrollView {
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

                            agentStatusBadge(for: agent)

                            if agent.supportsHookToggle {
                                if agent.isConnected {
                                    Button("Disconnect") {
                                        store.disconnectAgent(agent.agentCode)
                                    }
                                    .controlSize(.small)
                                } else {
                                    Button("Connect") {
                                        store.connectAgent(agent.agentCode)
                                    }
                                    .buttonStyle(.borderedProminent)
                                    .controlSize(.small)
                                }
                            }
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 7)
                        .background(
                            RoundedRectangle(cornerRadius: 8, style: .continuous)
                                .fill(Color(nsColor: .controlBackgroundColor))
                        )
                    }
                }

                GroupBox("Remote SSH Hosts") {
                    VStack(alignment: .leading, spacing: 8) {
                        if store.remoteHosts.isEmpty {
                            Text("No remotes configured in ~/.petdex/remote-agents.json")
                                .font(.system(size: 11.5))
                                .foregroundColor(.secondary)
                        } else {
                            VStack(alignment: .leading, spacing: 6) {
                                ForEach(store.remoteHosts, id: \.self) { host in
                                    HStack(spacing: 8) {
                                        Image(systemName: "network")
                                            .font(.system(size: 11))
                                            .foregroundColor(.secondary)
                                        Text(host)
                                            .font(.system(size: 11.5, design: .monospaced))
                                            .foregroundColor(.primary)
                                            .lineLimit(2)
                                        Spacer()
                                    }
                                }
                            }
                        }

                        HStack {
                            Spacer()
                            Button("Open Config") {
                                actions.onOpenRemoteConfig()
                            }
                            .controlSize(.small)
                        }
                    }
                    .padding(8)
                }

                GroupBox("Updates & Account") {
                    VStack(alignment: .leading, spacing: 10) {
                        Toggle("Auto-check updates", isOn: autoCheckUpdatesBinding)

                        HStack(spacing: 8) {
                            Button("Check Now") {
                                actions.onCheckUpdates()
                            }
                            .controlSize(.small)

                            Text(store.updateStatusText)
                                .font(.system(size: 11.5))
                                .foregroundColor(.secondary)
                                .lineLimit(2)

                            Spacer()

                            if let downloadURL = store.updateDownloadURL {
                                Button("Download Update") {
                                    NSWorkspace.shared.open(downloadURL)
                                }
                                .buttonStyle(.link)
                                .controlSize(.small)
                            }
                        }

                        VStack(alignment: .leading, spacing: 4) {
                            Text("petdex.dev Library Token (optional)")
                                .font(.system(size: 12, weight: .medium))
                            SecureField("Paste API token...", text: apiTokenBinding)
                                .textFieldStyle(.roundedBorder)
                                .font(.system(size: 12))
                        }
                    }
                    .padding(8)
                }
            }
            .padding(1)
        }
    }

    private func agentStatusBadge(for agent: DetectedAgent) -> some View {
        let foreground: Color
        let background: Color
        if agent.isConnected {
            foreground = Color(red: 0.10, green: 0.55, blue: 0.30)
            background = Color.green.opacity(0.14)
        } else if agent.isDetected {
            foreground = Color(red: 0.14, green: 0.42, blue: 0.88)
            background = Color.blue.opacity(0.14)
        } else {
            foreground = .secondary
            background = Color.secondary.opacity(0.10)
        }

        return Text(agent.statusLabel)
            .font(.system(size: 10.5, weight: .semibold))
            .foregroundColor(foreground)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(
                Capsule()
                    .fill(background)
            )
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
