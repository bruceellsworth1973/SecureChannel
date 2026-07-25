# SecureChannel Passthrough Connections

**Date:** 2026-03-07
**Covers:** Passthrough driver pattern, remote SC3 bridging, nginx proxy wiring, CachedData pipeline

---

## What is a Passthrough?

`Passthrough` extends `Node`. It runs as a child process (like any Node driver) but instead of implementing device logic directly, it creates a `SecureChannel` WebSocket client that connects to a **remote SC3 server**. It forwards all SC3 protocol messages bidirectionally between the parent Channel (via IPC) and the remote server (via WebSocket). This includes both JSON messages and binary stream data — see [binary streams.md](binary%20streams.md) for the stream relay details.

```
Parent Channel (IPC) ←→ Passthrough (child process) ←→ Remote SC3 Server (WebSocket)
```

From the remote server's perspective, a Passthrough connection is indistinguishable from a browser client — it uses the same SC3 handshake protocol (checkin → exports → import → checkin → ready → data).

---

## Passthrough Class API

```javascript
import { Passthrough } from 'securechannel';

class MyBridge extends Passthrough {
    constructor(devices, timeout) {
        super(devices);
        // this.channel = SecureChannel client (created by super)
        // this.node = device node name (from process args)
        // this.id = same as this.node
        // this.isReady = set true when remote sends 'ready'

        this.connect(device, { timeout });
        // connects to the remote SC3 server described by device
    }
}
```

### Key members

| Member | Type | Purpose |
|--------|------|---------|
| `this.channel` | `SecureChannel` | The WebSocket client to the remote server |
| `this.isReady` | `boolean` | Set `true` when the remote `ready` message arrives |
| `this.connect(device, options)` | method | Connect to a remote SC3 server |
| `this.emit(type, data)` | method | Send data up to parent via IPC (inherited from Node) |
| `this.error(err)` | method | Report error to parent (inherited from Node) |
| `this.log(...args)` | method | Log via parent process logger (inherited from Node) |

### connect() signatures

```javascript
// Signature 1: device object + options
this.connect(device, { timeout: 30 });
// device = { address, port, path, enforceSSLVerification, ... }
// timeout is in seconds

// Signature 2: async init function (advanced)
this.connect(async function() {
    // custom initialization
    this.channel.connect(deviceConfig);
    await this.onReady;
});
```

---

## Device Configuration

The device object passed to `connect()` is forwarded to `SecureChannel.connect()`. Key options:

| Option | Type | Default | Purpose |
|--------|------|---------|---------|
| `address` | string | required | Hostname or IP of the remote server |
| `port` | number | required | Port number |
| `path` | string | `''` | WebSocket path (e.g., `/socket`, `/teams-status/socket`) |
| `uri` | string | — | Explicit full URI, overrides address+port+path construction |
| `enforceSSLVerification` | boolean | `false` | Validate remote TLS certificate |
| `reconnect` | number | `5` | Reconnection delay in seconds |
| `handshakeTimeout` | number | `2000` | Handshake timeout in milliseconds |

### URL construction

`SecureChannel.connect()` builds the WebSocket URL as:
```
uri || `wss://${address}:${port}${path}`
```

When connecting through an **nginx reverse proxy**, use `address` + `port: 443` + `path` to hit the correct location block. The `uri` option is available if you need full control.

---

## Connecting Through nginx Reverse Proxy

When the remote SC3 server is behind nginx, the Passthrough must connect through the proxy.

### nginx requirements

The nginx location block must include WebSocket upgrade headers:

```nginx
location /my-app/socket {
    include snippets/wss-proxy.conf;
    proxy_pass http://upstream-name/;
}
```

Where `wss-proxy.conf` contains:
```nginx
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "Upgrade";
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_read_timeout 86400;
```

### Device config for nginx proxy

```javascript
const DEVICES = {
    'remote-host': {
        address: 'remote-host',          // nginx server hostname
        port: 443,                        // nginx HTTPS port
        path: '/my-app/socket',           // nginx location path to the SC3 WebSocket
        enforceSSLVerification: false     // internal certs may be self-signed
    }
};
```

### Finding the WebSocket path

If the remote SC3 application exposes a `/status` HTTP endpoint, the `socketPath` field in the status response reveals the configured WebSocket path. This path, combined with the nginx location prefix, gives the full `path` value.

---

## Data Pipeline: CachedData with Passthrough

Data emitted by the remote SC3 server flows through the Passthrough into the parent Channel's pipeline automatically. The parent Channel registers `CachedData` processors on the Passthrough's driver to collect and cache this data.

### Registering data types

Each data type published by the remote server needs its own `CachedData` processor:

```javascript
// In the Channel constructor:
this.myDriver = this.loadDriver('myDomain');
this.myDriver.process(new CachedData('group', {}));              // cumulative merge
this.myDriver.process(new CachedData('presence', {}));           // cumulative merge
this.myDriver.process(new CachedData('status', { overwrite: true }));  // full replacement
```

### overwrite modes

| Mode | Behavior | Use when |
|------|----------|----------|
| `overwrite: false` (default) | Merges new data into existing cache | Remote sends incremental updates (one node at a time) |
| `overwrite: true` | Replaces entire cache entry | Remote sends complete snapshots |

### Cache path

Data is cached at:
```
controller.state.cache[driverDomain][dataType][nodeName]
```

Example: `cache.msgraph.group['lsa-msgraph']` — where `msgraph` is the driver domain, `group` is the data type, and `lsa-msgraph` is the Passthrough node name.

### No request() calls needed

All CachedData arrives automatically on connection — the remote SC3 server pushes its full state during the handshake `pushState()` phase, and subsequent updates flow through the WebSocket. No explicit `request()` calls are needed to receive cached data.

---

## Complete Passthrough Driver Example

```javascript
import { bind } from 'helpers';
import { Passthrough } from 'securechannel';
import { REMOTE_CONFIG } from '../serviceConfig.js';

const DEVICES = {
    [REMOTE_CONFIG.address]: {
        address: REMOTE_CONFIG.address,
        port: REMOTE_CONFIG.port,
        path: REMOTE_CONFIG.path,
        enforceSSLVerification: false
    }
};

class RemoteBridge extends Passthrough {
    error(err) {
        if (this.isReady) this.emit('connectivity', { connected: false, error: err?.message || String(err) });
        super.error(err);
    }
    constructor(devices, timeout) {
        super(devices);
        const { node } = this;
        const device = devices[node];
        const { port } = device;
        const onReady = () => {
            this.log('connection established');
            this.emit('connectivity', { connected: true });
        };
        const events = {
            ready: onReady,
            connect: () => this.log(`connecting to ${node}:${port}`)
        };
        bind(events).to(this);
        this.connect(device, { timeout });
    }
}

new RemoteBridge(DEVICES, REMOTE_CONFIG.connectTimeout);
```

---

## Channel-Side Wiring

```javascript
// In Channel constructor:

// Load the Passthrough driver
this.remoteDriver = this.loadDriver('myRemoteDomain');

// Register CachedData processors for each data type
this.remoteDriver.process(new CachedData('typeA', {}));
this.remoteDriver.process(new CachedData('typeB', { overwrite: true }));

// Optional: handle connectivity events
this.remoteDriver.process({
    source: {
        connectivity: (data, node) => {
            if (data.connected) recordConnect(node);
            else recordDisconnect(node, data.error || null);
            return false;
        }
    }
});
```

---

## Debugging Connections

### Using the SC3 debug utility

`SecureChannel3/utilities/debug.mjs` is an interactive client that connects to any SC3 server using a raw `SecureChannel` instance. It emulates the full handshake protocol and is useful for verifying that a remote server is reachable and functional.

```bash
node SecureChannel3/utilities/debug.mjs
# Then type the URI: wss://remote-host/app/socket
```

The debug utility uses the same protocol as Passthrough — if it connects successfully, a Passthrough driver will too.

### Supervisor and new driver files

When adding a new driver file to the `drivers/` directory, the file watcher (supervisor) does **not** automatically pick up new files. A manual service restart is required for the supervisor to begin watching the new file. After the initial restart, subsequent edits to the file trigger automatic restarts as normal.

### Common connection issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| Connection timeout | Wrong port or path | Verify nginx location and upstream; test with debug utility |
| ECONNDROPPED immediately | Old process still running (supervisor didn't restart) | Manually restart the service |
| No data in cache | CachedData type name doesn't match remote emit type | Check remote server's data types; register matching CachedData processors |
| Data cached but not pushed to clients | Missing `publishDataStream: true` | Add option if clients need the data |

---

**End of Passthrough Connections Documentation**
