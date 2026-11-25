// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "PiloMacNativePrototype",
    platforms: [
        .macOS(.v14)
    ],
    targets: [
        .executableTarget(
            name: "PiloMacNative",
            path: "Sources/PiloMacNative"
        )
    ]
)
