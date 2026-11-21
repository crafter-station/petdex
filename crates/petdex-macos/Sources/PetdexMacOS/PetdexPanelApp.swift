import AppKit
import CPetdexCore
import Foundation
import Metal
import QuartzCore

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

    private func configureMetalLayer() {
        guard let metalLayer = layer as? CAMetalLayer else { return }
        let device = MTLCreateSystemDefaultDevice()
        metalDevice = device
        commandQueue = device?.makeCommandQueue()
        metalLayer.device = device
        metalLayer.contentsScale = NSScreen.main?.backingScaleFactor ?? 2.0
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
        tickTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60.0, repeats: true) { [weak self] _ in
            self?.stepFrame(dtMs: 16)
        }
    }

    private func stepFrame(dtMs: UInt32) {
        guard let engine else { return }
        lastFrame = petdex_engine_tick_ms(engine, dtMs)
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

    func applicationDidFinishLaunching(_ notification: Notification) {
        let frame = NSRect(x: 120, y: 120, width: 160, height: 160)
        let panel = PetdexFloatingPanel(contentRect: frame)
        let canvas = PetdexMetalCanvasView(frame: NSRect(origin: .zero, size: frame.size))
        panel.contentView = canvas
        panel.orderFrontRegardless()

        if let versionPtr = petdex_core_version() {
            let version = String(cString: versionPtr)
            NSLog("PetdexMacOS booted with petdex-core %@", version)
        }

        canvas.ingestStatus(
            sessionId: "macos-bootstrap",
            agent: UInt8(PETDEX_AGENT_CLAUDE_CODE.rawValue),
            status: UInt8(PETDEX_STATUS_IDLE.rawValue),
            summary: ""
        )

        self.panel = panel
        self.canvasView = canvas
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
