// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "SecureChannel",
    platforms: [.iOS(.v16), .tvOS(.v16), .macOS(.v13)],
    products: [.library(name: "SecureChannel", targets: ["SecureChannel"])],
    targets: [
        .binaryTarget(name: "SecureChannelDialect", path: "build/SecureChannelDialect.xcframework"),
        .target(name: "SecureChannel", dependencies: ["SecureChannelDialect"]),
    ]
)
