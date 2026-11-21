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

private struct PetdexBubbleCardView: View {
    let bubble: ActiveBubble
    let showTail: Bool
    let extraCount: Int
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
            ZStack {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(lipTint)
                    .offset(y: 2)
                    .shadow(color: navyInk.opacity(0.14), radius: 6, x: 0, y: 3)

                VStack(alignment: .leading, spacing: 6) {
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
                                .foregroundColor(cobaltRim)
                                .padding(.horizontal, 5.5)
                                .padding(.vertical, 1.5)
                                .background(
                                    Capsule()
                                        .fill(cobaltRim.opacity(0.12))
                                )
                                .overlay(
                                    Capsule()
                                        .strokeBorder(cobaltRim.opacity(0.24), lineWidth: 0.75)
                                )
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
                        .font(.system(size: 12.5, weight: .medium, design: .rounded))
                        .foregroundColor(navyInk)
                        .lineLimit(3)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.horizontal, 13)
                .padding(.vertical, 9.5)
                .frame(minWidth: 204, maxWidth: 276, alignment: .leading)
                .background(
                    ZStack {
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
            }

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

private struct PetdexBubbleStackView: View {
    let bubbles: [ActiveBubble]
    let showAllSessions: Bool
    let isExpanded: Bool
    let onToggleExpand: () -> Void
    let onDismiss: (ActiveBubble) -> Void

    private let cobaltRim = Color(red: 0.231, green: 0.349, blue: 0.949)
    private let navyInk = Color(red: 0.082, green: 0.118, blue: 0.278)
    private let pearlTop = Color.white
    private let pearlBottom = Color(red: 0.949, green: 0.961, blue: 0.996)
    private let lipTint = Color(red: 0.835, green: 0.867, blue: 0.961)

    private var peekingLayers: Int {
        min(2, max(0, bubbles.count - 1))
    }

    var body: some View {
        Group {
            if bubbles.count > 1 && isExpanded {
                VStack(spacing: 6) {
                    HStack {
                        Text("\(bubbles.count) SESSIONS")
                            .font(.system(size: 9, weight: .bold, design: .monospaced))
                            .foregroundColor(.white)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 3)
                            .background(Capsule().fill(cobaltRim))

                        Spacer(minLength: 4)

                        Button(action: onToggleExpand) {
                            HStack(spacing: 3) {
                                Image(systemName: "rectangle.stack")
                                    .font(.system(size: 9, weight: .bold))
                                Text("Stack")
                                    .font(.system(size: 10, weight: .bold, design: .rounded))
                            }
                            .foregroundColor(navyInk)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 3)
                            .background(
                                Capsule()
                                    .fill(pearlTop.opacity(0.95))
                                    .overlay(Capsule().stroke(cobaltRim.opacity(0.22), lineWidth: 1))
                            )
                        }
                        .buttonStyle(.plain)
                    }
                    .frame(minWidth: 204, maxWidth: 276)

                    ScrollView(.vertical, showsIndicators: false) {
                        VStack(spacing: 6) {
                            ForEach(Array(bubbles.prefix(12).enumerated()), id: \.element.sessionId) { index, bubble in
                                PetdexBubbleCardView(
                                    bubble: bubble,
                                    showTail: index == min(bubbles.count, 12) - 1,
                                    extraCount: 0,
                                    onDismiss: {
                                        onDismiss(bubble)
                                    }
                                )
                            }
                        }
                        .padding(.vertical, 2)
                    }
                    .frame(maxHeight: 300)
                }
            } else if let front = bubbles.first {
                ZStack(alignment: .top) {
                    if bubbles.count >= 3 && showAllSessions {
                        RoundedRectangle(cornerRadius: 18, style: .continuous)
                            .fill(
                                LinearGradient(
                                    colors: [pearlTop.opacity(0.86), pearlBottom.opacity(0.82)],
                                    startPoint: .top,
                                    endPoint: .bottom
                                )
                            )
                            .overlay(
                                RoundedRectangle(cornerRadius: 18, style: .continuous)
                                    .strokeBorder(cobaltRim.opacity(0.14), lineWidth: 1)
                            )
                            .frame(width: 224, height: 52)
                            .scaleEffect(0.90)
                            .offset(y: -14)
                            .shadow(color: navyInk.opacity(0.08), radius: 4, x: 0, y: 2)
                            .onTapGesture(perform: onToggleExpand)
                    }

                    if bubbles.count >= 2 && showAllSessions {
                        RoundedRectangle(cornerRadius: 18, style: .continuous)
                            .fill(
                                LinearGradient(
                                    colors: [pearlTop.opacity(0.94), pearlBottom.opacity(0.92)],
                                    startPoint: .top,
                                    endPoint: .bottom
                                )
                            )
                            .overlay(
                                RoundedRectangle(cornerRadius: 18, style: .continuous)
                                    .strokeBorder(cobaltRim.opacity(0.16), lineWidth: 1.1)
                            )
                            .frame(width: 244, height: 56)
                            .scaleEffect(0.95)
                            .offset(y: -7)
                            .shadow(color: navyInk.opacity(0.10), radius: 5, x: 0, y: 2)
                            .onTapGesture(perform: onToggleExpand)
                    }

                    PetdexBubbleCardView(
                        bubble: front,
                        showTail: true,
                        extraCount: bubbles.count > 1 ? bubbles.count - 1 : 0,
                        onDismiss: {
                            onDismiss(front)
                        }
                    )
                    .contentShape(Rectangle())
                    .onTapGesture {
                        if bubbles.count > 1 {
                            onToggleExpand()
                        }
                    }
                }
                .padding(.top, CGFloat(showAllSessions ? peekingLayers * 8 : 0))
            }
        }
        .padding(.horizontal, 10)
        .padding(.top, 6)
        .padding(.bottom, 10)
    }
}

final class PetdexBubblePanel: NSPanel {
    private var hostingView: NSHostingView<AnyView>?
    private weak var anchorWindow: NSWindow?
    private var moveObserver: NSObjectProtocol?
    private var resizeObserver: NSObjectProtocol?
    private var currentBubbles: [ActiveBubble] = []
    private var currentShowAllSessions = true
    private var bubblesEnabled = true
    private var isExpanded = false
    var onDismiss: ((ActiveBubble) -> Void)?

    init() {
        super.init(
            contentRect: NSRect(x: 0, y: 0, width: 240, height: 80),
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

    func update(bubbles: [ActiveBubble], showAllSessions: Bool, enabled: Bool, anchorVisible: Bool, forceRender: Bool = false) {
        if bubbles.count <= 1 {
            isExpanded = false
        }
        let unchanged = !forceRender
            && (bubbles == currentBubbles)
            && (showAllSessions == currentShowAllSessions)
            && (enabled == bubblesEnabled)
        currentBubbles = bubbles
        currentShowAllSessions = showAllSessions
        bubblesEnabled = enabled

        guard enabled, anchorVisible, !bubbles.isEmpty else {
            if let anchorWindow {
                anchorWindow.removeChildWindow(self)
            }
            orderOut(nil)
            return
        }

        if unchanged && isVisible {
            return
        }

        let stack = PetdexBubbleStackView(
            bubbles: bubbles,
            showAllSessions: showAllSessions,
            isExpanded: isExpanded,
            onToggleExpand: { [weak self] in
                guard let self else { return }
                self.isExpanded.toggle()
                self.update(
                    bubbles: self.currentBubbles,
                    showAllSessions: self.currentShowAllSessions,
                    enabled: self.bubblesEnabled,
                    anchorVisible: self.anchorWindow?.isVisible ?? true,
                    forceRender: true
                )
            },
            onDismiss: { [weak self] bubble in
                self?.onDismiss?(bubble)
            }
        )
        let wrapped = AnyView(stack)

        if let hostingView {
            hostingView.rootView = wrapped
        } else {
            let view = NSHostingView(rootView: wrapped)
            view.wantsLayer = true
            view.layer?.backgroundColor = NSColor.clear.cgColor
            contentView = view
            hostingView = view
        }

        hostingView?.layoutSubtreeIfNeeded()
        let fitting = hostingView?.fittingSize ?? NSSize(width: 240, height: 76)
        let size = NSSize(
            width: max(212, min(284, ceil(fitting.width))),
            height: max(60, min(360, ceil(fitting.height)))
        )
        setContentSize(size)
        reposition()
        if let anchorWindow, parent !== anchorWindow {
            anchorWindow.addChildWindow(self, ordered: .above)
        }
        orderFrontRegardless()
    }

    func reposition() {
        guard let anchorWindow, !currentBubbles.isEmpty, bubblesEnabled, anchorWindow.isVisible else {
            return
        }

        let petFrame = anchorWindow.frame
        let bubbleSize = frame.size
        var originX = round(petFrame.midX - bubbleSize.width * 0.5)
        var originY = round(petFrame.maxY + 8.0)

        if let screenFrame = (anchorWindow.screen ?? NSScreen.main)?.visibleFrame {
            originX = min(max(originX, screenFrame.minX + 8.0), screenFrame.maxX - bubbleSize.width - 8.0)
            originY = min(originY, screenFrame.maxY - bubbleSize.height - 8.0)
        }

        setFrameOrigin(NSPoint(x: originX, y: originY))
    }

    private func detachAnchorObservers() {
        if let moveObserver {
            NotificationCenter.default.removeObserver(moveObserver)
            self.moveObserver = nil
        }
        if let resizeObserver {
            NotificationCenter.default.removeObserver(resizeObserver)
            self.resizeObserver = nil
        }
    }
}
