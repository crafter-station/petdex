import AppKit
import CPetdexCore
import Foundation
import Metal
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
        level = .floating
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

final class PetdexMetalCanvasView: NSView {
    private var engine: OpaquePointer?
    private var tickTimer: Timer?
    private var metalDevice: MTLDevice?
    private var commandQueue: MTLCommandQueue?
    private var lastFrame = PetdexFrame(state: 0, row: 0, col: 0, frame_index: 0, frame_dur_ms: 0)
    private(set) var hookServerPort: UInt16 = 0
    var contextMenuProvider: (() -> NSMenu)?
    var onStateChanged: ((UInt8) -> Void)?

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        engine = petdex_engine_new()
        configureMetalLayer()
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

    override func makeBackingLayer() -> CALayer {
        let layer = CAMetalLayer()
        layer.isOpaque = false
        layer.backgroundColor = NSColor.clear.cgColor
        layer.pixelFormat = .bgra8Unorm
        layer.framebufferOnly = true
        return layer
    }

    override func menu(for event: NSEvent) -> NSMenu? {
        contextMenuProvider?()
    }

    private func configureMetalLayer() {
        guard let metalLayer = layer as? CAMetalLayer else { return }
        let device = MTLCreateSystemDefaultDevice()
        metalDevice = device
        commandQueue = device?.makeCommandQueue()
        metalLayer.device = device
        metalLayer.contentsScale = NSScreen.main?.backingScaleFactor ?? 2.0
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
        let previousState = lastFrame.state
        lastFrame = petdex_engine_tick_ms(engine, dtMs)
        if lastFrame.state != previousState {
            onStateChanged?(lastFrame.state)
        }
        renderClearPass()
    }

    private func renderClearPass() {
        guard
            let metalLayer = layer as? CAMetalLayer,
            let drawable = metalLayer.nextDrawable(),
            let queue = commandQueue,
            let commandBuffer = queue.makeCommandBuffer()
        else {
            return
        }

        let pass = MTLRenderPassDescriptor()
        pass.colorAttachments[0].texture = drawable.texture
        pass.colorAttachments[0].loadAction = .clear
        pass.colorAttachments[0].storeAction = .store
        pass.colorAttachments[0].clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0)

        if let encoder = commandBuffer.makeRenderCommandEncoder(descriptor: pass) {
            encoder.endEncoding()
        }
        commandBuffer.present(drawable)
        commandBuffer.commit()
    }

    var currentFrame: PetdexFrame {
        lastFrame
    }
}

final class PetdexAppDelegate: NSObject, NSApplicationDelegate {
    private var panel: PetdexFloatingPanel?
    private var canvasView: PetdexMetalCanvasView?
    private var statusItem: NSStatusItem?
    private var stateMenuItem: NSMenuItem?
    private var hookMenuItem: NSMenuItem?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let frame = NSRect(x: 120, y: 120, width: 160, height: 160)
        let panel = PetdexFloatingPanel(contentRect: frame)
        let canvas = PetdexMetalCanvasView(frame: NSRect(origin: .zero, size: frame.size))
        canvas.contextMenuProvider = { [weak self] in
            self?.buildPanelContextMenu() ?? NSMenu()
        }
        canvas.onStateChanged = { [weak self] state in
            self?.updateStatusLabels(state: state)
        }
        panel.contentView = canvas
        panel.orderFrontRegardless()

        if let versionPtr = petdex_core_version() {
            let version = String(cString: versionPtr)
            NSLog("PetdexMacOS booted with petdex-core %@", version)
        }

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

    private func buildPanelContextMenu() -> NSMenu {
        let menu = NSMenu()
        let currentState = canvasView?.currentFrame.state ?? 0
        let header = NSMenuItem(title: "Petdex: \(PetdexStateCatalog.name(for: currentState))", action: nil, keyEquivalent: "")
        header.isEnabled = false
        menu.addItem(header)

        menu.addItem(.separator())

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

    private func updateStatusLabels(state: UInt8) {
        stateMenuItem?.title = "State: \(PetdexStateCatalog.name(for: state))"
        if let port = canvasView?.hookServerPort, port > 0 {
            hookMenuItem?.title = "Hook Server: 127.0.0.1:\(port)"
        }
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
