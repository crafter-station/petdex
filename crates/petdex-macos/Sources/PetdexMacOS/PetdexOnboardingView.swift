import AppKit
import SwiftUI

struct PetdexOnboardingActions {
    let onSignIn: () -> Void
    let onSelectPet: (InstalledPet?) -> Void
    let onPetInstalled: (InstalledPet) -> Void
    let onRefreshAgents: () -> Void
    let onSendTestBubble: () -> Void
    let onFinish: () -> Void
}

private enum OnboardingStep: Int, CaseIterable, Identifiable {
    case account = 0
    case companion = 1
    case agents = 2
    case ready = 3

    var id: Int { rawValue }

    var numberLabel: String {
        String(format: "%02d", rawValue + 1)
    }

    var title: String {
        switch self {
        case .account:
            return "Account"
        case .companion:
            return "Companion"
        case .agents:
            return "Agents"
        case .ready:
            return "Ready"
        }
    }
}

struct PetdexOnboardingView: View {
    @ObservedObject var store: PetdexSettingsStore
    let actions: PetdexOnboardingActions

    @Environment(\.colorScheme) private var colorScheme
    @State private var currentStep: OnboardingStep = .account
    @State private var isInstallingBoba = false
    @State private var installBobaError: String?
    @State private var testBubbleSent = false

    private static let onboardingAgentSlugs: [String] = [
        "claude-code",
        "codex",
        "gemini",
        "opencode",
        "hermes",
    ]

    private let cobalt = Color(red: 59.0 / 255.0, green: 89.0 / 255.0, blue: 242.0 / 255.0)
    private let cobaltDeep = Color(red: 36.0 / 255.0, green: 63.0 / 255.0, blue: 214.0 / 255.0)

    private var canvasBackground: Color {
        colorScheme == .dark
            ? Color(nsColor: .windowBackgroundColor)
            : Color(red: 0.976, green: 0.973, blue: 0.961)
    }

    private var pearlSurface: Color {
        colorScheme == .dark
            ? Color(nsColor: .controlBackgroundColor)
            : Color(red: 1.0, green: 0.998, blue: 0.992)
    }

    private var subtleSurface: Color {
        colorScheme == .dark
            ? Color.white.opacity(0.06)
            : Color(red: 0.945, green: 0.940, blue: 0.925)
    }

    private var hairlineBorder: Color {
        colorScheme == .dark
            ? Color.white.opacity(0.11)
            : Color(red: 0.885, green: 0.875, blue: 0.850)
    }

    private var onboardingAgents: [DetectedAgent] {
        Self.onboardingAgentSlugs.compactMap { slug in
            store.detectedAgents.first(where: { $0.slug == slug })
        }
    }

    private var detectedUnconnectedAgents: [DetectedAgent] {
        onboardingAgents.filter { $0.isDetected && $0.supportsHookToggle }
    }

    private var connectedAgentCount: Int {
        onboardingAgents.filter(\.isConnected).count
    }

    var body: some View {
        VStack(spacing: 0) {
            stepHeaderBar
            Rectangle()
                .fill(hairlineBorder)
                .frame(height: 1)

            Group {
                switch currentStep {
                case .account:
                    accountStepView
                case .companion:
                    companionStepView
                case .agents:
                    agentsStepView
                case .ready:
                    readyStepView
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding(.horizontal, 26)
            .padding(.vertical, 20)

            Rectangle()
                .fill(hairlineBorder)
                .frame(height: 1)
            footerBar
        }
        .frame(width: 540, height: 440)
        .background(canvasBackground)
        .onAppear {
            actions.onRefreshAgents()
        }
    }

    private var stepHeaderBar: some View {
        HStack(spacing: 8) {
            ForEach(OnboardingStep.allCases) { step in
                let isCurrent = step == currentStep
                let isCompleted = step.rawValue < currentStep.rawValue

                Button {
                    withAnimation(.easeInOut(duration: 0.18)) {
                        currentStep = step
                    }
                } label: {
                    HStack(spacing: 5) {
                        if isCompleted {
                            Image(systemName: "checkmark")
                                .font(.system(size: 9, weight: .bold))
                        } else {
                            Text(step.numberLabel)
                                .font(.system(size: 10.5, weight: .bold, design: .monospaced))
                        }

                        Text(step.title)
                            .font(.system(size: 11.5, weight: isCurrent ? .semibold : .medium, design: .rounded))
                            .lineLimit(1)
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .frame(maxWidth: .infinity)
                    .foregroundColor(
                        isCurrent
                            ? .white
                            : (isCompleted ? cobalt : .secondary)
                    )
                    .background(
                        Capsule()
                            .fill(
                                isCurrent
                                    ? cobalt
                                    : (isCompleted ? cobalt.opacity(0.12) : pearlSurface)
                            )
                    )
                    .overlay(
                        Capsule()
                            .strokeBorder(
                                isCurrent ? cobalt : (isCompleted ? cobalt.opacity(0.25) : hairlineBorder),
                                lineWidth: 1
                            )
                    )
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 14)
        .background(pearlSurface.opacity(colorScheme == .dark ? 0.5 : 0.85))
    }

    private var accountStepView: some View {
        let isBusy = store.authPhase == "authorizing" || store.authPhase == "syncing"

        return VStack(spacing: 16) {
            Spacer(minLength: 4)

            cobaltSquircleMark(size: 68)

            VStack(spacing: 6) {
                Text("Welcome to Petdex")
                    .font(.system(size: 22, weight: .bold, design: .rounded))
                    .foregroundColor(.primary)

                Text("Your animated pixel companion for every coding agent.")
                    .font(.system(size: 13))
                    .foregroundColor(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 360)
            }

            if let user = store.authUser, store.isSignedIn {
                HStack(spacing: 12) {
                    AsyncImage(url: user.avatarURL) { phase in
                        switch phase {
                        case .success(let image):
                            image
                                .resizable()
                                .aspectRatio(contentMode: .fill)
                        default:
                            ZStack {
                                Circle()
                                    .fill(cobalt.opacity(0.16))
                                Image(systemName: "person.fill")
                                    .font(.system(size: 16, weight: .semibold))
                                    .foregroundColor(cobalt)
                            }
                        }
                    }
                    .frame(width: 40, height: 40)
                    .clipShape(Circle())

                    VStack(alignment: .leading, spacing: 2) {
                        Text(user.name)
                            .font(.system(size: 13.5, weight: .semibold, design: .rounded))
                            .lineLimit(1)
                        if let handle = user.handleText {
                            Text(handle)
                                .font(.system(size: 11.5, design: .monospaced))
                                .foregroundColor(.secondary)
                                .lineLimit(1)
                        }
                    }

                    Spacer()

                    HStack(spacing: 5) {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.system(size: 15))
                            .foregroundColor(Color(red: 0.13, green: 0.65, blue: 0.36))
                        Text("Signed in")
                            .font(.system(size: 11.5, weight: .semibold, design: .rounded))
                            .foregroundColor(Color(red: 0.13, green: 0.65, blue: 0.36))
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 5)
                    .background(
                        Capsule()
                            .fill(Color(red: 0.13, green: 0.65, blue: 0.36).opacity(0.12))
                    )
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
                .frame(maxWidth: 370)
                .background(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(pearlSurface)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .strokeBorder(hairlineBorder, lineWidth: 1)
                )
            } else {
                VStack(spacing: 10) {
                    Button {
                        actions.onSignIn()
                    } label: {
                        HStack(spacing: 8) {
                            if isBusy {
                                ProgressView()
                                    .controlSize(.small)
                                    .tint(.white)
                            } else {
                                Image(systemName: "person.badge.key.fill")
                                    .font(.system(size: 13, weight: .semibold))
                            }
                            Text(signInButtonTitle)
                                .font(.system(size: 13.5, weight: .semibold, design: .rounded))
                        }
                        .foregroundColor(.white)
                        .frame(width: 240, height: 38)
                        .background(
                            RoundedRectangle(cornerRadius: 11, style: .continuous)
                                .fill(
                                    LinearGradient(
                                        colors: [cobalt, cobaltDeep],
                                        startPoint: .top,
                                        endPoint: .bottom
                                    )
                                )
                        )
                        .shadow(color: cobalt.opacity(0.28), radius: 8, x: 0, y: 4)
                    }
                    .buttonStyle(.plain)
                    .disabled(isBusy)

                    Button {
                        withAnimation(.easeInOut(duration: 0.18)) {
                            currentStep = .companion
                        }
                    } label: {
                        Text("Skip for now")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundColor(.secondary)
                    }
                    .buttonStyle(.plain)
                }
            }

            if let authError = store.authError, !authError.isEmpty {
                HStack(spacing: 6) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 11))
                        .foregroundColor(.red)
                    Text(authError)
                        .font(.system(size: 11))
                        .foregroundColor(.red)
                        .lineLimit(2)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(Color.red.opacity(0.08))
                )
            }

            Spacer(minLength: 4)
        }
    }

    private var companionStepView: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 3) {
                Text("Choose your companion")
                    .font(.system(size: 17, weight: .bold, design: .rounded))
                Text("Select a pixel pet to appear on your desktop right away.")
                    .font(.system(size: 12))
                    .foregroundColor(.secondary)
            }

            if store.installedPets.isEmpty {
                VStack(spacing: 10) {
                    HStack(spacing: 12) {
                        cobaltSquircleMark(size: 40)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("No custom pets installed yet")
                                .font(.system(size: 13, weight: .semibold, design: .rounded))
                            Text("Grab Boba from petdex.dev or start with the built-in Cobalt Squircle.")
                                .font(.system(size: 11.5))
                                .foregroundColor(.secondary)
                        }
                        Spacer()
                    }

                    HStack(spacing: 10) {
                        Button {
                            installBoba()
                        } label: {
                            HStack(spacing: 6) {
                                if isInstallingBoba {
                                    ProgressView()
                                        .controlSize(.mini)
                                        .tint(.white)
                                } else {
                                    Image(systemName: "arrow.down.circle.fill")
                                        .font(.system(size: 12))
                                }
                                Text(isInstallingBoba ? "Installing Boba..." : "Install Boba from petdex.dev")
                                    .font(.system(size: 12, weight: .semibold, design: .rounded))
                            }
                            .foregroundColor(.white)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 7)
                            .background(
                                RoundedRectangle(cornerRadius: 9, style: .continuous)
                                    .fill(cobalt)
                            )
                        }
                        .buttonStyle(.plain)
                        .disabled(isInstallingBoba)

                        Spacer()
                    }

                    if let installBobaError {
                        HStack(spacing: 6) {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .font(.system(size: 11))
                                .foregroundColor(.orange)
                            Text(installBobaError)
                                .font(.system(size: 11))
                                .foregroundColor(.secondary)
                                .lineLimit(2)
                            Spacer()
                        }
                    }
                }
                .padding(14)
                .background(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(pearlSurface)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .strokeBorder(hairlineBorder, lineWidth: 1)
                )
            }

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
                        companionCard(
                            title: pet.displayName,
                            subtitle: pet.id,
                            selected: store.activePetId == pet.id
                        ) {
                            if let image = PetPreviewCache.shared.previewImage(for: pet) {
                                Image(nsImage: image)
                                    .interpolation(.none)
                                    .resizable()
                                    .aspectRatio(contentMode: .fit)
                                    .frame(width: 58, height: 58)
                            } else {
                                Image(systemName: "pawprint.fill")
                                    .font(.system(size: 22))
                                    .foregroundColor(.secondary)
                                    .frame(width: 58, height: 58)
                            }
                        } action: {
                            actions.onSelectPet(pet)
                        }
                    }

                    companionCard(
                        title: "Cobalt Squircle",
                        subtitle: "Built-in",
                        selected: store.activePetId == nil
                    ) {
                        cobaltSquircleMark(size: 46)
                    } action: {
                        actions.onSelectPet(nil)
                    }
                }
                .padding(2)
            }
        }
    }

    private var agentsStepView: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Connect your coding agents")
                        .font(.system(size: 17, weight: .bold, design: .rounded))
                    Text("Enable live bubbles when your CLI agents run or wait for input.")
                        .font(.system(size: 12))
                        .foregroundColor(.secondary)
                }

                Spacer()

                Button {
                    connectAllDetected()
                } label: {
                    Text("Connect All Detected")
                        .font(.system(size: 11.5, weight: .semibold, design: .rounded))
                        .foregroundColor(.white)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .background(
                            RoundedRectangle(cornerRadius: 8, style: .continuous)
                                .fill(detectedUnconnectedAgents.isEmpty ? cobalt.opacity(0.38) : cobalt)
                        )
                }
                .buttonStyle(.plain)
                .disabled(detectedUnconnectedAgents.isEmpty)
            }

            VStack(spacing: 8) {
                ForEach(onboardingAgents) { agent in
                    HStack(spacing: 10) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(agent.name)
                                .font(.system(size: 12.5, weight: .semibold, design: .rounded))
                            Text(agent.configPath)
                                .font(.system(size: 10.5, design: .monospaced))
                                .foregroundColor(.secondary)
                        }

                        Spacer()

                        onboardingAgentStatusPill(for: agent)

                        if agent.isConnected {
                            Image(systemName: "checkmark.circle.fill")
                                .font(.system(size: 16))
                                .foregroundColor(Color(red: 0.13, green: 0.65, blue: 0.36))
                                .frame(width: 68, alignment: .trailing)
                        } else {
                            Button {
                                store.connectAgent(agent.agentCode)
                            } label: {
                                Text("Connect")
                                    .font(.system(size: 11, weight: .semibold, design: .rounded))
                                    .foregroundColor(.white)
                                    .frame(width: 68, height: 24)
                                    .background(
                                        RoundedRectangle(cornerRadius: 7, style: .continuous)
                                            .fill(cobalt)
                                    )
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(
                        RoundedRectangle(cornerRadius: 11, style: .continuous)
                            .fill(pearlSurface)
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 11, style: .continuous)
                            .strokeBorder(hairlineBorder, lineWidth: 1)
                    )
                }
            }

            Spacer(minLength: 0)
        }
    }

    private var readyStepView: some View {
        VStack(spacing: 16) {
            Spacer(minLength: 2)

            ZStack {
                Circle()
                    .fill(cobalt.opacity(0.12))
                    .frame(width: 58, height: 58)
                Image(systemName: "sparkles")
                    .font(.system(size: 24, weight: .semibold))
                    .foregroundColor(cobalt)
            }

            VStack(spacing: 5) {
                Text("You're all set!")
                    .font(.system(size: 21, weight: .bold, design: .rounded))
                Text("Your companion is perched on your desktop and listening for agent updates.")
                    .font(.system(size: 12.5))
                    .foregroundColor(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 380)
            }

            HStack(spacing: 12) {
                Image(systemName: "hand.draw.fill")
                    .font(.system(size: 18))
                    .foregroundColor(cobalt)
                    .frame(width: 34, height: 34)
                    .background(
                        RoundedRectangle(cornerRadius: 9, style: .continuous)
                            .fill(cobalt.opacity(0.11))
                    )

                VStack(alignment: .leading, spacing: 2) {
                    Text("Quick tip: drag & fling your pet")
                        .font(.system(size: 12.5, weight: .semibold, design: .rounded))
                    Text("Grab your companion to move it anywhere on screen, toss it for a bounce, or click a bubble to jump back to your terminal.")
                        .font(.system(size: 11.5))
                        .foregroundColor(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Spacer(minLength: 0)
            }
            .padding(14)
            .frame(maxWidth: 430)
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(pearlSurface)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(hairlineBorder, lineWidth: 1)
            )

            HStack(spacing: 10) {
                summaryPill(
                    icon: "pawprint.fill",
                    text: activePetDisplayName
                )
                summaryPill(
                    icon: "bolt.horizontal.circle.fill",
                    text: "\(connectedAgentCount) agent\(connectedAgentCount == 1 ? "" : "s") connected"
                )
            }

            Button {
                actions.onSendTestBubble()
                testBubbleSent = true
                DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) {
                    testBubbleSent = false
                }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: testBubbleSent ? "checkmark.bubble.fill" : "bubble.left.and.text.bubble.right.fill")
                        .font(.system(size: 12))
                    Text(testBubbleSent ? "Test Bubble Sent!" : "Send Test Bubble")
                        .font(.system(size: 12.5, weight: .semibold, design: .rounded))
                }
                .foregroundColor(cobalt)
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
                .background(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(pearlSurface)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .strokeBorder(cobalt.opacity(0.35), lineWidth: 1)
                )
            }
            .buttonStyle(.plain)

            Spacer(minLength: 2)
        }
    }

    private var footerBar: some View {
        HStack {
            if currentStep != .account {
                Button {
                    goToPreviousStep()
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "chevron.left")
                            .font(.system(size: 10.5, weight: .semibold))
                        Text("Back")
                            .font(.system(size: 12.5, weight: .medium, design: .rounded))
                    }
                    .foregroundColor(.primary)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 7)
                    .background(
                        RoundedRectangle(cornerRadius: 9, style: .continuous)
                            .fill(pearlSurface)
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 9, style: .continuous)
                            .strokeBorder(hairlineBorder, lineWidth: 1)
                    )
                }
                .buttonStyle(.plain)
            }

            Spacer()

            if currentStep == .ready {
                Button {
                    store.onboardingCompleted = true
                    actions.onFinish()
                } label: {
                    Text("Start Using Petdex")
                        .font(.system(size: 12.5, weight: .semibold, design: .rounded))
                        .foregroundColor(.white)
                        .padding(.horizontal, 18)
                        .padding(.vertical, 8)
                        .background(
                            RoundedRectangle(cornerRadius: 9, style: .continuous)
                                .fill(
                                    LinearGradient(
                                        colors: [cobalt, cobaltDeep],
                                        startPoint: .top,
                                        endPoint: .bottom
                                    )
                                )
                        )
                        .shadow(color: cobalt.opacity(0.24), radius: 6, x: 0, y: 3)
                }
                .buttonStyle(.plain)
            } else {
                Button {
                    goToNextStep()
                } label: {
                    HStack(spacing: 4) {
                        Text("Next")
                            .font(.system(size: 12.5, weight: .semibold, design: .rounded))
                        Image(systemName: "chevron.right")
                            .font(.system(size: 10.5, weight: .semibold))
                    }
                    .foregroundColor(.white)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 7)
                    .background(
                        RoundedRectangle(cornerRadius: 9, style: .continuous)
                            .fill(cobalt)
                    )
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
        .background(pearlSurface.opacity(colorScheme == .dark ? 0.5 : 0.85))
    }

    private func companionCard<Preview: View>(
        title: String,
        subtitle: String,
        selected: Bool,
        @ViewBuilder preview: () -> Preview,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            VStack(spacing: 6) {
                ZStack(alignment: .topTrailing) {
                    RoundedRectangle(cornerRadius: 11, style: .continuous)
                        .fill(subtleSurface)
                        .frame(height: 76)
                        .overlay(preview())

                    if selected {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.system(size: 14))
                            .foregroundColor(cobalt)
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
                    .fill(selected ? cobalt.opacity(0.08) : pearlSurface)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(
                        selected ? cobalt : hairlineBorder,
                        lineWidth: selected ? 2 : 1
                    )
            )
        }
        .buttonStyle(.plain)
    }

    private func onboardingAgentStatusPill(for agent: DetectedAgent) -> some View {
        let foreground: Color
        let background: Color
        if agent.isConnected {
            foreground = Color(red: 0.11, green: 0.58, blue: 0.32)
            background = Color(red: 0.11, green: 0.58, blue: 0.32).opacity(0.12)
        } else if agent.isDetected {
            foreground = cobalt
            background = cobalt.opacity(0.12)
        } else {
            foreground = .secondary
            background = subtleSurface
        }

        return Text(agent.statusLabel)
            .font(.system(size: 10.5, weight: .semibold, design: .rounded))
            .foregroundColor(foreground)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(
                Capsule()
                    .fill(background)
            )
    }

    private func summaryPill(icon: String, text: String) -> some View {
        HStack(spacing: 5) {
            Image(systemName: icon)
                .font(.system(size: 10.5))
                .foregroundColor(cobalt)
            Text(text)
                .font(.system(size: 11, weight: .medium, design: .rounded))
                .foregroundColor(.secondary)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(
            Capsule()
                .fill(pearlSurface)
        )
        .overlay(
            Capsule()
                .strokeBorder(hairlineBorder, lineWidth: 1)
        )
    }

    private func cobaltSquircleMark(size: CGFloat) -> some View {
        let corner = size * 0.28
        let eyeW = size * 0.15
        let eyeH = size * 0.21
        let pupilW = size * 0.065
        let pupilH = size * 0.095
        let eyeSpacing = size * 0.16

        return ZStack {
            RoundedRectangle(cornerRadius: corner, style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [
                            Color(red: 0.28, green: 0.45, blue: 0.98),
                            cobalt,
                            cobaltDeep,
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
                .frame(width: size, height: size)
                .overlay(
                    RoundedRectangle(cornerRadius: corner, style: .continuous)
                        .strokeBorder(Color.white.opacity(0.32), lineWidth: 1.5)
                )
                .shadow(color: cobalt.opacity(0.32), radius: size * 0.16, x: 0, y: size * 0.08)

            HStack(spacing: eyeSpacing) {
                ZStack {
                    RoundedRectangle(cornerRadius: eyeW * 0.35, style: .continuous)
                        .fill(Color.white.opacity(0.96))
                        .frame(width: eyeW, height: eyeH)
                    RoundedRectangle(cornerRadius: pupilW * 0.4, style: .continuous)
                        .fill(Color(red: 0.08, green: 0.14, blue: 0.36))
                        .frame(width: pupilW, height: pupilH)
                }
                ZStack {
                    RoundedRectangle(cornerRadius: eyeW * 0.35, style: .continuous)
                        .fill(Color.white.opacity(0.96))
                        .frame(width: eyeW, height: eyeH)
                    RoundedRectangle(cornerRadius: pupilW * 0.4, style: .continuous)
                        .fill(Color(red: 0.08, green: 0.14, blue: 0.36))
                        .frame(width: pupilW, height: pupilH)
                }
            }
            .offset(y: -size * 0.03)
        }
    }

    private var signInButtonTitle: String {
        switch store.authPhase {
        case "authorizing":
            return "Waiting for browser..."
        case "syncing":
            return "Syncing account..."
        default:
            return "Sign in with Petdex"
        }
    }

    private var activePetDisplayName: String {
        if let activeId = store.activePetId,
           let pet = store.installedPets.first(where: { $0.id == activeId })
        {
            return pet.displayName
        }
        return "Cobalt Squircle"
    }

    private func goToNextStep() {
        guard let next = OnboardingStep(rawValue: currentStep.rawValue + 1) else { return }
        withAnimation(.easeInOut(duration: 0.18)) {
            currentStep = next
        }
    }

    private func goToPreviousStep() {
        guard let previous = OnboardingStep(rawValue: currentStep.rawValue - 1) else { return }
        withAnimation(.easeInOut(duration: 0.18)) {
            currentStep = previous
        }
    }

    private func connectAllDetected() {
        for agent in detectedUnconnectedAgents {
            store.connectAgent(agent.agentCode)
        }
    }

    private func installBoba() {
        guard !isInstallingBoba else { return }
        isInstallingBoba = true
        installBobaError = nil

        Task { @MainActor in
            defer { isInstallingBoba = false }
            do {
                let installed = try await PetdexCatalogClient.shared.installPet(slug: "boba")
                PetPreviewCache.shared.invalidate()
                actions.onPetInstalled(installed)
            } catch {
                installBobaError = "Could not install Boba: \(error.localizedDescription)"
            }
        }
    }
}
