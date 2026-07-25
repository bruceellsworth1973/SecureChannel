# SecureChannel Connection Handshake

**Date:** 2026-01-20
**Connection handshake sequence until 'ready' state is reached**

---

## Connection Handshake Sequence

```
CLIENT                           NETWORK                                 SERVER
  |═════ WebSocket Handshake ══════>|                                       |
  |                                 |                                       |
  |                                 |════════ Connection: Upgrade ═════════>|
  |                                 |                                       |
  |                                 |<═══ HTTP 101: Switching Protocols ════|
  |                                 |                                       |
  |<═══ WebSocket Established ══════|                                       |
  |                                 |                                       |

            *** SecureChannel Low Level Protocol Handshake ***
          *** Triggered automatically upon connection opened ***

  |                                 |═════════ connection opened ══════════>|
  |                                 |                                       |──┐
  |                                 |                                       |  | start session handshake
  |                                 |                                       |  | push unique SessionID to client
  |                                 |                                       |  | 
  |                                 |                                       |  | emit('up', {
  |                                 |                                       |  |     timestamp,
  |                                 |                                       |  |     SessionID
  |                                 |                                       |  | })
  |                                 |                                       |<─┘
  |                                 |                                       |
  |                                 |<═════════ emit "up" message ══════════|
  |                                 |                                       |
  |<════ trigger "up" handler ══════|                                       |
  |                                 |                                       |
  |──┐                              |                                       |
  |  | echo received SessionID,     |                                       |
  |  | or supply a new one          |                                       |
  |  |                              |                                       |
  |  | emit('up', {                 |                                       |
  |  |     address, SessionID       |                                       |
  |  | })                           |                                       |
  |<─┘                              |                                       |
  |                                 |                                       |
  |═══════ emit "up" message ══════>|                                       |
  |                                 |                                       |
  |                                 |════════ trigger "up" handler ════════>|
  |                                 |                                       |
  |                                 |                                       |──┐
  |                                 |                                       |  | capture client SessionID
  |                                 |                                       |  | session handshake complete
  |                                 |                                       |<─┘
  |                                 |                                       |

            *** SecureChannel High Level Protocol Handshake ***
          *** Triggered automatically upon connection opened ***

  |                                 |═════════ connection opened ══════════>|
  |                                 |                                       |
  |                                 |                                       |──┐
  |                                 |                                       |  | start checkin cycle
  |                                 |                                       |  | push node state to client
  |                                 |                                       |  |
  |                                 |                                       |  | emit('checkin', {
  |                                 |                                       |  |     nodes
  |                                 |                                       |  | })
  |                                 |                                       |<─┘
  |                                 |                                       |
  |                                 |<═══════ emit "checkin" message ═══════|
  |                                 |                                       |
  |<══ trigger "checkin" handler ═══|                                       |
  |                                 |                                       |
  |──┐                              |                                       |
  |  | capture node state           |                                       |
  |  |                              |                                       |
  |  | then                         |                                       |
  |  |                              |                                       |
  |  | perform abbreviated sync     |                                       |
  |  | and go straight to checkin   |                                       |
  |  |                              |                                       |
  |  | emit('checkin', {})          |                                       |
  |  |                              |                                       |
  |  | or                           |                                       |
  |  |                              |                                       |
  |  | perform full protocol and    |                                       |
  |  | request exported methods     |                                       |
  |  |                              |                                       |
  |  | emit('exports', {})          |                                       |
  |<─┘                              |                                       |
  |                                 |                                       |
  |════ emit "exports" message ════>|                                       |
  |                                 |                                       |
  |                                 |══════ trigger "exports" handler ═════>|
  |                                 |                                       |
  |                                 |                                       |──┐
  |                                 |                                       |  | push exported method names
  |                                 |                                       |  |
  |                                 |                                       |  | emit('import', {
  |                                 |                                       |  |     exports
  |                                 |                                       |  | })
  |                                 |                                       |<─┘
  |                                 |                                       |
  |                                 |<═══════ emit "import" message ════════|
  |                                 |                                       |
  |<═══ trigger "import" handler ═══|                                       |
  |                                 |                                       |
  |──┐                              |                                       |
  |  | capture exports              |                                       |
  |  |                              |                                       |
  |  | emit('checkin', {})          |                                       |
  |<─┘                              |                                       |
  |                                 |                                       |
  |════ emit "checkin" message ════>|                                       |
  |                                 |                                       |
  |                                 |═════ trigger "checkin" handler ══════>|
  |                                 |                                       |
  |                                 |                                       |──┐
  |                                 |                                       |  | checkin cycle complete
  |                                 |                                       |  | push channel state
  |                                 |                                       |  | connection established
  |                                 |                                       |  |
  |                                 |                                       |  | emit('ready', {})
  |                                 |                                       |<─┘
  |                                 |                                       |
  |                                 |<═══════ emit "ready" message ═════════|
  |                                 |                                       |
  |<═══ trigger "ready" handler ════|                                       |
  |                                 |                                       |
  |──┐                              |                                       |
  |  | capture channel state        |                                       |
  |  | handshake complete           |                                       |
  |  | connection established       |                                       |
  |<─┘                              |                                       |
  |                                 |                                       |

```

---

## Connection Handshake Message Types

### 1. Connection Initialization Messages

| Type | Direction | When | Purpose | Payload |
|------|-----------|------|---------|---------|
| `up` | Server → Client | After WebSocket established | Session initialization | `{timestamp, SessionID, keepalive}` |
| `sessionid` | Client → Server | After receiving 'up' | Session synchronization | `{SessionID}` |

**Note:** The `newsession` message type exists for forcing new session creation but is not part of the standard connection handshake. The `channel.sessions()` function triggers a local event only and does not send a message over the wire.

---

### 2. Exports Handshake Messages

| Type | Direction | When | Purpose | Payload |
|------|-----------|------|---------|---------|
| `exports` | Client → Server | After session established | Request available exports | `{}` |
| `import` | Server → Client | In response to 'exports' | Send list of callable functions | `{exports: ['fn1', 'fn2', ...]}` |
| `checkin` | Client → Server | After receiving exports | Ready to receive state | `{}` |
| `ready` | Server → Client | After pushState() complete | Connection fully synchronized | `{}` |

---

## Connection Handshake Branches

### Branch A: With Exports Handshake (Full Handshake)

```
WebSocket → up → sessionid → exports → import → checkin → pushState() → ready
```

**When:** Client explicitly requests exports list
**Use case:** Initial connection where client needs to discover available remote functions
**Message Count:** 6 messages

---

### Branch B: Without Exports Handshake (Direct Connection)

```
WebSocket → up → sessionid → pushState() → ready
```

**When:** Client doesn't request exports (already knows them)
**Use case:** Reconnection with known exports, or client configured to skip discovery
**Message Count:** 3 messages

---

## Handshake Message Sequence

### Complete Handshake (With Exports)

```
1. up                          (Server → Client: Session initialization)
2. sessionid                   (Client → Server: Session synchronization)
3. exports                     (Client → Server: Request exports)
4. import                      (Server → Client: Send exports list)
5. checkin                     (Client → Server: Ready for state)
6. ready                       (Server → Client: Handshake complete)
```

### Minimal Handshake (Without Exports)

```
1. up                          (Server → Client: Session initialization)
2. sessionid                   (Client → Server: Session synchronization)
3. ready                       (Server → Client: Handshake complete)
```

**Note:** The `pushState()` call on the server may trigger application-specific messages between `checkin` and `ready` (or between `sessionid` and `ready` in minimal handshake). These are not part of the protocol handshake and should be documented separately.

---

## Message Metadata

Every message has metadata automatically added by the protocol:

### Client → Server
Client sends:
```json
{
  "type": "exports"
}
```

Server receives (metadata added):
```json
{
  "type": "exports",
  "address": "192.168.1.10",      // Added by server
  "SessionID": "3f2a1b..."         // Added by server
}
```

### Server → Client
Server sends:
```json
{
  "type": "ready"
}
```

Client receives (metadata added):
```json
{
  "type": "ready",
  "address": "192.168.1.10",      // Added by server
  "SessionID": "3f2a1b..."         // Added by server
}
```

**Metadata Fields:**
- `address`: Client IP address (added by server to all messages)
- `SessionID`: Unique session identifier (added by server after session sync)

---

## Connection Timing

Typical timing for connection handshake (network latency dependent):

### With Exports Handshake:
```
T+0ms:    WebSocket Handshake begins
T+50ms:   Connection established (HTTP 101 Switching Protocols)
T+51ms:   up message sent (Server → Client)
T+52ms:   sessionid received (Client → Server)
T+53ms:   exports request received (Client → Server)
T+54ms:   import response sent (Server → Client)
T+55ms:   checkin received (Client → Server)
T+56ms:   pushState() executes (application-specific)
T+57ms:   ready message sent (Server → Client)

Total: ~7ms for protocol handshake (excluding pushState)
```

### Without Exports Handshake:
```
T+0ms:    WebSocket Handshake begins
T+50ms:   Connection established (HTTP 101 Switching Protocols)
T+51ms:   up message sent (Server → Client)
T+52ms:   sessionid received (Client → Server)
T+53ms:   pushState() executes (application-specific)
T+54ms:   ready message sent (Server → Client)

Total: ~4ms for protocol handshake (excluding pushState)
```

**Note:** The `pushState()` execution time varies based on application implementation and is not part of the protocol handshake timing.

---

## Handshake Error and Edge Cases

### Connection Lost During Handshake

```
Client                          Server
  |──── up ────────────────────>|
  |<─── sessionid ──────────────|
  X (disconnect)
  |
  |──┐ IF reconnect = true:
  |  | Retry connection
  |  | Start from WebSocket handshake
  |<─┘
```

**Behavior:** Client will restart the entire handshake sequence if reconnection is enabled.

---

### Exports Request Before Channel Ready

```
Client                          Server
  |──── exports ───────────────>|
  |                              X (channel.onReady not resolved)
  |                              |
  |─── Wait for response ───────|
  |                              |──┐
  |                              |  | await channel.onReady
  |                              |  | (Promise resolves when ready)
  |                              |<─┘
  |<─── import ─────────────────|
```

**Behavior:** Server waits for `channel.onReady` promise before responding with exports list. No timeout on the protocol level.

---

### WebSocket Handshake Failure

```
Client                          Server
  |═══ WebSocket Handshake ════>|
  |                              X (connection refused/error)
  |<═══ Error ══════════════════|
  |                              |
  |──┐ IF reconnect = true:
  |  | Wait reconnectDelay ms
  |  | Retry WebSocket handshake
  |<─┘
```

**Behavior:** Client retries connection based on `reconnect` and `reconnectDelay` configuration.

---

### Session ID Mismatch

```
Client                          Server
  |<──── up ───────────────────|  (SessionID: 'abc123')
  |                             |
  |───── sessionid ────────────>|  (SessionID: 'xyz789' - wrong!)
  |                             |──┐
  |                             |  | SessionID mismatch detected
  |                             |  | Force newsession flow
  |                             |<─┘
  |<──── up ───────────────────|  (New SessionID: 'new456')
  |                             |
  |───── sessionid ────────────>|  (SessionID: 'new456' - correct)
```

**Behavior:** Server can force new session creation if session ID validation fails.

---

**End of Connection Handshake Documentation**
