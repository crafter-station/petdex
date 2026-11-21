import AppKit
import SwiftUI

private struct BubbleTailShape: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.minX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY))
        path.addQuadCurve(
            to: CGPoint(x: rect.midX, y: rect.maxY),
            control: CGPoint(x: rect.midX + rect.width * 0.18, y: rect.midY + 1)
        )
        path.addQuadCurve(
            to: CGPoint(x: rect.minX, y: rect.minY),
            control: CGPoint(x: rect.midX - rect.width * 0.18, y: rect.midY + 1)
        )
        path.closeSubpath()
        return path
    }
}

private enum AgentLogoLoader {
    private static var cache: [String: NSImage] = [:]

    static func image(for agent: String) -> NSImage? {
        let key = normalizedResourceName(for: agent)
        if let cached = cache[key] {
            return cached
        }
        if let url = Bundle.module.url(forResource: key, withExtension: "png", subdirectory: "agents"),
           let img = NSImage(contentsOf: url)
        {
            cache[key] = img
            return img
        }
        if let fallbackUrl = Bundle.module.url(forResource: "fallback", withExtension: "png", subdirectory: "agents"),
           let img = NSImage(contentsOf: fallbackUrl)
        {
            cache[key] = img
            return img
        }
        return nil
    }

    private static func normalizedResourceName(for agent: String) -> String {
        switch agent.lowercased() {
        case "claude-code", "claude_code": return "claude-code"
        case "codex": return "codex"
        case "gemini", "gemini-cli": return "gemini"
        case "opencode": return "opencode-light"
        case "qoder": return "qoder"
        case "kimi-code", "kimi_code": return "kimi-code"
        case "codebuddy": return "codebuddy"
        case "omp": return "omp"
        case "hermes": return "hermes"
        case "herdr": return "herdr"
        default: return "fallback"
        }
    }
}

private final class BubblePanelModel: ObservableObject {
    @Published var bubbles: [ActiveBubble] = []
    @Published var showAllSessions: Bool = true
    @Published var isExpanded: Bool = false
}

private struct PetdexBubbleCardView: View {
    let bubble: ActiveBubble
    let showTail: Bool
    let extraCount: Int
    let isBackCard: Bool
    let onDismiss: () -> Void

    private let whiteTop = Color.white
    private let pearlBottom = Color(red: 0.961, green: 0.973, blue: 1.0)
    private let lipTint = Color(red: 0.835, green: 0.867, blue: 0.961)
    private let cobaltRim = Color(red: 0.231, green: 0.349, blue: 0.949)
    private let navyInk = Color(red: 0.082, green: 0.118, blue: 0.278)
    private let navyMuted = Color(red: 0.329, green: 0.388, blue: 0.569)
    private let voltYellow = Color(red: 1.0, green: 0.898, blue: 0.420)

    private var isNeedsInput: Bool {
        let normalized = bubble.status.lowercased()
        return normalized == "needs_input" || normalized == "needs-input"
    }

    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 6) {
                    if let logo = AgentLogoLoader.image(for: bubble.agent) {
                        Image(nsImage: logo)
                            .resizable()
                            .interpolation(.high)
                            .aspectRatio(contentMode: .fit)
                            .frame(width: 15, height: 15)
                            .clipShape(RoundedRectangle(cornerRadius: 3.5, style: .continuous))
                    } else {
                        Circle()
                            .fill(bubble.statusColor)
                            .frame(width: 8, height: 8)
                    }

                    Text(bubble.agentDisplayName)
                        .font(.system(size: 10.5, weight: .bold, design: .rounded))
                        .foregroundColor(navyInk)

                    Circle()
                        .fill(bubble.statusColor)
                        .frame(width: 6.5, height: 6.5)

                    if isNeedsInput {
                        Text("INPUT")
                            .font(.system(size: 8.5, weight: .bold, design: .monospaced))
                            .foregroundColor(navyInk)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1.5)
                            .background(Capsule().fill(voltYellow))
                    }

                    if extraCount > 0 {
                        Text("+\(extraCount)")
                            .font(.system(size: 8.5, weight: .bold, design: .monospaced))
                            .foregroundColor(.white)
                            .padding(.horizontal, 5.5)
                            .padding(.vertical, 1.5)
                            .background(Capsule().fill(cobaltRim))
                    }

                    Spacer(minLength: 4)

                    Button(action: onDismiss) {
                        Image(systemName: "xmark")
                            .font(.system(size: 8.5, weight: .bold))
                            .foregroundColor(navyMuted)
                            .frame(width: 18, height: 18)
                            .background(
                                Circle()
                                    .fill(cobaltRim.opacity(0.08))
                            )
                    }
                    .buttonStyle(.plain)
                    .help("Dismiss bubble")
                }

                Text(bubble.summary.isEmpty ? bubble.statusDisplayName : bubble.summary)
                    .font(.system(size: 12.2, weight: .medium, design: .rounded))
                    .foregroundColor(navyInk)
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, 13)
            .padding(.vertical, 9.5)
            .frame(width: 264, height: 66, alignment: .topLeading)
            .background(
                ZStack {
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .fill(lipTint)
                        .offset(y: 2)
                        .shadow(
                            color: navyInk.opacity(isBackCard ? 0.08 : 0.14),
                            radius: isBackCard ? 5 : 9,
                            x: 0,
                            y: isBackCard ? 2 : 4
                        )

                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .fill(
                            LinearGradient(
                                colors: [whiteTop, pearlBottom],
                                startPoint: .top,
                                endPoint: .bottom
                            )
                        )

                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .strokeBorder(
                            LinearGradient(
                                colors: [
                                    Color.white.opacity(0.95),
                                    cobaltRim.opacity(0.18),
                                ],
                                startPoint: .top,
                                endPoint: .bottom
                            ),
                            lineWidth: 1.2
                        )
                }
            )

            if showTail {
                ZStack {
                    BubbleTailShape()
                        .fill(lipTint)
                        .frame(width: 14, height: 7)
                        .offset(y: 1.5)

                    BubbleTailShape()
                        .fill(pearlBottom)
                        .frame(width: 14, height: 7)
                }
                .offset(y: -1)
            }
        }
    }
}

private struct PetdexBubbleDeckView: View {
    @ObservedObject var model: BubblePanelModel
    let onHoverChanged: (Bool) -> Void
    let onDismiss: (ActiveBubble) -> Void

    private let cobaltRim = Color(red: 0.231, green: 0.349, blue: 0.949)
    private let cardStep: CGFloat = 76
    private let maxVisibleExpanded = 4

    private var visibleBubbles: [ActiveBubble] {
        Array(model.bubbles.prefix(maxVisibleExpanded))
    }

    private var hiddenCount: Int {
        max(0, model.bubbles.count - maxVisibleExpanded)
    }

    private var expanded: Bool {
        model.isExpanded && model.showAllSessions && model.bubbles.count > 1
    }

    var body: some View {
        ZStack(alignment: .bottom) {
            if expanded && hiddenCount > 0 {
                Text("+\(hiddenCount) MORE SESSIONS")
                    .font(.system(size: 8.5, weight: .bold, design: .monospaced))
                    .foregroundColor(.white)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(Capsule().fill(cobaltRim))
                    .offset(y: -CGFloat(visibleBubbles.count) * cardStep - 12)
                    .transition(.opacity.combined(with: .scale(scale: 0.9)))
            }

            ForEach(Array(visibleBubbles.enumerated()), id: \.element.sessionId) { index, bubble in
                let isFront = index == 0
                let collapsedOffsetY: CGFloat = {
                    if !model.showAllSessions { return 0 }
                    if index == 0 { return 0 }
                    if index == 1 { return -11 }
                    if index == 2 { return -20 }
                    return -26
                }()
                let collapsedScale: CGFloat = {
                    if !model.showAllSessions { return 1.0 }
                    if index == 0 { return 1.0 }
                    if index == 1 { return 0.94 }
                    if index == 2 { return 0.88 }
                    return 0.82
                }()
                let collapsedOpacity: Double = {
                    if !model.showAllSessions { return isFront ? 1.0 : 0.0 }
                    if index == 0 { return 1.0 }
                    if index == 1 { return 0.90 }
                    if index == 2 { return 0.74 }
                    return 0.0
                }()

                let tailLift: CGFloat = isFront ? 0 : -6
                let yOffset = (expanded ? -CGFloat(index) * cardStep : collapsedOffsetY) + tailLift
                let scale = expanded ? 1.0 : collapsedScale
                let opacity = expanded ? 1.0 : collapsedOpacity

                PetdexBubbleCardView(
                    bubble: bubble,
                    showTail: isFront,
                    extraCount: (!expanded && isFront && model.bubbles.count > 1) ? model.bubbles.count - 1 : 0,
                    isBackCard: !expanded && !isFront,
                    onDismiss: {
                        onDismiss(bubble)
                    }
                )
                .scaleEffect(scale, anchor: .top)
                .offset(y: yOffset)
                .opacity(opacity)
                .zIndex(Double(maxVisibleExpanded - index))
                .allowsHitTesting(expanded || isFront)
            }
        }
        .padding(.horizontal, 22)
        .padding(.bottom, 16)
        .padding(.top, 24)
        .frame(width: 312, height: 376, alignment: .bottom)
        .animation(.spring(response: 0.36, dampingFraction: 0.74), value: expanded)
        .animation(.spring(response: 0.32, dampingFraction: 0.78), value: model.bubbles)
        .onHover { hovering in
            onHoverChanged(hovering)
        }
    }
}

final class PetdexBubblePanel: NSPanel {
    private let model = BubblePanelModel()
    private var hostingView: NSHostingView<PetdexBubbleDeckView>?
    private weak var anchorWindow: NSWindow?
    private var resizeObserver: NSObjectProtocol?
    private var collapseWorkItem: DispatchWorkItem?
    private var bubblesEnabled = true
    var onDismiss: ((ActiveBubble) -> Void)?

    private let panelSize = NSSize(width: 312, height: 376)

    init() {
        super.init(
            contentRect: NSRect(origin: .zero, size: NSSize(width: 312, height: 376)),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        level = .statusBar
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        hidesOnDeactivate = false
        ignoresMouseEvents = false
        becomesKeyOnlyIfNeeded = true
        acceptsMouseMovedEvents = true
    }

    deinit {
        detachAnchorObservers()
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    func attach(to window: NSWindow) {
        detachAnchorObservers()
        anchorWindow = window

        resizeObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.didResizeNotification,
            object: window,
            queue: .main
        ) { [weak self] _ in
            self?.reposition()
        }
    }

    func setAlwaysOnTop(_ enabled: Bool) {
        level = enabled ? .statusBar : .normal
    }

    func update(bubbles: [ActiveBubble], showAllSessions: Bool, enabled: Bool, anchorVisible: Bool) {
        bubblesEnabled = enabled

        guard enabled, anchorVisible, !bubbles.isEmpty else {
            collapseWorkItem?.cancel()
            collapseWorkItem = nil
            model.bubbles = []
            model.isExpanded = false
            if let anchorWindow {
                anchorWindow.removeChildWindow(self)
            }
            orderOut(nil)
            return
        }

        ensureHostingView()

        if model.bubbles != bubbles {
            model.bubbles = bubbles
        }
        if model.showAllSessions != showAllSessions {
            model.showAllSessions = showAllSessions
        }
        if bubbles.count <= 1 && model.isExpanded {
            model.isExpanded = false
        }

        if frame.size != panelSize {
            setContentSize(panelSize)
        }
        reposition()
        if let anchorWindow, parent !== anchorWindow {
            anchorWindow.addChildWindow(self, ordered: .above)
        }
        if !isVisible {
            orderFrontRegardless()
        }
    }

    private func ensureHostingView() {
        guard hostingView == nil else { return }
        let deck = PetdexBubbleDeckView(
            model: model,
            onHoverChanged: { [weak self] hovering in
                self?.handleHoverChange(hovering)
            },
            onDismiss: { [weak self] bubble in
                self?.onDismiss?(bubble)
            }
        )
        let view = NSHostingView(rootView: deck)
        view.wantsLayer = true
        view.layer?.backgroundColor = NSColor.clear.cgColor
        contentView = view
        hostingView = view
    }

    private func handleHoverChange(_ hovering: Bool) {
        collapseWorkItem?.cancel()
        collapseWorkItem = nil

        guard model.bubbles.count > 1, model.showAllSessions else { return }

        if hovering {
            if !model.isExpanded {
                withAnimation(.spring(response: 0.36, dampingFraction: 0.74)) {
                    model.isExpanded = true
                }
            }
        } else if model.isExpanded {
            let item = DispatchWorkItem { [weak self] in
                guard let self, self.model.isExpanded else { return }
                withAnimation(.spring(response: 0.34, dampingFraction: 0.78)) {
                    self.model.isExpanded = false
                }
            }
            collapseWorkItem = item
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.30, execute: item)
        }
    }

    func reposition() {
        guard let anchorWindow, !model.bubbles.isEmpty, bubblesEnabled, anchorWindow.isVisible else {
            return
        }

        let petFrame = anchorWindow.frame
        let bubbleSize = frame.size
        var originX = round(petFrame.midX - bubbleSize.width * 0.5)
        var originY = round(petFrame.maxY - 6.0)

        if let screenFrame = (anchorWindow.screen ?? NSScreen.main)?.visibleFrame {
            originX = min(max(originX, screenFrame.minX + 4.0), screenFrame.maxX - bubbleSize.width - 4.0)
            originY = min(originY, screenFrame.maxY - bubbleSize.height - 4.0)
        }

        setFrameOrigin(NSPoint(x: originX, y: originY))
    }

    private func detachAnchorObservers() {
        collapseWorkItem?.cancel()
        collapseWorkItem = nil
        if let resizeObserver {
            NotificationCenter.default.removeObserver(resizeObserver)
            self.resizeObserver = nil
        }
        if let anchorWindow {
            anchorWindow.removeChildWindow(self)
        }
    }
}
