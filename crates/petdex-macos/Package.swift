// swift-tools-version: 5.9
import Foundation
import PackageDescription

let packageDir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
let coreRoot = packageDir
    .deletingLastPathComponent()
    .appendingPathComponent("petdex-core")
    .standardizedFileURL
let coreIncludeDir = coreRoot.appendingPathComponent("include").path
let coreStaticLib = coreRoot.appendingPathComponent("target/release/libpetdex_core.a").path

let package = Package(
    name: "PetdexMacOS",
    platforms: [
        .macOS(.v13),
    ],
    products: [
        .executable(name: "PetdexMacOS", targets: ["PetdexMacOS"]),
    ],
    targets: [
        .target(
            name: "CPetdexCore",
            path: "Sources/CPetdexCore",
            publicHeadersPath: "include",
            cSettings: [
                .unsafeFlags(["-I\(coreIncludeDir)"]),
            ]
        ),
        .executableTarget(
            name: "PetdexMacOS",
            dependencies: ["CPetdexCore"],
            path: "Sources/PetdexMacOS",
            resources: [
                .copy("Resources/agents"),
            ],
            swiftSettings: [
                .unsafeFlags(["-Xcc", "-I\(coreIncludeDir)"]),
            ],
            linkerSettings: [
                .unsafeFlags([coreStaticLib]),
                .linkedFramework("AppKit"),
                .linkedFramework("CoreGraphics"),
                .linkedFramework("ImageIO"),
                .linkedFramework("QuartzCore"),
                .linkedFramework("SwiftUI"),
            ]
        ),
    ]
)
