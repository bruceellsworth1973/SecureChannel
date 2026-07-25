# SecureChannel

## Installation

Clone this project to your projects folder and install the dependencies using npm. This should create a SecureChannel folder in the current folder. Inside the SecureChannel folder, you also need to copy the contents of .env.sample to a new file called .env, and then customize the contents to set up the default environment. SecureChannel is typically installed at the root of your Projects folder so it can be accessed by any projects that use it.

Assuming you want to use this module from another project that is in its own folder, use the following steps from a command shell to install SecureChannel in your project:

```sh
cd SecureChannel
npm install
cd ..
cd <Your Project>
npm install -S ../SecureChannel
```

You can use a different folder structure, but the path specified in the npm install command and in your project's package.json file must reference the correct path to SecureChannel. If you follow the recommended process you will end up with a folder structure like the following:

```
Projects/
├── SecureChannel/
│   ├── package.json
│   ├── readme.md
│   └── index.js
├── Your Project/
│   ├── package.json
│   └── server.js
└── ssl/
    ├── server.pem
    ├── server.key
    └── ca.crt
```

To use SSL features, you will need to have a valid server certificate and key. Self-signed certs are supported but will not be as secure since you will need to disable strict certificate checking. A separate CA certificate file is supported, but it is not needed if your server certificate file is formatted properly as a full chain cert. Be aware, if you are using a self-signed certificate, you will also need to configure any client browsers and devices to trust your CA certificate, or your server cert will be flagged as invalid even if you serve a full chain cert from your SecureChannel instance.

---

## API Reference

### Class "Queue"

#### Properties
- `length` (number): Number of actions currently in the queue.

---

#### Methods

#### **`constructor(...actions)`**
Creates a generic action queue framework designed to be extended for more specific purposes.

**Input:**
- `actions` (Function[], optional): Initial actions to populate the queue

**Returns:** `Queue` - New Queue instance

**Example:**
```javascript
const queue = new Queue(
  async () => console.log('First action'),
  async () => console.log('Second action')
);
```

---

#### **`first(...actions): this`**
Adds one or more actions to the beginning of the queue.

**Input:**
- `actions` (Function[]): Actions to add to queue front

**Returns:** `this` - Queue instance for chaining

**Example:**
```javascript
queue.first(
  async () => console.log('High priority task')
);
```

---

#### **`defer(...actions): this`**
Adds one or more actions to the end of the queue.

**Input:**
- `actions` (Function[]): Actions to add to queue end

**Returns:** `this` - Queue instance for chaining

**Example:**
```javascript
queue.defer(
  async () => console.log('Lower priority task')
);
```

---

#### **`async next(): Promise<number>`**
Executes and removes the next action in the queue.

**Input:** None

**Returns:** `Promise<number>` - Number of remaining actions in the queue after execution

**Example:**
```javascript
const remaining = await queue.next();
console.log(`${remaining} actions left in queue`);
```

---

#### **`async drain(): Promise<void>`**
Executes all actions in the queue until empty.

**Input:** None

**Returns:** `Promise<void>`

**Example:**
```javascript
// Basic drain
await queue.drain();

// Drain with progress tracking
const queue = new Queue(
  async () => processImages(),
  async () => generateThumbnails(),
  async () => updateDatabase()
);

let total = queue.length;
console.log(`Starting batch process with ${total} tasks`);

// Track progress while draining
while (queue.length > 0) {
  await queue.next();
  const remaining = queue.length;
  const progress = Math.round(((total - remaining) / total) * 100);
  console.log(`Progress: ${progress}% (${remaining} tasks remaining)`);
}

// Drain with error handling
try {
  await queue.drain();
  console.log('All tasks completed');
} catch (error) {
  console.error('Queue processing failed:', error);
  // Remaining tasks are still in queue
  console.log(`${queue.length} tasks remaining`);
}
```

---

### Class "Transaction"

#### Methods

#### **`constructor(dispatcher: Dispatcher, prefix?: string)`**
Creates a new Transaction instance to handle multiplexing distinct request/response patterns over a full-duplex stream. The prefix allows multiple transactions to happen on the stream simultaneously as long as a unique prefix is used for each running instance.

**Input:**
- `dispatcher` (Dispatcher): Dispatcher instance for coordinating transaction events
- `prefix` (string, optional): Namespace prefix for transaction routing, defaults to ''

**Returns:** `Transaction` - New Transaction instance

**Example:**
```javascript
const tx = new Transaction(dispatcher, 'user');
```

---

#### **`transact(query: Function, timeout?: number): Promise<any>`**
Starts an asynchronous transaction using the supplied query function, with optional timeout protection.

**Input:**
- `query` (Function): Transaction logic to execute
- `timeout` (number, optional): Timeout in seconds (0 or undefined = no timeout)

**Returns:** `Promise<any>` - Promise that:
- Resolves with transaction result
- Rejects on timeout or error
- Always cleans up listeners

**Events Handled:**
- `${prefix}result`: Success path
- `${prefix}error`: Failure path

**Example:**
```javascript
// Simple transaction
try {
  const result = await tx.transact(async () => {
    return await api.getData();
  });
  console.log('Success:', result);
} catch (error) {
  console.error('Failed:', error);
}

// Transaction with 5-second timeout
try {
  const result = await tx.transact(async () => {
    return await longOperation();
  }, 5);
  console.log('Completed:', result);
} catch (error) {
  if (error === 'timeout') {
    console.error('Operation timed out');
  }
}
```

---

### Class "TransactionQueue" extends Queue

#### Properties
- see `Queue` documentation.

#### Methods

#### **`constructor(dispatcher: Dispatcher)`**
Creates a queue for managing sequential asynchronous transactions that cannot run concurrently.

**Input:**
- `dispatcher` (Dispatcher): Dispatcher instance for transaction events

**Example:**
```javascript
const queue = new TransactionQueue(dispatcher);
```

---

#### **`async transact(query: Function, prefix?: string, timeout?: number): Promise<any>`**
Executes a transaction, queuing it if another transaction is in progress. Queued transactions execute serially from a first-in-first-out queue as soon as the prior transaction is complete.

**Input:**
- `query` (Function): Transaction logic to execute
- `prefix` (string, optional): Namespace prefix for transaction routing
- `timeout` (number, optional): Transaction timeout in seconds

**Returns:** Promise resolving with transaction result

**Example:**
```javascript
const queue = new TransactionQueue(dispatcher);

// Sequential transactions
const result1 = await queue.transact(async () => {
  return await firstOperation();
});

const result2 = await queue.transact(async () => {
  return await secondOperation();
}, 'prefix', 30);  // with prefix and 30 second timeout
```

---

### Class "Dispatcher"

#### Methods

#### **`constructor(events?: object, context?: object)`**
Creates a central event dispatcher for message routing and processing.

**Input:** 
- `events` (object, optional): Initial event handler mappings
- `context` (object, optional): Context object for handler execution, defaults to null

**Returns:** `Dispatcher` - New Dispatcher instance

**Example:**
```javascript
// Create with initial handlers and context
const dispatcher = new Dispatcher({
  'user:login': function(data) {
    // 'this' refers to context object (or null if not provided at instantiation)
    console.log('Login from:', data.username);
    if (this) {
      this.lastLogin = Date.now();
    }
  }
}, {
  environment: 'production',
  lastLogin: null
});
```

---

#### **`reduce(message: any): this`**
Processes a message through the parser pipeline.

**Input:**
- `message` (any): Message to process through parsers

**Returns:** `this` - Dispatcher instance for chaining

**Example:**
```javascript
dispatcher.use(msg => {
  if (msg.type === 'error') return false; // Stop processing
  return msg;
});

dispatcher.reduce({ type: 'data', value: 42 });
```

---

#### **`transact(query: Function, prefix?: string, timeout?: number): Promise<any>`**
Convenience method to create and execute a transaction following a request/response pattern. The query function initiates sending a request, and the returned Promise will resolve a response or throw an error based on the result of the query.

**Input:**
- `query` (Function): Transaction logic to execute
- `prefix` (string, optional): Namespace prefix for transaction routing
- `timeout` (number, optional): Timeout in seconds (0 = no timeout)

**Returns:** Promise resolving with transaction result

**Example:**
```javascript
const result = await dispatcher.transact(
  () => api.getData(),
  'user',
  5
);
```
---

#### **`trigger(type: string, message: any, socket?: object): boolean`**
Triggers an event handler (alias: `emit`).

**Input:**
- `type` (string): Event type to trigger
- `message` (any): Event payload
- `socket` (object, optional): Client socket for handler context, falls back to default context if not supplied

**Returns:** `boolean` - True if event handler found and triggered

**Example:**
```javascript
dispatcher.trigger('data', { type: 'data', value: 42 });
```

---

#### **`use(parser: Function): this`**
Adds a message parser to the processing pipeline.

**Input:**
- `parser` (Function): Message transformation function
  - Receives: message
  - Returns: transformed message or falsy to stop processing

**Returns:** `this` - Dispatcher instance for chaining

**Example:**
```javascript
dispatcher.use(msg => {
  if (msg.type === 'error') return false; // Stop processing
  return msg;
});

dispatcher.reduce({ type: 'data', value: 42 });
```

---

#### **`on(type: string, callback: Function): this`**
Registers an event handler.

**Input:**
- `type` (string): Event type to listen for
- `callback` (Function): Event handler function

**Returns:** `this` - Dispatcher instance for chaining

**Example:**
```javascript
// Handler with context access
dispatcher.on('event', function(message) {
  // 'this' is the context object passed to constructor (or null)
  if (this?.environment === 'production') {
    console.log('Production event:', message);
  }
});

// Handler without context dependency
dispatcher.on('data', (message) => {
  console.log('Received data:', message);
});
```

---

#### **`off(type: string): this`**
Removes an event handler.

**Input:**
- `type` (string): Event type to remove

**Returns:** `this` - Dispatcher instance for chaining

**Example:**
```javascript
const dispatcher = new Dispatcher();

// Remove specific handler
dispatcher.off('temporary');

// Remove multiple handlers
['temp1', 'temp2'].forEach(type => {
  dispatcher.off(type);
});
```

---

#### **`emit(type: string, message: any, socket?: object): boolean`**
Triggers an event handler.

**Input:**
- `type` (string): Event type to trigger
- `message` (any): Message to pass to event handler
- `socket` (object, optional): Client socket for handler context, falls back to default context if not supplied

**Returns:** `boolean` - True if event handler found and triggered

**Example:**
```javascript
const dispatcher = new Dispatcher();

// Emit to all
dispatcher.emit('broadcast', {
  message: 'System update'
});

// Emit to specific client
dispatcher.emit('private', {
  message: 'Your account updated'
}, clientSocket);
```

---

#### **`bind(events: object): this`**
Registers multiple event handlers.

**Input:**
- `events` (object): Event handlers to register

**Returns:** `this` - Dispatcher instance for chaining

**Example:**
```javascript
const dispatcher = new Dispatcher();

// Bind multiple handlers
dispatcher.bind({
  'data': data => console.log('Received:', data),
  'error': error => console.error('Error:', error)
});
```

---

### Class "SystemCommand" extends Dispatcher

#### Methods

#### **`constructor(command: string, args: string[]|string, cwd?: string, signal?: AbortSignal)`**
Creates a managed system process with event handling capabilities.

**Input:**
- `command` (string): System command to execute (e.g., 'node', 'python')
- `args` (string[]|string): Command arguments as array or space-separated string
- `cwd` (string, optional): Working directory for process execution
- `signal` (AbortSignal, optional): Signal for process cancellation

**Returns:** `SystemCommand` - New SystemCommand instance

#### Properties
- `output`: Promise resolving when process completes

**Events Emitted:**
- `'data'`: Raw process output
- `'progress'`: Process status updates
- `'error'`: Process errors
- `'ended'`: Process completion

**Example:**
```javascript
// Execute command with array arguments
const cmd = new SystemCommand('npm', ['install', '--save', 'express']);

// Execute with string arguments
const cmd = new SystemCommand('git', 'status --short');

// Execute in specific directory with abort signal
const controller = new AbortController();
const cmd = new SystemCommand(
  'python',
  ['build.py', '--release'],
  '/path/to/project',
  controller.signal
);

// Abort after timeout
setTimeout(() => controller.abort(), 5000);
```

---

#### **`get output(): Promise<string>`**
Provides access to process execution results.

**Returns:** Promise that:
- Resolves with 'done' when process completes
- Rejects if process fails or is aborted
- Always emits 'ended' event

**Example:**
```javascript
const cmd = new SystemCommand('npm', 'test');
try {
  await cmd.output;
  console.log('Tests completed');
} catch (error) {
  console.error('Tests failed:', error);
}
```

---

#### **`abort(): void`**
Terminates the running process immediately.

**Input:** None

**Returns:** `void`

**Effect:**
- Kills child process
- Rejects output Promise
- Emits 'ended' event

**Example:**
```javascript
const cmd = new SystemCommand('long-process');
setTimeout(() => {
  console.log('Process taking too long, aborting...');
  cmd.abort();
}, 5000);
```

---

#### **`progress(data: any): void`**
Updates process progress state.

**Input:**
- `data` (any): Progress information to emit

**Example:**
```javascript
class BuildCommand extends SystemCommand {
  constructor() {
    super('make', ['build']);
    this.on('data', data => {
      const progress = parseBuildOutput(data);
      this.progress(progress);
    });
  }
}

const build = new BuildCommand();
build.on('progress', progress => {
  console.log(`Build progress: ${progress.percent}%`);
});
```

---

### Class "SecureChannel"

#### Static Properties and Methods

#### **`static serverip`**
Returns the server IP address from the environment variable `SERVERIP`.

**Input:** None

**Returns:** `string|undefined` - The server IP address or undefined if not set

#### **`static time(moment = new Date())`**
Creates an extended Date object with SQL formatting support.

**Input:** 
- `moment` (Date, optional): Timestamp to format (defaults to current time)

**Returns:** `Date` - Modified Date object with additional method:
- `.toSQL()`: Returns date string in format 'YYYY-MM-DD HH:mm:ss'

**Example:**
```javascript
// Current time in SQL format
const now = SecureChannel.time().toSQL();
console.log(now); // '2024-03-14 15:30:45'

// Specific date in SQL format
const date = SecureChannel.time(new Date('2024-01-01'));
console.log(date.toSQL()); // '2024-01-01 00:00:00'
```

#### Instance Properties

#### **`isClient`**
Indicates if this instance is operating as a client.

**Returns:** `boolean` - True if instance is a client with active connection

#### **`clients`**
List of connected WebSocket clients when operating as a server.

**Returns:** `WebSocket[]` - Array of connected clients (empty array if client mode)

#### **`SessionID`**
Unique identifier for the current session. This is typically used as an initial value, and a different SessionID is established by the client.

**Returns:** `string` - Session identifier

---

#### Methods

#### **`constructor(routes? = {}, clientName? = false)`**
Creates a new SecureChannel instance for secure WebSocket communication. This class can be used in a stand-alone form if you only need a WebSocket communication layer and you want to develop your own application implementation around it. It is easier to implement than a raw WebSocket (it uses the ws library underneath), and it is superior in some ways to socket.io, though there is no apples-to-apples comparison. Both libraries have some overlapping feature sets but are optimized for different applications.

SecureChannel provides the following upgrades to the basic WebSocket class:
- client establishes a persistent connection with the server when a keepalive value > 0 is specified
- enables heartbeat telemetry by default when establishing persistent connections
- provides connection telemetry with latency data point (using heartbeat mechanism)
- sessions provide basis for stateful connection tracking
- automatic reconnection and session recovery
- unique event listeners can be triggered on user-definable message types
- bridging connections and passing messages between sockets is simplified
- a single class instance can simultaneously connect to one outbound server and service multiple inbound clients on the same port

**Input:**
- `routes` (object, optional): Optional event handlers for channel lifecycle and messages. It is possible to add them later with a typical on('event', handler) pattern if preferred.
- `clientName` (string, optional): Optional client identifier for session management

**Environment Variables Used:**
- `SERVERIP`: Server IP address for static reference
- `TELEMETRY`: Enable telemetry logging
- `ACTIVITY`: Enable activity logging
- `DEBUGGING`: Enable debug logging
- `VERBOSE`: Enable verbose logging
- `ERROR`: Enable error logging

**Features:**
- Persistent connection with keepalive support
- Heartbeat telemetry by default for persistent connections
- Connection telemetry with latency data
- Stateful connection tracking via sessions
- Automatic reconnection and session recovery
- Custom event listeners for message types
- Simplified connection bridging and message passing
- Simultaneous server and client operation support

**Example:**
```javascript
const channel = new SecureChannel({
  up: (event) => console.log('Connected:', event),
  down: (event) => console.log('Disconnected:', event),
  error: (error) => console.error('Error:', error),
  message: (msg) => console.log('Received:', msg)
}, 'client-123');
```

---

#### Network Methods

#### **`listen(options)`**
Initializes and starts a SecureChannel server instance. This internally starts an http or https server underneath, which is simultaneously accessible to other middleware, such as Express. The WebSocket server can listen to a custom endpoint specified by the `path` option, but it defaults to the `/` endpoint if unspecified. The `/securechannel` endpoint (and all subpaths) always serve up the SecureChannel web client and should not be used for any other purpose.

**Input:**
- `options` (object):
  - `address` (string): Network interface address (e.g., '0.0.0.0')
  - `port` (number): TCP port number
  - `keepalive` (number, optional): Heartbeat interval in seconds
  - `cert` (Buffer): SSL/TLS certificate data
  - `key` (Buffer): SSL/TLS private key data
  - `path` (string, optional): WebSocket endpoint path, defaults to '/'

**Returns:** `this` - The SecureChannel instance

**Events Emitted:**
- `'listening'`: When server starts listening, emits event (object)
  - `address` (string),
  - `port` (string|number)
- `'open'`: When new client connects, emits event (object)
  - `address` (string)
- `'close'`: When a client disconnects, emits event (object)
  - `address` (string)
  - `sessionid` (string)
  - `reason` (number)
- `'heartbeat'`: When a keepalive ping is received, emits event (object)
  - `address` (string)
  - `sessionid` (string)
  - `latency` (number)
- `'error'`: On server error, emits event (object)
  - `address` (string)
  - `sessionid` (string)
  - `reason` (string)

**Example:**
```javascript
import { readFileSync } from 'fs';

const server = new SecureChannel()
  .listen({
    address: '0.0.0.0',
    port: 8080,
    keepalive: 30,
    cert: readFileSync('path/to/cert.pem'),
    key: readFileSync('path/to/key.pem'),
    path: '/websocket'
  });
```

---

#### **`connect(options)`**
Establishes a client connection to a SecureChannel server.

**Input:**
- `options` (object):
  - `address` (string): Server hostname or IP address
  - `port` (number): Server port number
  - `path` (string, optional): WebSocket endpoint path
  - `reconnect` (boolean, optional): Auto-reconnect on disconnect
  - `handshakeTimeout` (number, optional): Handshake timeout in ms
  - `signal` (AbortSignal, optional): AbortSignal to cancel connection

**Returns:** `this` - The SecureChannel instance

**Events Emitted:**
- `'connect'`: On connection attempt, emits event (object)
  - `address` (string)
- `'up'`: On successful connection, emits event (object)
  - `address` (string)
  - `SessionID` (string)
- `'down'`: On disconnection, emits event (object)
  - `address` (string)
- `'heartbeat'`: On sending keepalive ping, emits event (object)
  - `address` (string)
- `'error'`: On error, emits event (object)
  - `address` (string)
  - `reason` (string)

**Example:**
```javascript
const client = new SecureChannel()
  .connect({
    address: 'example.com',
    port: 8080,
    path: '/websocket',
    reconnect: true,
    handshakeTimeout: 5000
  });
```

---

#### Message Methods

#### **`send(payload, ws?): boolean|undefined`**
Transmits a payload to a specific socket or broadcasts to all connected sockets. The payload may be a plain object (JSON-stringified before transmission) or a `Buffer` (sent as-is, used internally by the binary stream system for `BinaryFrame` data).

**Input:**
- `payload` (object|Buffer): Message payload to transmit. Objects are JSON-stringified; Buffers are sent unchanged.
- `ws` (WebSocket, optional): Target WebSocket for direct message, omit for broadcast

**Returns:** 
- `boolean` - True if sent successfully
- `false` - If send failed
- `undefined` - If socket inactive

**Example:**
```javascript
// Send to specific client
channel.send({ type: 'data', value: 42 }, clientSocket);

// Broadcast to all clients
channel.send({ type: 'notification', message: 'System update' });
```

---

#### **`message(type, message = {}, ws?)`**
Sends a structured message with type identifier and payload. Internally uses the `send()` method. Intended for low-level messaging to support internal negotiation and management protocols. Do not use this method to send arbitrary data types (prefer the `data` method instead). The message payload is always an object and defaults to an empty object if not specified. User-defined class instances and functions are not supported unless they can be degraded to plain objects through JSON serialization. See message input description for important details.

**Input:**
- `type` (string): Message type identifier
- `message` (object|any): Message payload object, defaults to `{}`
  - The payload will always be converted to an object when received by the remote end of the link
  - If the input is a plain object then all object properties will pass through as is (caveats below)
  - If the input is undefined then an empty payload object will be sent
  - If the input is any other type then a payload object containing a `body` property set to the input value will be sent
  - In all cases, the receiving end of the link will append two additional properties to the raw payload, overwriting these values if they already exist in the source object:
    - `address` (string): The source IP address of the sender
    - `SessionID` (string): The unique Session ID of the connection
- `ws` (WebSocket, optional): Target client WebSocket, broadcasts to the entire channel if unset

**Returns:**
- `boolean|undefined`: Same as send() method

**Example:**
```javascript
// Send typed message to specific client
channel.message('status', { state: 'ready' }, clientSocket);

// Broadcast error to all clients
channel.message('error', { code: 404, text: 'Not found' });

// Message with default empty message
channel.message('ping');  // equivalent to channel.message('ping', {})

// Message with non-object message
channel.message('nonstandard', 'payload');  // equivalent to channel.message('nonstandard', {body: 'payload'})
```

---

#### **`data(type, message)`**
Sends an application-level data message with practically any arbitrary type. Internally uses the `message()` method. The message payload can be any JSON-serializable value including native types (strings, numbers, booleans, null), arrays, and plain objects. User-defined class instances and functions are not supported unless they can be degraded to plain objects through JSON serialization.

**Input:**
- `type` (string): Data message type identifier
- `message` (any): Data payload (must be JSON-serializable)

**Returns:** 
- `boolean|undefined`: Same as message() method

**Example:**
```javascript
// Native types
channel.data('count', 42);
channel.data('active', true);
channel.data('name', 'device-1');

// Arrays and objects
channel.data('points', [1, 2, 3]);
channel.data('config', { timeout: 5000, retries: 3 });

// Invalid - will lose class methods after serialization
class User {
  constructor(name) { this.name = name; }
  greet() { return `Hello ${this.name}`; }
}
channel.data('user', new User('Alice')); // Only {name: 'Alice'} is transmitted
```

### Class "Channel"

#### Static Methods

#### **`getConnection(id, options): object`**
Creates a connection configuration object from ID and options.

**Input:**
- `id` (string): Channel identifier
- `options` (object): Connection options
  - `ports` (object, optional): Map of channel IDs to ports, (must contain a property name matching the supplied `id`)
  - `port` (string|number, optional): used instead of the `ports` property if only one port is defined
  - Additional connection properties

**Returns:** `object` - Connection configuration object

---

#### Methods

#### **`constructor(id, connection)`**
Creates a managed communication channel with state and driver support.

**Input:**
- `id` (string): Channel identifier
- `connection` (object): Connection configuration

The Channel class extends SecureChannel to provide domain-driven communication between clients and workers. Each domain identifies a driver class, and a matching JavaScript source file named <domain>.js should exist in the configured DRIVERS location to spawn worker nodes of that class.

---

#### **`request(command: string, args: object, key?: string): void`**
Sends a command request to execute an exported function.

**Input:**
- `command` (string): Name of exported command to invoke
- `args` (object): Command arguments
- `key` (string, optional): Request correlation identifier

**Example:**
```javascript
channel.request('getData', { id: 123 });
```

---

#### **`dispatch(data: object, socket?: object): void`**
Routes messages to appropriate handlers by streaming data through the driver pipeline.

**Input:**
- `data` (object): Message data to route
- `socket` (object, optional): Handler context, falls back to `Channel` context if not supplied

**Returns:**
- `void`: No return value

**Example:**
```javascript
channel.dispatch({ type: 'update', data: newState });
```

---

#### **`join(controller: Controller): void`**
Joins this channel to a controller instance.

**Input:**
- `controller` (Controller): Controller instance to join

**Example:**
```javascript
channel.join(systemController);
```

---

#### **`use(middleware: Function): void`**
Adds message processing middleware.

**Input:**
- `middleware` (function): Middleware function

**Example:**
```javascript
channel.use(message => {
  console.log('Processing:', message);
  return message;
});
```

---

#### **`export(exports: object): void`**
Registers remotely callable functions.

**Input:**
- `exports` (object): Map of command names to handlers

**Example:**
```javascript
channel.export({
  ping: async () => 'pong',
  echo: async (data) => data
});
```

---

#### **`end(): void`**
Stops the channel and performs cleanup.

**Input:** None

**Returns:** `void`

**Example:**
```javascript
// Basic shutdown
channel.end();

// Graceful shutdown with cleanup
async function shutdownChannel() {
  // Notify clients
  channel.emit('shutdown', {
    reason: 'maintenance',
    timestamp: Date.now()
  });

  // Wait for client acknowledgments
  await Promise.all(Array.from(channel.clients).map(client => 
    new Promise(resolve => {
      client.once('shutdown_ack', resolve);
      setTimeout(resolve, 5000); // 5s timeout
    })
  ));

  // Stop channel
  channel.end();
}

// Coordinated multi-channel shutdown
async function shutdownAllChannels(channels) {
  // Notify all channels
  channels.forEach(ch => 
    ch.emit('shutdown_pending', { timestamp: Date.now() })
  );

  // Wait briefly for notifications to be sent
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Shutdown channels in sequence
  for (const ch of channels) {
    await new Promise(resolve => {
      ch.once('down', resolve);
      ch.end();
    });
    console.log(`Channel ${ch.id} shutdown complete`);
  }
}
```

---

#### **`start(): Promise<void>`**
Initializes the channel.

**Input:** None

**Returns:** `Promise<void>`

**Example:**
```javascript
// Basic startup
await channel.start();

// Startup with health check
async function startChannel() {
  await channel.start();
  
  // Wait for readiness
  await channel.onReady();
  
  // Verify driver status
  const status = channel.status();
  const unhealthyDomains = Object.entries(status)
    .filter(([_, ready]) => !ready)
    .map(([domain]) => domain);
    
  if (unhealthyDomains.length > 0) {
    throw new Error(`Domains not ready: ${unhealthyDomains.join(', ')}`);
  }
  
  console.log('Channel started and healthy');
}

// Startup with retry logic
async function startWithRetry(maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await channel.start();
      await Promise.race([
        channel.onReady(),
        new Promise((_, reject) => 
          setTimeout(() => reject('timeout'), 10000)
        )
      ]);
      console.log('Channel started successfully');
      return;
    } catch (error) {
      console.error(`Start attempt ${attempt} failed:`, error);
      if (attempt === maxAttempts) {
        throw new Error('Failed to start channel after max attempts');
      }
      await new Promise(resolve => 
        setTimeout(resolve, 5000 * Math.pow(2, attempt - 1))
      );
    }
  }
}
```

---

#### **`channelExports(): LazyObject`**
Returns an object capable of directly calling exports through the channel context.

**Returns:** `LazyObject` - Proxy object for calling channel exports

**Example:**
```javascript
// Get exports proxy
const exports = channel.channelExports();

// Call exported methods directly
await exports.getData({ id: 123 });
await exports.updateConfig({ timeout: 5000 });
```

---

#### **`status(): object`**
Returns the ready status of all driver domains.

**Returns:** `object` - Map of domain IDs to ready status

**Example:**
```javascript
const status = channel.status();
console.log('Domain status:', status);
// Output: { 
//   'sensors': true,
//   'displays': false,
//   'system': true 
// }
```

---

#### **`channels(): object`**
Returns a map of available channels from the controller.

**Returns:** `object` - Channel map

**Example:**
```javascript
const channels = channel.channels();
console.log('Available channels:', Object.keys(channels));
// Output: ['main', 'admin', 'metrics']

// Access specific channel
const adminChannel = channels['admin'];
```

---

#### **`channelReady(): boolean`**
Indicates if all domains are ready.

**Returns:** `boolean` - False if any domain is not ready

**Example:**
```javascript
if (channel.channelReady()) {
  console.log('All domains are ready');
  await startProcessing();
} else {
  console.log('Waiting for domains to become ready...');
}
```

---

#### **`onReady(): Promise<void>`**
Promise that resolves when all domains become ready.

**Returns:** `Promise<void>`

**Example:**
```javascript
// Wait for all domains to be ready
console.log('Waiting for channel readiness...');
await channel.onReady();
console.log('Channel is now ready');

// With timeout
try {
  await Promise.race([
    channel.onReady(),
    new Promise((_, reject) => setTimeout(() => reject('timeout'), 5000))
  ]);
  console.log('Channel ready within timeout');
} catch (error) {
  console.error('Channel not ready within 5 seconds');
}
```

---

#### **`emitCache(path = [], socket = this): void`**
Fires sink methods using the passed socket as context and using the path to walk the state cache.

**Input:**
- `path` (array): Path to walk in cache hierarchy [domain, type, node]
- `socket` (object, optional): Socket context for emission, defaults to channel instance

**Returns:** `void`

**Example:**
```javascript
// Emit all cache data
channel.emitCache();

// Emit specific domain cache
channel.emitCache(['sensors']);

// Emit specific node cache to client
channel.emitCache(['sensors', 'temperature', 'sensor1'], clientSocket);
```

---

#### **`pushState(socket): void`**
Synchronizes client state on connection by emitting cache state and node state.

**Input:**
- `socket` (object): Client socket to synchronize

**Returns:** `void`

**Example:**
```javascript
// On new client connection
channel.on('connection', socket => {
  console.log('New client connected, syncing state...');
  channel.pushState(socket);
});
```

---

#### **`createDriver(id): Driver`**
Creates a new Driver instance attached to this channel.

**Input:**
- `id` (string): Driver domain identifier

**Returns:** `Driver` - New driver instance

**Example:**
```javascript
// Create and configure a new driver
const sensorDriver = channel.createDriver('sensors');
sensorDriver.publish({
  data: (reading) => console.log('Sensor reading:', reading)
});
await sensorDriver.start();

// Create driver with immediate configuration
const displayDriver = channel.createDriver('displays')
  .publish({
    status: (state) => updateDisplay(state)
  })
  .subscribe({
    command: (cmd) => handleCommand(cmd)
  });
await displayDriver.start();
```

---

#### **`loadDriver(id): Driver`**
Alias for createDriver().

**Input:**
- `id` (string): Driver domain identifier

**Returns:** `Driver` - New driver instance

**Example:**
```javascript
// Load existing driver configuration
const driver = channel.loadDriver('existing-domain');
await driver.start();
```

---

#### **`handle(exports)`**
Alias for export().

**Input:**
- `exports` (object): Map of command names to handlers

**Returns:** `this` - The channel instance

**Example:**
```javascript
// Register command handlers using handle()
channel.handle({
  'getStatus': async () => ({ status: 'ok' }),
  'restart': async () => {
    await restartSystem();
    return { success: true };
  }
});

// Chain multiple handlers
channel
  .handle({ ping: async () => 'pong' })
  .handle({ echo: async (msg) => msg });
```

---

#### **`destroy()`**
Immediately terminates the channel and all drivers.

**Input:** None

**Returns:** `void`

---

#### **`request(command, args, key)`**
Executes a command through the channel's exports.

**Input:**
- `command` (string): Name of the command to execute
- `args` (object): Arguments to pass to the command
- `key` (string, optional): Transaction key for correlation

**Returns:** `Promise<any>` - Command result

**Example:**
```javascript
// Basic command execution
const result = await channel.request('getData', { id: 123 });

// With correlation key for tracking
const status = await channel.request('checkStatus', 
  { deviceId: 'sensor1' },
  'status-check-001'
);

// Error handling
try {
  const result = await channel.request('updateConfig', {
    timeout: 5000,
    retries: 3
  });
  console.log('Config updated:', result);
} catch (error) {
  console.error('Config update failed:', error);
}
```

---

#### **`passthrough(command)`**
Factory method to produce an action function with a curried command baked in.

**Input:**
- `command` (string): Command name to curry

**Returns:** `Function` - Curried function that takes args and executes the command

**Example:**
```javascript
// Create curried functions for common operations
const getData = channel.passthrough('getData');
const updateConfig = channel.passthrough('updateConfig');

// Use the curried functions
const data = await getData({ id: 123 });
await updateConfig({ timeout: 5000 });

// Use in array operations
const ids = [1, 2, 3];
const results = await Promise.all(
  ids.map(id => getData({ id }))
);
```

---

#### **`dispatch(data, socket)`**
Pushes data through the driver pipeline, as if arriving directly from a source.

**Input:**
- `data` (object): Data to dispatch through pipeline
- `socket` (object, optional): Socket context for dispatch

**Returns:** `void`

**Example:**
```javascript
// Dispatch to all clients
channel.dispatch({
  type: 'status',
  value: 'online'
});

// Dispatch with specific context
channel.dispatch({
  type: 'private',
  message: 'Your session is expiring'
}, clientSocket);

// Dispatch with error handling
try {
  channel.dispatch({
    type: 'sensor',
    readings: [
      { id: 1, value: 25.5 },
      { id: 2, value: 30.2 }
    ]
  });
} catch (error) {
  console.error('Dispatch failed:', error);
}
```

---

#### **`join(controller)`**
Attaches this channel to a controller instance.

**Input:**
- `controller` (Controller): Controller instance to join

**Returns:** `this` - The channel instance

**Example:**
```javascript
// Basic controller join
const controller = new Controller();
channel.join(controller);

// Chain configuration after joining
channel
  .join(controller)
  .use(middleware)
  .export({
    ping: () => 'pong'
  });

// Join with error handling
try {
  channel.join(controller);
  console.log('Channel joined to controller');
} catch (error) {
  console.error('Failed to join controller:', error);
}
```

---

#### **`use(middleware)`**
Attaches middleware to the channel's server.

**Input:**
- `middleware` (Function): Express middleware function

**Returns:** `this` - The channel instance

**Example:**
```javascript
// Basic logging middleware
channel.use((req, res, next) => {
  console.log(`${req.method} ${req.path}`);
  next();
});

// Authentication middleware
channel.use((req, res, next) => {
  if (!req.headers.authorization) {
    res.status(401).send('Unauthorized');
    return;
  }
  next();
});

// Chain multiple middleware
channel
  .use(cors())
  .use(bodyParser.json())
  .use(compression());
```

---

#### **`export(exports)`**
Adds command handlers to the channel's exports.

**Input:**
- `exports` (object): Map of command names to handlers

**Returns:** `this` - The channel instance

**Example:**
```javascript
// Basic exports
channel.export({
  ping: async () => 'pong',
  echo: async (msg) => msg,
  time: async () => new Date().toISOString()
});

// Exports with error handling
channel.export({
  getData: async ({ id }) => {
    try {
      return await database.query(id);
    } catch (error) {
      throw new Error(`Data fetch failed: ${error.message}`);
    }
  },
  validate: async (data) => {
    if (!data.id) throw new Error('ID required');
    return { valid: true };
  }
});

// Chain exports for different features
channel
  .export({ ping: async () => 'pong' })
  .export({ echo: async (msg) => msg })
  .export({ time: async () => new Date().toISOString() });
```

---

#### **`end()`**
Gracefully shuts down the channel and all drivers.

**Returns:** `Promise<void>` - Resolves when shutdown is complete

**Example:**
```javascript
// Basic shutdown
await channel.end();

// Shutdown with timeout
try {
  await Promise.race([
    channel.end(),
    new Promise((_, reject) => 
      setTimeout(() => reject('Shutdown timeout'), 5000)
    )
  ]);
  console.log('Channel shutdown complete');
} catch (error) {
  console.error('Shutdown failed:', error);
}

// Cleanup pattern
async function cleanup() {
  try {
    await channel.end();
    console.log('Channel shutdown complete');
  } catch (error) {
    console.error('Shutdown error:', error);
  } finally {
    process.exit();
  }
}
```

---

#### **`start()`**
Starts the channel server and all drivers.

**Returns:** `Promise<void>` - Resolves when startup is complete

**Example:**
```javascript
// Basic startup
await channel.start();

// Startup with configuration
const channel = new Channel('main', config);
try {
  await channel.start();
  console.log('Channel started successfully');
} catch (error) {
  console.error('Channel startup failed:', error);
}

// Startup with timeout
try {
  await Promise.race([
    channel.start(),
    new Promise((_, reject) => 
      setTimeout(() => reject('Startup timeout'), 10000)
    )
  ]);
  console.log('Channel started within timeout');
} catch (error) {
  console.error('Startup failed:', error);
}
```

---

### Class "Driver"

The Driver class provides an interface between Channels and Workers, managing device communication and state. Each driver is given a unique domain ID that sits hierarchically under the parent channel.

#### Properties
- `domain` (string): The unique identifier for this driver instance.
- `sessionid` (string): The channel's session ID
- `controller` (Controller): Reference to the parent controller instance.
**Example:**
```javascript
const driver = new Driver('sensors');
if (driver.controller) {
  // Access controller state
  const state = driver.controller.state;
  // Access other channels through controller
  const otherChannels = driver.controller.channels;
}
```

- `channels` (object): Map of available channels from the controller.
**Example:**
```javascript
const driver = new Driver('sensors');
// Access other channels
const channels = driver.channels;
if (channels.admin) {
  // Send message through admin channel
  channels.admin.send({ type: 'status', status: 'ok' });
}
```
- `sources` (object): Collection of source event handlers.
**Example:**
```javascript
const driver = new Driver('sensors');
// Register source handlers
driver.subscribe({
  'temperature': (data) => console.log('Temperature:', data),
  'humidity': (data) => console.log('Humidity:', data)
});

// Access registered handlers
console.log('Registered sources:', Object.keys(driver.sources));
```

- `sinks` (object): Collection of sink event handlers.
**Example:**
```javascript
const driver = new Driver('sensors');
// Register sink handlers
driver.publish({
  'data': (data) => processData(data),
  'error': (error) => handleError(error)
});

// Access registered handlers
console.log('Registered sinks:', Object.keys(driver.sinks));
```

- `workers` (object): Map of worker instances for this driver's domain.
**Example:**
```javascript
const driver = new Driver('sensors');
// Access worker instances
const workers = driver.workers;
// Send command to specific worker
if (workers['temp1']) {
  await workers['temp1'].request({ command: 'calibrate' });
}
```

- `hasWorkers` (boolean): Indicates if the driver has any active workers.
- `status` (object): Current ready status of all worker nodes.
**Example:**
```javascript
const driver = new Driver('sensors');
// Check status of all nodes
const status = driver.status;
Object.entries(status).forEach(([nodeId, ready]) => {
  console.log(`Node ${nodeId}: ${ready ? 'ready' : 'not ready'}`);
});
```

- `domainHealthy` (boolean): True if all nodes are ready or no nodes exist
- `domainReady` (string|false|undefined): Returns the first available node if any are ready.
**Returns:** 
- `string` - Node ID if a node is ready
- `false` - If no nodes are ready
- `undefined` - If no nodes have checked in

**Example:**
```javascript
const driver = new Driver('sensors');
const readyNode = driver.domainReady;
if (typeof readyNode === 'string') {
  console.log('Ready node:', readyNode);
  await driver.workers[readyNode].request({ command: 'getData' });
} else if (readyNode === false) {
  console.log('No nodes are ready');
} else {
  console.log('No nodes have checked in yet');
}
```

- `onReady` (Promise<void>): Promise that resolves when domain becomes ready (at least one node has checked in).
**Example:**
```javascript
const driver = new Driver('sensors');
// Wait for domain to become ready
console.log('Waiting for domain readiness...');
await driver.onReady;
console.log('Domain is now ready');

// With timeout
try {
  await Promise.race([
    driver.onReady,
    new Promise((_, reject) => setTimeout(() => reject('timeout'), 5000))
  ]);
  console.log('Domain ready within timeout');
} catch (error) {
  console.error('Domain not ready within 5 seconds');
}
```

- `onHealthy` (Promise<void>): Promise that resolves when all nodes are healthy.
**Example:**
```javascript
const driver = new Driver('sensors');
// Wait for all nodes to be healthy
console.log('Waiting for all nodes to be healthy...');
await driver.onHealthy;
console.log('All nodes are now healthy');

// With health check and timeout
async function waitForHealthyDomain() {
  try {
    await Promise.race([
      driver.onHealthy,
      new Promise((_, reject) => setTimeout(() => reject('timeout'), 10000))
    ]);
    
    // Verify node health
    const unhealthyNodes = Object.entries(driver.status)
      .filter(([_, ready]) => !ready)
      .map(([node]) => node);
      
    if (unhealthyNodes.length > 0) {
      throw new Error(`Nodes still unhealthy: ${unhealthyNodes.join(', ')}`);
    }
    
    console.log('All nodes verified healthy');
  } catch (error) {
    console.error('Health check failed:', error);
  }
}
```

---

#### Methods

#### **`emit(type: string, node?: string, socket?: WebSocket)`**
Emits an event to registered sinks.

**Input:**
- `type` (string): Event type to emit
- `node` (string, optional): Specific node to emit for
- `socket` (WebSocket, optional): Target socket

**Example:**
```javascript
// Emit to all sinks
driver.emit('status', { state: 'ready' });

// Emit from specific node
driver.emit('temperature', 'sensor1', { value: 25.5 });

// Emit to specific client
driver.emit('alert', null, clientSocket);
```

---

#### **`pipeline(type: string, node?: string)`**
Creates a pipeline to process a source event stream and orchestrate data output to listeners.

**Input:**
- `type` (string): Event type to handle
- `node` (string, optional): Specific node to handle

**Returns:** `Function` - Pipeline handler

**Example:**
```javascript
// Create data processing pipeline
const processData = driver.pipeline('sensor-data');

// Create node-specific pipeline
const processNodeData = driver.pipeline('sensor-data', 'sensor1');

// Use pipeline in event handler
driver.subscribe({
  'sensor-data': processData
});
```

---

#### **`cache(...args)`**
Manages cache state for the driver domain.

**Input:**
- Overload 1:
  - `path` (string[]): Cache path
  - `value` (any): Value to cache
- Overload 2:
  - `path` (string[]): Cache path to retrieve
- Overload 3:
  - `channel` (Channel): Channel instance
  - `path` (string[]): Cache path
  - `value` (any): Value to cache
  - `overwrite` (boolean, optional): Whether to overwrite existing value
- Overload 4:
  - `channel` (Channel): Channel instance
  - `path` (string[]): Cache path to retrieve

**Returns:** `any` - Cached value when getting, `void` when setting

**Example:**
```javascript
// Store value in cache
driver.cache(['sensors', 'temp1'], { value: 25.5 });

// Retrieve cached value
const temp = driver.cache(['sensors', 'temp1']);

// Store with channel context
driver.cache(channel, ['sensors', 'temp1'], { value: 25.5 }, true);

// Retrieve with channel context
const temp2 = driver.cache(channel, ['sensors', 'temp1']);
```

---

#### **`nodes(...args)`**
Manages node state metadata.

**Input:** Same overloads as `cache()`

**Returns:** `any` - Node state value when getting, `void` when setting

**Example:**
```javascript
// Store node state
driver.nodes(['temp1'], { status: 'active' });

// Retrieve node state
const nodeState = driver.nodes(['temp1']);

// Store with channel context
driver.nodes(channel, ['temp1'], { status: 'active' }, true);

// Retrieve with channel context
const nodeState2 = driver.nodes(channel, ['temp1']);
```

---

#### **`request(command: string, options: object)`**
Sends a command to a worker node.

**Input:**
- `command` (string): Command to execute
- `options` (object):
  - `node` (string): Target node, defaults to node that checked in most recently if not specified
  - Additional command arguments

**Returns:** `Promise<any>` - Command result

**Example:**
```javascript
// Send command to most recent node
const result = await driver.request('getData', {
  timeRange: '1h'
});

// Send command to specific node
const result2 = await driver.request('calibrate', {
  node: 'sensor1',
  offset: 0.5
});
```

---

#### **`join(channel: Channel)`**
Attaches the driver to a channel.

**Input:**
- `channel` (Channel): Channel to join

**Returns:** `this` - The driver instance

---

#### **`leave()`**
Detaches the driver from its channel.

**Input:** None

**Returns:** `void`

---

#### **`publish(sinks: object)`**
Registers sink event handlers.

**Input:**
- `sinks` (object): Event handlers

**Returns:** `this` - The driver instance

---

#### **`subscribe(sources: object)`**
Registers source event handlers.

**Input:**
- `sources` (object): Event handlers

---

**Returns:** `this` - The driver instance

#### **`process(options: object)`**
Configures both sources and sinks.

**Input:**
- `options` (object):
  - `source` (object): Source handlers
  - `sink` (object): Sink handlers

---

**Returns:** `this` - The driver instance

#### **`end()`**
Stops all workers and detaches from channel.

**Input:** None

---

**Returns:** `Promise<void>`

#### **`start()`**
Initializes workers for the domain.

**Input:** None

**Returns:** `Promise<void>`

---

#### **`reset(devices: object)`**
Resets workers with new device configurations.

**Input:**
- `devices` (object): New device configurations

**Returns:** `Promise<boolean>` - Success status

---

#### Constructor

#### **`constructor(id: string)`**
Creates a new Driver instance.

**Input:**
- `id` (string): Unique domain identifier

**Example:**
```javascript
const driver = new Driver('myDomain')
  .join(channel)
  .publish({
    status: (data) => console.log('Status:', data)
  })
  .subscribe({
    command: (data) => handleCommand(data)
  });

await driver.start();
```

---

### Class "Node"

#### Methods

#### **`constructor(devices: any)`**
Creates a node instance to represent a logical or physical device.

**Input:**
- `devices` (any): Device configuration data

**Example:**
```javascript
const node = new Node({
  id: 'device1',
  type: 'sensor',
  config: { interval: 1000 }
});
```

---

#### **`dispatch(type: string, message: any): void`**
Emits an event with payload to handlers.

**Input:**
- `type` (string): Event type identifier
- `message` (any): Event data payload

**Example:**
```javascript
node.dispatch('reading', { temperature: 22.5 });
```

---

#### **`connect(init: Function): void`**
Initializes node connection and setup.

**Input:**
- `init` (function): Initialization logic

**Example:**
```javascript
node.connect(async () => {
  await setupDevice();
  console.log('Node connected');
});
```

---

#### **`end(): void`**
Gracefully terminates node operation.

**Example:**
```javascript
await node.end();
```

---

#### **`destroy(message?: any): void`**
Forces immediate node termination.

**Input:**
- `message` (any, optional): Shutdown reason

**Example:**
```javascript
node.destroy('Emergency shutdown');
```

---

### Class "Worker"

#### Properties
- `queue` (object): Map of pending request handlers.
**Example:**
```javascript
// Check queue status
console.log(`Pending requests: ${Object.keys(worker.queue).length}`);

// Monitor queue changes
setInterval(() => {
  const queueLength = Object.keys(worker.queue).length;
  if (queueLength > 0) {
    console.log(`${queueLength} requests pending`);
  }
}, 5000);
```

- `nodeReady` (boolean): Indicates if the worker node is ready to process requests.
**Example:**
```javascript
// Wait for node readiness before sending commands
if (worker.nodeReady) {
  await worker.request({ command: 'getData' });
} else {
  console.log('Node not ready, waiting...');
  await worker.onReady;
  console.log('Node now ready');
  await worker.request({ command: 'getData' });
}
```

- `nodeDown` (boolean): Indicates if the worker node has disconnected.
**Example:**
```javascript
// Monitor node status
worker.on('status', () => {
  if (worker.nodeDown) {
    console.log('Node disconnected, attempting recovery...');
    // Implement recovery logic
  }
});

// Wait for reconnection
if (worker.nodeDown) {
  console.log('Waiting for node to reconnect...');
  await worker.onReady;
  console.log('Node reconnected');
}
```

- `nodeError` (string|null): Contains the last error reported by the node, or null.
**Example:**
```javascript
// Error monitoring
worker.on('error', () => {
  const error = worker.nodeError;
  if (error) {
    console.error('Node error:', error);
    // Implement error handling
  }
});

// Regular health check
setInterval(() => {
  const error = worker.nodeError;
  if (error) {
    console.error('Node health check failed:', error);
    worker.end().then(() => worker.start());
  }
}, 60000);
```

- `onReady` (Promise<void>): Promise that resolves when the node becomes ready.
**Example:**
```javascript
// Wait for readiness with timeout
try {
  await Promise.race([
    worker.onReady,
    new Promise((_, reject) => 
      setTimeout(() => reject('timeout'), 5000)
    )
  ]);
  console.log('Node ready within timeout');
} catch (error) {
  console.error('Node failed to become ready:', error);
}

// Sequential startup
async function startWorkers(workers) {
  for (const worker of workers) {
    await worker.onReady;
    console.log(`Worker ${worker.id} ready`);
  }
  console.log('All workers ready');
}
```

- `onDown` (Promise<void>): Promise that resolves when the node disconnects.
**Example:**
```javascript
// Monitor for disconnection
worker.onDown.then(() => {
  console.log('Node disconnected');
  // Implement cleanup or recovery
});

// Graceful shutdown pattern
async function shutdown() {
  worker.end();
  await worker.onDown;
  console.log('Worker shutdown complete');
}
```

---

#### Methods

#### **`constructor(driver: Driver, id: string, sessionid: string, deviceProps?: object)`**
Creates a worker instance to manage a child process for a specific device node.

**Input:**
- `driver` (Driver): Parent driver instance
- `id` (string): Unique worker identifier
- `sessionid` (string): Session identifier
- `deviceProps` (object, optional): Additional device configuration properties

**Example:**
```javascript
// Create a temperature sensor worker
const tempWorker = new Worker(sensorDriver, 'temp-sensor-1', 'session-123', {
  interval: 1000,  // Read temperature every second
  units: 'celsius'
});

// Create a display worker with custom properties
const displayWorker = new Worker(displayDriver, 'lcd-1', 'session-123', {
  width: 128,
  height: 64,
  interface: 'i2c'
});
```

---

#### **`message(type: string, message: any): boolean`**
Sends a message to the worker process.

**Input:**
- `type` (string): Message type identifier
- `message` (any): Message payload

**Returns:** `boolean` - True if message was sent successfully

**Example:**
```javascript
// Send configuration update
worker.message('config', {
  interval: 2000,
  threshold: 25.5
});

// Send control command
worker.message('control', {
  action: 'reset',
  params: { mode: 'soft' }
});

// Send with error handling
try {
  const sent = worker.message('command', {
    action: 'calibrate',
    target: 0
  });
  if (!sent) {
    console.error('Failed to send message');
  }
} catch (error) {
  console.error('Message error:', error);
}
```

---

#### **`request(request: object): Promise<any>`**
Sends a request to the worker process and waits for response.

**Input:**
- `request` (object): Request object containing command and parameters

**Returns:** Promise resolving with response

**Example:**
```javascript
// Basic request
try {
  const data = await worker.request({
    command: 'getData',
    params: { timeRange: '1h' }
  });
  console.log('Received data:', data);
} catch (error) {
  console.error('Request failed:', error);
}

// Request with timeout
try {
  const result = await Promise.race([
    worker.request({
      command: 'longOperation',
      params: { size: 'large' }
    }),
    new Promise((_, reject) => 
      setTimeout(() => reject('timeout'), 10000)
    )
  ]);
  console.log('Operation completed:', result);
} catch (error) {
  if (error === 'timeout') {
    await worker.abort(requestKey);
    console.error('Operation timed out');
  }
}

// Sequential requests
async function processBatch(items) {
  const results = [];
  for (const item of items) {
    const result = await worker.request({
      command: 'process',
      params: { item }
    });
    results.push(result);
  }
  return results;
}
```

---

#### **`abort(key: string): Promise<string>`**
Aborts a pending request.

**Input:**
- `key` (string): Request identifier

**Returns:** Promise resolving with 'acknowledged' if request was aborted

**Example:**
```javascript
// Abort specific request
try {
  const status = await worker.abort('request-123');
  console.log('Abort status:', status);
} catch (error) {
  console.error('Abort failed:', error);
}

// Abort with timeout pattern
async function requestWithTimeout(command, params, timeout) {
  const requestKey = Date.now().toString();
  try {
    return await Promise.race([
      worker.request({ command, params, key: requestKey }),
      new Promise((_, reject) => 
        setTimeout(async () => {
          await worker.abort(requestKey);
          reject('timeout');
        }, timeout)
      )
    ]);
  } catch (error) {
    if (error === 'timeout') {
      console.error('Request timed out');
    }
    throw error;
  }
}
```

---

#### **`start(): void`**
Launches the worker process and initializes communication.

**Example:**
```javascript
// Basic start
worker.start();

// Start with error handling
try {
  worker.start();
  await worker.onReady;
  console.log('Worker started successfully');
} catch (error) {
  console.error('Worker start failed:', error);
}

// Start with health check
async function startWithHealthCheck() {
  worker.start();
  await worker.onReady;
  
  // Verify node health
  const response = await worker.request({
    command: 'healthCheck'
  });
  
  if (!response.healthy) {
    throw new Error('Health check failed');
  }
  
  console.log('Worker started and healthy');
}
```

---

#### **`end(): Promise<void>`**
Gracefully terminates the worker process.

**Returns:** Promise resolving when shutdown is complete

**Example:**
```javascript
// Basic shutdown
await worker.end();

// Graceful shutdown with timeout
async function shutdownWithTimeout(timeout = 5000) {
  try {
    await Promise.race([
      worker.end(),
      new Promise((_, reject) => 
        setTimeout(() => reject('timeout'), timeout)
      )
    ]);
    console.log('Worker shutdown complete');
  } catch (error) {
    console.error('Shutdown timed out, forcing termination');
    worker.destroy();
  }
}

// Coordinated shutdown of multiple workers
async function shutdownAll(workers) {
  await Promise.all(
    workers.map(worker => worker.end())
  );
  console.log('All workers shut down');
}
```

---

#### **`destroy(): void`**
Immediately terminates the worker process.

**Example:**
```javascript
// Immediate termination
worker.destroy();

// Force quit after failed graceful shutdown
async function forceQuit() {
  try {
    await worker.end();
  } catch (error) {
    console.error('Graceful shutdown failed:', error);
    worker.destroy();
  }
}

// Emergency shutdown pattern
function emergencyShutdown(workers) {
  console.error('Emergency shutdown initiated');
  workers.forEach(worker => worker.destroy());
  process.exit(1);
}
```

---

### Class "Passthrough" extends Node

#### Methods

#### **`constructor(devices: object)`**
Creates a message forwarding node that cascades connections to a downstream SecureChannel server. The Passthrough relays both JSON protocol messages and binary stream data bidirectionally between the parent Channel (via IPC) and the remote server (via WebSocket); it bridges binary streams automatically, mirroring stream advertisements and subscription state, with no application code required. See `docs/binary streams.md` for the stream relay details.

**Input:**
- `devices` (object): Device configuration map

**Example:**
```javascript
const passthrough = new Passthrough({
  'device-1': {
    address: 'localhost',
    port: 8080
  }
});
```

---

#### **`connect(init: Function|object, options?: object): Promise<void>`**
Establishes connection to downstream server.

**Input:**
- `init` (Function|object): Initialization function or device configuration
- `options` (object, optional): Connection options
  - `timeout` (number): Connection timeout in seconds

**Returns:** `Promise<void>`

**Example:**
```javascript
// Using initialization function
await passthrough.connect(async () => {
  await setupConnection();
});

// Using device configuration
await passthrough.connect({
  address: 'localhost',
  port: 8080
}, { timeout: 30 });
```

#### **`end(): void`**
Disconnects from downstream server and terminates node.

**Example:**
```javascript
// Basic shutdown
passthrough.end();

// Graceful shutdown with cleanup
async function shutdownPassthrough() {
  // Notify upstream about shutdown
  passthrough.forwardToParent({
    type: 'status',
    status: 'shutting_down'
  });
  
  // Wait for pending operations
  await Promise.all(pendingOperations);
  
  // Disconnect
  passthrough.end();
  
  console.log('Passthrough node terminated');
}

// Coordinated shutdown
async function shutdownSystem() {
  // Notify all connected clients
  await broadcastMessage('shutdown_imminent');
  
  // Shutdown passthroughs in sequence
  for (const node of passthroughNodes) {
    await new Promise(resolve => {
      node.once('down', resolve);
      node.end();
    });
  }
}
```

---

#### **`forwardToRemote(payload: object): void`**
Forwards message to downstream server.

**Input:**
- `payload` (object): Message to forward

**Example:**
```javascript
// Basic message forwarding
passthrough.forwardToRemote({
  type: 'command',
  action: 'restart',
  target: 'service-1'
});

// Forward with metadata
passthrough.forwardToRemote({
  type: 'data',
  timestamp: Date.now(),
  source: 'sensor-1',
  readings: [
    { temp: 25.5, humidity: 60 }
  ]
});

// Forward with error handling
try {
  passthrough.forwardToRemote({
    type: 'critical_command',
    action: 'emergency_shutdown'
  });
} catch (error) {
  console.error('Failed to forward critical command:', error);
  // Implement fallback or retry logic
}

// Batch forwarding
function batchForward(messages) {
  messages.forEach(msg => {
    try {
      passthrough.forwardToRemote({
        type: 'batch',
        timestamp: Date.now(),
        payload: msg
      });
    } catch (error) {
      console.error('Batch item forward failed:', error);
    }
  });
}
```

---

#### **`forwardToParent(payload: object): void`**
Forwards message to parent process.

**Input:**
- `payload` (object): Message to forward

**Example:**
```javascript
// Status update
passthrough.forwardToParent({
  type: 'status',
  status: 'connected',
  timestamp: Date.now()
});

// Error reporting
passthrough.forwardToParent({
  type: 'error',
  error: 'Connection lost',
  details: {
    timestamp: Date.now(),
    attempts: retryCount,
    lastError: error.message
  }
});

// Data streaming
passthrough.forwardToParent({
  type: 'stream',
  dataType: 'sensor_readings',
  data: readings,
  sequence: sequenceNumber++
});

// Health metrics
setInterval(() => {
  passthrough.forwardToParent({
    type: 'health',
    metrics: {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      connections: activeConnections.size
    }
  });
}, 60000);
```

---

#### **`onError(error: Error|object): void`**
Handles connection errors.

**Input:**
- `error` (Error|object): Error object

**Example:**
```javascript
// Basic error handling
passthrough.onError = (error) => {
  console.error('Connection error:', error);
  // Implement recovery logic
};

// Advanced error handling
passthrough.onError = (error) => {
  // Log error details
  console.error('Connection error:', {
    message: error.message,
    code: error.code,
    timestamp: new Date().toISOString()
  });

  // Notify monitoring system
  monitoringService.reportError({
    component: 'passthrough',
    error: error
  });

  // Implement recovery strategy based on error type
  switch(error.code) {
    case 'ECONNREFUSED':
      scheduleReconnect(5000);
      break;
    case 'ETIMEDOUT':
      scheduleReconnect(10000);
      break;
    default:
      // For unknown errors, try immediate reconnect
      attemptReconnect();
  }
};

// Error handling with retry logic
let retryCount = 0;
const maxRetries = 5;

passthrough.onError = async (error) => {
  console.error(`Connection error (attempt ${retryCount + 1}/${maxRetries}):`, error);

  if (retryCount < maxRetries) {
    retryCount++;
    const delay = Math.min(1000 * Math.pow(2, retryCount), 30000);
    console.log(`Retrying in ${delay}ms...`);
    await new Promise(resolve => setTimeout(resolve, delay));
    attemptReconnect();
  } else {
    console.error('Max retries exceeded, shutting down');
    passthrough.end();
  }
};
```

---

#### **`onDown(): void`**
Handles connection loss.

**Example:**
```javascript
// Basic connection loss handling
passthrough.onDown = () => {
  console.log('Connection lost');
  // Implement reconnection logic
};

// Advanced connection loss handling
passthrough.onDown = async () => {
  console.log('Connection lost at:', new Date().toISOString());

  // Notify parent about connection loss
  passthrough.forwardToParent({
    type: 'status',
    status: 'disconnected',
    timestamp: Date.now()
  });

  // Clear any pending operations
  clearPendingOperations();

  // Attempt reconnection with backoff
  let attempt = 0;
  const maxAttempts = 5;

  while (attempt < maxAttempts) {
    attempt++;
    const delay = Math.min(1000 * Math.pow(2, attempt), 30000);
    
    console.log(`Reconnection attempt ${attempt}/${maxAttempts} in ${delay}ms`);
    await new Promise(resolve => setTimeout(resolve, delay));

    try {
      await reconnect();
      console.log('Successfully reconnected');
      return;
    } catch (error) {
      console.error(`Reconnection attempt ${attempt} failed:`, error);
    }
  }

  console.error('Failed to reconnect after maximum attempts');
  passthrough.end();
};

// Connection loss handling with state management
passthrough.onDown = () => {
  const state = {
    disconnectedAt: Date.now(),
    pendingMessages: getPendingMessages(),
    lastKnownState: getCurrentState()
  };

  // Save state for recovery
  saveState(state);

  // Notify monitoring
  monitoringService.reportIncident({
    type: 'connection_loss',
    timestamp: state.disconnectedAt,
    details: {
      pendingCount: state.pendingMessages.length,
      lastState: state.lastKnownState
    }
  });

  // Initiate recovery process
  startRecoveryProcess(state);
};
```

---

### Class "Controller"

#### **`constructor(state?: object, driverPath?: string, respawnTime?: number)`**
Creates a controller to manage channels and drivers.

**Input:**
- `state` (object, optional): Initial controller state
- `driverPath` (string, optional): Path to driver modules, defaults to DRIVERS environment variable
- `respawnTime` (number, optional): Driver respawn delay in seconds

**Environment Variables Used:**
- `DRIVERS`: Default path to driver modules when driverPath is not specified

**Example:**
```javascript
// Using explicit driver path
const controller = new Controller({
  config: { timeout: 5000 }
}, './drivers', 30);  // 30 second respawn delay

// Using DRIVERS environment variable
const controller = new Controller({
  config: { timeout: 5000 }
});  // Will use process.env.DRIVERS for driver path
```

---

#### Methods

#### **`static getDevices(path: string): any[]`**
Discovers available devices at specified path.

**Input:**
- `path` (string): Device search path

**Returns:** Array of device configurations

**Example:**
```javascript
const devices = Controller.getDevices('./devices');
```

---

#### **`createChannel(id: string, options: object): Channel`**
Creates a new managed communication channel and automatically joins it to the Controller instance.

**Input:**
- `id` (string): Channel identifier
- `options` (object): Channel configuration
  - Must include one of:
    - `ports` (object): Map of channel IDs to port numbers
      - Must contain an entry for the provided `id`
    - `port` (string|number): Direct port specification
  - Supports all configuration options from Channel/SecureChannel classes:
    - `address` (string): Network interface address
    - `keepalive` (number): Heartbeat interval in seconds
    - `cert` (Buffer): SSL/TLS certificate data
    - `key` (Buffer): SSL/TLS private key data
    - `path` (string): WebSocket endpoint path
    - See Channel and SecureChannel class documentation for complete options

**Returns:** New Channel instance

**Example:**
```javascript
// Using ports map with additional channel options
const controller = new Controller();
const channel1 = controller.createChannel('main', {
  ports: {
    'main': 8080,
    'admin': 8081
  },
  address: '0.0.0.0',
  keepalive: 30,
  path: '/websocket'
});

// Using direct port with SSL
const channel2 = controller.createChannel('metrics', {
  port: 9090,
  cert: readFileSync('path/to/cert.pem'),
  key: readFileSync('path/to/key.pem')
});

// Invalid - will throw error (no port specified)
const invalidChannel = controller.createChannel('error', {
  host: 'localhost'
}); 

// Invalid - will throw error (id not in ports map)
const invalidChannel2 = controller.createChannel('unknown', {
  ports: {
    'main': 8080
  }
});
```

---

#### **`end(message?: any): void`**
Shuts down all managed components.

**Input:**
- `message` (any, optional): Shutdown reason

**Example:**
```javascript
await controller.end('System shutdown');
```

---

#### **`start(): Promise<void>`**
Initializes all managed components.

**Input:** None

**Returns:** `Promise<void>` - Resolves on startup completion

**Example:**
```javascript
await controller.start();
```

---

### Class "ExpressMiddleware"

#### **`static secureChannel(req: Request, res: Response, next: Function): void`**
Ensures that requests from the /securechannel/ url path segment are ignored by Express so they can be properly multiplexed on the same http(s) connection without conflict.

**Input:**
- `req` (Request): Express request object
- `res` (Response): Express response object
- `next` (Function): Express next middleware function

**Returns:** `void`

**Example:**
```javascript
const express = require('express');
const app = express();

// Add SecureChannel middleware
app.use(ExpressMiddleware.secureChannel);

// Your other routes
app.get('/', (req, res) => {
  res.send('Hello World');
});

// SecureChannel requests will be ignored by Express
app.listen(3000);
```

---

#### **`static injectToken(req: Request, res: Response, next: Function): void`**
Adds authentication tokens to requests.

**Input:**
- `req` (Request): Express request object
- `res` (Response): Express response object
- `next` (Function): Express next middleware function

**Returns:** `void`

**Example:**
```javascript
const express = require('express');
const app = express();

// Add token injection middleware
app.use(ExpressMiddleware.injectToken);

// Protected route that requires authentication
app.get('/api/secure', (req, res) => {
  // Token will be available in req.token
  if (!req.token) {
    res.status(401).send('Unauthorized');
    return;
  }
  res.json({ message: 'Secure data' });
});

app.listen(3000);
```

---

#### **`static noRoute(req: Request, res: Response): void`**
Handles undefined route requests.

**Input:**
- `req` (Request): Express request object
- `res` (Response): Express response object

**Returns:** `void` - Sends 404 Not Found response

**Example:**
```javascript
const express = require('express');
const app = express();

// Your defined routes
app.get('/', (req, res) => {
  res.send('Home page');
});

// Use noRoute as the last middleware
app.use(ExpressMiddleware.noRoute);

// Example with custom error handling
app.use((req, res, next) => {
  if (req.accepts('html')) {
    next(); // Let noRoute handle HTML requests
  } else {
    res.status(404).json({ error: 'Not found' });
  }
}, ExpressMiddleware.noRoute);

app.listen(3000);
```

---

#### **`static getStatus(controller: Controller, getUserSessions?: Function): void`**
Creates status endpoint middleware.

**Input:**
- `controller` (Controller): Controller instance
- `getUserSessions` (function, optional): Session retrieval function
  - Must take no input parameters
  - Must return an array (empty array if no sessions)
  - Each array item must be an object with:
    - `sessionid` (string): Unique session identifier
    - `user` (string): Username or identifier
    - `accessed` (string): Last access timestamp

**Returns:** Express middleware function that:
- Returns 200 with system status on success:
  ```javascript
  {
    state: object,    // Controller state
    channels: object, // Channel map
    devices: object,  // Device configurations
    sessions: array   // Active sessions (if getUserSessions provided)
  }
  ```
- Returns 500 with error message if:
  - getUserSessions throws an error
  - Return value is not an array
  - Session objects missing required properties
  - Session property values are not strings

**Example:**
```javascript
// Example getUserSessions implementation
function getUserSessions() {
  return [
    {
      sessionid: 'abc123',
      user: 'admin',
      accessed: '2024-03-14 12:00:00'
    }
  ];
}

app.get('/status', ExpressMiddleware.getStatus(controller, getUserSessions));
```

---

### Class "CachedData"

#### **`constructor(type: string, options: object)`**
Creates a data collector with caching support, designed to sit in between child nodes and the parent channel, leveraging the in-memory caching mechanisms available in the `Controller` and `Driver` classes. Each data type that should be cached needs its own `CachedData` instance.

**Input:**
- `type` (string): Data type identifier
- `options` (object): Configuration options
  - `dedup` (boolean): When true, filters duplicate data arriving from the collector. When false, passes through source data unfiltered (use false for sources that natively emit only unique events)
  - `overwrite` (boolean): When true, treats source data as complete and removes stale properties from cache. When false, treats source data as an overlay that only adds or updates properties but never removes them (cached properties unspecified in current event remain unchanged)
  - `publishDataStream` (boolean): When true, publishes cached data to new clients upon connection and republishes on changes. When false, disables automatic publishing of raw cache data (use for very large data or when data isn't needed by all clients)
  - `publishStatus` (boolean): When true, publishes status updates from the collector. Use for real-time status updates of large data collections not auto-published through publishDataStream. When false, bypasses status update publishing
  - `nodeInData` (boolean): When true, extracts dynamic node name from incoming data. When false, uses statically defined node name of data source
  - `onData` (function, optional): Optional middleware to be called when data events occur. Useful when extended functionality is needed, beyond the native collector behavior
  - `publishDatatype` (string, optional): Optional property used only with nodeInData mode. Provides mechanism for receiving data from redundant sources in high-availability scenarios. Only most recent data from any node is retained as current state. Aggregates source data types under one output type, firing all aggregated changes to a single subscriber

**Returns:** `CachedData` - New CachedData instance

**Example:**
```javascript
// Basic collector with deduplication
const collector = new CachedData('sensor', {
  dedup: true,
  overwrite: false,
  publishDataStream: true
});

// High-availability collector with dynamic nodes
const haCollector = new CachedData('cluster', {
  nodeInData: true,
  publishDatatype: 'clusterStatus',
  publishStatus: true,
  onData: (data, node) => console.log(`Update from ${node}:`, data)
});
```

---

#### **`collector(...args: any[]): void`**
Collects and processes incoming data.

**Input:**
- `args` (any[]): Data items to collect and process
  - First argument: Data payload
  - Additional arguments: Processing context (if needed)

**Returns:** `void`

**Example:**
```javascript
// Create a collector for temperature data
const tempCollector = new CachedData('temperature', {
  dedup: true,
  overwrite: true
});

// Basic data collection
tempCollector.collector({
  sensorId: 'temp1',
  value: 25.5,
  timestamp: Date.now()
});

// Collection with context
tempCollector.collector(
  { value: 25.5 },
  { source: 'sensor1', priority: 'high' }
);

// Batch collection
const readings = [
  { sensorId: 'temp1', value: 25.5 },
  { sensorId: 'temp2', value: 26.0 }
];
readings.forEach(reading => tempCollector.collector(reading));

// Collection with validation
const validateReading = (reading) => {
  if (typeof reading.value !== 'number') {
    throw new Error('Invalid reading value');
  }
  return reading;
};

try {
  tempCollector.collector(
    validateReading({ sensorId: 'temp1', value: 25.5 })
  );
} catch (error) {
  console.error('Validation failed:', error);
}
```

---

#### **`emitter(...args: any[]): void`**
Broadcasts collected data to subscribers.

**Input:**
- `args` (any[]): Data items to emit

**Returns:** `void`

**Example:**
```javascript
// Create a collector with custom emission
const statusCollector = new CachedData('status', {
  dedup: true,
  publishStatus: true
});

// Basic emission
statusCollector.emitter({
  status: 'online',
  timestamp: Date.now()
});

// Emit with metadata
statusCollector.emitter(
  { status: 'error', code: 500 },
  { severity: 'high', notify: true }
);

// Batched emissions
const updates = [
  { nodeId: 'node1', status: 'online' },
  { nodeId: 'node2', status: 'offline' }
];

updates.forEach(update => {
  statusCollector.emitter(update);
});

// Throttled emissions
let lastEmit = 0;
const THROTTLE_MS = 1000;

function throttledEmit(data) {
  const now = Date.now();
  if (now - lastEmit >= THROTTLE_MS) {
    statusCollector.emitter(data);
    lastEmit = now;
  }
}

// Usage with throttling
setInterval(() => {
  throttledEmit({
    status: 'healthy',
    metrics: getSystemMetrics()
  });
}, 100);  // Runs every 100ms but only emits every 1000ms
```

---

### High Level Architecture

The SecureChannel framework follows a hierarchical structure where a Controller manages multiple Channels, each Channel can have multiple Drivers, and each Driver manages one or more Workers:

```
Controller (manages state, cache, and coordination)
├── Channel "main" (port 8080)
│   ├── Driver "sensors"
│   │   ├── Worker "temp1"
│   │   └── Worker "temp2"
│   └── Driver "displays"
│       └── Worker "lcd1"
└── Channel "admin" (port 8081)
    └── Driver "system"
        ├── Worker "cpu"
        └── Worker "memory"
```

#### Component Roles

1. **Node Process**
   - Runs in a child process for each Worker
   - Implements device-specific logic
   - Generates typed data streams
   - Receives and executes commands

2. **Worker**
   - Controls a single Node process
   - Maintains bidirectional communication with Node
   - Routes commands down to Node
   - Forwards data streams up to Driver

3. **Driver**
   - Manages multiple Workers of the same type
   - Handles application-level data processing
   - Implements caching strategy:
     - In-memory using native mechanisms
     - External storage via custom logic
   - Controls data forwarding:
     - Raw data streaming
     - Status change notifications

4. **Channel**
   - Manages client communication via full duplex WebSocket
   - Routes data from Drivers to clients
   - Supports two data delivery modes to clients:
     - Server push for real-time updates
     - Request/response to retrieve large data sets and to receive user commands

5. **Controller**
   - Controls one or more independent Channels to isolate traffic for specific roles or client types
   - Coordinates overall system state
   - Manages shared cache
   - Orchestrates inter-channel communication

#### Data Flow

```
 Node ───→ Data Stream ────┐
  ↑                        ↓
  └───── Commands ←───── Worker ←─────┐
                           │          │
                       Typed Data     │
                           │          │
                           ↓          │
                         Driver ←→ Commands
                           │          ↑
                      Cache/Process   │
                           │          │
                           ↓          │
      Push Updates ←─── Channel ──────┘
            │              ↑
            │              │
            ↓              │
         Clients           │
            ↑              │
            │              │
            ↓              │
    Request/Response ←─────┘
```

Each Worker's Node process generates typed data streams that flow upward through the system. The Driver layer can cache or process this data, then either push it directly to clients through the Channel or send status notifications that allow clients to request the full data on demand.

---

### Advanced Examples

#### Media Processing Pipeline with SystemCommand and Queue

This example demonstrates how to create a media processing pipeline that:
1. Converts a video file using FFmpeg
2. Copies the result using rsync
3. Tracks and reports progress for both operations

```javascript
import {SystemCommand, Queue} from 'securechannel';

// Shared state for progress tracking
const progressData = {
  mode: 'idle',
  job: '',
  source: '',
  dest: '',
  length: 100,
  scale: 1,
  step: 0,
  steps: 0,
  started: new Date(),
  transferred: 0,
  percentage: 0,
  eta: 0,
  overall: 0
};

// Progress handlers for different command types
const onData = {
  // Parse FFmpeg progress output
  ffmpeg(chunk) {
    const payload = chunk.toString().trim().replace(/[\n]/g, ' ');
    const filter = /total_size=\s*([\d]+)\s+/;
    if (filter.test(payload)) {
      const columns = filter.exec(payload);
      const transferred = +columns[1];
      let ratio = Math.min(progressData.scale * transferred / progressData.length, 1);
      const percentage = Math.ceil(ratio * 100);
      const elapsed = new Date() - progressData.started;
      const eta = Math.ceil((elapsed / ratio - elapsed) / 1000);
      const overall = Math.ceil((progressData.step + ratio) * 100/progressData.steps);
      
      const {job, mode, source, dest} = progressData;
      const length = Math.ceil(progressData.length / progressData.scale);
      this.progress({
        job, mode, source, dest, length,
        transferred, percentage, eta, overall
      });
    }
  },

  // Parse rsync progress output
  rsync(chunk) {
    const payload = chunk.toString().trim();
    const filter = /([^\s]+)\s+([\d]+)%\s+([^\s]+)\s+([\d:]+)/;
    if (filter.test(payload)) {
      const columns = filter.exec(payload);
      // Work around rsync ETA reporting bug
      if (+columns[2] > 98) columns[4] = '0:00:00';
      
      const percentage = +columns[2];
      const overall = Math.ceil(100 * progressData.step / progressData.steps + percentage);
      const transferred = columns[1];
      const {job, mode, source, dest, length} = progressData;
      const eta = toSeconds(columns[4]);
      
      this.progress({
        job, mode, source, dest, length,
        transferred, percentage, eta, overall
      });
    }
  }
};

// Generic progress handler
const onProgress = status => {
  console.log(status || {mode: 'idle'});
};

// Helper to create and run commands
const run = (command, args, data = () => {}, progress = () => {}) => {
  const shell = new SystemCommand(command, args, '/path/to/working/directory');
  shell.on('data', data);
  shell.on('progress', progress);
  return shell.output;
};

// Command wrappers
const ffmpeg = async (source, dest) => {
  progressData.job = 'convert';
  progressData.source = source;
  progressData.dest = dest;
  try {
    return await run('/path/to/ffmpeg', ['-i', source, dest], onData.ffmpeg, onProgress);
  } catch(error) {
    onProgress({error, mode: 'idle'});
  }
};

const rsync = async (source, dest) => {
  progressData.job = 'copy';
  progressData.source = source;
  progressData.dest = dest;
  try {
    return await run('/path/to/rsync', [source, dest], onData.rsync, onProgress);
  } catch(error) {
    onProgress({error, mode: 'idle'});
  }
};

// Create action queue
const actions = [
  () => ffmpeg('source.mp4', 'destination.mp4'),
  () => rsync('source/', 'dest/')
];

// Execute queue
const queue = new Queue(actions);
progressData.mode = 'working';
progressData.steps = queue.length;
queue.drain();
```
This example shows:
- Using `SystemCommand` to execute and monitor external processes
- Parsing command output to track progress
- Using `Queue` to manage sequential operations
- Progress tracking across multiple operations
- Error handling (which must be implemented in the command wrapper, not in the action queue)

The pipeline will:
1. Convert a video file using FFmpeg, tracking progress
2. Copy the result using rsync, tracking progress
3. Calculate and report overall progress across both operations
