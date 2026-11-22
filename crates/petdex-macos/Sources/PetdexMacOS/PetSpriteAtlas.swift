import CoreGraphics
import Foundation
import ImageIO

struct InstalledPet: Equatable {
    let id: String
    let displayName: String
    let directoryURL: URL
    let spritesheetURL: URL
}

final class PetSpriteAtlas {
    static let defaultColumns = 8
    static let defaultRows = 9
    static let canonicalFrameWidth = 192.0
    static let canonicalFrameHeight = 208.0

    private struct AtlasMetadata: Decodable {
        struct FrameSize: Decodable {
            let width: Int?
            let height: Int?
        }

        struct Grid: Decodable {
            let cols: Int?
            let rows: Int?
        }

        let frameWidth: Int?
        let frameHeight: Int?
        let frameSize: FrameSize?
        let grid: Grid?
    }

    struct ResolvedLayout: Equatable {
        let columns: Int
        let rows: Int
        let frameWidth: Int
        let frameHeight: Int
    }

    let pet: InstalledPet
    let sheetImage: CGImage
    let columns: Int
    let rows: Int
    let frameWidth: Int
    let frameHeight: Int
    private var frameCache: [Int: CGImage] = [:]

    init?(pet: InstalledPet) {
        guard
            let source = CGImageSourceCreateWithURL(pet.spritesheetURL as CFURL, nil),
            let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
        else {
            return nil
        }

        let metadataURL = pet.spritesheetURL
            .deletingLastPathComponent()
            .appendingPathComponent("pet.json", isDirectory: false)
        guard let layout = Self.resolveLayout(
            imageWidth: image.width,
            imageHeight: image.height,
            metadataURL: metadataURL
        ) else {
            return nil
        }

        self.pet = pet
        self.sheetImage = image
        self.columns = layout.columns
        self.rows = layout.rows
        self.frameWidth = layout.frameWidth
        self.frameHeight = layout.frameHeight
    }

    static func resolveLayout(
        imageWidth: Int,
        imageHeight: Int,
        metadataURL: URL?
    ) -> ResolvedLayout? {
        guard imageWidth > 0, imageHeight > 0 else {
            return nil
        }

        if let metadataURL,
           let data = try? Data(contentsOf: metadataURL),
           let metadata = try? JSONDecoder().decode(AtlasMetadata.self, from: data)
        {
            if let fw = metadata.frameWidth,
               let fh = metadata.frameHeight,
               fw > 0, fh > 0, fw <= imageWidth, fh <= imageHeight
            {
                let cols = imageWidth / fw
                let rows = imageHeight / fh
                if cols > 0, rows > 0 {
                    return ResolvedLayout(columns: cols, rows: rows, frameWidth: fw, frameHeight: fh)
                }
            }

            if let fw = metadata.frameSize?.width,
               let fh = metadata.frameSize?.height,
               fw > 0, fh > 0, fw <= imageWidth, fh <= imageHeight
            {
                let cols = imageWidth / fw
                let rows = imageHeight / fh
                if cols > 0, rows > 0 {
                    return ResolvedLayout(columns: cols, rows: rows, frameWidth: fw, frameHeight: fh)
                }
            }

            if let cols = metadata.grid?.cols,
               let rows = metadata.grid?.rows,
               cols > 0, rows > 0, cols <= imageWidth, rows <= imageHeight
            {
                let fw = imageWidth / cols
                let fh = imageHeight / rows
                if fw > 0, fh > 0 {
                    return ResolvedLayout(columns: cols, rows: rows, frameWidth: fw, frameHeight: fh)
                }
            }
        }

        let cols = Self.defaultColumns
        let frameWidth = imageWidth / cols
        guard frameWidth > 0 else {
            return nil
        }

        let expectedFrameHeight = Int((Double(frameWidth) * Self.canonicalFrameHeight / Self.canonicalFrameWidth).rounded())
        if expectedFrameHeight > 0 {
            let computedRows = imageHeight / expectedFrameHeight
            let exactMultiple = computedRows > 0 && (imageHeight % expectedFrameHeight == 0)
            let roundedRows = Int((Double(imageHeight) / Double(expectedFrameHeight)).rounded())
            let nearMultiple = computedRows >= Self.defaultRows
                && abs(imageHeight - expectedFrameHeight * roundedRows) <= 4
            if exactMultiple || nearMultiple {
                return ResolvedLayout(
                    columns: cols,
                    rows: computedRows,
                    frameWidth: frameWidth,
                    frameHeight: expectedFrameHeight
                )
            }
        }

        let fallbackRows = Self.defaultRows
        let fallbackFrameHeight = imageHeight / fallbackRows
        guard fallbackFrameHeight > 0 else {
            return nil
        }

        return ResolvedLayout(
            columns: cols,
            rows: fallbackRows,
            frameWidth: frameWidth,
            frameHeight: fallbackFrameHeight
        )
    }

    func frameImage(row: UInt32, col: UInt32) -> CGImage? {
        let clampedRow = min(Int(row), rows - 1)
        let clampedCol = min(Int(col), columns - 1)
        let cacheKey = clampedRow * columns + clampedCol

        if let cached = frameCache[cacheKey] {
            return cached
        }

        let cropRect = CGRect(
            x: clampedCol * frameWidth,
            y: clampedRow * frameHeight,
            width: frameWidth,
            height: frameHeight
        )
        guard let cropped = sheetImage.cropping(to: cropRect) else {
            return nil
        }

        frameCache[cacheKey] = cropped
        return cropped
    }
}

enum PetCatalog {
    private struct PetMetadata: Decodable {
        let name: String?
    }

    static var searchDirectories: [URL] {
        let home = FileManager.default.homeDirectoryForCurrentUser
        return [
            home.appendingPathComponent(".petdex/pets", isDirectory: true),
            home.appendingPathComponent(".codex/pets", isDirectory: true),
        ]
    }

    static func discoverPets() -> [InstalledPet] {
        let fm = FileManager.default
        var seen = Set<String>()
        var discovered: [InstalledPet] = []

        for root in searchDirectories {
            guard
                let entries = try? fm.contentsOfDirectory(
                    at: root,
                    includingPropertiesForKeys: [.isDirectoryKey],
                    options: [.skipsHiddenFiles]
                )
            else {
                continue
            }

            let sortedEntries = entries.sorted {
                $0.lastPathComponent.localizedCaseInsensitiveCompare($1.lastPathComponent) == .orderedAscending
            }

            for dirURL in sortedEntries {
                var isDirectory: ObjCBool = false
                guard fm.fileExists(atPath: dirURL.path, isDirectory: &isDirectory), isDirectory.boolValue else {
                    continue
                }

                let id = dirURL.lastPathComponent
                let dedupeKey = id.lowercased()
                guard !seen.contains(dedupeKey) else {
                    continue
                }

                let spritesheetURL = dirURL.appendingPathComponent("spritesheet.webp", isDirectory: false)
                guard fm.isReadableFile(atPath: spritesheetURL.path) else {
                    continue
                }

                seen.insert(dedupeKey)
                let displayName = readDisplayName(in: dirURL) ?? id
                discovered.append(
                    InstalledPet(
                        id: id,
                        displayName: displayName,
                        directoryURL: dirURL,
                        spritesheetURL: spritesheetURL
                    )
                )
            }
        }

        return discovered.sorted {
            $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending
        }
    }

    static func resolveInitialPet(
        from pets: [InstalledPet],
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> InstalledPet? {
        if let requestedRaw = environment["PETDEX_PET"]?.trimmingCharacters(in: .whitespacesAndNewlines),
           !requestedRaw.isEmpty
        {
            if let match = pets.first(where: { $0.id.caseInsensitiveCompare(requestedRaw) == .orderedSame }) {
                return match
            }

            if let directPet = resolveDirectPath(requestedRaw) {
                return directPet
            }
        }

        if let boba = pets.first(where: { $0.id.caseInsensitiveCompare("boba") == .orderedSame }) {
            return boba
        }

        return pets.first
    }

    private static func resolveDirectPath(_ rawPath: String) -> InstalledPet? {
        let expanded = (rawPath as NSString).expandingTildeInPath
        let url = URL(fileURLWithPath: expanded)
        let fm = FileManager.default

        var isDir: ObjCBool = false
        guard fm.fileExists(atPath: url.path, isDirectory: &isDir) else {
            return nil
        }

        if isDir.boolValue {
            let sheetURL = url.appendingPathComponent("spritesheet.webp", isDirectory: false)
            guard fm.isReadableFile(atPath: sheetURL.path) else {
                return nil
            }
            let id = url.lastPathComponent
            return InstalledPet(
                id: id,
                displayName: readDisplayName(in: url) ?? id,
                directoryURL: url,
                spritesheetURL: sheetURL
            )
        }

        guard fm.isReadableFile(atPath: url.path) else {
            return nil
        }
        let parent = url.deletingLastPathComponent()
        let id = parent.lastPathComponent.isEmpty ? url.deletingPathExtension().lastPathComponent : parent.lastPathComponent
        return InstalledPet(
            id: id,
            displayName: id,
            directoryURL: parent,
            spritesheetURL: url
        )
    }

    private static func readDisplayName(in directoryURL: URL) -> String? {
        let metadataURL = directoryURL.appendingPathComponent("pet.json", isDirectory: false)
        guard
            let data = try? Data(contentsOf: metadataURL),
            let metadata = try? JSONDecoder().decode(PetMetadata.self, from: data),
            let name = metadata.name?.trimmingCharacters(in: .whitespacesAndNewlines),
            !name.isEmpty
        else {
            return nil
        }
        return name
    }
}
