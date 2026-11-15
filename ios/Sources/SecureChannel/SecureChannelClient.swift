import Foundation
import SecureChannelDialect
import os

@MainActor
public final class SecureChannelClient {
    public let request: URLRequest
    public private(set) var views: [SecureChannelView]
    private let dialect: OpaquePointer
    private let logger = Logger(subsystem: "SecureChannel", category: "client")
    private let urlSession: URLSession
    private var calls: [UInt64: CheckedContinuation<ChannelJSON, Error>] = [:]
    private var deadlines: [UInt64: Task<Void, Never>] = [:]
    private var lastTraffic = ContinuousClock.now
    private var openStreams: [String: SecureChannelStream] = [:]
    private var persistent = false
    private var reconnection: Task<Void, Never>?
    private var renamedSession: String?
    private var socket: URLSessionWebSocketTask?
    private var watchdog: Task<Void, Never>?

    public init(request: URLRequest, views: [SecureChannelView], urlSession: URLSession = .shared) {
        self.request = request
        self.views = views
        self.urlSession = urlSession
        dialect = sc_dialect_new()!
    }

    deinit {
        sc_dialect_free(dialect)
    }

    public var isLive: Bool {
        sc_dialect_is_live(dialect)
    }

    public var sessionID: String? {
        get { renamedSession }
        set {
            guard let newValue else { return }
            renamedSession = newValue
            withUTF8(newValue) { sc_dialect_rename_session(dialect, $0, $1) }
            drain()
        }
    }

    public func call(_ command: String, _ arguments: ChannelJSON = .null, timeout: Duration = .milliseconds(30_000)) async throws -> ChannelJSON {
        let argumentsJSON = try arguments.encoded()
        let key = withUTF8(command) { commandStart, commandLength in
            argumentsJSON.withUnsafeBytes { raw in
                sc_dialect_call(dialect, commandStart, commandLength, raw.bindMemory(to: UInt8.self).baseAddress, raw.count)
            }
        }
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                calls[key] = continuation
                deadlines[key] = Task { [weak self] in
                    do { try await Task.sleep(for: timeout) } catch { return }
                    self?.expire(key, after: timeout)
                }
                drain()
            }
        } onCancel: {
            Task { @MainActor [weak self] in self?.cancel(key) }
        }
    }

    public func closeStream(_ streamID: String) {
        withUTF8(streamID) { sc_dialect_close_stream(dialect, $0, $1) }
        drain()
    }

    public func connect() {
        persistent = true
        open()
    }

    public func disconnect() {
        persistent = false
        reconnection?.cancel()
        reconnection = nil
        if let socket {
            socket.cancel(with: .normalClosure, reason: nil)
            lose(socket, because: "the application disconnected")
        }
    }

    public func isStreamUp(_ streamID: String) -> Bool {
        withUTF8(streamID) { sc_dialect_is_stream_up(dialect, $0, $1) }
    }

    public func newSession() {
        sc_dialect_request_new_session(dialect)
        drain()
    }

    public func openStream(_ streamID: String) -> SecureChannelStream {
        if let held = openStreams[streamID] {
            return held
        }
        let stream = SecureChannelStream(streamID: streamID, client: self)
        openStreams[streamID] = stream
        withUTF8(streamID) { sc_dialect_open_stream(dialect, $0, $1) }
        drain()
        return stream
    }

    func writeStream(_ streamID: String, _ payload: Data) {
        withUTF8(streamID) { streamStart, streamLength in
            payload.withUnsafeBytes { raw in
                sc_dialect_write_stream(dialect, streamStart, streamLength, raw.bindMemory(to: UInt8.self).baseAddress, raw.count)
            }
        }
        drain()
    }

    private func armWatchdog() {
        watchdog?.cancel()
        let liveness = sc_dialect_liveness_seconds(dialect)
        guard liveness > 0, let watched = socket else {
            watchdog = nil
            return
        }
        let allowance = Duration.seconds(Int64(liveness))
        watchdog = Task { [weak self] in
            var due = ContinuousClock.now + allowance
            while true {
                do { try await Task.sleep(until: due, clock: .continuous) } catch { return }
                guard let self, self.socket === watched else { return }
                let silentUntil = self.lastTraffic + allowance
                if ContinuousClock.now >= silentUntil {
                    self.logger.error("SecureChannel \(self.request.url?.absoluteString ?? "", privacy: .public): nothing received for \(liveness) s (two keepalive periods), dropping the socket")
                    watched.cancel(with: .goingAway, reason: nil)
                    self.lose(watched, because: "two keepalive periods passed with nothing received")
                    return
                }
                due = silentUntil
            }
        }
    }

    private func cancel(_ key: UInt64) {
        sc_dialect_cancel(dialect, key)
        drain()
    }

    private func dispatch(_ action: ScAction) {
        let name = action.name.map { String(decoding: UnsafeBufferPointer(start: $0, count: action.name_length), as: UTF8.self) } ?? ""
        let body = action.body.map { Data(bytes: $0, count: action.body_length) } ?? Data()
        switch Int(action.kind) {
        case SC_ACTION_SEND_TEXT:
            send(.string(String(decoding: body, as: UTF8.self)))
        case SC_ACTION_SEND_BINARY:
            send(.data(body))
        case SC_ACTION_DROPPED:
            logger.notice("SecureChannel \(self.request.url?.absoluteString ?? "", privacy: .public) dropped \(String(decoding: body, as: UTF8.self), privacy: .public)")
        case SC_ACTION_SUCCEEDED:
            settle(action.key, with: .success(json(body, for: "the result of call \(action.key)")))
        case SC_ACTION_FAILED:
            settle(action.key, with: .failure(SecureChannelError.failed(json(body, for: "the error of call \(action.key)"))))
        case SC_NOTICE_CONNECTING:
            views.forEach { $0.connecting() }
        case SC_NOTICE_ONLINE:
            renamedSession = name
            lastTraffic = .now
            armWatchdog()
            views.forEach { $0.online(name) }
        case SC_NOTICE_OFFLINE:
            views.forEach { $0.offline() }
        case SC_NOTICE_NODES:
            let nodes = json(body, for: "nodes")
            views.forEach { $0.nodes(nodes) }
        case SC_NOTICE_IMPORT:
            let names = String(decoding: body, as: UTF8.self).split(separator: "\n").map(String.init)
            let exports = SecureChannelExports(names: names, client: self)
            views.forEach { $0.import(exports) }
        case SC_NOTICE_READY:
            views.forEach { $0.ready() }
        case SC_NOTICE_LATENCY:
            views.forEach { $0.latency(action.seconds) }
        case SC_NOTICE_TYPED_DATA:
            let message = json(body, for: "typed data \(name)")
            views.forEach { $0.typedData[name]?(message) }
        case SC_NOTICE_EXCEPTION:
            let error = json(body, for: "an exception")
            logger.error("SecureChannel \(self.request.url?.absoluteString ?? "", privacy: .public) server error: \(error.description, privacy: .public)")
            views.forEach { $0.exception(error) }
        case SC_NOTICE_STREAMS:
            let streams = json(body, for: "the stream advertisement")
            views.forEach { $0.streams(streams) }
        case SC_NOTICE_STREAM_UP:
            views.forEach { $0.streamUp(name) }
        case SC_NOTICE_STREAM_DOWN:
            views.forEach { $0.streamDown(name) }
        case SC_NOTICE_STREAM_CLOSED:
            openStreams.removeValue(forKey: name)?.finish()
            views.forEach { $0.streamClosed(name) }
        case SC_NOTICE_STREAM_BYTES:
            openStreams[name]?.deliver(body)
        default:
            logger.error("SecureChannel dialect produced unknown action kind \(action.kind)")
        }
    }

    private func drain() {
        var action = ScAction()
        while sc_dialect_next_action(dialect, &action) {
            dispatch(action)
        }
    }

    private func expire(_ key: UInt64, after timeout: Duration) {
        let milliseconds = timeout.components.seconds * 1_000 + timeout.components.attoseconds / 1_000_000_000_000_000
        sc_dialect_expire(dialect, key, UInt64(max(milliseconds, 0)))
        drain()
    }

    private func json(_ body: Data, for purpose: String) -> ChannelJSON {
        do {
            return try ChannelJSON.decoded(from: body)
        } catch {
            logger.error("SecureChannel \(self.request.url?.absoluteString ?? "", privacy: .public): \(purpose, privacy: .public) is not JSON (\(error.localizedDescription, privacy: .public)): \(String(decoding: body, as: UTF8.self), privacy: .public)")
            return .string(String(decoding: body, as: UTF8.self))
        }
    }

    private func lose(_ task: URLSessionWebSocketTask, because reason: String) {
        guard task === socket else { return }
        socket = nil
        watchdog?.cancel()
        watchdog = nil
        logger.notice("SecureChannel \(self.request.url?.absoluteString ?? "", privacy: .public) socket lost: \(reason, privacy: .public)")
        sc_dialect_closed(dialect)
        drain()
        guard persistent else { return }
        let delay = sc_dialect_reconnect_delay_seconds(dialect)
        reconnection = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(Int64(delay))) } catch { return }
            self?.open()
        }
    }

    private func open() {
        guard socket == nil else { return }
        let task = urlSession.webSocketTask(with: request)
        socket = task
        task.resume()
        sc_dialect_opened(dialect)
        drain()
        receive(on: task)
    }

    private func receive(on task: URLSessionWebSocketTask) {
        task.receive { [weak self] outcome in
            Task { @MainActor in self?.received(outcome, on: task) }
        }
    }

    private func received(_ outcome: Result<URLSessionWebSocketTask.Message, Error>, on task: URLSessionWebSocketTask) {
        guard task === socket else { return }
        switch outcome {
        case .success(let message):
            lastTraffic = .now
            switch message {
            case .string(let text):
                withUTF8(text) { sc_dialect_text(dialect, $0, $1) }
            case .data(let frame):
                frame.withUnsafeBytes { raw in
                    sc_dialect_binary(dialect, raw.bindMemory(to: UInt8.self).baseAddress, raw.count)
                }
            @unknown default:
                logger.error("SecureChannel \(self.request.url?.absoluteString ?? "", privacy: .public) received a WebSocket message of an unknown kind")
            }
            drain()
            receive(on: task)
        case .failure(let error):
            logger.error("SecureChannel \(self.request.url?.absoluteString ?? "", privacy: .public) receive failed: \(String(describing: error), privacy: .public)")
            lose(task, because: error.localizedDescription)
        }
    }

    private func send(_ message: URLSessionWebSocketTask.Message) {
        guard let task = socket else {
            logger.notice("SecureChannel \(self.request.url?.absoluteString ?? "", privacy: .public) has no socket; an outbound frame was dropped")
            return
        }
        task.send(message) { [weak self] error in
            guard let error else { return }
            Task { @MainActor in
                guard let self else { return }
                self.logger.error("SecureChannel \(self.request.url?.absoluteString ?? "", privacy: .public) send failed: \(String(describing: error), privacy: .public)")
                self.lose(task, because: error.localizedDescription)
            }
        }
    }

    private func settle(_ key: UInt64, with outcome: Result<ChannelJSON, Error>) {
        deadlines.removeValue(forKey: key)?.cancel()
        calls.removeValue(forKey: key)?.resume(with: outcome)
    }

    private func withUTF8<Answer>(_ text: String, _ body: (UnsafePointer<UInt8>?, Int) -> Answer) -> Answer {
        var copy = text
        return copy.withUTF8 { body($0.baseAddress, $0.count) }
    }
}
