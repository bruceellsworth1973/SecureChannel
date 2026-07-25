# SecureChannel Binary Streams

**Date:** 2026-06-07
**Covers:** SubstreamDuplex API, StreamIndex registry, UID-addressed binary frame protocol, declarative stream advertisement and subscription, layer-uniform propagation, Passthrough relay, browser client

---

## Overview

SecureChannel provides named binary stream pipes where a stream created at any layer of the SC3 stack is accessible at every other layer up to the browser client. Each layer owns a `StreamIndex` registry of `SubstreamDuplex` instances. Binary payload travels a parallel binary frame path on WebSocket hops and on process boundaries — child processes are forked with `serialization: 'advanced'`, so binary `BinaryFrame` buffers cross IPC natively (there is no JSON `streamData`/`streamEnd` envelope).

A SubstreamDuplex is **two independent unidirectional streams** addressed by a single stream identifier:

- **Collator** (many → one): A `QueueIterator` accessible via `stream.collator`. Multiple writers feed it; one reader consumes it. In a shell context: multiple browser clients write keystrokes into the collator; a single pump reads and delivers them to SSH stdin.
- **Fanout** (one → many): An `AsyncFanout` accessible via `stream.fanout`. One writer feeds it; multiple consumers each get an independent copy. In a shell context: SSH stdout writes to the fanout; each connected browser client has a consumer pump that independently reads from the fanout.

These two streams never cross. Data entering the collator never appears in the fanout. Data entering the fanout never appears in the collator. At every layer (Node, Worker, Channel, Passthrough, browser), the collator and fanout maintain this separation. IPC and WebSocket relays at each boundary bridge collator-to-collator and fanout-to-fanout — never collator-to-fanout.

**Terminology:** Do not use "inbound" and "outbound" to describe the streams — these terms are relative to the observer and flip at every boundary. Use "collator" (many→one) and "fanout" (one→many) as absolute identifiers that never change regardless of which layer you are examining.

The system is:
- **Cohesive** — one class (`SubstreamDuplex`), one interface at every layer
- **Symmetric** — same construction pattern at Node, Worker, Channel, Passthrough, and browser
- **Automatic** — the framework handles stream bookkeeping and propagation; application code uses `openStream()` / `closeStream()` at the Node layer and treats the framework as a black box

---

## SubstreamDuplex Class

Located in `utilities/substreamDuplex.js`. Used at every layer of the SC3 stack. Extends `EventEmitter`. Composes a `QueueIterator` (the `collator`) and an `AsyncFanout` (the `fanout`).

### Constructor

```javascript
new SubstreamDuplex()
```

Takes no arguments. The streamId↔uid identity is owned by the enclosing `StreamIndex`, not by the duplex instance. `StreamIndex.add(streamId, uid, stream)` default-constructs a `SubstreamDuplex` when no instance is supplied.

### Public interface

```javascript
class SubstreamDuplex extends EventEmitter
{
    ended           // boolean lifecycle state
    fanout          // AsyncFanout — the fanout stream (one writer, many consumers)
    collator        // QueueIterator — the collator stream (many writers, one reader)
    sockets         // Set of subscribed websockets
    get isSubscribed()   // true when sockets.size > 0

    write(frame)    // writes a frame to the fanout (emits 'write')
    process(frame)  // writes a frame to the collator (emits 'process')
    end()           // orderly shutdown: ends fanout + collator, clears sockets (emits 'end')
    close()         // alias for end()
    fail(reason)    // error shutdown: fails fanout + collator, clears sockets (emits 'fail')

    [Symbol.asyncIterator]()   // returns fanout.consumer() — a fresh independent consumer

    // EventEmitter surface: on / off / once / emit / removeAllListeners
    // Lifecycle events: 'write', 'process', 'end', 'fail'
}
```

### Internal composition

- **Fanout path (one→many):** `stream.fanout` is an `AsyncFanout`. `stream.write(frame)` pushes to it. Each call to `stream.fanout.consumer()` (or `for await (const frame of stream)`) creates an independent consumer that receives its own copy of every frame.
- **Collator path (many→one):** `stream.collator` is a `QueueIterator`. `stream.process(frame)` pushes to it. A single reader consumes it via `for await (const frame of stream.collator)`.

### Supporting primitives (same file)

- `QueueIterator extends EventEmitter` — an idempotent async-iterator queue. `write(value)`, `end(aborted = false)`, `close()`, `fail(error)`, `next()`, `return()`. `end()`/`fail()` route through a shared `finalPacket`; the aborted path clears the queue. `consume(onData, onFail, onEnd, abortSignal)` returns a `startPump` async function.
- `AsyncFanout extends QueueIterator` — `consumer()` mints a child `QueueIterator` that auto-detaches on its own fail/end; the parent broadcasts write/fail/end to every consumer.
- `StreamIndex` — the per-link registry of streams and the uid mapping (see Stream Registry below).
- `resolveStream(validStream, streamIndex)` — module-level helper. Maps a parsed frame's `uid` to its `SubstreamDuplex` via `streamIndex.get(uid)`, or returns `null`.
- `toReadable(asyncIterable, options)` / `toWritable(sink, options)` — Node.js `stream` adapters for bridging to native streams.

### Exports from `substreamDuplex.js`

```javascript
const {
    BinaryFrame,
    StreamIndex,
    QueueIterator,
    AsyncFanout,
    SubstreamDuplex,
    resolveStream,
    toReadable,
    toWritable
} = require('./utilities/substreamDuplex.js');
```

`BinaryFrame`, `StreamIndex`, `QueueIterator`, `AsyncFanout`, `toReadable`, and `toWritable` are also re-exported from the framework root (`require('securechannel')`).

---

## Binary Frame Protocol

Binary data on WebSocket connections and over advanced-serialization IPC uses a compact frame format with a fixed 6-byte header.

### Constants

The frame-type constants are static members of `BinaryFrame`:

```javascript
BinaryFrame.sentinel   // 0xFE
BinaryFrame.data       // 0x01
BinaryFrame.open       // 0x02
BinaryFrame.close      // 0x03
BinaryFrame.error      // 0x04
BinaryFrame.headerSize // 6
```

### Frame format

```
[sentinel(1)][frameType(1)][uid:uint32BE(4)][payload(N)]
```

- `sentinel` — `0xFE`, distinguishes binary stream frames from JSON messages
- `frameType` — one of `BinaryFrame.data`, `.open`, `.close`, `.error`
- `uid` — uint32, the local numeric identifier for the stream on this link
- `payload` — arbitrary binary data, coerced by `BinaryFrame.toBuffer`

### BinaryFrame class

Frames are built and parsed by the static `BinaryFrame` class (not free functions):

- `BinaryFrame.build(frameType, uid, data)` → `Buffer`. `data` is coerced via `toBuffer`.
- `BinaryFrame.parse(buffer)` → `{ frameType, uid, payload }` or `null` (validates length and sentinel).
- `BinaryFrame.toBuffer(data)` — coercion helper: `null` → empty buffer, `Buffer` passthrough, `string` → `Buffer.from(string)`, `{ type: 'Buffer', data: [...] }` → `Buffer.from(data.data)`, anything else → JSON-stringify then `Buffer.from`.
- `BinaryFrame.mintUID(streamIndex)` — mints a monotonic, collision-free uint32 uid from the index's `next` counter.

Frames are addressed by numeric `uid`, **not** by string `streamId`. The string↔uid mapping lives in each link's `StreamIndex`.

### UID management — framework only

Application code uses string streamIds throughout. The binary frame protocol uses uint32 uids for compact wire representation. **The application never assigns, reads, or passes uids.** The framework handles the streamId↔uid mapping at every layer.

Each link's `StreamIndex` owns the mapping:

```javascript
streamIndex.byStreamId   // Map<string, uint>
streamIndex.byUID        // Map<uint, string>
streamIndex.next         // next uid counter
```

- The Channel/Node `sendBinary(frameType, streamId, payload, ws)` resolves `streamId → uid` via `streamIndex.getUID(streamId)` before building the frame. The Worker's `sendBinary(frameType, uid, payload)` is already uid-addressed.
- Inbound binary frame dispatch parses the frame, then routes via `resolveStream(validStream, streamIndex)` — keyed directly on the frame's `uid`.
- The mapping is local to each link — it does not cascade across hops. The Worker translates between a child uid namespace (`_childStreamIndex`) and the channel uid namespace (`channel.streamIndex`).

---

## Stream Advertisement and Subscription — Declarative Registry Lifecycle

Stream availability and subscription state travel the standard SC3 emit chain as the `streams` and `subscriptions` message types, reconciled declaratively by `StreamIndex` at each layer. There is **no** `{ action: 'open' | 'close', metadata }` advertisement envelope — that was the pre-Sprint-3 model.

### Message shapes

```javascript
// Advertisement (bottom-up): the current set of live streams
{ type: 'streams', message: { streams: [ { streamId: 'cam-01', uid: 7 } ] } }

// Subscription request (per-socket, client → channel)
{ type: 'streamSubscribe',   message: { streamId: 'cam-01' } }
{ type: 'streamUnsubscribe', message: { streamId: 'cam-01' } }

// Subscription delta broadcast (top-down, channel → workers → node)
{ type: 'subscriptions', message: [ 'cam-01', 'cam-02' ] }
```

### Advertisement — bottom-up only

A producer registers a stream in its `StreamIndex` and calls `publishStreams()`, emitting the full live set upward. Each layer applies `StreamIndex.reconcileStreams(streams, onOpen, onClose)` to open or close local `SubstreamDuplex` instances so the local registry matches the advertised set.

```
Node: this.openStream(streamId)
  → mints its own uid, registers the stream, calls publishStreams()
  → emits { type: 'streams', message: { streams } } via IPC to the Worker
  → Worker._NodeEvents.streams reconciles _childStreamIndex, calls channel.publishStreams()
  → Channel publishStreams() broadcasts the 'streams' message to subscribed clients
  → Browser Client 'streams' route reconciles its streamMap
```

The advertisement never travels top-down.

### Subscription — top-down

Subscription is a separate concern from advertisement. A browser sends `streamSubscribe`; the Channel mints a uid if needed, calls `subscribeStream(streamId, uid, ws)` (which adds `ws` to the stream's `sockets` set and attaches a per-socket fanout consumer pump), then `reconcileSubscriptions()` recomputes the active set via `StreamIndex.getActiveStreams()` and broadcasts a `subscriptions` delta downward through every worker via `messageAll`. Workers and Nodes apply the delta through `StreamIndex.subscribe`, which gates which streams actually produce data.

A Passthrough mirrors subscription deltas onto its remote channel by sending `streamSubscribe` / `streamUnsubscribe` per delta.

---

## Layer Glue — How Each Layer Wires Streams

Each layer owns a `StreamIndex` and wires its transport into the `SubstreamDuplex` `write()` / `process()` / `fanout` / `collator` interface. Binary frames are distinguished from JSON by the `0xFE` sentinel and intercepted before JSON dispatch at every layer.

### Node ↔ Worker (binary IPC)

The child is forked with `serialization: 'advanced'`, so Buffers cross IPC natively. Stream payloads travel as binary `BinaryFrame` buffers. Lifecycle travels as the `streams` message; subscription as the `subscriptions` message.

**Node.openStream(streamId):** registers the stream in `this.streamIndex` (minting its own uid), pumps `stream.fanout.consume(...)` → `sendBinary(BinaryFrame.data, streamId, payload)` upward toward the Worker, and calls `publishStreams()`. Returns the `SubstreamDuplex` for the Node to write to via `stream.write(payload)` (fanout) and read from via `stream.collator` (collator).

**Node inbound:** `_interfaceSignals.message` parses each frame; binary frames route via `resolveStream(validStream, this.streamIndex)?.process(payload)`. `unwrapFrames` (default `true` on `Node`) controls whether the raw payload or the full frame is delivered to the collator.

**Node `_localEvents.subscriptions`:** replaces the local subscription set via `StreamIndex.subscribe` and re-publishes.

**Worker `_NodeEvents.streams`:** receives the child advertisement, reconciles `_childStreamIndex` via `reconcileStreams`, and calls `channel.publishStreams()`.

**Worker.openStream(streamId, childUID):** registers the stream against both the child uid namespace (`_childStreamIndex`) and the channel uid namespace, then pumps the channel-uid `collator` downward — rewrapping each frame from the channel uid into the child uid before sending it to the child over IPC.

**Worker inbound binary frames** (in the fork `message` callback): resolve against `_childStreamIndex`, then rewrap child-uid → channel-uid and `stream.write(...)` into the channel fanout.

### Channel ↔ WebSocket (binary frames)

- `channel.sendBinary(frameType, streamId, payload, ws)` resolves `streamId → uid` via `streamIndex.getUID` and sends a `BinaryFrame`.
- `channel.subscribeStream(streamId, uid, ws)` registers the stream, adds `ws` to the stream's `sockets`, and attaches a per-socket fanout consumer pump (guarded by an `AbortController`) that delivers each frame to that socket.
- `channel.unsubscribeStream(streamId, ws)` drops `ws` from the stream's `sockets`.
- `channel.registerStream(streamId, uid)` / `channel.unregisterStream(streamId)` manage registry membership without per-socket fanout.
- `channel.publishStreams(ws)` emits the current `streamIndex.list()` as a `streams` message.
- Inbound binary frame dispatch is inline in the `listen()` and `connect()` socket `message` handlers: `BinaryFrame.parse` → `resolveStream(...).process(frame)` on the server side, `resolveStream(...).write(frame)` on the client side.
- `channel.destroy()` closes every stream in `streamIndex` and clears it.

There is **no** Channel `openStream` / `closeStream`. Those names were removed; the Channel surface is `registerStream` / `unregisterStream` / `subscribeStream` / `unsubscribeStream` / `publishStreams` / `reconcileSubscriptions`.

### Passthrough (remote SC3 bridge)

The Passthrough bridges binary streams bidirectionally between a remote SC3 server (WebSocket) and the parent Channel (IPC). It sets `unwrapFrames = false` and delegates `streams` and `streamIndex` to its embedded `SecureChannel`.

**Advertisement reconciliation:** the constructor's `populateStreams` handler applies `streamIndex.reconcileStreams(...)`, opening a local `SubstreamDuplex` per advertised remote stream.

**openStream(streamId, uid):** runs two consume pumps guarded by an `AbortController` — the `collator` pump forwards frames toward the remote socket, the `fanout` pump forwards frames toward the parent over IPC.

**Subscription mirroring:** the `subscriptions` handler diffs the parent's subscription list against the local set and mirrors each delta onto the remote channel via `streamSubscribe` / `streamUnsubscribe`.

**Binary frames** from the remote route via `resolveStream(validStream, this.streamIndex)?.write(frame)`.

No application code is needed in the Passthrough subclass — the framework handles all stream relay automatically.

### Browser client

`dist/client.js` ships its own `BinaryFrame`, `EventEmitter`, `QueueIterator`, and `SubstreamDuplex`, plus a `StreamConsumer` wiring class. The browser `SecureChannel` holds:

```javascript
streams    // Map<string, StreamConsumer>
streamMap  // { byUID: Map<uint, string>, byStreamId: Map<string, uint> }
```

- `channel.openStream(streamId, uid)` constructs a `StreamConsumer` and stores it in `streams`.
- `channel.closeStream(streamId)` tears the stream down and clears the uid mapping.
- `channel.sendBinary(frame)` sends a pre-built binary frame over the WebSocket.
- `binaryType = 'arraybuffer'` is set on the socket; binary inbound dispatch is inline in `onmessage`, resolving uid → streamId via `streamMap`.

The `Client` `streams` route reconciles the advertised set into `streamMap`; the `down` route clears the map and closes all streams. The default client `openStream(streamId)` export first issues the `subscribeStream` command to obtain a uid from the server, then constructs the `StreamConsumer` — subscribe-then-open.

---

## Stream Registry — StreamIndex

### SecureChannel (Channel layer)

`this.streamIndex = new StreamIndex()` is the per-link registry. It holds `byStreamId`, `byUID`, `streams` (a `Map` of `SubstreamDuplex` instances keyed by string streamId), `subscriptions`, and a `next` uid counter.

Public methods on the Channel:
- `registerStream(streamId, uid)` — adds the stream to the index (minting a uid if absent) and returns the `SubstreamDuplex`.
- `unregisterStream(streamId)` — removes the stream from the index.
- `subscribeStream(streamId, uid, ws)` — registers, adds `ws` to `sockets`, and attaches a per-socket fanout consumer pump.
- `unsubscribeStream(streamId, ws)` — drops `ws` from the stream's `sockets`.
- `publishStreams(ws)` — emits `streamIndex.list()` as a `streams` message.
- `reconcileSubscriptions()` — recomputes the active set and broadcasts a `subscriptions` delta downward.

### Worker and Node layers

The Worker holds `_childStreamIndex` (the child uid namespace, distinct from `channel.streamIndex`) and exposes `registerStream` / `openStream` / `closeStream`. The Node holds `_streamIndex` and exposes the application-facing `openStream(streamId)` / `closeStream(streamId)`. Both reconcile declaratively via `StreamIndex.reconcileStreams` / `StreamIndex.subscribe`.

---

## Complete Data Flow Diagram

### Fanout direction (SSH output → browser)

```
Node application
  → stream.write(chunk)                  — writes to the fanout
  → fanout consumer pump: sendBinary(BinaryFrame.data, streamId, payload)
  ─────────────[ IPC (advanced serialization, binary frame) ]─────────────→
  → Worker message handler: resolveStream(frame, _childStreamIndex)
                            rewrap child-uid → channel-uid, stream.write(frame)
  → Channel per-socket fanout consumer pump: send(frame, ws)
  ─────────────[ WebSocket (binary frame) ]─────────────→
  → Browser onmessage: BinaryFrame.parse → streamMap uid→streamId
                       → StreamConsumer.process(payload) → view 'data'
```

### Collator direction (browser keystrokes → SSH stdin)

```
Browser application
  → StreamConsumer.write(data) → channel.sendBinary(BinaryFrame.build(...))
  ─────────────[ WebSocket (binary frame) ]─────────────→
  → Channel listen() message handler: resolveStream(frame, streamIndex).process(frame)
  → Worker collator pump: for await (const frame of stream.collator)
                          rewrap channel-uid → child-uid, sendBinary to child
  ─────────────[ IPC (advanced serialization, binary frame) ]─────────────→
  → Node message handler: resolveStream(frame, streamIndex).process(payload)
  → Node application: for await (const frame of stream.collator) → SSH stdin
```

### Through a Passthrough relay

```
Remote Channel advertises via 'streams'
  → Passthrough populateStreams: streamIndex.reconcileStreams → openStream(streamId, uid)
  → Passthrough runs collator pump (→ remote socket) and fanout pump (→ IPC)

Fanout (remote → parent → browser):
  Remote Channel → sendBinary() binary frame over WebSocket
  → Passthrough forwardToIPC: resolveStream(frame, streamIndex).write(frame)
  → fanout pump forwards the frame to the parent Worker over IPC
  → parent Worker rewraps to channel-uid, stream.write(frame)
  → Channel per-socket fanout pump → sendBinary to browser

Collator (browser → parent → remote):
  Browser → channel.sendBinary() binary frame to parent server
  → parent Channel resolveStream(...).process(frame)
  → parent Worker collator pump → binary frame to Passthrough child over IPC
  → Passthrough collator pump → channel.send(frame) binary frame to remote
```

---

## Application Integration Patterns

### Session identity vs stream transport

Two separate concerns share the same streamId as a key:

- **Session** (application concept): An SSH session, deployment, or other long-running process with metadata — hostname, status, log path. Managed by application-level exports and CachedData.
- **Stream** (framework concept): A bidirectional binary transport pipe. Managed by the framework's registry. UID assignment, binary frame encoding/decoding, consumer pump management, and inter-layer relay are all framework-internal. The application never sees or manages uids.

### Opening a stream from a Node

The Node is the application's entry point into the stream system. `Node.openStream(streamId)` creates the `SubstreamDuplex`, mints the stream's uid, wires the fanout pump toward the Worker, and publishes the advertisement upward:

```javascript
const stream = this.openStream(streamId);

// Fanout: write process output toward subscribed browsers
for await (const chunk of process.stdout)
{
    stream.write(chunk);
}

// Collator: read browser input flowing back toward the process
for await (const frame of stream.collator)
{
    process.stdin.write(frame);
}
```

`Node.closeStream(streamId)` tears the stream down and re-publishes the advertisement.

### Server-authoritative state

Session state (dimensions, status, metadata) is broadcast via CachedData, not via stream data or export responses. The browser receives session state reactively and does not depend on export return values for state discovery.

---

## Test Coverage

The test runner is `tests/run.js`: it discovers every `*.test.js` / `*.test.mjs` file in `tests/`, runs each with `node` (plain assertions, not jest), and exits non-zero on any failure (`npm test` → `node tests/run.js`).

| Suite | Scope |
|-------|-------|
| `async-fanout.test.js` | `AsyncFanout` / `QueueIterator` primitive |
| `duplex-fanout.test.js` | `SubstreamDuplex` fanout and collator behavior |
| `channel-api.test.js` | Channel-level API, including the stream registry surface |
| `controller-cache.test.js` | Controller cache / nodes state |
| `binary-relay.test.mjs` | End-to-end binary relay, including Passthrough fixtures |

Fixtures live in `tests/fixtures/` (`binary-emitter.js`, `node-emitter.js`, `passthrough-relay.js`).

Per-suite pass counts are not asserted here — the suites have not been re-run as part of this documentation pass. Run `npm test` to verify current status.

---

**End of Binary Streams Documentation**
