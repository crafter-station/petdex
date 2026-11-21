import AppKit
import CPetdexCore
import CoreGraphics
import Foundation
import QuartzCore

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
        isMovableByWindowBackground = true
        hidesOnDeactivate = false
        ignoresMouseEvents = false
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

final class PetdexSpriteCanvasView: NSView {
    private var engine: OpaquePointer?
    private var tickTimer: Timer?
    private var spriteAtlas: PetSpriteAtlas?
    private var lastFrame = PetdexFrame(state: 0, row: 0, col: 0, frame_index: 0, frame_dur_ms: 0)
    private(set) var hookServerPort: UInt16 = 0
    private(set) var activePet: InstalledPet?
    var contextMenuProvider: (() -> NSMenu)?
    var onStateChanged: ((UInt8) -> Void)?
    var onPetChanged: ((InstalledPet?) -> Void)?

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
    override var mouseDownCanMoveWindow: Bool { true }

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
        let previous = lastFrame
        let next = petdex_engine_tick_ms(engine, dtMs)
        lastFrame = next

        if next.state != previous.state {
            onStateChanged?(next.state)
        }

        if next.row != previous.row || next.col != previous.col || next.state != previous.state || next.frame_index != previous.frame_index {
            needsDisplay = true
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
    private var panel: PetdexFloatingPanel?
    private var canvasView: PetdexSpriteCanvasView?
    private var statusItem: NSStatusItem?
    private var petMenuItem: NSMenuItem?
    private var stateMenuItem: NSMenuItem?
    private var hookMenuItem: NSMenuItem?
    private var statusPetsSubmenuItem: NSMenuItem?
    private var installedPets: [InstalledPet] = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        let panelSize = NSSize(width: 220, height: 238)
        let screenFrame = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let origin = NSPoint(
            x: screenFrame.maxX - panelSize.width - 48,
            y: screenFrame.minY + 48
        )
        let frame = NSRect(origin: origin, size: panelSize)
        let panel = PetdexFloatingPanel(contentRect: frame)
        let canvas = PetdexSpriteCanvasView(frame: NSRect(origin: .zero, size: frame.size))
        canvas.contextMenuProvider = { [weak self] in
            self?.buildPanelContextMenu() ?? NSMenu()
        }
        canvas.onStateChanged = { [weak self] state in
            self?.updateStatusLabels(state: state)
        }
        canvas.onPetChanged = { [weak self] _ in
            self?.refreshPetMenuState()
        }
        panel.contentView = canvas
        panel.orderFrontRegardless()

        if let versionPtr = petdex_core_version() {
            let version = String(cString: versionPtr)
            NSLog("PetdexMacOS booted with petdex-core %@", version)
        }

        installedPets = PetCatalog.discoverPets()
        let initialPet = PetCatalog.resolveInitialPet(from: installedPets)
        if let initialPet, !installedPets.contains(initialPet) {
            installedPets.insert(initialPet, at: 0)
        }
        canvas.selectPet(initialPet)

        let env = ProcessInfo.processInfo.environment
        let requestedPort = env["PETDEX_HOOK_PORT"].flatMap(UInt16.init) ?? 7777
        let token = env["PETDEX_UPDATE_TOKEN"] ?? UUID().uuidString
        let boundPort = canvas.startHookServer(port: requestedPort, token: token)
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
        configureStatusItem(boundPort: boundPort)
        updateStatusLabels(state: canvas.currentFrame.state)
        refreshPetMenuState()
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

        let cycleItem = NSMenuItem(title: "Cycle State", action: #selector(handleCycleState), keyEquivalent: "c")
        cycleItem.target = self
        menu.addItem(cycleItem)

        let toggleItem = NSMenuItem(title: "Toggle Pet Panel", action: #selector(handleTogglePanel), keyEquivalent: "p")
        toggleItem.target = self
        menu.addItem(toggleItem)

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
