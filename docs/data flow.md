# SecureChannel Connection Flow Diagram

**Date:** 2026-01-20
**Based on:** SecureChannel v1.0 Protocol

---

## 1. Server Initialization Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ SERVER STARTUP                                                   │
└────────┬────────────────────────────────────────────────────────┘
         │
         ├─ new Controller(state, driverPath, respawnTime)
         │   └─ Initialize controller state
         │
         ├─ controller.createChannel(id, options)
         │   ├─ Channel.getConnection(id, options)
         │   │   └─ Extract port from options.ports[id] or options.port
         │   ├─ new Channel(id, connection)
         │   │   └─ extends SecureChannel
         │   └─ channel.join(controller)
         │       └─ Register channel with controller
         │
         ├─ channel.loadDriver(domainId)
         │   ├─ new Driver(domainId)
         │   ├─ driver.join(channel)
         │   └─ driver.process(CachedData)
         │       └─ Configure sources/sinks
         │
         ├─ channel.export({functions})
         │   └─ Register remotely callable functions
         │
         ├─ await channel.start()
         │   ├─ channel.listen({address, port, cert, key, keepalive, path})
         │   │   ├─ Create HTTP/HTTPS server
         │   │   ├─ Create WebSocket server (ws library)
         │   │   ├─ Attach to port
         │   │   └─ emit('listening', {address, port})
         │   │
         │   └─ driver.start()
         │       ├─ Discover devices
         │       ├─ Create Workers for each device
         │       │   └─ new Worker(driver, id, sessionid, deviceProps)
         │       │       ├─ Spawn child process
         │       │       └─ Initialize IPC channel
         │       └─ await worker.onReady
         │
         └─ SERVER READY
             └─ Listening for WebSocket connections
```

---

## 2. Client Connection Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ CLIENT INITIATES CONNECTION                                      │
└────────┬────────────────────────────────────────────────────────┘
         │
         ├─ new SecureChannel(routes, clientName)
         │   ├─ Initialize Dispatcher with event routes
         │   └─ Set clientName for session management
         │
         ├─ channel.connect({address, port, path, reconnect})
         │   ├─ emit('connect', {address})
         │   ├─ Create WebSocket client
         │   │   └─ ws://address:port/path (or wss://)
         │   │
         │   ├─ WebSocket: 'open' event
         │   │   ├─ Connection established
         │   │   ├─ Server assigns SessionID
         │   │   ├─ emit('up', {address, SessionID})
         │   │   │
         │   │   └─ IF keepalive configured:
         │   │       └─ Start heartbeat timer
         │   │           └─ setInterval(() => send({type:'heartbeat'}), keepalive)
         │   │
         │   ├─ WebSocket: 'message' event
         │   │   ├─ Parse JSON message
         │   │   ├─ dispatcher.reduce(message)
         │   │   │   └─ Apply parser pipeline
         │   │   └─ dispatcher.trigger(type, message)
         │   │       └─ Call registered route handler
         │   │
         │   ├─ WebSocket: 'close' event
         │   │   ├─ emit('down', {address})
         │   │   ├─ Stop heartbeat timer
         │   │   └─ IF reconnect === true:
         │   │       └─ Attempt reconnection
         │   │
         │   └─ WebSocket: 'error' event
         │       └─ emit('error', {address, reason})
         │
         └─ CLIENT CONNECTED
             └─ Ready to send/receive messages
```

---

## 3. Server Side Client Connection Handling

```
┌─────────────────────────────────────────────────────────────────┐
│ SERVER RECEIVES CLIENT CONNECTION                                │
└────────┬────────────────────────────────────────────────────────┘
         │
         ├─ WebSocket Server: 'connection' event
         │   │
         │   ├─ Extract client address
         │   ├─ Generate SessionID = crypto.randomBytes(16).toString('hex')
         │   ├─ Store client socket: this.clients.push(ws)
         │   ├─ emit('open', {address})
         │   │
         │   ├─ Send session initialization
         │   │   └─ ws.send({type: 'session', SessionID})
         │   │
         │   ├─ channel.pushState(ws)
         │   │   ├─ Send cache state to client
         │   │   │   └─ channel.emitCache([], ws)
         │   │   │       └─ Walk cache hierarchy and emit data
         │   │   └─ Send node state to client
         │   │       └─ For each driver, emit node status
         │   │
         │   ├─ WebSocket: 'message' event (from this client)
         │   │   ├─ Parse JSON message
         │   │   ├─ Append metadata:
         │   │   │   ├─ message.address = clientAddress
         │   │   │   └─ message.SessionID = sessionId
         │   │   │
         │   │   ├─ dispatcher.reduce(message, ws)
         │   │   │   └─ Apply parser pipeline
         │   │   │
         │   │   ├─ Handle message types:
         │   │   │   ├─ type === 'heartbeat'
         │   │   │   │   ├─ Calculate latency
         │   │   │   │   └─ emit('heartbeat', {address, SessionID, latency})
         │   │   │   │
         │   │   │   ├─ type === 'request'
         │   │   │   │   ├─ Extract command and args
         │   │   │   │   ├─ Execute channel.exports[command](args)
         │   │   │   │   ├─ Send result or error
         │   │   │   │   └─ emit('result' or 'error', response)
         │   │   │   │
         │   │   │   └─ type === custom
         │   │   │       └─ dispatcher.trigger(type, message, ws)
         │   │   │           └─ Call registered handler
         │   │   │
         │   │   └─ IF keepalive configured:
         │   │       └─ Server expects periodic heartbeats
         │   │           └─ Disconnect if missed
         │   │
         │   ├─ WebSocket: 'close' event (client disconnect)
         │   │   ├─ Remove from this.clients
         │   │   ├─ emit('close', {address, SessionID, reason})
         │   │   └─ Cleanup resources
         │   │
         │   └─ WebSocket: 'error' event
         │       └─ emit('error', {address, SessionID, reason})
         │
         └─ CLIENT MANAGED
             └─ Bidirectional communication established
```

---

## 4. Request/Response Transaction Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ CLIENT SENDS REQUEST                                             │
└────────┬────────────────────────────────────────────────────────┘
         │
         ├─ client.transact(query, prefix, timeout)
         │   ├─ Generate unique requestKey
         │   ├─ Setup response listener
         │   │   ├─ on(`${prefix}result`, resolve)
         │   │   └─ on(`${prefix}error`, reject)
         │   │
         │   ├─ IF timeout > 0:
         │   │   └─ setTimeout(() => reject('timeout'), timeout * 1000)
         │   │
         │   ├─ Execute query()
         │   │   └─ client.send({type: 'request', command, args, key: requestKey})
         │   │
         │   └─ return Promise (resolves on result, rejects on error/timeout)
         │
         ├─────────────[ NETWORK ]─────────────→
         │
         ├─ SERVER RECEIVES REQUEST
         │   ├─ Parse message: {type: 'request', command, args, key}
         │   ├─ Lookup command in channel.exports
         │   ├─ Execute: result = await exports[command](args)
         │   │
         │   ├─ IF success:
         │   │   └─ ws.send({type: 'result', key, result})
         │   │
         │   └─ IF error:
         │       └─ ws.send({type: 'error', key, error})
         │
         ├─────────────[ NETWORK ]─────────────→
         │
         └─ CLIENT RECEIVES RESPONSE
             ├─ Parse message: {type: 'result|error', key, data}
             ├─ emit(`${prefix}result|error`, data)
             │   └─ Triggers Promise resolve/reject
             └─ Cleanup timeout and listeners
```

---

## 5. Data Push Flow (Server → Client)

```
┌─────────────────────────────────────────────────────────────────┐
│ WORKER GENERATES DATA                                            │
└────────┬────────────────────────────────────────────────────────┘
         │
         ├─ Node Process (child)
         │   ├─ Generate typed data
         │   └─ process.send({type, data, node})
         │
         ├─────────────[ IPC ]─────────────→
         │
         ├─ Worker (parent)
         │   ├─ Receive from child process
         │   ├─ driver.pipeline(type, node)
         │   │   ├─ driver.cache([domain, type, node], data)
         │   │   │   └─ Store in controller cache
         │   │   │
         │   │   └─ driver.emit(type, node)
         │   │       └─ Fire registered sink handlers
         │   │
         │   └─ CachedData collector/emitter
         │       ├─ IF publishDataStream:
         │       │   └─ channel.send({type, data}, ws)
         │       │       └─ Broadcast to client(s)
         │       │
         │       └─ IF publishStatus:
         │           └─ channel.send({type: 'status', domain, node}, ws)
         │               └─ Notify client of change
         │
         ├─────────────[ WebSocket ]─────────────→
         │
         └─ CLIENT RECEIVES DATA
             ├─ dispatcher.reduce(message)
             ├─ dispatcher.trigger(type, message)
             │   └─ Call registered route handler
             └─ Update UI / Process data
```

---

## 6. Heartbeat/Keepalive Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ PERSISTENT CONNECTION (keepalive > 0)                            │
└────────┬────────────────────────────────────────────────────────┘
         │
         ├─ CLIENT HEARTBEAT TIMER
         │   └─ setInterval(() => {
         │       ├─ timestamp = Date.now()
         │       ├─ send({type: 'heartbeat', timestamp})
         │       └─ emit('heartbeat', {address})
         │   }, keepalive * 1000)
         │
         ├─────────────[ WebSocket ]─────────────→
         │
         ├─ SERVER RECEIVES HEARTBEAT
         │   ├─ receivedTime = Date.now()
         │   ├─ latency = receivedTime - message.timestamp
         │   ├─ emit('heartbeat', {address, SessionID, latency})
         │   └─ Optional: Track last heartbeat time
         │       └─ IF heartbeat missed:
         │           └─ Disconnect client
         │
         └─ LOOP: Continuous heartbeat monitoring
             └─ Provides connection telemetry and liveness detection
```

---

## 7. Channel-Driver-Worker Hierarchy

```
┌─────────────────────────────────────────────────────────────────┐
│ HIERARCHICAL ARCHITECTURE                                        │
└────────┬────────────────────────────────────────────────────────┘
         │
         ├─ CONTROLLER (system coordinator)
         │   ├─ State management
         │   ├─ Cache coordination
         │   └─ Inter-channel communication
         │
         ├─ CHANNEL (client communication)
         │   ├─ WebSocket server
         │   ├─ Client session management
         │   ├─ Message routing
         │   ├─ Exports (remote callable functions)
         │   └─ Dispatcher (event handling)
         │
         ├─ DRIVER (domain management)
         │   ├─ Worker lifecycle
         │   ├─ Cache management
         │   ├─ Data aggregation
         │   ├─ Source handlers (from workers)
         │   ├─ Sink handlers (to clients)
         │   └─ CachedData processors
         │
         ├─ WORKER (process management)
         │   ├─ Child process spawn
         │   ├─ IPC communication
         │   ├─ Command routing
         │   ├─ Response handling
         │   └─ Process lifecycle
         │
         └─ NODE (device logic - child process)
             ├─ Device-specific implementation
             ├─ Data generation
             ├─ Command execution
             └─ IPC communication with Worker
```

---

## 8. Complete Connection Lifecycle

```
┌─────────────────────────────────────────────────────────────────┐
│ FULL CONNECTION LIFECYCLE                                        │
└────────┬────────────────────────────────────────────────────────┘
         │
    [INITIALIZATION]
         │
         ├─ 1. Controller.start()
         │   └─ Initialize system state
         │
         ├─ 2. Channel.start()
         │   ├─ Start WebSocket server
         │   └─ Listen on configured port
         │
         ├─ 3. Driver.start()
         │   ├─ Discover devices
         │   └─ Spawn Worker processes
         │
         ├─ 4. Worker.start()
         │   ├─ Spawn Node child process
         │   └─ Establish IPC channel
         │
         ├─ 5. Node.connect()
         │   ├─ Initialize device
         │   └─ Send 'ready' message
         │
         ├─ 6. Worker receives 'ready'
         │   └─ worker.onReady resolves
         │
         ├─ 7. Driver detects all workers ready
         │   └─ driver.onHealthy resolves
         │
         └─ 8. Channel detects all drivers ready
             └─ channel.onReady resolves
                 └─ SYSTEM READY
         │
         ├─────────────────────────────────────────
         │
    [RUNTIME]
         │
         ├─ Client connects
         │   ├─ WebSocket handshake
         │   ├─ Session initialization
         │   └─ State synchronization
         │
         ├─ Data flows (JSON)
         │   ├─ Node → Worker → Driver → Channel → Client
         │   └─ Client → Channel → Driver → Worker → Node
         │
         ├─ Data flows (binary streams)
         │   ├─ See binary streams.md for full details
         │   ├─ Uses SubstreamDuplex at every layer, addressed by uint32 uid
         │   ├─ IPC hops: native binary frames (advanced serialization, 0xFE sentinel)
         │   └─ WebSocket hops: native binary frames (0xFE sentinel)
         │
         ├─ Heartbeats
         │   └─ Client ←→ Server keepalive ping/pong
         │
         └─ Requests/Responses
             └─ Client ←→ Server command execution
         │
         ├─────────────────────────────────────────
         │
    [SHUTDOWN]
         │
         ├─ 1. controller.end()
         │   └─ Initiate graceful shutdown
         │
         ├─ 2. channel.end()
         │   ├─ Close WebSocket server
         │   └─ Disconnect all clients
         │
         ├─ 3. driver.end()
         │   └─ Stop all workers
         │
         ├─ 4. worker.end()
         │   ├─ Send 'shutdown' to Node
         │   └─ await worker.onDown
         │
         ├─ 5. Node.end()
         │   ├─ Cleanup device resources
         │   └─ process.exit(0)
         │
         └─ SYSTEM SHUTDOWN COMPLETE
```

---

## 9. Message Types and Protocol

### Core Message Structure
All messages are JSON objects with:
```javascript
{
  type: string,        // Message type identifier
  // ... type-specific fields
  address: string,     // Sender IP (added by server)
  SessionID: string    // Session ID (added by server)
}
```

### Built-in Message Types

| Type | Direction | Purpose | Payload |
|------|-----------|---------|---------|
| `session` | Server → Client | Session initialization | `{SessionID}` |
| `heartbeat` | Client ↔ Server | Keepalive/latency | `{timestamp}` |
| `request` | Client → Server | Command execution | `{command, args, key}` |
| `result` | Server → Client | Command response | `{key, result}` |
| `error` | Server → Client | Command error | `{key, error}` |
| `data` | Server → Client | Data stream push | `{dataType, payload}` |
| `status` | Server → Client | Status notification | `{domain, node, state}` |
| *custom* | Both | User-defined | User-defined |

### Custom Message Routing

Client registers handlers:
```javascript
const channel = new SecureChannel({
  'myEvent': (message) => {
    console.log('Received:', message);
  }
});
```

Server sends custom messages:
```javascript
channel.data('myEvent', {custom: 'payload'});
```

---

## 10. Connection Options Reference

### Server Listen Options
```javascript
channel.listen({
  address: '0.0.0.0',      // Network interface
  port: 8080,              // TCP port
  keepalive: 30,           // Heartbeat interval (seconds)
  cert: certBuffer,        // SSL certificate
  key: keyBuffer,          // SSL private key
  path: '/websocket'       // WebSocket endpoint (default: '/')
});
```

### Client Connect Options
```javascript
channel.connect({
  address: 'example.com',  // Server hostname/IP
  port: 8080,              // Server port
  path: '/websocket',      // WebSocket endpoint
  reconnect: true,         // Auto-reconnect on disconnect
  handshakeTimeout: 5000   // Handshake timeout (ms)
});
```

### Channel Configuration
```javascript
controller.createChannel('channelId', {
  ports: {                 // Port mapping
    'channel1': 8080,
    'channel2': 8081
  },
  // OR
  port: 8080,             // Direct port (single channel)

  address: '0.0.0.0',     // Listen address
  keepalive: 30,          // Heartbeat interval
  cert: certBuffer,       // SSL cert
  key: keyBuffer,         // SSL key
  path: '/ws'            // WebSocket path
});
```

---

## 11. Connection States

### Client States
```
DISCONNECTED → CONNECTING → CONNECTED → DISCONNECTED
      ↑                          ↓
      └────── (reconnect) ───────┘
```

**State Events:**
- `connect`: Connection attempt started
- `up`: Connection established
- `down`: Connection closed
- `error`: Connection error

### Worker States
```
SPAWNING → INITIALIZING → READY → DOWN
                            ↓
                         ERROR
```

**State Properties:**
- `worker.nodeReady`: Boolean, true when ready
- `worker.nodeDown`: Boolean, true when disconnected
- `worker.nodeError`: String|null, last error
- `worker.onReady`: Promise, resolves when ready
- `worker.onDown`: Promise, resolves when down

### Driver States
```
CREATED → STARTING → READY → HEALTHY
                       ↓
                     PARTIAL
```

**State Properties:**
- `driver.domainReady`: string|false|undefined (first ready node ID)
- `driver.domainHealthy`: Boolean (all nodes ready or no nodes)
- `driver.status`: Object (per-node ready status)
- `driver.onReady`: Promise (first node ready)
- `driver.onHealthy`: Promise (all nodes ready)

---

## 12. Error Handling and Reconnection

### Client Reconnection Logic
```javascript
// Automatic reconnection enabled
channel.connect({
  address: 'example.com',
  port: 8080,
  reconnect: true
});

// Connection lost → automatic reconnect attempts
channel.on('down', (event) => {
  console.log('Disconnected, will auto-reconnect');
});

channel.on('up', (event) => {
  console.log('Reconnected successfully');
});
```

### Worker Respawn Logic
```javascript
// Controller manages worker respawn
const controller = new Controller(
  state,
  driverPath,
  30  // Respawn delay in seconds
);

// Worker process crashes → automatic respawn after delay
```

### Transaction Timeout
```javascript
// Request with timeout protection
try {
  const result = await channel.transact(
    () => channel.request('getData', {id: 123}),
    'prefix',
    5  // Timeout in seconds
  );
} catch (error) {
  if (error === 'timeout') {
    console.error('Request timed out');
  }
}
```

---

**End of Connection Flow Documentation**
