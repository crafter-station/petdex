import AppKit
import CPetdexCore
import CoreGraphics
import Foundation
import QuartzCore
import SwiftUI

enum PetdexStateCatalog {
    static let allStates: [(UInt8, String)] = [
        (UInt8(PETDEX_STATE_IDLE.rawValue), "Idle"),
        (UInt8(PETDEX_STATE_RUNNING_RIGHT.rawValue), "Running Right"),
        (UInt8(PETDEX_STATE_RUNNING_LEFT.rawValue), "Running Left"),
        (UInt8(PETDEX_STATE_WAVING.rawValue), "Waving"),
        (UInt8(PETDEX_STATE_JUMPING.rawValue), "Jumping"),
        (UInt8(PETDEX_STATE_FAILED.rawValue), "Failed"),
        (UInt8(PETDEX_STATE_WAITING.rawValue), "Waiting"),
        (UInt8(PETDEX_STATE_RUNNING.rawValue), "Running"),
        (UInt8(PETDEX_STATE_REVIEW.rawValue), "Review"),
    ]

    static func name(for state: UInt8) -> String {
        allStates.first(where: { $0.0 == state })?.1 ?? "Unknown"
    }
}

final class PetdexFloatingPanel: NSPanel {
    init(contentRect: NSRect) {
        super.init(
            contentRect: contentRect,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        level = .statusBar
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        isMovableByWindowBackground = false
        hidesOnDeactivate = false
        ignoresMouseEvents = false
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    func setAlwaysOnTop(_ enabled: Bool) {
        level = enabled ? .statusBar : .normal
    }
}

final class PetdexSpriteCanvasView: NSView {
    private var engine: OpaquePointer?
    private var tickTimer: Timer?
    private var spriteAtlas: PetSpriteAtlas?
    private let physics = PetdexPhysicsController()
    private var dragPointerOffset: NSPoint?
    private var preDragState: UInt8?
    private var lastFrame = PetdexFrame(state: 0, row: 0, col: 0, frame_index: 0, frame_dur_ms: 0)
    private var bubblePollAccumulatorMs: UInt32 = 0
    private var lastBubbles: [ActiveBubble] = []
    private(set) var hookServerPort: UInt16 = 0
    private(set) var activePet: InstalledPet?
    var contextMenuProvider: (() -> NSMenu)?
    var onStateChanged: ((UInt8) -> Void)?
    var onPetChanged: ((InstalledPet?) -> Void)?
    var onBubblesChanged: (([ActiveBubble]) -> Void)?
    var onPhysicsSettled: ((NSPoint) -> Void)?

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layerContentsRedrawPolicy = .onSetNeedsDisplay
        configureBackingLayer()
        engine = petdex_engine_new()
        if let engine {
            lastFrame = petdex_engine_tick_ms(engine, 0)
        }
        startTickLoop()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    deinit {
        tickTimer?.invalidate()
        if let engine {
            petdex_engine_stop_hook_server(engine)
            petdex_engine_free(engine)
        }
    }

    override var isOpaque: Bool { false }
    override var mouseDownCanMoveWindow: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func mouseDown(with event: NSEvent) {
        if event.modifierFlags.contains(.control) {
            super.mouseDown(with: event)
            return
        }
        guard let window else { return }
        let pointerScreen = NSEvent.mouseLocation
        let origin = window.frame.origin
        dragPointerOffset = NSPoint(x: pointerScreen.x - origin.x, y: pointerScreen.y - origin.y)
        if preDragState == nil {
            preDragState = lastFrame.state
        }
        physics.beginDrag(at: origin)
    }

    override func mouseDragged(with event: NSEvent) {
        guard let window, let offset = dragPointerOffset else { return }
        let pointerScreen = NSEvent.mouseLocation
        let newOrigin = NSPoint(x: pointerScreen.x - offset.x, y: pointerScreen.y - offset.y)
        window.setFrameOrigin(newOrigin)
        if let suggested = physics.updateDrag(to: newOrigin) {
            setState(suggested)
        }
    }

    override func mouseUp(with event: NSEvent) {
        guard let window, dragPointerOffset != nil else { return }
        dragPointerOffset = nil
        let isThrowing = physics.endDrag(at: window.frame.origin)
        if !isThrowing {
            if let saved = preDragState {
                preDragState = nil
                setState(saved)
            }
            onPhysicsSettled?(window.frame.origin)
        }
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        updateLayerScale()
    }

    override func viewDidChangeBackingProperties() {
        super.viewDidChangeBackingProperties()
        updateLayerScale()
    }

    override func menu(for event: NSEvent) -> NSMenu? {
        contextMenuProvider?()
    }

    private func configureBackingLayer() {
        guard let layer else { return }
        layer.isOpaque = false
        layer.backgroundColor = NSColor.clear.cgColor
        layer.magnificationFilter = .nearest
        layer.minificationFilter = .nearest
        updateLayerScale()
    }

    private func updateLayerScale() {
        let scale = window?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? 2.0
        layer?.contentsScale = scale
        needsDisplay = true
    }

    @discardableResult
    func selectPet(_ pet: InstalledPet?) -> Bool {
        guard let pet else {
            activePet = nil
            spriteAtlas = nil
            onPetChanged?(nil)
            needsDisplay = true
            return true
        }

        if let atlas = PetSpriteAtlas(pet: pet) {
            activePet = pet
            spriteAtlas = atlas
            onPetChanged?(pet)
            needsDisplay = true
            NSLog("PetdexMacOS loaded pet %@ (%dx%d per frame)", pet.id, atlas.frameWidth, atlas.frameHeight)
            return true
        }

        NSLog("PetdexMacOS failed to decode spritesheet at %@, using fallback renderer", pet.spritesheetURL.path)
        activePet = nil
        spriteAtlas = nil
        onPetChanged?(nil)
        needsDisplay = true
        return false
    }

    @discardableResult
    func startHookServer(port: UInt16, token: String) -> UInt16 {
        guard let engine else { return 0 }
        let boundPort = token.withCString { tokenPtr in
            petdex_engine_start_hook_server(engine, port, tokenPtr, token.utf8.count)
        }
        hookServerPort = boundPort
        return boundPort
    }

    func setState(_ state: UInt8) {
        guard let engine else { return }
        if petdex_engine_set_state(engine, state) {
            lastFrame = petdex_engine_tick_ms(engine, 0)
            onStateChanged?(lastFrame.state)
            needsDisplay = true
        }
    }

    func cycleState() {
        let count = UInt8(PetdexStateCatalog.allStates.count)
        let next = (lastFrame.state + 1) % count
        setState(next)
    }

    func ingestStatus(sessionId: String, agent: UInt8, status: UInt8, summary: String) {
        guard let engine else { return }
        let nowMs = UInt64(Date().timeIntervalSince1970 * 1000.0)
        sessionId.withCString { sidPtr in
            summary.withCString { sumPtr in
                _ = petdex_engine_ingest_status(engine, sidPtr, agent, status, sumPtr, nowMs)
            }
        }
        pollActiveBubbles()
    }

    func dismissBubble(_ bubble: ActiveBubble) {
        guard let engine else { return }
        _ = bubble.sessionId.withCString { sidPtr in
            petdex_engine_dismiss_session(engine, sidPtr)
        }
        pollActiveBubbles()
    }

    func reconcileLocalSessions() {
        guard let engine else { return }
        let nowMs = UInt64(Date().timeIntervalSince1970 * 1000.0)
        _ = petdex_engine_reconcile_local(engine, nowMs)
        pollActiveBubbles()
    }

    func pollActiveBubbles() {
        guard let engine else { return }
        let nowMs = UInt64(Date().timeIntervalSince1970 * 1000.0)
        var buffer = [UInt8](repeating: 0, count: 8192)
        let written = buffer.withUnsafeMutableBufferPointer { ptr -> Int in
            guard let base = ptr.baseAddress else { return 0 }
            return petdex_engine_active_bubbles_json(engine, nowMs, base, ptr.count)
        }

        let decoded: [ActiveBubble]
        if written > 0 {
            let data = Data(buffer[0..<written])
            decoded = (try? JSONDecoder().decode([ActiveBubble].self, from: data)) ?? []
        } else {
            decoded = []
        }

        if decoded != lastBubbles {
            lastBubbles = decoded
            onBubblesChanged?(decoded)
        }
    }

    func takeOAuthCallback() -> PetdexOAuthCallbackPayload? {
        guard let engine else { return nil }
        var buffer = [UInt8](repeating: 0, count: 4096)
        let written = buffer.withUnsafeMutableBufferPointer { ptr -> Int in
            guard let base = ptr.baseAddress else { return 0 }
            return petdex_engine_take_oauth_callback_json(engine, base, ptr.count)
        }
        guard written > 0 else { return nil }
        let data = Data(buffer[0..<written])
        return try? JSONDecoder().decode(PetdexOAuthCallbackPayload.self, from: data)
    }

    private func startTickLoop() {
        let timer = Timer(timeInterval: 1.0 / 60.0, repeats: true) { [weak self] _ in
            self?.stepFrame(dtMs: 16)
        }
        RunLoop.main.add(timer, forMode: .common)
        tickTimer = timer
    }

    private func stepFrame(dtMs: UInt32) {
        guard let engine else { return }
        if physics.isThrowing, let window {
            let dt = Double(dtMs) / 1000.0
            let screenBounds = window.screen?.visibleFrame
                ?? NSScreen.main?.visibleFrame
                ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
            let result = physics.step(dt: dt, currentFrame: window.frame, screenBounds: screenBounds)
            window.setFrameOrigin(result.newOrigin)
            if let suggested = result.suggestedState, suggested != lastFrame.state {
                setState(suggested)
            }
            if result.finished {
                if let saved = preDragState {
                    preDragState = nil
                    setState(saved)
                }
                onPhysicsSettled?(window.frame.origin)
            }
        }

        let previous = lastFrame
        let next = petdex_engine_tick_ms(engine, dtMs)
        lastFrame = next

        if next.state != previous.state {
            onStateChanged?(next.state)
        }

        if next.row != previous.row || next.col != previous.col || next.state != previous.state || next.frame_index != previous.frame_index {
            needsDisplay = true
        }

        bubblePollAccumulatorMs += dtMs
        if bubblePollAccumulatorMs >= 150 {
            bubblePollAccumulatorMs = 0
            pollActiveBubbles()
        }
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let context = NSGraphicsContext.current?.cgContext else { return }
        context.clear(bounds)

        if let atlas = spriteAtlas,
           let frameImage = atlas.frameImage(row: lastFrame.row, col: lastFrame.col)
        {
            context.saveGState()
            context.interpolationQuality = .none
            context.setShouldAntialias(false)
            let drawRect = aspectFitRect(
                imageSize: CGSize(width: frameImage.width, height: frameImage.height),
                in: bounds
            )
            context.draw(frameImage, in: drawRect)
            context.restoreGState()
            return
        }

        drawCobaltSquircleFallback(in: context)
    }

    private func aspectFitRect(imageSize: CGSize, in container: CGRect) -> CGRect {
        guard imageSize.width > 0, imageSize.height > 0 else {
            return container
        }
        let scale = min(container.width / imageSize.width, container.height / imageSize.height)
        let width = floor(imageSize.width * scale)
        let height = floor(imageSize.height * scale)
        let x = floor(container.midX - width * 0.5)
        let y = floor(container.midY - height * 0.5)
        return CGRect(x: x, y: y, width: width, height: height)
    }

    private func drawCobaltSquircleFallback(in context: CGContext) {
        context.saveGState()
        context.setAllowsAntialiasing(true)
        context.setShouldAntialias(true)

        let phase = Int(lastFrame.frame_index % 8)
        let bobOffset: CGFloat = (phase == 2 || phase == 3 || phase == 6) ? 3.0 : 0.0
        let bodySize = min(bounds.width, bounds.height) * 0.68
        let bodyRect = CGRect(
            x: bounds.midX - bodySize * 0.5,
            y: bounds.midY - bodySize * 0.5 + bobOffset,
            width: bodySize,
            height: bodySize
        )
        let cornerRadius = bodySize * 0.28

        let shadowRect = CGRect(
            x: bodyRect.minX + bodySize * 0.14,
            y: bounds.midY - bodySize * 0.5 - 6.0,
            width: bodySize * 0.72,
            height: 10.0
        )
        context.setFillColor(NSColor(calibratedRed: 0.05, green: 0.12, blue: 0.30, alpha: 0.28).cgColor)
        context.fillEllipse(in: shadowRect)

        let bodyPath = CGPath(
            roundedRect: bodyRect,
            cornerWidth: cornerRadius,
            cornerHeight: cornerRadius,
            transform: nil
        )

        context.saveGState()
        context.addPath(bodyPath)
        context.clip()

        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let isFailed = lastFrame.state == UInt8(PETDEX_STATE_FAILED.rawValue)
        let topColor = isFailed
            ? CGColor(red: 0.86, green: 0.26, blue: 0.32, alpha: 1.0)
            : CGColor(red: 0.23, green: 0.51, blue: 0.98, alpha: 1.0)
        let bottomColor = isFailed
            ? CGColor(red: 0.62, green: 0.12, blue: 0.18, alpha: 1.0)
            : CGColor(red: 0.11, green: 0.31, blue: 0.82, alpha: 1.0)
        if let gradient = CGGradient(
            colorsSpace: colorSpace,
            colors: [bottomColor, topColor] as CFArray,
            locations: [0.0, 1.0]
        ) {
            context.drawLinearGradient(
                gradient,
                start: CGPoint(x: bodyRect.midX, y: bodyRect.minY),
                end: CGPoint(x: bodyRect.midX, y: bodyRect.maxY),
                options: []
            )
        }

        let highlightRect = CGRect(
            x: bodyRect.minX + 6,
            y: bodyRect.maxY - bodySize * 0.36,
            width: bodyRect.width - 12,
            height: bodySize * 0.30
        )
        let highlightPath = CGPath(
            roundedRect: highlightRect,
            cornerWidth: cornerRadius * 0.65,
            cornerHeight: cornerRadius * 0.65,
            transform: nil
        )
        context.addPath(highlightPath)
        context.setFillColor(CGColor(red: 1.0, green: 1.0, blue: 1.0, alpha: 0.14))
        context.fillPath()
        context.restoreGState()

        context.addPath(bodyPath)
        context.setStrokeColor(CGColor(red: 0.07, green: 0.19, blue: 0.54, alpha: 0.92))
        context.setLineWidth(2.5)
        context.strokePath()

        let innerRimRect = bodyRect.insetBy(dx: 2.5, dy: 2.5)
        let innerRimPath = CGPath(
            roundedRect: innerRimRect,
            cornerWidth: max(4, cornerRadius - 2.5),
            cornerHeight: max(4, cornerRadius - 2.5),
            transform: nil
        )
        context.addPath(innerRimPath)
        context.setStrokeColor(CGColor(red: 0.72, green: 0.86, blue: 1.0, alpha: 0.45))
        context.setLineWidth(1.25)
        context.strokePath()

        let blink = phase == 7
        let eyeWidth: CGFloat = 10.0
        let eyeHeight: CGFloat = blink ? 2.5 : 14.0
        let eyeY = bodyRect.midY + 4.0 - eyeHeight * 0.5
        let leftEyeRect = CGRect(x: bodyRect.midX - 20.0, y: eyeY, width: eyeWidth, height: eyeHeight)
        let rightEyeRect = CGRect(x: bodyRect.midX + 10.0, y: eyeY, width: eyeWidth, height: eyeHeight)

        context.setFillColor(CGColor(red: 0.96, green: 0.98, blue: 1.0, alpha: 0.96))
        context.addPath(CGPath(roundedRect: leftEyeRect, cornerWidth: 3.0, cornerHeight: 3.0, transform: nil))
        context.addPath(CGPath(roundedRect: rightEyeRect, cornerWidth: 3.0, cornerHeight: 3.0, transform: nil))
        context.fillPath()

        if !blink {
            context.setFillColor(CGColor(red: 0.08, green: 0.16, blue: 0.36, alpha: 1.0))
            context.fill(CGRect(x: leftEyeRect.midX - 2.0, y: leftEyeRect.midY - 3.0, width: 4.0, height: 6.0))
            context.fill(CGRect(x: rightEyeRect.midX - 2.0, y: rightEyeRect.midY - 3.0, width: 4.0, height: 6.0))
        }

        context.restoreGState()
    }

    var currentFrame: PetdexFrame {
        lastFrame
    }
}

final class PetdexAppDelegate: NSObject, NSApplicationDelegate {
    private let basePanelSize = NSSize(width: 220, height: 238)
    private let settingsStore = PetdexSettingsStore()
    private let chimePlayer = PetdexChimePlayer()
    private let clerkAuth = PetdexClerkAuthClient.shared
    private var panel: PetdexFloatingPanel?
    private var canvasView: PetdexSpriteCanvasView?
    private var bubblePanel: PetdexBubblePanel?
    private var settingsWindow: NSWindow?
    private var onboardingWindow: NSWindow?
    private var panelMoveObserver: NSObjectProtocol?
    private var reconcileTimer: Timer?
    private var rotatePetsTimer: Timer?
    private var oauthFlowTask: Task<Void, Never>?
    private var accountSyncTask: Task<Void, Never>?
    private var statusItem: NSStatusItem?
    private var petMenuItem: NSMenuItem?
    private var stateMenuItem: NSMenuItem?
    private var hookMenuItem: NSMenuItem?
    private var statusPetsSubmenuItem: NSMenuItem?
    private var focusModeMenuItem: NSMenuItem?
    private var lastObservedState: UInt8 = UInt8(PETDEX_STATE_IDLE.rawValue)
    private var installedPets: [InstalledPet] = []
    private var pendingOpenSlugs: [String] = []

    deinit {
        reconcileTimer?.invalidate()
        rotatePetsTimer?.invalidate()
        oauthFlowTask?.cancel()
        accountSyncTask?.cancel()
        if let panelMoveObserver {
            NotificationCenter.default.removeObserver(panelMoveObserver)
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(settingsStore.hideDockIcon ? .accessory : .regular)

        let scale = settingsStore.scale
        let panelSize = scaledPanelSize(for: scale)
        let origin = resolvedInitialOrigin(for: panelSize)
        let frame = NSRect(origin: origin, size: panelSize)

        let panel = PetdexFloatingPanel(contentRect: frame)
        panel.setAlwaysOnTop(settingsStore.alwaysOnTop)

        let canvas = PetdexSpriteCanvasView(frame: NSRect(origin: .zero, size: frame.size))
        canvas.autoresizingMask = [.width, .height]
        canvas.contextMenuProvider = { [weak self] in
            self?.buildPanelContextMenu() ?? NSMenu()
        }
        canvas.onStateChanged = { [weak self] state in
            guard let self else { return }
            let previous = self.lastObservedState
            self.lastObservedState = state
            self.settingsStore.currentState = state
            self.updateStatusLabels(state: state)
            let waitingState = UInt8(PETDEX_STATE_WAITING.rawValue)
            if state == waitingState
                && previous != waitingState
                && self.settingsStore.waitingSoundEnabled
                && !self.settingsStore.focusMode
            {
                self.chimePlayer.playWaitingChime(petDirectory: self.canvasView?.activePet?.directoryURL)
            }
        }
        canvas.onPetChanged = { [weak self] pet in
            self?.settingsStore.activePetId = pet?.id
            self?.refreshPetMenuState()
        }
        canvas.onBubblesChanged = { [weak self] bubbles in
            self?.settingsStore.activeBubbles = bubbles
            self?.syncBubblePanel()
        }
        canvas.onPhysicsSettled = { [weak self] settledOrigin in
            self?.settingsStore.updatePanelOrigin(settledOrigin)
        }

        panel.contentView = canvas
        panel.orderFrontRegardless()

        panelMoveObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.didMoveNotification,
            object: panel,
            queue: .main
        ) { [weak self] _ in
            guard let self, let panel = self.panel else { return }
            self.settingsStore.updatePanelOrigin(panel.frame.origin)
        }

        let bubblePanel = PetdexBubblePanel()
        bubblePanel.setAlwaysOnTop(settingsStore.alwaysOnTop)
        bubblePanel.attach(to: panel)
        bubblePanel.onSelectBubble = { [weak self] bubble in
            self?.focusCodingApplication(for: bubble)
        }
        bubblePanel.onDismiss = { [weak self] bubble in
            self?.canvasView?.dismissBubble(bubble)
        }

        if let versionPtr = petdex_core_version() {
            let version = String(cString: versionPtr)
            NSLog("PetdexMacOS booted with petdex-core %@", version)
        }

        installedPets = PetCatalog.discoverPets()
        let initialPet = resolveBootPet(from: installedPets)
        if let initialPet, !installedPets.contains(initialPet) {
            installedPets.insert(initialPet, at: 0)
        }
        settingsStore.installedPets = installedPets
        canvas.selectPet(initialPet)

        let env = ProcessInfo.processInfo.environment
        let requestedPort = env["PETDEX_HOOK_PORT"].flatMap(UInt16.init) ?? 7777
        let token = env["PETDEX_UPDATE_TOKEN"] ?? UUID().uuidString
        let boundPort = canvas.startHookServer(port: requestedPort, token: token)
        settingsStore.hookServerPort = boundPort
        settingsStore.hookToken = token
        let tokenPersisted = token.withCString { tokenPtr in
            petdex_write_runtime_token(tokenPtr)
        }
        if !tokenPersisted {
            NSLog("PetdexMacOS failed to persist runtime update token")
        }
        if boundPort > 0 {
            NSLog("PetdexMacOS hook server listening on 127.0.0.1:%u", boundPort)
        } else {
            NSLog("PetdexMacOS failed to bind hook server on port %u", requestedPort)
        }

        canvas.ingestStatus(
            sessionId: "macos-bootstrap",
            agent: UInt8(PETDEX_AGENT_CLAUDE_CODE.rawValue),
            status: UInt8(PETDEX_STATUS_IDLE.rawValue),
            summary: ""
        )

        self.panel = panel
        self.canvasView = canvas
        self.bubblePanel = bubblePanel
        lastObservedState = canvas.currentFrame.state
        settingsStore.currentState = canvas.currentFrame.state
        configureStatusItem(boundPort: boundPort)
        updateStatusLabels(state: canvas.currentFrame.state)
        refreshPetMenuState()
        reloadRemoteHosts()
        syncBubblePanel()

        if settingsStore.autoCheckUpdates {
            checkForUpdates()
        }

        restoreAccountSessionOnLaunch()

        let reconcile = Timer(timeInterval: 10.0, repeats: true) { [weak self] _ in
            self?.canvasView?.reconcileLocalSessions()
        }
        RunLoop.main.add(reconcile, forMode: .common)
        reconcileTimer = reconcile

        let rotate = Timer(timeInterval: 15.0 * 60.0, repeats: true) { [weak self] _ in
            guard let self else { return }
            if self.settingsStore.rotatePets && self.installedPets.count > 1 {
                self.shufflePet()
            }
        }
        RunLoop.main.add(rotate, forMode: .common)
        rotatePetsTimer = rotate

        if !pendingOpenSlugs.isEmpty {
            let queued = pendingOpenSlugs
            pendingOpenSlugs.removeAll()
            for slug in queued {
                handleOpenPetSlug(slug)
            }
        }

        if !settingsStore.onboardingCompleted || env["PETDEX_SHOW_ONBOARDING"] == "1" {
            DispatchQueue.main.async { [weak self] in
                self?.showOnboardingWindow()
            }
        }
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls {
            guard let slug = Self.extractPetSlug(from: url) else { continue }
            if canvasView == nil {
                pendingOpenSlugs.append(slug)
            } else {
                handleOpenPetSlug(slug)
            }
        }
    }

    private static func extractPetSlug(from url: URL) -> String? {
        guard url.scheme?.lowercased() == "petdex" else { return nil }

        let host = url.host?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
        if host == "install" {
            if let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
               let querySlug = components.queryItems?.first(where: { $0.name == "slug" })?.value?
                   .trimmingCharacters(in: .whitespacesAndNewlines)
                   .lowercased(),
               !querySlug.isEmpty
            {
                return querySlug
            }
            let pathSlug = url.pathComponents
                .first(where: { $0 != "/" && !$0.isEmpty })?
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .lowercased()
            return (pathSlug?.isEmpty == false) ? pathSlug : nil
        }

        if !host.isEmpty {
            return host
        }

        let pathSlug = url.pathComponents
            .first(where: { $0 != "/" && !$0.isEmpty })?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        return (pathSlug?.isEmpty == false) ? pathSlug : nil
    }

    private func handleOpenPetSlug(_ rawSlug: String) {
        let slug = rawSlug.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !slug.isEmpty else { return }

        installedPets = PetCatalog.discoverPets()
        settingsStore.installedPets = installedPets

        if let existing = installedPets.first(where: { $0.id.caseInsensitiveCompare(slug) == .orderedSame }) {
            canvasView?.selectPet(existing)
            panel?.orderFrontRegardless()
            refreshPetMenuState()
            NSLog("PetdexMacOS selected already-installed pet %@ via URL scheme", existing.id)
            return
        }

        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let installed = try await PetdexCatalogClient.shared.installPet(slug: slug)
                self.registerAndActivateInstalledPet(installed)
                self.panel?.orderFrontRegardless()
                NSLog("PetdexMacOS installed and activated pet %@ via URL scheme", installed.id)
            } catch {
                NSLog("PetdexMacOS failed to install pet %@ via URL scheme: %@", slug, error.localizedDescription)
            }
        }
    }

    private func registerAndActivateInstalledPet(_ pet: InstalledPet) {
        installedPets = PetCatalog.discoverPets()
        if !installedPets.contains(where: { $0.id.caseInsensitiveCompare(pet.id) == .orderedSame }) {
            installedPets.insert(pet, at: 0)
        }
        settingsStore.installedPets = installedPets
        canvasView?.selectPet(pet)
        refreshPetMenuState()
    }

    private func scaledPanelSize(for scale: Double) -> NSSize {
        let clamped = PetdexSettingsStore.clampScale(scale)
        return NSSize(
            width: round(basePanelSize.width * clamped),
            height: round(basePanelSize.height * clamped)
        )
    }

    private func resolvedInitialOrigin(for panelSize: NSSize) -> NSPoint {
        let fallbackScreen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        if let savedX = settingsStore.panelX, let savedY = settingsStore.panelY {
            let candidate = NSRect(origin: NSPoint(x: savedX, y: savedY), size: panelSize)
            let onAnyScreen = NSScreen.screens.contains { screen in
                screen.visibleFrame.intersects(candidate)
            }
            if onAnyScreen {
                return candidate.origin
            }
        }
        return NSPoint(
            x: fallbackScreen.maxX - panelSize.width - 48,
            y: fallbackScreen.minY + 48
        )
    }

    private func resolveBootPet(from pets: [InstalledPet]) -> InstalledPet? {
        let env = ProcessInfo.processInfo.environment
        if let requested = env["PETDEX_PET"]?.trimmingCharacters(in: .whitespacesAndNewlines),
           !requested.isEmpty
        {
            return PetCatalog.resolveInitialPet(from: pets, environment: env)
        }

        if let savedId = settingsStore.activePetId,
           let savedPet = pets.first(where: { $0.id.caseInsensitiveCompare(savedId) == .orderedSame })
        {
            return savedPet
        }

        return PetCatalog.resolveInitialPet(from: pets, environment: env)
    }

    private func applyScale(_ scale: Double) {
        guard let panel else { return }
        let oldFrame = panel.frame
        let nextSize = scaledPanelSize(for: scale)
        let nextOrigin = NSPoint(
            x: round(oldFrame.midX - nextSize.width * 0.5),
            y: oldFrame.minY
        )
        panel.setFrame(NSRect(origin: nextOrigin, size: nextSize), display: true)
        canvasView?.frame = NSRect(origin: .zero, size: panel.contentLayoutRect.size)
        canvasView?.needsDisplay = true
        settingsStore.updatePanelOrigin(panel.frame.origin)
        bubblePanel?.reposition()
    }

    private func applyAlwaysOnTop(_ enabled: Bool) {
        panel?.setAlwaysOnTop(enabled)
        bubblePanel?.setAlwaysOnTop(enabled)
    }

    private func syncBubblePanel() {
        bubblePanel?.update(
            bubbles: settingsStore.activeBubbles,
            showAllSessions: settingsStore.showAllSessions,
            enabled: settingsStore.bubblesEnabled && !settingsStore.focusMode,
            anchorVisible: panel?.isVisible ?? false,
            textSize: settingsStore.bubbleTextSize,
            maxLines: settingsStore.bubbleMaxLines
        )
        focusModeMenuItem?.state = settingsStore.focusMode ? .on : .off
    }

    private func reloadRemoteHosts() {
        let loaded = PetdexRemoteAgentsLoader.load()
        settingsStore.remoteHosts = loaded.map { r in
            "\(r.name) (\(r.host)) · \(r.enabledAgents.joined(separator: ", "))"
        }
    }

    private func shufflePet() {
        guard installedPets.count > 1 else { return }
        let activeId = canvasView?.activePet?.id
        let candidates = installedPets.filter { $0.id != activeId }
        guard let next = candidates.randomElement() else { return }
        canvasView?.selectPet(next)
    }

    private func checkForUpdates() {
        settingsStore.updateStatusText = "Checking for updates..."
        settingsStore.updateDownloadURL = nil
        Task { @MainActor [weak self] in
            guard let self else { return }
            let status = await PetdexUpdateChecker.checkLatestRelease()
            switch status {
            case .idle:
                self.settingsStore.updateStatusText = "Not checked yet"
                self.settingsStore.updateDownloadURL = nil
            case .checking:
                self.settingsStore.updateStatusText = "Checking for updates..."
                self.settingsStore.updateDownloadURL = nil
            case let .upToDate(version):
                self.settingsStore.updateStatusText = "Up to date (v\(version))"
                self.settingsStore.updateDownloadURL = nil
            case let .available(version, downloadURL):
                self.settingsStore.updateStatusText = "Update available: v\(version)"
                self.settingsStore.updateDownloadURL = downloadURL
            case let .failed(message):
                self.settingsStore.updateStatusText = "Update check failed: \(message)"
                self.settingsStore.updateDownloadURL = nil
            }
        }
    }

    private func openRemoteConfig() {
        let configURL = PetdexRemoteAgentsLoader.configURL
        let petdexDir = configURL.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: petdexDir, withIntermediateDirectories: true)
        if FileManager.default.fileExists(atPath: configURL.path) {
            NSWorkspace.shared.open(configURL)
        } else {
            NSWorkspace.shared.open(petdexDir)
        }
    }

    private func openSettingsWindow() {
        settingsStore.refreshDetectedAgents()
        reloadRemoteHosts()
        if settingsWindow == nil {
            let actions = PetdexSettingsActions(
                onSelectPet: { [weak self] pet in
                    self?.canvasView?.selectPet(pet)
                },
                onPetInstalled: { [weak self] pet in
                    self?.registerAndActivateInstalledPet(pet)
                },
                onReloadPets: { [weak self] in
                    self?.handleReloadPets()
                },
                onOpenPetsFolder: { [weak self] in
                    self?.openPetsFolder()
                },
                onBrowsePetdex: {
                    if let url = URL(string: "https://petdex.dev") {
                        NSWorkspace.shared.open(url)
                    }
                },
                onScaleChanged: { [weak self] scale in
                    self?.applyScale(scale)
                },
                onAlwaysOnTopChanged: { [weak self] enabled in
                    self?.applyAlwaysOnTop(enabled)
                },
                onBubblesEnabledChanged: { [weak self] _ in
                    self?.syncBubblePanel()
                },
                onShowAllSessionsChanged: { [weak self] _ in
                    self?.syncBubblePanel()
                },
                onSelectState: { [weak self] state in
                    self?.canvasView?.setState(state)
                },
                onSendTestBubble: { [weak self] in
                    self?.sendTestBubble()
                },
                onSendTestTwoSessions: { [weak self] in
                    self?.sendTestTwoSessions()
                },
                onRefreshAgents: { [weak self] in
                    self?.settingsStore.refreshDetectedAgents()
                    self?.reloadRemoteHosts()
                },
                onShufflePet: { [weak self] in
                    self?.shufflePet()
                },
                onHideDockChanged: { hide in
                    NSApp.setActivationPolicy(hide ? .accessory : .regular)
                },
                onFocusModeChanged: { [weak self] _ in
                    self?.syncBubblePanel()
                },
                onBubbleStyleChanged: { [weak self] in
                    self?.syncBubblePanel()
                },
                onCheckUpdates: { [weak self] in
                    self?.checkForUpdates()
                },
                onOpenRemoteConfig: { [weak self] in
                    self?.openRemoteConfig()
                },
                onSignIn: { [weak self] in
                    self?.handleSignIn()
                },
                onRefreshAccount: { [weak self] in
                    self?.handleRefreshAccount()
                },
                onSignOut: { [weak self] in
                    self?.handleSignOut()
                },
                onReplayOnboarding: { [weak self] in
                    self?.showOnboardingWindow()
                }
            )

            let rootView = PetdexSettingsView(store: settingsStore, actions: actions)
            let hostingController = NSHostingController(rootView: rootView)
            let window = NSWindow(contentViewController: hostingController)
            window.title = "Petdex Settings"
            window.styleMask = [.titled, .closable, .fullSizeContentView]
            window.titleVisibility = .hidden
            window.titlebarAppearsTransparent = true
            window.isMovableByWindowBackground = true
            window.standardWindowButton(.miniaturizeButton)?.isHidden = true
            window.standardWindowButton(.zoomButton)?.isHidden = true
            window.setContentSize(NSSize(width: 720, height: 520))
            window.isReleasedWhenClosed = false
            window.center()
            settingsWindow = window
        }

        NSApp.activate(ignoringOtherApps: true)
        settingsWindow?.makeKeyAndOrderFront(nil)
        settingsWindow?.orderFrontRegardless()
    }

    private func showOnboardingWindow() {
        settingsStore.refreshDetectedAgents()

        let actions = PetdexOnboardingActions(
            onSignIn: { [weak self] in
                self?.handleSignIn()
            },
            onSelectPet: { [weak self] pet in
                self?.canvasView?.selectPet(pet)
            },
            onPetInstalled: { [weak self] pet in
                self?.registerAndActivateInstalledPet(pet)
            },
            onRefreshAgents: { [weak self] in
                self?.settingsStore.refreshDetectedAgents()
            },
            onSendTestBubble: { [weak self] in
                self?.sendTestBubble()
            },
            onFinish: { [weak self] in
                self?.onboardingWindow?.close()
            }
        )

        let rootView = PetdexOnboardingView(store: settingsStore, actions: actions)
        let hostingController = NSHostingController(rootView: rootView)

        if let window = onboardingWindow {
            window.contentViewController = hostingController
            window.setContentSize(NSSize(width: 560, height: 500))
            window.center()
        } else {
            let window = NSWindow(contentViewController: hostingController)
            window.title = "Welcome to Petdex"
            window.styleMask = [.titled, .closable, .fullSizeContentView]
            window.titleVisibility = .hidden
            window.titlebarAppearsTransparent = true
            window.isMovableByWindowBackground = true
            window.standardWindowButton(.miniaturizeButton)?.isHidden = true
            window.standardWindowButton(.zoomButton)?.isHidden = true
            window.isOpaque = false
            window.backgroundColor = .clear
            window.hasShadow = true
            window.setContentSize(NSSize(width: 560, height: 500))
            window.isReleasedWhenClosed = false
            window.center()
            onboardingWindow = window
        }

        NSApp.activate(ignoringOtherApps: true)
        onboardingWindow?.makeKeyAndOrderFront(nil)
        onboardingWindow?.orderFrontRegardless()
    }

    private func focusCodingApplication(for bubble: ActiveBubble) {
        let runningApps = NSWorkspace.shared.runningApplications.filter {
            !$0.isTerminated && $0.activationPolicy == .regular
        }

        var preferredBundleIds = [
            "com.mitchellh.ghostty",
            "com.googlecode.iterm2",
            "com.apple.Terminal",
            "dev.warp.Warp-Stable",
            "com.todesktop.230313mzl4w4u92",
            "com.microsoft.VSCode",
            "com.openai.chat",
        ]

        let agent = bubble.agent.lowercased()
        if agent == "cursor" {
            preferredBundleIds.removeAll { $0 == "com.todesktop.230313mzl4w4u92" }
            preferredBundleIds.insert("com.todesktop.230313mzl4w4u92", at: 0)
        } else if agent == "vscode" {
            preferredBundleIds.removeAll { $0 == "com.microsoft.VSCode" }
            preferredBundleIds.insert("com.microsoft.VSCode", at: 0)
        }

        for bundleId in preferredBundleIds {
            if let app = runningApps.first(where: {
                $0.bundleIdentifier?.caseInsensitiveCompare(bundleId) == .orderedSame
            }) {
                app.activate(options: [.activateIgnoringOtherApps])
                return
            }
        }

        let preferredNames = [
            "Ghostty",
            "iTerm2",
            "Terminal",
            "Warp",
            "Cursor",
            "Visual Studio Code",
            "ChatGPT",
            "Codex",
        ]

        for name in preferredNames {
            if let app = runningApps.first(where: {
                $0.localizedName?.caseInsensitiveCompare(name) == .orderedSame
            }) {
                app.activate(options: [.activateIgnoringOtherApps])
                return
            }
        }
    }

    private func openPetsFolder() {
        let petsDir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".petdex/pets", isDirectory: true)
        try? FileManager.default.createDirectory(at: petsDir, withIntermediateDirectories: true)
        NSWorkspace.shared.open(petsDir)
    }

    private func sendTestBubble() {
        if !settingsStore.bubblesEnabled {
            settingsStore.bubblesEnabled = true
        }
        canvasView?.ingestStatus(
            sessionId: "settings-test",
            agent: UInt8(PETDEX_AGENT_CLAUDE_CODE.rawValue),
            status: UInt8(PETDEX_STATUS_NEEDS_INPUT.rawValue),
            summary: "Build passed. Ready for review!"
        )
        syncBubblePanel()
    }

    private func sendTestTwoSessions() {
        if !settingsStore.bubblesEnabled {
            settingsStore.bubblesEnabled = true
        }
        canvasView?.ingestStatus(
            sessionId: "settings-test-claude",
            agent: UInt8(PETDEX_AGENT_CLAUDE_CODE.rawValue),
            status: UInt8(PETDEX_STATUS_NEEDS_INPUT.rawValue),
            summary: "Build passed. Ready for review!"
        )
        canvasView?.ingestStatus(
            sessionId: "settings-test-codex",
            agent: UInt8(PETDEX_AGENT_CODEX.rawValue),
            status: UInt8(PETDEX_STATUS_RUNNING.rawValue),
            summary: "Running unit tests on petdex-core..."
        )
        syncBubblePanel()
    }

    private func configureStatusItem(boundPort: UInt16) {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = item.button {
            if let symbol = NSImage(systemSymbolName: "pawprint.fill", accessibilityDescription: "Petdex") {
                symbol.isTemplate = true
                button.image = symbol
            } else {
                button.title = "Petdex"
            }
        }

        let menu = NSMenu()
        let petItem = NSMenuItem(title: "Pet: Fallback", action: nil, keyEquivalent: "")
        petItem.isEnabled = false
        menu.addItem(petItem)
        self.petMenuItem = petItem

        let stateItem = NSMenuItem(title: "State: Idle", action: nil, keyEquivalent: "")
        stateItem.isEnabled = false
        menu.addItem(stateItem)
        self.stateMenuItem = stateItem

        let hookTitle = boundPort > 0 ? "Hook Server: 127.0.0.1:\(boundPort)" : "Hook Server: Offline"
        let hookItem = NSMenuItem(title: hookTitle, action: nil, keyEquivalent: "")
        hookItem.isEnabled = false
        menu.addItem(hookItem)
        self.hookMenuItem = hookItem

        menu.addItem(.separator())

        let petsItem = NSMenuItem(title: "Pets", action: nil, keyEquivalent: "")
        petsItem.submenu = buildPetsSubmenu()
        menu.addItem(petsItem)
        self.statusPetsSubmenuItem = petsItem

        let shuffleItem = NSMenuItem(title: "Shuffle Pet", action: #selector(handleShufflePet), keyEquivalent: "r")
        shuffleItem.target = self
        menu.addItem(shuffleItem)

        let focusModeItem = NSMenuItem(title: "Focus Mode", action: #selector(handleToggleFocusMode), keyEquivalent: "f")
        focusModeItem.target = self
        focusModeItem.state = settingsStore.focusMode ? .on : .off
        menu.addItem(focusModeItem)
        self.focusModeMenuItem = focusModeItem

        let cycleItem = NSMenuItem(title: "Cycle State", action: #selector(handleCycleState), keyEquivalent: "c")
        cycleItem.target = self
        menu.addItem(cycleItem)

        let toggleItem = NSMenuItem(title: "Toggle Pet Panel", action: #selector(handleTogglePanel), keyEquivalent: "p")
        toggleItem.target = self
        menu.addItem(toggleItem)

        let settingsItem = NSMenuItem(title: "Settings...", action: #selector(handleOpenSettings), keyEquivalent: ",")
        settingsItem.target = self
        menu.addItem(settingsItem)

        let onboardingItem = NSMenuItem(title: "Welcome & Onboarding...", action: #selector(handleOpenOnboarding), keyEquivalent: "")
        onboardingItem.target = self
        menu.addItem(onboardingItem)

        menu.addItem(.separator())

        let quitItem = NSMenuItem(title: "Quit Petdex", action: #selector(handleQuit), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)

        item.menu = menu
        self.statusItem = item
    }

    private func buildPetsSubmenu() -> NSMenu {
        let petsMenu = NSMenu()
        let activePetId = canvasView?.activePet?.id

        if installedPets.isEmpty {
            let emptyItem = NSMenuItem(title: "No installed pets found", action: nil, keyEquivalent: "")
            emptyItem.isEnabled = false
            petsMenu.addItem(emptyItem)
        } else {
            for pet in installedPets {
                let item = NSMenuItem(title: pet.displayName, action: #selector(handleSelectPet(_:)), keyEquivalent: "")
                item.target = self
                item.representedObject = pet
                item.state = pet.id == activePetId ? .on : .off
                petsMenu.addItem(item)
            }
        }

        petsMenu.addItem(.separator())

        let fallbackItem = NSMenuItem(title: "Cobalt Squircle (Fallback)", action: #selector(handleSelectFallbackPet), keyEquivalent: "")
        fallbackItem.target = self
        fallbackItem.state = activePetId == nil ? .on : .off
        petsMenu.addItem(fallbackItem)

        let reloadItem = NSMenuItem(title: "Reload Pets", action: #selector(handleReloadPets), keyEquivalent: "")
        reloadItem.target = self
        petsMenu.addItem(reloadItem)

        return petsMenu
    }

    private func buildPanelContextMenu() -> NSMenu {
        let menu = NSMenu()
        let currentState = canvasView?.currentFrame.state ?? 0
        let petLabel = canvasView?.activePet?.displayName ?? "Cobalt Squircle"
        let header = NSMenuItem(title: "\(petLabel): \(PetdexStateCatalog.name(for: currentState))", action: nil, keyEquivalent: "")
        header.isEnabled = false
        menu.addItem(header)

        menu.addItem(.separator())

        let petsItem = NSMenuItem(title: "Pets", action: nil, keyEquivalent: "")
        petsItem.submenu = buildPetsSubmenu()
        menu.addItem(petsItem)

        let cycleItem = NSMenuItem(title: "Cycle State", action: #selector(handleCycleState), keyEquivalent: "")
        cycleItem.target = self
        menu.addItem(cycleItem)

        let statesMenu = NSMenu()
        for (stateValue, label) in PetdexStateCatalog.allStates {
            let item = NSMenuItem(title: label, action: #selector(handleSelectState(_:)), keyEquivalent: "")
            item.target = self
            item.tag = Int(stateValue)
            item.state = stateValue == currentState ? .on : .off
            statesMenu.addItem(item)
        }
        let setStateItem = NSMenuItem(title: "Set State", action: nil, keyEquivalent: "")
        setStateItem.submenu = statesMenu
        menu.addItem(setStateItem)

        let settingsItem = NSMenuItem(title: "Settings...", action: #selector(handleOpenSettings), keyEquivalent: ",")
        settingsItem.target = self
        menu.addItem(settingsItem)

        menu.addItem(.separator())

        let quitItem = NSMenuItem(title: "Quit Petdex", action: #selector(handleQuit), keyEquivalent: "")
        quitItem.target = self
        menu.addItem(quitItem)

        return menu
    }

    private func refreshPetMenuState() {
        let petName = canvasView?.activePet?.displayName ?? "Cobalt Squircle"
        petMenuItem?.title = "Pet: \(petName)"
        statusPetsSubmenuItem?.submenu = buildPetsSubmenu()
    }

    private func updateStatusLabels(state: UInt8) {
        stateMenuItem?.title = "State: \(PetdexStateCatalog.name(for: state))"
        if let port = canvasView?.hookServerPort, port > 0 {
            hookMenuItem?.title = "Hook Server: 127.0.0.1:\(port)"
        }
    }

    @objc private func handleOpenSettings() {
        openSettingsWindow()
    }

    @objc private func handleOpenOnboarding() {
        showOnboardingWindow()
    }

    @objc private func handleSelectPet(_ sender: NSMenuItem) {
        guard let pet = sender.representedObject as? InstalledPet else { return }
        canvasView?.selectPet(pet)
    }

    @objc private func handleSelectFallbackPet() {
        canvasView?.selectPet(nil)
    }

    @objc private func handleReloadPets() {
        let previousId = canvasView?.activePet?.id
        installedPets = PetCatalog.discoverPets()
        settingsStore.installedPets = installedPets
        if let previousId,
           let match = installedPets.first(where: { $0.id == previousId })
        {
            canvasView?.selectPet(match)
        } else {
            let nextPet = PetCatalog.resolveInitialPet(from: installedPets)
            canvasView?.selectPet(nextPet)
        }
        refreshPetMenuState()
    }

    @objc private func handleCycleState() {
        canvasView?.cycleState()
    }

    @objc private func handleShufflePet() {
        shufflePet()
    }

    @objc private func handleToggleFocusMode() {
        settingsStore.focusMode.toggle()
        syncBubblePanel()
    }

    @objc private func handleSelectState(_ sender: NSMenuItem) {
        canvasView?.setState(UInt8(sender.tag))
    }

    @objc private func handleTogglePanel() {
        guard let panel else { return }
        if panel.isVisible {
            panel.orderOut(nil)
        } else {
            panel.orderFrontRegardless()
        }
        syncBubblePanel()
    }

    private func restoreAccountSessionOnLaunch() {
        guard let savedTokens = clerkAuth.loadTokens() else {
            settingsStore.authPhase = "signed_out"
            return
        }

        accountSyncTask?.cancel()
        settingsStore.authPhase = "syncing"
        settingsStore.authError = nil

        accountSyncTask = Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let (library, _) = try await self.clerkAuth.fetchLibraryWithAutoRefresh(tokens: savedTokens)
                if Task.isCancelled { return }
                self.applySignedInLibrary(library)
            } catch PetdexClerkAuthError.unauthorized {
                if Task.isCancelled { return }
                _ = self.clerkAuth.deleteTokens()
                self.resetAccountState(error: nil)
            } catch {
                if Task.isCancelled { return }
                NSLog("PetdexMacOS silent library sync failed: %@", error.localizedDescription)
                self.settingsStore.authPhase = self.settingsStore.authUser != nil ? "signed_in" : "signed_out"
            }
        }
    }

    private func handleSignIn() {
        oauthFlowTask?.cancel()
        accountSyncTask?.cancel()
        _ = canvasView?.takeOAuthCallback()

        let challenge: PetdexPKCEChallenge
        do {
            challenge = try clerkAuth.beginPKCEFlow()
        } catch {
            settingsStore.authPhase = "error"
            settingsStore.authError = error.localizedDescription
            return
        }

        settingsStore.authPhase = "authorizing"
        settingsStore.authError = nil
        NSWorkspace.shared.open(challenge.authorizeURL)

        oauthFlowTask = Task { @MainActor [weak self] in
            guard let self else { return }
            let deadline = Date().addingTimeInterval(180)
            var callback: PetdexOAuthCallbackPayload?

            while Date() < deadline {
                if Task.isCancelled { return }
                if let received = self.canvasView?.takeOAuthCallback() {
                    callback = received
                    break
                }
                try? await Task.sleep(nanoseconds: 250_000_000)
            }

            if Task.isCancelled { return }

            guard let callback else {
                self.settingsStore.authPhase = "error"
                self.settingsStore.authError = PetdexClerkAuthError.timedOut.localizedDescription
                return
            }

            if !callback.error.isEmpty {
                self.settingsStore.authPhase = "error"
                self.settingsStore.authError = PetdexClerkAuthError.oauthError(callback.error).localizedDescription
                return
            }

            guard callback.state == challenge.state else {
                self.settingsStore.authPhase = "error"
                self.settingsStore.authError = PetdexClerkAuthError.stateMismatch.localizedDescription
                return
            }

            guard !callback.code.isEmpty else {
                self.settingsStore.authPhase = "error"
                self.settingsStore.authError = PetdexClerkAuthError.missingAuthorizationCode.localizedDescription
                return
            }

            self.settingsStore.authPhase = "syncing"
            self.settingsStore.authError = nil

            do {
                let tokens = try await self.clerkAuth.exchangeCodeForTokens(
                    code: callback.code,
                    codeVerifier: challenge.codeVerifier
                )
                if Task.isCancelled { return }
                _ = self.clerkAuth.saveTokens(tokens)
                let (library, _) = try await self.clerkAuth.fetchLibraryWithAutoRefresh(tokens: tokens)
                if Task.isCancelled { return }
                self.applySignedInLibrary(library)
                NSApp.activate(ignoringOtherApps: true)
                if let onboardingWindow = self.onboardingWindow, onboardingWindow.isVisible {
                    onboardingWindow.makeKeyAndOrderFront(nil)
                    onboardingWindow.orderFrontRegardless()
                } else {
                    self.settingsWindow?.makeKeyAndOrderFront(nil)
                    self.settingsWindow?.orderFrontRegardless()
                }
            } catch {
                if Task.isCancelled { return }
                self.settingsStore.authPhase = "error"
                self.settingsStore.authError = error.localizedDescription
            }
        }
    }

    private func handleRefreshAccount() {
        guard let savedTokens = clerkAuth.loadTokens() else {
            resetAccountState(error: nil)
            return
        }

        accountSyncTask?.cancel()
        settingsStore.authPhase = "syncing"
        settingsStore.authError = nil

        accountSyncTask = Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let (library, _) = try await self.clerkAuth.fetchLibraryWithAutoRefresh(tokens: savedTokens)
                if Task.isCancelled { return }
                self.applySignedInLibrary(library)
            } catch PetdexClerkAuthError.unauthorized {
                if Task.isCancelled { return }
                _ = self.clerkAuth.deleteTokens()
                self.resetAccountState(error: PetdexClerkAuthError.unauthorized.localizedDescription)
            } catch {
                if Task.isCancelled { return }
                self.settingsStore.authError = error.localizedDescription
                self.settingsStore.authPhase = self.settingsStore.authUser != nil ? "signed_in" : "error"
            }
        }
    }

    private func handleSignOut() {
        oauthFlowTask?.cancel()
        accountSyncTask?.cancel()
        _ = clerkAuth.deleteTokens()
        resetAccountState(error: nil)
    }

    private func applySignedInLibrary(_ library: PetdexLibraryPayload) {
        settingsStore.authUser = library.user
        settingsStore.ownedPets = library.owned
        settingsStore.caughtPets = library.caught
        settingsStore.authError = nil
        settingsStore.authPhase = "signed_in"
    }

    private func resetAccountState(error: String?) {
        settingsStore.authUser = nil
        settingsStore.ownedPets = []
        settingsStore.caughtPets = []
        settingsStore.authError = error
        settingsStore.authPhase = error == nil ? "signed_out" : "error"
    }

    @objc private func handleQuit() {
        NSApp.terminate(nil)
    }
}

@main
struct PetdexPanelApp {
    static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let delegate = PetdexAppDelegate()
        app.delegate = delegate
        app.run()
    }
}
