import AppKit
import CPetdexCore
import Foundation

final class PetdexPhysicsController {
    struct Sample {
        let origin: NSPoint
        let time: TimeInterval
    }

    private let sampleWindow: TimeInterval = 0.10
    private let maxVelocity: CGFloat = 2600
    private let minThrowSpeed: CGFloat = 85
    private let stopSpeed: CGFloat = 18
    private let frictionBase: Double = 0.06
    private let restitution: CGFloat = -0.58

    private var samples: [Sample] = []
    private var vx: CGFloat = 0
    private var vy: CGFloat = 0

    private(set) var isThrowing: Bool = false

    func beginDrag(at origin: NSPoint) {
        samples.removeAll(keepingCapacity: true)
        vx = 0
        vy = 0
        isThrowing = false
        samples.append(Sample(origin: origin, time: ProcessInfo.processInfo.systemUptime))
    }

    func updateDrag(to origin: NSPoint) -> UInt8? {
        let now = ProcessInfo.processInfo.systemUptime
        samples.append(Sample(origin: origin, time: now))
        trimSamples(relativeTo: now)

        guard let velocity = sampleVelocity() else {
            return nil
        }

        if velocity.dy > 220 {
            return UInt8(PETDEX_STATE_JUMPING.rawValue)
        }
        if velocity.dx > 140 {
            return UInt8(PETDEX_STATE_RUNNING_RIGHT.rawValue)
        }
        if velocity.dx < -140 {
            return UInt8(PETDEX_STATE_RUNNING_LEFT.rawValue)
        }
        return nil
    }

    func endDrag(at origin: NSPoint) -> Bool {
        let now = ProcessInfo.processInfo.systemUptime
        samples.append(Sample(origin: origin, time: now))
        trimSamples(relativeTo: now)

        let velocity = sampleVelocity()
        samples.removeAll(keepingCapacity: true)

        guard let velocity else {
            vx = 0
            vy = 0
            isThrowing = false
            return false
        }

        let clampedVx = min(max(velocity.dx, -maxVelocity), maxVelocity)
        let clampedVy = min(max(velocity.dy, -maxVelocity), maxVelocity)
        let speed = hypot(clampedVx, clampedVy)

        if speed > minThrowSpeed {
            vx = clampedVx
            vy = clampedVy
            isThrowing = true
            return true
        }

        vx = 0
        vy = 0
        isThrowing = false
        return false
    }

    func step(
        dt: TimeInterval,
        currentFrame: NSRect,
        screenBounds: NSRect
    ) -> (newOrigin: NSPoint, suggestedState: UInt8?, finished: Bool) {
        guard isThrowing, dt > 0 else {
            return (currentFrame.origin, nil, !isThrowing)
        }

        var origin = currentFrame.origin
        origin.x += vx * CGFloat(dt)
        origin.y += vy * CGFloat(dt)

        let damping = CGFloat(pow(frictionBase, dt))
        vx *= damping
        vy *= damping

        let minX = screenBounds.minX
        let maxX = max(minX, screenBounds.maxX - currentFrame.width)
        let minY = screenBounds.minY
        let maxY = max(minY, screenBounds.maxY - currentFrame.height)

        if origin.x < minX {
            origin.x = minX
            if vx < 0 {
                vx *= restitution
            }
        } else if origin.x > maxX {
            origin.x = maxX
            if vx > 0 {
                vx *= restitution
            }
        }

        if origin.y < minY {
            origin.y = minY
            if vy < 0 {
                vy *= restitution
            }
        } else if origin.y > maxY {
            origin.y = maxY
            if vy > 0 {
                vy *= restitution
            }
        }

        if hypot(vx, vy) < stopSpeed {
            vx = 0
            vy = 0
            isThrowing = false
            return (origin, nil, true)
        }

        let suggestedState: UInt8?
        if vx > 90 {
            suggestedState = UInt8(PETDEX_STATE_RUNNING_RIGHT.rawValue)
        } else if vx < -90 {
            suggestedState = UInt8(PETDEX_STATE_RUNNING_LEFT.rawValue)
        } else if vy > 120 {
            suggestedState = UInt8(PETDEX_STATE_JUMPING.rawValue)
        } else {
            suggestedState = nil
        }

        return (origin, suggestedState, false)
    }

    private func trimSamples(relativeTo now: TimeInterval) {
        let cutoff = now - sampleWindow
        samples.removeAll { $0.time < cutoff }
    }

    private func sampleVelocity() -> CGVector? {
        guard let first = samples.first, let last = samples.last else {
            return nil
        }
        let dt = last.time - first.time
        guard dt > 1e-4 else {
            return nil
        }
        let dx = (last.origin.x - first.origin.x) / CGFloat(dt)
        let dy = (last.origin.y - first.origin.y) / CGFloat(dt)
        return CGVector(dx: dx, dy: dy)
    }
}

final class PetdexChimePlayer {
    private let cooldown: TimeInterval = 2.5
    private let customSoundFilenames = ["sound.mp3", "sound.wav", "sound.m4a"]
    private var lastPlayedAt: TimeInterval = -.greatestFiniteMagnitude
    private var activeSound: NSSound?

    func playWaitingChime(petDirectory: URL?) {
        let now = ProcessInfo.processInfo.systemUptime
        guard now - lastPlayedAt >= cooldown else {
            return
        }

        if let petDirectory {
            for filename in customSoundFilenames {
                let candidate = petDirectory.appendingPathComponent(filename)
                if FileManager.default.fileExists(atPath: candidate.path),
                   let sound = NSSound(contentsOf: candidate, byReference: true) {
                    activeSound?.stop()
                    activeSound = sound
                    sound.play()
                    lastPlayedAt = now
                    return
                }
            }
        }

        guard let fallback = NSSound(named: NSSound.Name("Pop")) ?? NSSound(named: NSSound.Name("Glass")) else {
            return
        }
        let sound = (fallback.copy() as? NSSound) ?? fallback
        sound.volume = 0.45
        activeSound?.stop()
        activeSound = sound
        sound.play()
        lastPlayedAt = now
    }
}
