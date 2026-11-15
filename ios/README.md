# SecureChannel for Apple platforms

The SecureChannel client for native Swift applications on iOS, tvOS and macOS: a Swift package (`SecureChannel`)
that speaks the SecureChannel WebSocket dialect to any SecureChannel `Channel`, the same dialect the framework's
web client (`dist/client.js`) and its own `ClientProtocol` speak. An application links it and talks to the same
service the web application talks to, with the same session, exports, typed data, cache replay and binary streams.

The framework (`index.js`, `utilities/`, `dist/`, `docs/`) is frozen prior art. Nothing here changes it, and
nothing here reimplements a server feature: deduplication, emission, cache replay, export bubbling, workers and
stream relay all stay on the server, and the Apple client receives their results exactly as a browser does.

## What is shared and what is native

- **The dialect** is one Rust library, `securechannel-dialect` (`rust/crates/securechannel-dialect`): the frame
  codec, the envelopes, the handshake, the transaction table, the stream index and the reconnect timing. It does no
  I/O. It is reached from Swift through a C ABI (`rust/crates/securechannel-dialect-c`: `libsecurechannel_dialect_c.a`, `include/securechannel_dialect.h`),
  the one boundary crate (`BOUNDARY.md`), built into `build/SecureChannelDialect.xcframework`.
- **The transport** is Apple's own: `URLSessionWebSocketTask` (TLS, the system trust store, cookies from
  `HTTPCookieStorage`, answering the server's WebSocket pings), timers as Swift tasks, logging through `os.Logger`
  (subsystem `SecureChannel`).
- **The API** is Swift (`Sources/SecureChannel`), on the main actor.

The same Rust library is the dialect for any later native client (Linux, Windows); each of those brings its own
transport the way this package brings Apple's.

## The wire

Every frame on the socket is one of two kinds.

**Text frames** are JSON envelopes `{"type": T, "message": M}`. The client acts on these types:

| type | direction | message | what the client does |
|---|---|---|---|
| `up` | server → client | `{timestamp, SessionID, keepalive}` | records the session and the keepalive, counts the socket live, tells the views `online(SessionID)` |
| `checkin` | server → client | `{nodes}` | tells the views `nodes(nodes)`, then sends `exports`, or `checkin` when the exports are already known |
| `exports` | client → server | `{}` | asks for the export names |
| `import` | server → client | `{exports: [names]}` | hands every view the exports, then sends `checkin` |
| `checkin` | client → server | `{}` | asks for the state replay |
| `ready` | server → client | `{}` | restates every held stream subscription, then tells the views `ready()` |
| `request` | client → server | `{key, request: {command, ...args}}` | a call to an export |
| `response` | server → client | `{key, result: {result} or {error}}` | settles the call with that key |
| `data` | server → client | `{type, message}` | typed data (the server's CachedData publications and replays): routed to the views by `type` |
| `latency` | server → client | `{latency}` | tells the views `latency(seconds)` |
| `streams` | server → client | `{streams: [{streamId, uid}]}` | reconciles the stream index |
| `streamSubscribe`, `streamUnsubscribe` | client → server | `{streamId}` | a view's interest in a stream |
| `error` | server → client | `{error}` | tells the views `exception(error)` |
| `sessionid` | client → server | `{SessionID}` | renames the session on the server |
| `newsession` | client → server | `{}` | asks the server for a new session (`up` again) |

A text frame that is not JSON, has no string `type` or whose `message` is not an object is dropped, as the web
client drops it; any other type is not the client's and is ignored.

**Binary frames** are stream frames: `[0xFE][frame type][uid: u32 big-endian][payload]`. Only frame type `0x01`
(data) carries payload; the server mints every uid, the client never does. A frame whose uid is not wired to a
stream the client holds is dropped.

## The handshake and its replay

```
socket open → up → checkin{nodes} → exports → import → checkin → (server replays its cache as data, nodes, streams) → ready
```

On every reconnect the handshake runs again; the client sends `exports` only until it has the names once, then goes
straight to `checkin` (the framework's `ClientProtocol` rule). The server's replay between `checkin` and `ready` is
the whole state: views receive it through the same typed-data routing as live updates and never ask for it.

## Calls

`request` carries a key the client mints (a counter, unique per client) and the command with its one argument
object (`node` is the framework's routing key and passes through untouched). A call is refused at once with
`socket not ready` while the socket is not live, settles with the server's `result` or `error`, fails with
`request timed out: COMMAND after Nms` when its time runs out (30 000 ms unless the caller gives one), and fails
with `aborted` when the caller cancels it or the socket is lost.

## Streams

The client's stream rules are the web client's:

- A view opens a stream by its streamId; the stream exists from open to close whatever happens to the socket, and
  only closing it ends it.
- A stream is **up** while its streamId is in the server's latest `streams` advertisement; the client then knows
  its uid. Every transition from down to up restates the subscription (`streamSubscribe`), as the server's
  subscription tag dies with its socket or its stream.
- Bytes a view writes go out as data frames under the current uid; written while the stream is down they are
  dropped, never queued, so stale input never replays into a healed stream.
- Views hear `streams(list)`, `streamUp(id)`, `streamDown(id)` and `streamClosed(id)`, and each open stream's bytes.

## Liveness and reconnecting

The server pings every `keepalive` seconds (from `up`) and answers each pong with `latency`. Any inbound frame
counts as life; with a keepalive set, two keepalive periods without one drop the socket, as the framework's own
client does. Losing the socket suspends the client: every call in flight fails with `aborted`, every stream goes
down (its subscription is kept), and the views hear `offline()`.

My choice, not a framework rule: a dropped client reconnects at once the first time and then waits one more second
per further failure, up to five seconds, starting over after each `up`; a client the application disconnected stays
down.

## The Swift API

```swift
import SecureChannel

@MainActor final class KitchenView: SecureChannelView {
    var exports = SecureChannelExports()
    var typedData: [String: (ChannelJSON) -> Void] {
        ["recipes": { recipes in self.show(recipes) }]
    }
    func `import`(_ exports: SecureChannelExports) { self.exports = exports }
    func online(_ sessionID: String) {}
    func offline() {}
}

let client = SecureChannelClient(request: URLRequest(url: URL(string: "wss://recipes.example.com/channels/data")!), views: [view])
client.connect()
let saved = try await view.exports.saveRecipe(["name": "Bread"])
```

- `SecureChannelClient(request:views:)` connects to one channel; the request carries any headers the server's
  front door needs, and cookies come from the shared cookie storage.
- A view declares the typed data it consumes in `typedData`, keyed by type: that table is the whole wiring, the
  counterpart of the web view's methods named after the type. Lifecycle hooks (`import`, `online`, `offline`,
  `latency`, `nodes`, `ready`, `exception`, and the stream hooks) have empty defaults.
- `SecureChannelExports` holds the export names from `import`: `exports.NAME(args)` (dynamic member) calls that
  export and returns its result as `ChannelJSON`, throwing `SecureChannelError` on refusal, error, timeout or abort.
- `ChannelJSON` is the JSON tree every message arrives as and every argument goes out as.
- `client.openStream(id)` returns the stream's `SecureChannelStream` (the same one for every caller):
  `payloads()` gives each caller an `AsyncStream<Data>` of its own (the fanout), `write(_:)` sends (the collator);
  `client.closeStream(id)` ends it and every consumer, `client.isStreamUp(id)` says whether it is up.
- `client.sessionID` is the session from the last `up`, or the name set since; setting it renames the session on
  the server (`sessionid`). `client.newSession()`, `client.isLive`, `client.disconnect()`.

## Building

On the Mac, in this folder: `make` builds the dialect for every Apple slice (iOS device and simulator, tvOS device and
simulator, macOS) and assembles `build/SecureChannelDialect.xcframework`; then `swift build` or any Xcode project that
adds this folder as a local package dependency builds the package. The tvOS simulator on an Intel Mac needs
`x86_64-apple-tvos`, which rustup does not ship: `make` builds that slice with the nightly toolchain's `build-std`.

## Layout

```
ios/
  Package.swift                     the Swift package SecureChannel (iOS 16, tvOS 16, macOS 13)
  Sources/SecureChannel/            the Swift API and the URLSession transport
  Makefile                          the xcframework
  BOUNDARY.md                       the one crate allowed unsafe code
  rust/                             the Cargo workspace (rust-policy's lints, clippy.toml, deny.toml)
    crates/securechannel-dialect/   the dialect, no I/O
    crates/securechannel-dialect-c/ its C ABI and header
```
