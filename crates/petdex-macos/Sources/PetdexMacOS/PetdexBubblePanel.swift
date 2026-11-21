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

private struct PetdexBubbleCardView: View {
    let bubble: ActiveBubble
    let onDismiss: () -> Void

    private let cobaltTop = Color(red: 0.345, green: 0.463, blue: 1.0)
    private let cobaltMid = Color(red: 0.231, green: 0.349, blue: 0.949)
    private let cobaltBottom = Color(red: 0.137, green: 0.220, blue: 0.675)
    private let lipNavy = Color(red: 0.075, green: 0.125, blue: 0.420)
    private let deepShadow = Color(red: 0.043, green: 0.075, blue: 0.227)
    private let voltYellow = Color(red: 1.0, green: 0.886, blue: 0.349)
    private let navyInk = Color(red: 0.063, green: 0.098, blue: 0.267)

    private var isNeedsInput: Bool {
        bubble.status.lowercased() == "needs_input"
    }

    var body: some View {
        VStack(spacing: 0) {
            ZStack {
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .fill(lipNavy)
                    .offset(y: 4)
                    .shadow(color: deepShadow.opacity(0.38), radius: 10, x: 0, y: 7)

                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 6) {
                        Circle()
                            .fill(bubble.statusColor)
                            .frame(width: 8, height: 8)
                            .overlay(
                                Circle()
                                    .stroke(Color.white.opacity(0.65), lineWidth: 1)
                            )
                            .shadow(color: bubble.statusColor.opacity(0.75), radius: 3, x: 0, y: 0)

                        Text(bubble.agentDisplayName.uppercased())
                            .font(.system(size: 9.5, weight: .bold, design: .monospaced))
                            .tracking(0.6)
                            .foregroundColor(isNeedsInput ? navyInk : Color.white)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 2.5)
                            .background(
                                Capsule()
                                    .fill(isNeedsInput ? voltYellow : Color.white.opacity(0.18))
                            )

                        Spacer(minLength: 4)

                        Button(action: onDismiss) {
                            Image(systemName: "xmark")
                                .font(.system(size: 8.5, weight: .heavy))
                                .foregroundColor(Color.white.opacity(0.88))
                                .frame(width: 19, height: 19)
                                .background(
                                    Circle()
                                        .fill(Color.white.opacity(0.16))
                                        .overlay(
                                            Circle()
                                                .stroke(Color.white.opacity(0.24), lineWidth: 0.8)
                                        )
                                )
                        }
                        .buttonStyle(.plain)
                        .help("Dismiss bubble")
                    }

                    Text(bubble.summary.isEmpty ? bubble.statusDisplayName : bubble.summary)
                        .font(.system(size: 12.5, weight: .semibold, design: .rounded))
                        .foregroundColor(.white)
                        .shadow(color: deepShadow.opacity(0.35), radius: 1, x: 0, y: 1)
                        .lineLimit(3)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .frame(minWidth: 204, maxWidth: 276, alignment: .leading)
                .background(
                    ZStack {
                        RoundedRectangle(cornerRadius: 20, style: .continuous)
                            .fill(
                                LinearGradient(
                                    colors: [cobaltTop, cobaltMid, cobaltBottom],
                                    startPoint: .top,
                                    endPoint: .bottom
                                )
                            )

                        RoundedRectangle(cornerRadius: 20, style: .continuous)
                            .fill(
                                RadialGradient(
                                    colors: [
                                        Color.white.opacity(0.30),
                                        Color.white.opacity(0.06),
                                        Color.clear,
                                    ],
                                    center: UnitPoint(x: 0.5, y: 0.0),
                                    startRadius: 4,
                                    endRadius: 96
                                )
                            )

                        RoundedRectangle(cornerRadius: 20, style: .continuous)
                            .strokeBorder(
                                LinearGradient(
                                    colors: [
                                        Color.white.opacity(0.62),
                                        Color.white.opacity(0.16),
                                        lipNavy.opacity(0.55),
                                    ],
                                    startPoint: .top,
                                    endPoint: .bottom
                                ),
                                lineWidth: 1.4
                            )
                    }
                )
            }

            ZStack {
                BubbleTailShape()
                    .fill(lipNavy)
                    .frame(width: 16, height: 9)
                    .offset(y: 3)

                BubbleTailShape()
                    .fill(cobaltBottom)
                    .frame(width: 16, height: 9)
            }
            .offset(y: -1)
        }
        .padding(.horizontal, 10)
        .padding(.top, 8)
        .padding(.bottom, 12)
    }
}

final class PetdexBubblePanel: NSPanel {
    private var hostingView: NSHostingView<AnyView>?
    private weak var anchorWindow: NSWindow?
    private var moveObserver: NSObjectProtocol?
    private var resizeObserver: NSObjectProtocol?
    private var currentBubble: ActiveBubble?
    private var bubblesEnabled = true
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

        moveObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.didMoveNotification,
            object: window,
            queue: .main
        ) { [weak self] _ in
            self?.reposition()
        }

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

    func update(bubble: ActiveBubble?, enabled: Bool, anchorVisible: Bool) {
        currentBubble = bubble
        bubblesEnabled = enabled

        guard enabled, anchorVisible, let bubble else {
            orderOut(nil)
            return
        }

        let card = PetdexBubbleCardView(bubble: bubble) { [weak self] in
            self?.onDismiss?(bubble)
        }
        let wrapped = AnyView(card)

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
            height: max(60, ceil(fitting.height))
        )
        setContentSize(size)
        reposition()
        orderFrontRegardless()
    }

    func reposition() {
        guard let anchorWindow, currentBubble != nil, bubblesEnabled, anchorWindow.isVisible else {
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
