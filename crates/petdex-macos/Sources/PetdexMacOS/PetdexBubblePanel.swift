import AppKit
import SwiftUI

private struct PetdexBubbleCardView: View {
    let bubble: ActiveBubble
    let onDismiss: () -> Void

    private let pearlFill = Color(red: 0.97, green: 0.98, blue: 1.0)
    private let navyInk = Color(red: 0.09, green: 0.16, blue: 0.34)
    private let navyMuted = Color(red: 0.25, green: 0.34, blue: 0.54)
    private let navyBorder = Color(red: 0.13, green: 0.24, blue: 0.50)

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 6) {
                Circle()
                    .fill(bubble.statusColor)
                    .frame(width: 8, height: 8)
                    .shadow(color: bubble.statusColor.opacity(0.45), radius: 2, x: 0, y: 0)

                Text(bubble.agentDisplayName)
                    .font(.system(size: 10.5, weight: .semibold, design: .rounded))
                    .foregroundColor(navyInk)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .background(
                        Capsule()
                            .fill(navyBorder.opacity(0.09))
                    )

                Spacer(minLength: 4)

                Button(action: onDismiss) {
                    Image(systemName: "xmark")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundColor(navyMuted)
                        .frame(width: 18, height: 18)
                        .background(
                            Circle()
                                .fill(navyBorder.opacity(0.08))
                        )
                }
                .buttonStyle(.plain)
                .help("Dismiss bubble")
            }

            Text(bubble.summary.isEmpty ? bubble.statusDisplayName : bubble.summary)
                .font(.system(size: 12, weight: .medium, design: .rounded))
                .foregroundColor(navyInk)
                .lineLimit(3)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .frame(minWidth: 196, maxWidth: 268, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(pearlFill.opacity(0.97))
                .overlay(
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .strokeBorder(navyBorder.opacity(0.24), lineWidth: 1.5)
                )
                .shadow(color: navyBorder.opacity(0.18), radius: 8, x: 0, y: 4)
        )
        .padding(8)
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
