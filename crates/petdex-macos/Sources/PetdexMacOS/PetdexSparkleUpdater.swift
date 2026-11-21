import Foundation
import Sparkle

final class PetdexSparkleUpdater {
    private let updaterController: SPUStandardUpdaterController?

    var isSparkleAvailable: Bool {
        updaterController != nil
    }

    init(bundle: Bundle = .main) {
        guard Self.canInitializeSparkle(in: bundle) else {
            self.updaterController = nil
            return
        }

        self.updaterController = SPUStandardUpdaterController(
            startingUpdater: true,
            updaterDelegate: nil,
            userDriverDelegate: nil
        )
    }

    @discardableResult
    func checkForUpdates() -> Bool {
        guard let updaterController else {
            return false
        }
        updaterController.checkForUpdates(nil)
        return true
    }

    func setAutomaticChecks(_ enabled: Bool) {
        updaterController?.updater.automaticallyChecksForUpdates = enabled
    }

    private static func canInitializeSparkle(in bundle: Bundle) -> Bool {
        guard bundle.bundleURL.pathExtension == "app" else {
            return false
        }

        guard let feedURL = (bundle.object(forInfoDictionaryKey: "SUFeedURL") as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !feedURL.isEmpty
        else {
            return false
        }

        guard let publicKey = (bundle.object(forInfoDictionaryKey: "SUPublicEDKey") as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !publicKey.isEmpty,
            publicKey != "__SPARKLE_PUBLIC_ED_KEY__",
            !(publicKey.hasPrefix("__") && publicKey.hasSuffix("__"))
        else {
            return false
        }

        return true
    }
}
