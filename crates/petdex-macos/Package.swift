// swift-tools-version: 5.9
import PackageDescription

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
                .headerSearchPath("../../../petdex-core/include"),
            ]
        ),
        .executableTarget(
            name: "PetdexMacOS",
            dependencies: ["CPetdexCore"],
            path: "Sources/PetdexMacOS",
            linkerSettings: [
                .unsafeFlags(["-L../petdex-core/target/release"]),
                .linkedLibrary("petdex_core"),
                .linkedFramework("AppKit"),
                .linkedFramework("QuartzCore"),
                .linkedFramework("Metal"),
            ]
        ),
    ]
)
