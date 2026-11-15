import Foundation

public enum SecureChannelError: Error, Equatable, CustomStringConvertible {
    case failed(ChannelJSON)

    public var description: String {
        switch self {
        case .failed(let reason): return reason.description
        }
    }
}

@MainActor
public protocol SecureChannelView: AnyObject {
    var typedData: [String: (ChannelJSON) -> Void] { get }
    func connecting()
    func exception(_ error: ChannelJSON)
    func `import`(_ exports: SecureChannelExports)
    func latency(_ seconds: Double)
    func nodes(_ nodes: ChannelJSON)
    func offline()
    func online(_ sessionID: String)
    func ready()
    func streamClosed(_ streamID: String)
    func streamDown(_ streamID: String)
    func streamUp(_ streamID: String)
    func streams(_ streams: ChannelJSON)
}

extension SecureChannelView {
    public var typedData: [String: (ChannelJSON) -> Void] { [:] }
    public func connecting() {}
    public func exception(_ error: ChannelJSON) {}
    public func `import`(_ exports: SecureChannelExports) {}
    public func latency(_ seconds: Double) {}
    public func nodes(_ nodes: ChannelJSON) {}
    public func offline() {}
    public func online(_ sessionID: String) {}
    public func ready() {}
    public func streamClosed(_ streamID: String) {}
    public func streamDown(_ streamID: String) {}
    public func streamUp(_ streamID: String) {}
    public func streams(_ streams: ChannelJSON) {}
}

@MainActor
@dynamicMemberLookup
public struct SecureChannelExports {
    public let names: [String]
    weak var client: SecureChannelClient?

    public init() {
        names = []
        client = nil
    }

    init(names: [String], client: SecureChannelClient) {
        self.names = names
        self.client = client
    }

    public subscript(dynamicMember command: String) -> SecureChannelExport {
        SecureChannelExport(command: command, client: client)
    }
}

@MainActor
public struct SecureChannelExport {
    public let command: String
    weak var client: SecureChannelClient?

    public func callAsFunction(_ arguments: ChannelJSON = .null, timeout: Duration = .milliseconds(30_000)) async throws -> ChannelJSON {
        guard let client else {
            throw SecureChannelError.failed(.string("\(command) was called after its SecureChannel client was released"))
        }
        return try await client.call(command, arguments, timeout: timeout)
    }
}

@MainActor
public final class SecureChannelStream {
    public let streamID: String
    weak var client: SecureChannelClient?
    private var consumers: [UUID: AsyncStream<Data>.Continuation] = [:]

    init(streamID: String, client: SecureChannelClient) {
        self.streamID = streamID
        self.client = client
    }

    public func payloads() -> AsyncStream<Data> {
        let consumer = UUID()
        return AsyncStream { continuation in
            consumers[consumer] = continuation
            continuation.onTermination = { [weak self] _ in
                Task { @MainActor in self?.consumers[consumer] = nil }
            }
        }
    }

    public func write(_ payload: Data) {
        client?.writeStream(streamID, payload)
    }

    func deliver(_ payload: Data) {
        for continuation in consumers.values {
            continuation.yield(payload)
        }
    }

    func finish() {
        for continuation in consumers.values {
            continuation.finish()
        }
        consumers = [:]
    }
}
