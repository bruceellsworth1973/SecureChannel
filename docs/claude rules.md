# SecureChannel3 (SC3) Framework Rules

These rules govern application code built on the SC3 framework. They are not style preferences. They are invariants of correctness — code that violates them either fails subtly at runtime, fails to be human-readable, or both. Read this document in full before writing or modifying SC3 code, regardless of how small the change appears.

---

## 0. The Premise: The Framework Is Invariant and Canonical

The SC3 framework is a black box from the application's perspective. **No framework code is modified by application code.** **No framework mechanism is reproduced by application code.** **No framework guarantee is shored up by application code.**

Errors bubble through Promises. Caching, replay, error propagation, lifecycle, RPC dispatch, data routing, and stream handling are all framework concerns. Application code participates at exactly the configuration points and lifecycle hooks the framework provides; everywhere else, application code that "supports" the framework is reproducing what the framework already does, and is wrong.

If you find yourself writing code that:

- Wraps a framework call in `try/catch` to "harden" it,
- Adds an RPC export to "expose" data the framework already publishes,
- Holds cached state in a Channel field instead of using `this.controller.cache(...)`,
- Wires a UI event handler with `addEventListener` instead of a `data-*` attribute,
- Forwards a method from one layer to another with a thin wrapper,
- Reads framework source to figure out *why* something works,
- Adds `console.log` to a Node constructor "to see what's happening",
- Schedules periodic work with `setInterval` instead of Node `interval`/`poll`,

— stop. The instinct is wrong, and one of the rules below names it specifically.

### The meta-failure: generic OO instincts produce specific SC3 violations

Every recurring SC3 violation has a plausible-sounding software-engineering justification: DRY, separation of concerns, defense in depth, encapsulation, "interfaces should be thin," "private by default." Each of these instincts is a generic best practice that pattern-matches onto SC3 code where it is *actively wrong*. The SC3 idioms below override these instincts. When the instinct disagrees with the rule, the rule wins. The framework was designed against these idioms; the instinct's "improvement" is the violation.

---

## 1. Architecture: The Layers

SC3 is a layered framework. The layers, top to bottom on the server, plus the client:

- **Controller** — root of a server-side SC3 application. One per app. Sole owner of the cached application state. Holds root references to every Channel and every Driver. The application root class is typically a Controller subclass.
- **Channel** — application-facing interface. Loads Drivers, declares CachedData processing, exposes RPC exports. Each Channel is a separate HTTPS server instance with its own WebSocket interface on a dedicated port. Multiple Channels provide message isolation: namespace can be reused without conflict, and different client types can coexist in one app without contention.
- **Driver** *(framework-internal)* — represents a *domain* (a class of nodes). Knows how to spawn Workers for that domain. Multiple Node instances per Driver, all contributing to the same CachedData flow. Application code touches Drivers only through the Channel's fluent registration API (`loadDriver(name).process(...).subscribe(...).publish(...)`).
- **Worker** *(framework-internal)* — lifecycle manager for a Node. 1:1 with a Node. Spawns the Node process, routes data bidirectionally over IPC, detects failure, respawns. Application code never reaches into a Worker.
- **Node** — runs in its own spawned process. Emits typed data via `this.emit(type, payload)`. Two orthogonal classifications apply: a Node is either a **local Node** (acquires data locally) or a **Passthrough** (cascades to a remote SC3 app over WebSocket); independently, its driver is either **static** (defines its node list at module scope) or **sparse** (no static list; nodes are configured dynamically at runtime by the Channel). The local Controller does not distinguish data sourced from local Worker-Nodes versus remote Passthrough cascades.
- **View** *(client-side)* — the browser-side consumer. Receives RPC exports through `import(exports)`, receives typed data streams through methods named after the type, dispatches UI events through `this.exports` keyed by `data-*` attributes.

**Public layers (application writes here):** Controller, Channel, Node, View.
**Internal layers (application never reaches in):** Driver, Worker.

The fluent API `loadDriver(name).process(...).subscribe(...).publish(...)` is the *only* application-side surface for Driver and Worker behavior. If you find yourself wanting to reach further in, you are about to violate rule 0.

### 1.1 `this.exports` semantics by layer (the lookup table)

The single most-violated call-pattern rule in SC3 is layer-asymmetric: the same syntactic surface (`this.exports`) means different things in different layers. Before writing or reading any `this.exports`-related code, identify the layer and consult this table:

| Layer | Define exports on | Call exports via | Symmetric? |
|---|---|---|---|
| **Channel** | `this.exports = { ... }` | `this.channelExports.<name>` (destructure preferred) | **No** — `this.exports` is define-only on Channel |
| **Node** | `this.exports = { ... }` | `this.exports.<name>` (destructure preferred) | Yes |
| **View** | `this.exports = { ... }` (assigned in `import(exports)`) | `this.exports.<name>` (and via `data-*` attribute dispatch) | Yes |

The Channel is the *only* layer where define-site and call-site differ. In Node and View, `this.exports` is read/write from the same object. The Channel's `this.channelExports` proxy exists specifically to route every call through the framework's `request(command, args)` dispatcher — it is not a stylistic alternative to `this.exports`; it is the *only* working call surface at the Channel layer.

Detailed rules per layer: §4.4 (Channel), §5.1 (Node), §7.4 (View).

---

## 2. The Three Automatic Data Flows (Trust Them)

SC3 provides three automatic mechanisms that move data without application code. **Each is invisible at the application call site, which is exactly what creates the discomfort that drives the developer to reproduce it. The discomfort is not a signal. The mechanism is the answer.**

### 2.1 Export bubbling (RPC, upward)

Exports defined on a `Node` *and* exports defined on a `Channel` share a flattened namespace at the Channel level. Node exports propagate upward through Driver and Worker layers and merge into the Channel's export surface automatically.

**On collision, the Node export wins** — Node is dynamic and resolved at runtime; Channel is static. This is documented framework behavior, not a bug.

**Forbidden:** thin Channel exports that "expose" Node functionality. The framework has already exposed it. Wrapping it produces an export that is either redundant (when the wrapper happens to share a name with no Node export) or *invisible at runtime* (when the Node export shadows it). In the shadowed case, any logging, validation, or arg-massaging in the wrapper is dead code that never executes.

```javascript
// WRONG — wrapper to "expose" a Node export at the Channel:
class CatalogChannel extends Channel {
    exports = {
        storeDHCPHosts: args => this.driver.exports.storeDHCPHosts(args)  // dead code
    };
}

// CORRECT — define storeDHCPHosts on the Node; Channel callers use it as if it were Channel-defined:
// (No Channel-side code at all. The framework does the rest.)
```

### 2.2 CachedData auto-publication (typed data streams, upward then outward)

`new CachedData(type, opts)` registered on a Driver via `.process(...)` causes the framework to:

- Receive `type`-named events from the Node (`this.emit(type, payload)` on the Node side),
- Cache the payload at `[domain, type, node]` in the Controller cache,
- Optionally dedup against the cached value (`dedup: true`),
- Optionally publish status updates to subscribed clients (`publishStatus: true`),
- Optionally publish the payload to subscribed clients (`publishPayload: true`),
- Optionally re-emit to data-stream subscribers (`publishDataStream: true`),
- Replay cached data to clients on (re)connect.

**Once a CachedData processor is registered with `publishPayload` or `publishDataStream`, the data is already arriving at subscribed clients. No further code is needed to expose, fetch, or replay it.**

**Forbidden:**

- RPC exports that "fetch the current state" of CachedData-managed data — the View receives it automatically on connect.
- Manual `socket.data(type, payload)` emissions when CachedData is configured to publish — the framework already publishes.
- Direct calls to framework messaging primitives such as `channel.send(object, ws)`, `socket.send(...)`, or any other low-level write/broadcast method. These are framework internals that CachedData and the RPC dispatcher build on top of. Application code expresses publication intent by configuring CachedData, defining RPC exports, or emitting from a Node via `this.emit(type, payload)` — never by reaching for the underlying transport.
- Channel instance fields holding cached payloads — the cache is owned by the Controller and accessed via `this.controller.cache(...)`.
- Custom replay logic in `online`/`import` lifecycle hooks — replay is automatic.

`onData` is the legitimate application-side hook for *additional* per-update side effects (cross-channel coordination, derived computations, batch tracking). It is **not** a substitute for `publishPayload`/`publishDataStream`; it is layered on top of them — the cache write, dedup, and publication still happen automatically.

```javascript
// WRONG — RPC export to fetch state CachedData already publishes:
exports = {
    getDeviceStatus: async () => this.controller.cache(['adscan', 'status'])  // never call this; client already has it
};

// CORRECT — register the CachedData processor; the View's status() method receives it automatically:
this.loadDriver('adscan').process(new CachedData('status', { publishPayload, publishDataStream, nodeInData, onData }));
```

#### Two forms of `onData`

The framework supports `onData` in two equivalent forms. Pick whichever is clearer for the case at hand; do not provide both for the same CachedData (the subclass method wins; the option form is ignored).

**As a constructor option.** Best for short, contextual logic that captures surrounding closures lexically:

```javascript
const onData = function(addresses, node) {
    const { catalog } = this.channels;
    const { storeDHCPHosts } = catalog.channelExports;
    if (node === DHCP_SERVER) { storeDHCPHosts({ addresses }); }
};
this.loadDriver('adscan').process(new CachedData('status', { publishPayload, publishDataStream, onData }));
```

For parameterized callbacks, the canonical shape is an outer arrow that captures the parameter, returning an inner `function`:

```javascript
const trackOnboarding = domain => function(data) { this.trackOnboardingStatus(domain, data); };
this.loadDriver('lifecycle')
    .process(new CachedData('netdata', { publishDataStream, overwrite, nodeInData, onData: trackOnboarding('netdata') }))
    .process(new CachedData('landscape', { publishDataStream, overwrite, nodeInData, onData: trackOnboarding('landscape') }));
```

**As a method on a CachedData subclass.** Best when the side-effect logic is non-trivial, has a clear name, or is reused across multiple instances:

```javascript
class DeploymentData extends CachedData {
    onData(data, node) {
        const { batch } = data;
        const { batches } = this.channel;
        if (!batch) return;
        batches.get(batch)?.targets.get(node)?.ingest(data);
    }
}
this.loadDriver('deployment').process(new DeploymentData('batch', { publishDataStream, overwrite }));
```

The framework checks `this.onData` first (the method-on-subclass form) and falls back to the constructor option only if the method is absent.

Subclassing CachedData is **only** for overriding `onData`. The other framework methods on CachedData (`collector`, `emitter`, the constructor itself) implement the cache-write, dedup, and publication semantics — those are framework concerns and must not be overridden.

#### `this`-binding inside `onData` (both forms)

The framework `.call()`s the `onData` handler with the **driver instance** as `this`. This rule applies to both forms and is non-negotiable:

- The option form must use `function` syntax — an arrow loses the framework's bound `this`.
- The subclass form must define `onData` as a regular method shorthand (`onData(data, node) { ... }`), **not** as a class-field arrow (`onData = (data, node) => { ... }` would lose the binding the same way).

Inside `onData`, `this` exposes the driver's surface: `this.channel`, `this.channels`, `this.controller`, `this.cache(path)` (driver-scoped, see §3). Use it; do not reach for closures over the surrounding Channel constructor when the driver context already has what you need.

This is one specific case of a cross-cutting rule that applies to every framework-bound callback in SC3. **See §7.7 for the comprehensive treatment** — the full list of callsites, the Dispatcher pattern that underlies all of them, and the parameterized factory shape for callbacks that need both a captured parameter and the framework's `this`.

### 2.3 View typed-data auto-routing (downward, automatic)

Typed messages from the Channel route to View methods *named after the type*, with no registration, no subscription, no listener wiring.

```javascript
class DashboardView extends Operations {
    // Receives every 'devices' update, including replays on connect:
    devices(data) { /* render */ }

    // Receives 'status' updates the same way:
    status(data) { /* update */ }
}
```

`publishDatatype: 'lifecycleDevices'` in a CachedData config remaps the routing target — that data lands at `view.lifecycleDevices(data)` rather than `view.devices(data)`.

**Forbidden:**

- `import(exports)`-time wiring that subscribes to typed data streams — there is nothing to subscribe to. The framework has already routed it by name.
- RPC exports that fetch initial state at view startup — replay covers this.
- `addEventListener`-style registrations in the View for typed-data delivery.

The View consumes typed data by **declaring methods with the right names**. That is the entire wiring. The sparseness is correct.

---

## 3. The Cache: `this.controller.cache()` and `this.controller.nodes()`

The Controller owns the cache. Channels are permitted to know its shape and read freely. **All access — read or write — goes through `this.controller.cache(...)` and `this.controller.nodes(...)`.**

```javascript
// Read:
const status = this.controller.cache(['adscan', 'status', nodeId]);

// Write (application code rarely does this directly — CachedData processors handle it):
this.controller.cache(['domain', 'type', node], payload, overwrite);

// Write with channel notification:
this.controller.cache(channelInstance, ['domain', 'type'], payload);
```

**Forbidden:**

- Reaching into `this.controller.state.cache` directly (bypassing the accessor).
- Holding stale references to cache entries on Channel instance fields — read fresh each time through `this.controller.cache(...)`.
- Building parallel caches on Channels (`this.statusByNode = new Map()`).

### The auto-path-creation footgun

`this.controller.cache(path)` and `this.controller.nodes(path)` **never fail on missing keys**. They walk the cache and inject placeholder objects along the requested path. A typo in a cache key does not return undefined — it silently materializes `state.cache.misspelledDomain.misspelledType = {}` and returns the empty placeholder.

When constructing cache paths from variables (driver name, node id, etc.), be certain the values are correct. Defensive coding does not help here; the cache will never tell you the read was wrong.

The hierarchy is `[domain, type, node]` (or in some flows, structured differently per the CachedData configuration — `nodeInData: true` means the node is keyed inside the payload, not in the path). Maintain the hierarchy as the framework expects it; do not invent ad-hoc nesting levels.

### Driver-scoped cache and nodes accessors

When code is running in **driver context** — inside a CachedData `onData` callback, inside any callback in the driver pipeline (`.subscribe(...)`, `.publish(...)`), or inside any other method `.call()`ed with the driver as `this` — the driver exposes a domain-scoped version of `cache` and `nodes`:

- `this.cache(path)` automatically prepends the driver's domain to `path`.
- `this.nodes(path)` does the same for node registry access.

This is preferred when available because (a) it eliminates a class of pathing typos that would otherwise silently auto-create placeholders (see the footgun above), and (b) it makes the intent visible without ceremony — the code reads as "this driver's cache" rather than "the global cache, scoped to this driver's domain by string concatenation."

```javascript
// CORRECT — inside an onData on the 'lifecycle' driver:
class DeploymentData extends CachedData {
    onData(data, node) {
        const cached = this.cache(['batch', node]);   // resolves to ['lifecycle', 'batch', node]
        // ...
    }
}

// REDUNDANT — manually prepending the domain that the driver already knows:
onData(data, node) {
    const cached = this.controller.cache(['lifecycle', 'batch', node]);
    // ...
}
```

The full `this.controller.cache(...)` form is correct when the code is *not* in driver context (Channel constructor, RPC export bodies, framework lifecycle hooks at the View layer) or when the access is genuinely cross-domain.

#### Driver `cache` and `nodes` accept an optional channel as first arg

The driver-scoped `cache` and `nodes` accept an optional channel as the first argument, in the same shape as `this.controller.cache(channel, path, value, overwrite)`. When a channel is supplied, the write **emits a cache update to the channel's subscribers** in addition to writing the cache:

```javascript
// Write to cache AND broadcast the change to the channel's subscribers:
this.cache(this.channel, ['status', node], payload, true);
```

This is the canonical form for "mutate cache and notify clients" from inside driver context — it routes through the same machinery CachedData uses for its `publishStatus`/`publishPayload` flags, but for application-controlled write moments rather than framework-controlled ones. Use it when your code is the source of the change rather than the recipient.

---

## 4. The Channel Layer

### 4.1 Constructor: declarative driver pipelines

The Channel constructor declares the data pipeline. Application logic in the constructor is the `loadDriver(name).process(...).subscribe(...).publish(...)` chain.

```javascript
constructor(id, controller, options) {
    const { connection } = Channel.getConnection(id, options);
    super(id, connection).join(controller);

    this.loadDriver('adscan')
        .process(new CachedData('status',   { publishPayload, publishDataStream, overwrite, nodeInData, onData }))
        .process(new CachedData('progress', { publishPayload, publishDataStream, overwrite, nodeInData }));

    this.loadDriver('cambium')
        .process(new CachedData('devices',  { publishDataStream, overwrite }));
}
```

`new CachedData(type, opts)` is a configuration-object factory disguised as a constructor — it `return`s a `{source, sink}` config from inside `new`. There is no CachedData *instance* with methods to call later. The configuration moment is the entire lifecycle of the CachedData object. Treat the call as you would a config literal.

**Forbidden uses of the result.** The only legitimate destination for the value `new CachedData(...)` returns is `.process(...)`. Any other use is a category error:

```javascript
// WRONG — there is no method to call:
const cached = new CachedData('status', { publishDataStream });
cached.start();                        // no such method
cached.subscribe(handler);             // no such method
cached.flush();                        // no such method

// WRONG — there is no instance to retain:
this.statusCache = new CachedData('status', { publishDataStream });
// ...later...
this.statusCache.update(payload);      // not how this works

// WRONG — registering update handlers on the object:
const cached = new CachedData('status', { publishDataStream });
cached.onChange = (data) => { /* ... */ };   // there is no onChange hook here

// CORRECT — pass the result directly to .process():
this.loadDriver('cisco').process(new CachedData('status', { publishDataStream }));
```

The class form is a closure factory in class clothing. After `.process(...)` consumes the `{source, sink}` config, the original `new CachedData(...)` expression has fulfilled its entire purpose.

### 4.2 RPC exports live in `this.exports` — and only there

Every RPC-callable method on a Channel is a key of `this.exports = { ... }`. No other attachment point is permitted. Not class arrow-method fields. Not constructor-bound closures. Not regular instance methods.

```javascript
// WRONG — class arrow-method field:
class LogsChannel extends Channel {
    requestArchiveReplay = async ({ node, options }) => { /* ... */ };
}

// WRONG — constructor closure:
class LogsChannel extends Channel {
    constructor(...) {
        super(...);
        this.requestArchiveReplay = async (args) => { /* ... */ };
    }
}

// CORRECT — in this.exports:
class LogsChannel extends Channel {
    replayQueues = new Map();
    exports = {
        requestArchiveReplay: async ({ node, options }) => {
            // ... full logic here, in the export body ...
        }
    };
}
```

The framework's `Channel.request(command, args)` dispatcher looks up `this.exports[command]`. Methods anywhere else are invisible to it — they bypass the request pipeline that enforces error handling, logging, and result shaping. **An export defined outside `this.exports` is a category error**, not a stylistic choice.

### 4.3 The export body contains the logic

Export bodies are not declarations of intent that delegate to "the real method." They *are* the real method. The framework calls every export with the Channel instance as `this` (via `.call(channelInstance, ...)`) — there is no functional distinction between accessing class state from inside an export and accessing it from inside a class method. **An export is a class method that happens to live in `this.exports` so the framework can reach it via RPC.**

```javascript
// WRONG — thin export delegating to a fat class method:
class LogsChannel extends Channel {
    async doRequestArchiveReplay({ node, options }) {
        // ... actual logic ...
    }
    exports = {
        requestArchiveReplay: args => this.doRequestArchiveReplay(args)
    };
}

// CORRECT — logic in the export body, with helpers extracted only when justified:
class LogsChannel extends Channel {
    replayQueues = new Map();
    exports = {
        requestArchiveReplay: async ({ node, options }) => {
            const agentNodeId = node.id;
            const queue = this.replayQueues.get(agentNodeId) ?? this.initReplayQueue(agentNodeId);
            queue.queue.push({ node, options });
            if (!queue.current) { this.dispatchReplay(agentNodeId); }
        }
    };
}
```

### 4.4 Calling exports: use `channelExports`, not `exports`

`this.exports` on a Channel is **define-only**. To *invoke* an export from anywhere — another export, a class method, the constructor — use `this.channelExports`, with destructuring preferred for readability:

```javascript
// PREFERRED:
const { requestArchiveReplay } = this.channelExports;
await requestArchiveReplay({ node, options });

// FUNCTIONAL but less preferred:
await this.channelExports.requestArchiveReplay({ node, options });

// BREAKS at runtime:
await this.exports.requestArchiveReplay({ node, options });   // wrong dispatcher
const { requestArchiveReplay } = this.exports;                // same problem
await this.driver.request('requestArchiveReplay', args);      // bypasses framework philosophy
```

`channelExports` is a `LazyObject` proxy built on Channel's `passthrough` factory. Every property access returns a fresh function that routes through `channel.request(command, args)` — the single dispatch site that enforces the framework's error-handling and logging contract. Late-bound resolution means exports added or mutated after construction are visible immediately at call time.

The `driver.request('foo', args)` form is functional but **forbidden on philosophical grounds**: it re-introduces the messaging seam the framework spent effort hiding. The framework's contract is that exports are *callable functions that happen to perform work remotely*. A working pattern is wrong here specifically because it makes the seam visible.

**The Channel layer is the only layer where define-site (`this.exports`) and call-site (`this.channelExports`) differ.** In Node and View, `this.exports` is symmetric — the same object is read and written. The Channel asymmetry is *the* call-pattern trap. Two layers, identical surface name, opposite read semantics.

#### Why the asymmetry exists

The asymmetry isn't arbitrary. **Channels are the only SC3 layer where multiple instances coexist in the same address space, each with its own export namespace.** That structural fact forces the call surface to be different from the define surface.

- A **Node** is one subprocess; one `this.exports`; no other Node visible from inside. "The exports" is unambiguous.
- A **View** instance owns its own `this.exports` for UI handlers; the View's own code reads only its own. "The exports" is unambiguous.
- A **Channel** lives alongside other Channels in the Controller's address space. "The exports" must say *which Channel* — the local one (`this.channelExports`) or a sibling (`this.controller.channels.<name>.channelExports`).

`channelExports` is the disambiguation mechanism: it always names a Channel and asks for *its* exports. The proxy/dispatcher mechanics (late binding, framework error contract) are *how* it works; the multi-instance reality is *why* it exists. Define-only `this.exports` keeps the define side local while the call side carries the address.

### 4.5 The `channelExports` rule covers all main-thread callers

The Controller, Channel, Driver, and Worker layers all run in the **same main server thread** — one Node.js process, one event loop, calling each other as ordinary JavaScript objects. (Workers spawn Node *subprocesses* per device; that's out-of-process and out of scope for this rule.) The `channelExports` discipline applies to **all code in this main thread** that wants to invoke a Channel's exports — not just to code inside the Channel itself.

In practice the main-thread callers you write are:

- **Controller subclasses** — the application's main server class. Cross-channel orchestration, startup-time bootstrap, scheduled background tasks, and HTTP route handlers living on the Controller all belong here, and all must use `channelExports` when invoking a Channel's exports.
- **Sibling Channels** — Channel A reaching Channel B for cross-channel coordination, accessed via the Controller's channel registry.
- **Helper classes the application owns** — API adapters, route handlers, scheduled job runners. They take a Channel reference (or a Controller reference and look up the Channel) and call through `channelExports`.
- **`onData` callbacks and custom source/sink handlers** — these run in driver context but live in the main thread; same rule applies.

The Driver and Worker layers also run in the main thread, so the rule applies there too. In practice you don't write much application code at either layer — the framework manages both. If you ever do, the rule still holds.

The pattern in all cases: resolve the channel through the Controller's registry, then dereference exports at call time:

```javascript
// CORRECT — controller-based; no captured channel reference:
class API {
    constructor(controller) { this.controller = controller; }
    requestHistory = async (req, res) => {
        const { logs } = this.controller.channels;
        await logs.channelExports.requestArchiveReplay({ node, options: {} });
    };
}

// WRONG — captures method references at construction (frozen at capture time):
class API {
    constructor(channel, requestArchiveReplay) {
        this.requestArchiveReplay = requestArchiveReplay;
    }
}

// WRONG — getter dereferencing direct method:
get requestArchiveReplay() { return this.controller.channels.logs.requestArchiveReplay; }
```

Cross-channel coordination from an `onData` callback or similar uses the same pattern — driver context exposes `this.channels` directly, so destructure off it and reach `channelExports` per call:

```javascript
const onData = function(addresses, node) {
    const { catalog } = this.channels;
    const { storeDHCPHosts } = catalog.channelExports;
    if (node === DHCP_SERVER) { storeDHCPHosts({ addresses }); }
};
```

#### Controller subclasses must follow the rule

Because the application's main server class is typically a Controller subclass, this is the most common place for the rule to be tested. Channels self-register on construction, so the Controller does not store them in instance fields. Methods access them via `this.channels.<name>`:

```javascript
class MyController extends Controller {
    constructor() {
        super();
        new MonitorChannel(this, monitorOptions);        // self-registers as this.channels.monitor
        new DeploymentChannel(this, deploymentOptions);  // self-registers as this.channels.deployment
    }

    async dailyMaintenanceTask() {
        const { monitor, deployment } = this.channels;
        const { runHealthCheck } = monitor.channelExports;
        const { archiveOldBatches } = deployment.channelExports;
        await runHealthCheck({ scope: 'all' });
        await archiveOldBatches({ olderThan: '30d' });
    }
}
```

The Controller's privileged position in the architecture does not exempt it from the discipline. The example uses the canonical two-step destructure — channels off `this.channels`, then exports off `channelExports` — which is the form most production code takes. The condensed rule: **anywhere in the main server thread, calls into a Channel's exports go through `channelExports`, with the Channel resolved through the registry — never a stored reference**. The Channel's own `this.channelExports` (4.4) is the in-Channel form. Everywhere else uses `<registry>.<name>.channelExports`, where the registry is `this.channels` from inside the Controller or from driver context, and `this.controller.channels` from anywhere else. There is no other access pattern.

### 4.6 The driver pipeline API: `process`, `subscribe`, `publish`

The fluent methods on a driver instance — `.process(cachedDataConfig)`, `.subscribe(sourcesObject)`, `.publish(sinksObject)` — are the application's surface for declaring what data types the driver handles and how. All three return the driver, so they chain. Together they constitute the *only* application-facing surface for driver behavior; everything else on the driver is framework-internal and off-limits.

#### `.process(config)` — the canonical pattern

Accepts a `{source, sink}` config (what `new CachedData(...)` returns) and registers both the source collector and the sink emitter for the configured data type. The vast majority of application driver wiring is repeated `.process(...)` calls, one per type:

```javascript
this.loadDriver('cisco')
    .process(new CachedData('status',   { publishPayload, publishDataStream, nodeInData }))
    .process(new CachedData('progress', { publishPayload, publishDataStream, overwrite, nodeInData }));
```

#### `.subscribe(sources)` — custom source handlers

Registers source handlers without configuring caching or framework publication. The argument is an object whose keys are data types and whose values are handler functions. Use it for custom source handling that doesn't fit CachedData — pure stream forwarding without caching, transformation of raw inputs into other types, side effects with no associated cache entry:

```javascript
this.lifecycleStreamSources = {
    progress(data, node, socket) { /* ... */ return shouldPublish; },
    history(data, node, socket) { /* ... */ return shouldPublish; }
};
this.loadDriver('lifecycle')
    .process(new CachedData('connectivity', { publishDataStream, overwrite, nodeInData }))
    .process(new CachedData('batch',        { publishDataStream, overwrite }))
    .subscribe(this.lifecycleStreamSources);
```

#### `.publish(sinks)` — optional custom sink handlers

Registers custom emitter functions that fire when a corresponding `.subscribe(...)` for the same type returns truthy. Use this when CachedData's standard emitter machinery is not what you need — constructed messages from sources other than the driver's cache, special transmission patterns, conditional broadcast. A `.publish(...)` registration with no corresponding `.subscribe(...)` for the same type does nothing — there is no trigger to fire it.

#### Subscribers without publishers: live events, no caching

`.publish(...)` is **optional**. `.subscribe(...)` is the primary mechanism — it's what makes data flow through the pipeline at all. A registered `.publish(...)` fires only when the corresponding `.subscribe(...)` returns truthy; a publisher with no subscriber for the same type has nothing to trigger it.

A subscriber registered alone is a complete configuration. Call `socket.data(type, payload)` directly inside the handler to deliver to clients, then **return `false`** to suppress any registered publisher (present or future) and prevent double-publication.

```javascript
this.eventStreamSources = {
    alert(data, node, socket) {
        socket.data('alert', { node, ...data, at: Date.now() });
        return false;   // we already published; suppress any registered publisher
    }
};
this.loadDriver('alerting').subscribe(this.eventStreamSources);
```

This is the framework's idiom for **live-event flow with no caching and no replay** — the same shape CachedData uses internally to implement `publishPayload`. CachedData's collector calls `socket.data(...)` directly when `publishPayload` is set, then returns `false` to suppress the `publishDataStream` emitter. Application code reaches for the same shape when emitting live events outside the CachedData model: alert streams, notification feeds, real-time event ticks where each event is a moment, not a state worth caching.

Returning truthy from a subscriber that has already published directly is a bug — it causes any registered publisher for the type to fire alongside the direct publish, sending the data twice.

#### Multiple calls accumulate

A sequence of `.process(...)` / `.subscribe(...)` / `.publish(...)` calls on the same driver registers all of them; later calls do **not** overwrite earlier ones. This is what allows the canonical "list every type the driver handles, one `.process()` call each" pattern. The order of types within a chain is not significant.

#### Custom handler signatures (the `this`-binding rule applies — see §7.7)

A function passed via `.subscribe({ type: fn })` is called with:
- `this` = the **driver**
- args = `(data, node, socket)` — the incoming payload, the originating node id, and the socket that produced the event (or the channel for broadcast).
- **Return value:** truthy → fire the corresponding sink emitter for this type; falsy → suppress. This is the framework's filtering hook; CachedData's `dedup` option uses it to suppress unchanged updates.

A function passed via `.publish({ type: fn })` is called with:
- `this` = the **driver**
- args = `(data, socket)` — the outbound payload and the destination socket (a specific socket during replay to a newly-connected client, or the channel for broadcast).

Both must use `function` syntax (or method shorthand on a containing class), not arrow, per §7.7. Inside either handler, the driver-scoped `this.cache(path)` and `this.nodes(path)` (§3) are available and preferred over `this.controller.cache(...)`.

#### Forbidden

- Reaching into `driver.sinks`, `driver.sources`, or `driver.workers` directly to modify the registry or worker list → use `.subscribe(...)`, `.publish(...)`, or the dynamic-orchestration patterns in §5.6.
- Calling `driver.emit(type, node, socket)` from application code → this is the framework's internal emit dispatcher invoked by the pipeline. Application emission goes through CachedData configuration, custom sinks registered via `.publish(...)`, or `this.emit(...)` from a Node.
- Calling `driver.start()`, `driver.end()`, `driver.reset(...)`, `driver.join(...)`, or `driver.leave()` from application code → these are framework lifecycle methods. The fluent registration API plus `addWorker`/`dropWorker` (for sparse drivers, §5.6) are the application's complete driver surface.

---

## 5. The Node Layer

### 5.1 Exports symmetry

Node `this.exports` is **symmetric** — define-site and call-site are the same object. Define exports there, invoke them there with destructuring preferred:

```javascript
class MyNode extends Node {
    exports = {
        fetchConfig: async ({ id }) => { /* ... */ },
        applyConfig: async ({ id, config }) => {
            const { fetchConfig } = this.exports;   // destructure preferred
            const current = await fetchConfig({ id });
            // ...
        }
    };
}
```

Node exports propagate upward into the Channel's flattened export namespace automatically (rule 2.1). Do not write Channel-side wrappers for them.

### 5.2 Emitting data upward

Nodes emit typed data with `this.emit(type, payload)`. The framework routes the emission through the Worker IPC, into the Driver's CachedData processors, into the Controller cache, out to subscribed clients.

```javascript
class NetData extends Node {
    refresh() {
        const emit = nodes => {
            this.initialized || this.ready();
            this.initialized = true;
            this.emit('nodes', nodes);   // type 'nodes' lands at view.nodes(...) on subscribed clients
        };
        return this.getContexts().then(emit, this.error.bind(this));
    }
}
```

The Channel-side counterpart is `new CachedData('nodes', { publishDataStream, ... })` registered via `.process(...)`. Without that registration, the emission has nowhere to go.

### 5.3 Passthrough vs Node

Two Node base classes. Use the right one:

- **`Node`** — implement when the Node performs local data acquisition (polls an HTTP endpoint, reads from a database, manages a hardware device). The Node owns the data source.
- **`Passthrough`** — implement when the Node cascades to a remote SC3 application. The framework handles full-duplex WebSocket linking; the Node body is wiring (address, port, auth) rather than data acquisition. `super(devices)`, then `channel.connect(connection)`.

### 5.4 The driver startup contract: stdout must be JSON

When a Driver starts up for a new domain, it spawns the corresponding `<project>/drivers/<domain>.js` file as an independent subprocess and reads the subprocess's stdout, expecting **a single valid JSON string containing the devices object**. The Driver parses that JSON and uses it to instantiate Workers, one per node.

If the parse fails for any reason — JSON pollution, syntax error, missing dependency, file permission failure — the Driver substitutes a placeholder driver named **MISSING**. The MISSING driver does not spawn workers because it has no node list. The Channel reports the driver loaded; nothing further happens. There is no console error visible to the application; the failure is silent.

This contract is fragile and Claude's instinct to "see what's happening" by adding diagnostic output to the Node startup code is the most common way to break it. **Anything that writes to stdout before the framework's JSON emission corrupts it.** That includes:

- `console.log`, `console.warn`, `console.error` calls.
- `this.debug(...)`, `this.log(...)`, or any framework log method that writes to stdout.
- Module-scope side effects in imported modules (a dependency's `console.log` on import).
- `dotenv` warnings, deprecation notices from third-party packages, or any other process-startup chatter.

### 5.5 Constructor minimalism: the `connect(callback)` pattern

The Node constructor does **four things and four things only**:

1. `super(...)` with the necessary args.
2. Store constructor-time configuration as instance fields.
3. Register event handlers via `this.on(eventName, handler)`.
4. Kick off connection with `this.connect(callback)`, where the callback is the real init method.

Every other concern — including diagnostics, configuration validation, prerequisite checks, and initial fetches — happens in the connect callback or in methods called from it. This rule exists because of the JSON-on-stdout contract (5.4): the constructor runs *before* the framework emits the devices JSON, so any output it produces corrupts the contract.

```javascript
// CORRECT — minimal constructor; real work in init():
class DeploymentNode extends Node {
    constructor(devices, settings, logger) {
        super(devices, logger);
        this.deviceList = devices;
        this.settings = settings;
        this.on('abort', ({ reason }) => this.abort(reason));
        this.connect(() => this.init());
    }
    init() {
        const device = this.getDevice(this.deviceList);
        this.import({ ...this.settings, ...device });
        const { batch, hostname, ip } = this;
        if (!batch || !hostname || !ip) {
            throw `missing batch context: batch=${batch} hostname=${hostname} ip=${ip}`;
        }
        this.ready();
        return this.executeSshDeployment();
    }
}
new DeploymentNode(DEVICES, DEPLOYMENT, new Logger(['telemetry', 'activity', 'error', 'warn']));

// WRONG — diagnostic output in constructor breaks driver startup silently:
class DeploymentNode extends Node {
    constructor(devices, settings, logger) {
        super(devices, logger);
        console.log('DeploymentNode starting');   // pollutes JSON; driver becomes MISSING
        this.debug('configuring node');           // same
        // ...
    }
}
```

The `init` method (or whatever the connect callback is named) is the canonical home for:

- Pulling configuration from the framework via `this.import({...})`.
- Validating prerequisites (`throw` on failure — the framework bubbles via Promise; do not try/catch).
- Diagnostic logging.
- Initial fetches that gate `this.ready()`.
- Kicking off the Node's normal operation.

The `this.on('abort', ...)` registration is the one piece of "real work" the constructor is permitted, because event handlers must be in place before `connect()` fires. The arrow form is correct here because the handler body wants the surrounding Node's `this` (so `this.abort(reason)` resolves to the Node method); a `function` form would receive the emitter's `this` instead. See §7.7 for the full rule on framework-bound callback context.

### 5.6 Sparse drivers: dynamic node orchestration

A **sparse driver** has no statically defined node list. The `<domain>.js` file does not call `new SomeNode(DEVICES, ...)` with a populated `DEVICES` constant; instead, the Channel layer dynamically configures and spawns Nodes at runtime based on application logic.

Sparse drivers retain the JSON-on-stdout contract (5.4): `<domain>.js` must still emit valid JSON on its first stdout (typically representing an empty or minimal devices structure) so the framework can register the driver. The dynamic part is that no Workers are spawned at startup; spawning happens later through orchestration code in the Channel.

The canonical orchestration pattern uses `this.uniqueKey` to mint Node identifiers, project-defined wrappers (`Target`, `Batch`) to group and track in-flight Nodes, and an `AbortController` per batch for early teardown:

```javascript
// In the Channel exports:
orchestrateDeployment: async ({ packageName, collection, args, origin = 'user' }) => {
    const { resolveCollection } = this.channelExports;
    const targets = await resolveCollection(collection);
    const deployment = this.deploymentDriver;
    const batchKey = this.uniqueKey;
    const batch = new Batch(deployment, batchKey, packageName, targets.length);
    this.batches.set(batchKey, batch);

    const configureWorker = host => {
        const node = this.uniqueKey;
        const connection = { batch: batchKey, hostname: host.hostname, ip: host.ip, packageName, args, origin };
        const { signal } = batch.abortController;
        const target = new Target(batch, deployment, this.ids, node, connection, signal);
        batch.targets.set(node, target);
        return { node, connection, target };
    };
    const workerConfigs = targets.map(configureWorker);
    const deployTarget = ({ target, node, connection }) => target.start(node, connection);

    batch.pushStatus('batchStarting', { /* ... */ });
    await concurrent(workerConfigs, deployTarget);
    // ...
}

// Early teardown — abort propagates to each Node via the connection signal:
abortDeployment: async ({ batch: batchKey, reason = 'aborted by user' }) => {
    const batch = this.batches.get(batchKey);
    if (!batch) throw `batch ${batchKey} not found`;
    batch.pushStatus('batchAborting', { reason });
    batch.abortController.abort(reason);
    return 'acknowledged';
}
```

The Node side responds to abort by registering `this.on('abort', ({reason}) => this.abort(reason))` in the constructor (the one piece of constructor work permitted, per 5.5) and performing graceful shutdown via `this.end(code)`.

Cache cleanup for completed batches uses `this.controller.cache(...)` with a delayed cleanup pattern:

```javascript
const cleanup = () => {
    this.batches.delete(batchKey);
    this.ids.delete(batchKey);
    setTimeout(() => {
        const cache = this.controller.cache(['deployment', 'batch']);
        if (cache) for (const key of Object.keys(cache)) {
            if (cache[key]?.batch === batchKey) delete cache[key];
        }
    }, 10000);
};
```

Note: the cleanup reads through `this.controller.cache(...)` (the proper accessor, per 3) and then mutates the returned object directly. This pattern is acceptable for cleanup of transient orchestration state; the cleanup is application-owned data, not framework-published data.

#### `driver.addWorker(node, data)` and `driver.dropWorker(node)`

The driver-level surface for dynamically spawning and removing workers is `driver.addWorker(node, data)` and `driver.dropWorker(node)`. These are the application-facing primitives that orchestration wrappers (`Target`, `Batch`, or whatever your project uses) build on top of:

- **`addWorker(node, data)`** — spawns a Worker for a new node id with the given data. Returns a Promise that resolves with the `Worker` instance once the worker is ready. Throws if the driver is not yet ready (`domainReady` is false) or if the node id is already in use.
- **`dropWorker(node)`** — initiates orderly shutdown of an existing Worker. Returns a Promise that resolves when shutdown completes; rejects after 5 seconds if the worker is unresponsive.

Workers carry a `persistent` flag. **Non-persistent workers** (`persistent === false`) automatically remove their node entry from the driver's node registry when they go down — appropriate for ephemeral, single-use workers like deployment targets. Persistent workers stay registered across down/up cycles.

```javascript
// Inside a sparse driver's Channel-side orchestration:
const worker = await this.deploymentDriver.addWorker(nodeId, connection);
// ...later, after the work completes:
await this.deploymentDriver.dropWorker(nodeId);
```

Application orchestration code typically wraps these calls in project-defined classes (`Target`, `Batch`) that also track per-node application state, abort signals, and result aggregation. The `Target.start(node, connection)` call in the orchestration example earlier is one such wrapper.

### 5.7 Polling: use `interval` and `poll`, never `setInterval`

SC3 applications are inherently asynchronous and event-driven. Manual polling loops do not belong in application code anywhere. The framework provides a built-in polling mechanism at the Node layer, via two coordinated properties:

- **`this.interval`** — polling cadence in seconds. Sub-second intervals are not supported. Setting `interval = 0` stops the cycle.
- **`this.poll`** — assigning a function (typically a method reference) starts the polling cycle. The framework calls the function on each tick, signals `ready()` on success, surfaces errors via `this.error(...)`, and self-schedules the next tick. Assigning a falsy value stops the cycle.

```javascript
class RepositoryNode extends Node {
    async refresh() { /* called automatically on each tick */ }
    constructor(devices, settings) {
        super(devices);
        const { dir, pollInterval, logsDir } = settings;
        this.logsDir = logsDir;
        const repository = async () => {
            this.repositoryPath = dir;
            this.interval = pollInterval;     // cadence in seconds
            this.poll = this.refresh;         // start the polling cycle
            await mkdir(logsDir, { recursive: true });
            // event-driven re-scan (different mechanism, also fine, complementary):
            watch(logsDir, { recursive: true }, () => this.scanArchive().then(emitArchive));
        };
        this.connect(repository);
    }
}
```

The framework's polling implementation handles ready-signal coordination with the Worker, error propagation through the framework's standard channels, clean cancellation, and re-entrancy safety. None of this is visible to or available to application code; application code declares cadence and function and stops.

**Forbidden:**

- `setInterval(...)` anywhere in application code. Node `interval`/`poll` covers the periodic case; event handlers cover the reactive case; there is no third case where a raw `setInterval` would be the right tool.
- `setTimeout(...)` patterns where the timeout body schedules another timeout to do the same work — a polling loop in disguise. If the intent is "do this every N seconds," use `interval`/`poll`.
- Custom polling state machines (`while (true) { await fn(); await sleep(N); }` or generator/async-iterator equivalents).
- Reimplementing error-handling, cancellation, or re-entrancy guards around any of the above. The framework's polling already has these; reproductions do not improve on the default.

The discriminating test for `setTimeout` versus a polling loop in disguise: **does the scheduled callback re-schedule itself, directly or transitively?** If yes, it's a polling loop and the fix is `interval`/`poll`. If no — bounded delay for debouncing, cleanup-after-N-seconds, abort-after-deadline, deferred single action — it's a true timeout and is fine.

For event-driven data sources (filesystem changes, network events, IPC messages), use the appropriate event mechanism (`fs.watch`, socket listeners, `this.on(...)`) rather than polling. Polling and event-driven mechanisms are complementary, not alternatives — the canonical RepositoryNode above uses both.

---

## 6. RPC Interface Conventions

These apply to every RPC handler, on every layer, regardless of where the export lives.

### 6.1 Single-arg, named-properties signature

Every RPC handler accepts **exactly one argument**: an object whose properties are the call's named args, or `undefined`.

```javascript
// CORRECT:
exports = {
    requestArchiveReplay: async ({ node, options }) => { /* ... */ },
    setSessionID:         async ({ sessionid })    => { /* ... */ },
    listAll:              async ()                 => { /* no args */ }
};

// WRONG — multiple positional args:
exports = {
    requestArchiveReplay: async (node, options) => { /* will not work */ }
};
```

Claude's instinct will be `requestFoo(node, options, flags)` because that is canonical JavaScript. The framework dispatcher passes one arg. Multi-arg signatures silently misroute or fail.

### 6.2 Async / Promise interface

Every RPC handler is `async` (or returns a Promise explicitly). The framework bubbles all errors through the Promise chain. Application callers `await` and `.catch()`; the framework owns the error path.

**Forbidden:** `try/catch` around RPC invocations to "harden" them or convert errors into return values. The framework's error propagation is the application's error propagation. Defensive wrapping is the wrong instinct here:

```javascript
// WRONG — defensive try/catch hardening:
const { requestArchiveReplay } = this.channelExports;
try {
    await requestArchiveReplay({ node, options });
} catch (err) {
    console.error(err);   // swallowing or reformatting framework errors
    return null;
}

// CORRECT — let errors propagate; framework + caller's existing handler manage them:
const { requestArchiveReplay } = this.channelExports;
await requestArchiveReplay({ node, options });
```

Application-specific error handling at a deliberate boundary (e.g., a UI handler that needs to show a toast on failure) is fine. Reflexive try/catch around every framework call is not.

### 6.3 Reserved arg keys

The `node` property in an RPC args object is reserved by the framework for routing. The driver's request dispatcher resolves it as follows:

- **undefined** — targets the **last node to check in as ready** for the driver's domain. For a singleton driver this is unambiguous; for a multi-node driver this is the framework's clustering fallback for "any node will do." The selection is **arbitrary** — not primary/replica, not load-aware, not consistent across calls; whichever node most recently transitioned to ready wins. Use this shape when (a) the driver is a singleton, or (b) the driver has multiple nodes and the application doesn't care which one serves the request. Do not use it when correctness depends on hitting a specific node; specify `node` explicitly in that case.
- **string** — addresses a local node by id (one Channel deep).
- **array of strings** — addresses a node living through Passthrough cascades. The array's **head** identifies the local node target (typically a Passthrough), and the **tail** is repackaged as the new `node` arg forwarded to that node — which then resolves it the same way (string for local, array for further cascade). A single-element tail is unwrapped from array to string before forwarding.

```javascript
// Singleton OR any-node-will-do — node omitted, framework selects:
await this.channelExports.requestStatus({ timeout: 5000 });

// Local multi-node driver — node as string, specific node targeted:
await this.channelExports.requestStatus({ node: 'agent-3', timeout: 5000 });

// Cascaded through one Passthrough — head is local, tail is forwarded:
await this.channelExports.requestStatus({ node: ['edge-router', 'agent-3'], timeout: 5000 });
//   local target: 'edge-router' (Passthrough)
//   remote receives: { node: 'agent-3', timeout: 5000 }

// Cascaded through multiple Passthroughs — head is local, tail is forwarded as array:
await this.channelExports.requestStatus({ node: ['datacenter-2', 'rack-7', 'agent-3'], timeout: 5000 });
//   local target: 'datacenter-2' (Passthrough)
//   remote receives: { node: ['rack-7', 'agent-3'], timeout: 5000 }
//   that remote's local target: 'rack-7' (Passthrough)
//   its remote receives: { node: 'agent-3', timeout: 5000 }
```

The framework throws when the targeted worker is not ready, when the node id is unknown, or when no workers are available for the domain. These throws bubble through the Promise chain (rule 6.2); do not wrap the call to handle them defensively.

**View-side node awareness.** When a Node-bubbled RPC is invoked from a View and the underlying driver has multiple nodes, the View must carry node identity from user input (typically a list selection rendered from a typed-data stream) into the `node` argument of the RPC call. The framework does not infer node identity for the View. Channel-level RPCs that wrap and route internally are an application alternative — the View passes a domain-meaningful argument (e.g., `target`) and the Channel's export translates it to a `node` for the inner RPC.

No other arg keys are reserved.

---

## 7. The View Layer

### 7.1 The UI base: `ui.js` and `app.js`

All Views in an SC3 application extend a project-specific class defined in `app.js`, which itself extends the framework's base from `ui.js`. The `UI` class is a static utility surface (DOM ops, cookies, hash params, focus traps); never `new UI(...)`.

- **`ui.js` (framework-supplied)** provides data-attribute routing for the standard DOM events (`click`, `dblclick`, `contextmenu`, `change`, `focus`, `blur`, `mouseover`, `mouseout`, `submit`, `reset`, `input`, etc.), structural primitives (`Panel`, `Menu`, `MutexPanelGroup`, `MutexTabGroup`), dialog primitives (`alert`, `confirm`), and framework-known page-global handlers (`popstate`/`hashchange` routing, capture-phase keydown for modal escape).
- **`app.js` (project-customized)** extends `ui.js`'s base with project-specific event handling and UI behavior: user session state, application-wide UI state, project-specific dialog/spinner primitives, any global event handlers the project's UI needs that aren't in `ui.js`. The filename is conventional, not magic.

**All event listener registration in the application lives in `ui.js` or `app.js`.** Application code outside these two files never calls `addEventListener` directly, never assigns `onclick`, never binds handlers to specific elements. New event types not yet handled go into `app.js`; this is the only framework-compliant way to extend event coverage. See 7.6.

### 7.2 Framework lifecycle methods (reserved class-method names)

Four reserved method names on the View class are framework-invoked:

- **`import(exports)`** — RPC handshake. The Channel's exported RPC methods arrive here. This is the canonical home for View-layer initialization logic.
- **`online(sessionid)`** — CachedData stream lifecycle: channel connection up.
- **`offline()`** — CachedData stream lifecycle: channel connection down.
- **`latency(ms)`** — periodic latency metric from the channel.

These are **class methods, not entries in `this.exports`**. They are not RPC-callable; they are framework lifecycle hooks.

Additionally, every typed data stream the View consumes is a class method *named after the type*. `socket.data('devices', payload)` on the Channel side routes to `view.devices(payload)` on the View side. `publishDatatype: 'lifecycleDevices'` remaps to `view.lifecycleDevices(payload)`.

### 7.3 `import(exports)` is a fat method body

The canonical View-init pattern. Form choice per entry in `this.exports` is driven by what `this` should be inside the handler body:

```javascript
import(exports) {
    const { startSession, endSession, retrieveSession, updateUserSettings } = exports;

    this.exports = {
        // Arrow form — handler needs View `this` (this.getView, this.State, etc.)
        // OR doesn't use `this` at all. This is the most common case:
        selectItem: ({ id }) => isValid(id) && this.changeFocus({ id }),
        viewSettings: () => this.changeView({ view: 'settings' }),
        login: () => this.login(),
        logout: () => this.logout(),
        cancel: ({ jobId }) => endSession({ jobId }),

        // Method shorthand — handler needs `this` to be the source DOM element
        // (the framework dispatches as handler.call(sourceElement, data, event)):
        toggleSelected({ id }) {
            UI.toggleClass(this, 'selected');         // 'this' = source element
            this.dataset.itemId = id;
        },
        updateField() { captureChange(this); },       // pass DOM element to helper

        // Property shorthand — raw RPC re-exposure (callable directly from data-*):
        updateUserSettings
    };

    this.Ready = true;
}
```

The form-choice rule:

- **`name: (args) => ...`** — when the handler needs `this` to be the View instance (`this.getView`, `this.State`, `this.confirm`, etc.) **or doesn't use `this` at all**. Most View handlers fall here.
- **`name(args) { ... }`** — when the handler needs `this` to be the **source DOM element** (`UI.toggleClass(this, ...)`, `this.value`, `this.dataset`, etc.). The framework dispatches UI events as `handler.call(sourceElement, data, event)`, and method-shorthand bodies honor that binding.
- **`name`** (property shorthand) — when re-exposing a raw destructured RPC by its own name (see 7.4, 7.5).

#### Mixed-context workaround: arrow closure above `this.exports`

When a single handler needs **both** DOM `this` (for UI manipulation) **and** View context (for `this.onConfirmed`, an RPC call, `this.getView`, awaited dialog flow), neither form alone is sufficient: an arrow inside `this.exports` loses the DOM binding, and method shorthand inside loses lexical View access. The workaround: a `const` arrow closure defined *above* `this.exports` that captures View `this` lexically and accepts the source element as an explicit parameter, called from a **thin** method-shorthand wrapper inside `this.exports` whose only job is to forward `this` and the standard `(data, event)` arguments through:

```javascript
import(exports) {
    const { startJob } = exports;
    const { toggleClass } = UI;

    // Arrow closure above — captures lexical View `this` for this.onConfirmed
    // and this.showToast. Receives the source element as `target`, the data-*
    // object as `data`, and the original DOM event as `event`:
    const confirmAndStart = (target, data, event) => {
        const { job } = data;
        const aborted = () => this.showToast('Job aborted', 'danger');
        const doWork  = async () => {
            toggleClass(target, 'starting');
            await startJob(job, event);
            toggleClass(target, 'completed');
        };
        this.onConfirmed('Start job', `Start work on ${job}?`).then(doWork, aborted);
    };

    this.exports = {
        // Thin wrapper — `this` is the source DOM element here. Captures it
        // and forwards as an explicit parameter to the closure above. No logic:
        startJob(data, event) { confirmAndStart(this, data, event); }
    };
}
```

Two structural points worth naming:

- **The wrapper has no logic.** Its only job is to capture `this` (the framework-bound source element) and forward `(this, data, event)` to the closure. Putting any logic in the wrapper splits the work across two `this` semantics — a constant source of confusion. Keep the wrapper pure pass-through; the closure does everything.
- **The closure receives the source element as a regular parameter.** Inside the closure, `target` is the DOM element and `this` is the View — both are unambiguous, both are usable simultaneously, and they don't collide because they have different names.

Use this shape only for genuinely-mixed-context handlers. The arrow-above pattern is a workaround for the cases where neither pure form fits — not the default. Most handlers need one form or the other and get inlined directly into `this.exports`.

Helper closures defined above `this.exports` capture both lexical View `this` *and* the destructured RPC namespace from `import`, so they're the natural home for any logic that combines View state, awaited dialogs, or RPC orchestration.

### 7.4 `this.exports` in the View

Symmetric (define + call from the same object). Populated in `import(exports)`. **The framework injects nothing into `this.exports`** — there are no auto-populated RPC methods, no merged Channel surface, no hidden entries. Whatever shows up at `this.exports.<name>` is something the application placed there in `import()`. Three productive entry shapes (plus the mixed-context workaround), all covered in 7.3:

- **Arrow form** `name: (args) => ...` — when the handler needs View `this` (or no `this`). The most common shape.
- **Method shorthand** `name(args) { ... }` — when the handler needs DOM `this` (the source element from the framework's dispatch binding).
- **Property shorthand** `name` — raw RPC re-exposure by name; the destructured RPC is directly callable from `data-click="<rpcName>"`.

Anything else does not belong on `this.exports`. Framework lifecycle methods (`import`, `online`, `offline`, `latency`, typed-data methods) are class methods, not entries here.

### 7.5 Raw re-exposure vs wrapped closure: pick per action

Because the application owns `this.exports` entirely, the View author chooses for each entry whether to re-expose the raw RPC or wrap it in a gating closure. The framework does not arbitrate.

- **Raw RPC re-exposure** is fast and direct: `data-click="updateUserSettings"` invokes the RPC immediately when triggered, no intermediate logic. Valid for **low-stakes idempotent operations only** — preference reads, refresh actions, status checks.
- **Wrapped closure** (`cancel: ({ jobId }) => confirmAndCancel(jobId)`) gates the call with confirmation, validation, or precondition checks before forwarding. Required for **anything destructive, stateful, or security-sensitive** — cancels, deletes, transfers, mutations of shared state, actions that cost real resources.

Within a single `this.exports = { ... }` literal, JavaScript's last-key-wins applies if a View author lists the same name twice (a View-local closure and a raw RPC re-exposure). This is application-level namespace discipline, not framework behavior.

### 7.6 UI event handlers: data-attribute routing only

There are exactly two legitimate ways to wire UI actions to handlers in a View:

**(a) Data-attribute routing.** The element gets `data-click="handlerName"` (or `data-dblclick`, `data-context`, `data-input`, `data-change`, `data-focus`, `data-blur`, `data-hover`, `data-drag`, `data-mousemove`, `data-submit`, `data-reset`, `data-scroll`, `data-wheel`). The View defines `handlerName` on `this.exports`. Global listeners on `document` (installed by `ui.js`) route the event through the dispatcher, which calls:

```javascript
method.call(source, data, event);
```

— where `source` is the matched DOM element (found via `closest`), `data` is the element's `data-*` attributes as an object (with the action key stripped out), and `event` is the original event.

**(b) Structural-primitive callbacks.** `Panel`'s `onStateChange` and `onVisibilityChange`; `MutexTabGroup` and `MutexPanelGroup` constructor callbacks; `Menu`'s built-in keydown trap. Provide the callback at construction.

**Forbidden in View code (and in any application code outside `ui.js` and `app.js`):** any direct event listener registration. This includes `element.addEventListener(...)`, `element.onclick = ...`, `document.addEventListener(...)`, `window.onpopstate = ...`, `window.onhashchange = ...`, and every other ad-hoc binding. **The single framework-compliant place to add new event handling is `app.js`** (see 7.1). If a View needs an event type not already wired by `ui.js` + `app.js`, extend `app.js` to handle it, then consume from Views via `data-<event>="handler"` + `this.exports`.

### 7.7 Function vs arrow for framework-bound callbacks (the `this`-binding rule, cross-cutting)

**This rule is cross-cutting — it applies to handlers and callbacks at every layer, not only the View. It lives in this section for historical reasons; treat it as authoritative everywhere.**

#### The Dispatcher pattern

Most SC3 framework classes derive from an internal `Dispatcher` base class. When a Dispatcher invokes a handler — whether through event emission, RPC dispatch, UI-event routing, or pipeline callback — it does so via `handler.call(frameworkContext, ...)`. The framework supplies a `this` binding deliberately, because the body of the handler frequently needs access to that context (the socket that received a message, the source DOM element of a click, the driver running a CachedData pipeline).

Two consequences:

- **`function` syntax (and method shorthand on a class) accepts the framework-supplied `this`.** The body sees whatever the framework bound.
- **Arrow functions ignore `.call()`'s context binding.** The body sees the surrounding lexical `this` instead. This is the explicit override mechanism — use it when you want the surrounding class's `this`, not the framework's.

The choice is not stylistic. It is determined by what the body of the handler needs to access.

#### The framework callback contexts (definitive list)

| Callsite | Framework-supplied `this` | Use `function` when... | Use arrow when... |
|---|---|---|---|
| UI dispatch handler in View `this.exports` (fired by `data-*` attribute routing) | the **source DOM element** that matched the data attribute | The handler manipulates the source element directly (`UI.toggleClass(this, ...)`, `this.value = ...`, etc.) | The handler only invokes View methods or manipulates View state |
| CachedData `onData` (constructor option) | the **driver** instance | Always — accessing `this.channel`, `this.channels`, `this.controller`, or `this.cache(path)` requires the driver context | Only if you genuinely need the surrounding Channel's `this` and intentionally bypass the driver context (rare) |
| CachedData `onData` (method on subclass) | the **driver** instance | Method shorthand `onData(data, node) { ... }` — never a class-field arrow | Never — there is no override case here |
| Driver pipeline callbacks (`.subscribe(...)`, `.publish(...)`, and any other chain method that takes a function) | the **driver** instance | Always — pipeline callbacks operate in driver context | Same caveat as `onData` option form |
| `this.on(eventName, handler)` on any Dispatcher subclass (Channel, Node, sockets, framework primitives) | the **emitter** of the event (varies — for socket events the socket; for channel events the channel; for node events the node) | The handler needs to act on the specific emitter (e.g., reply to the specific socket via `this.message(...)`) | The handler needs the surrounding class's `this` (e.g., `this.abort(reason)` on the enclosing Node) |
| Socket message-callback hooks (framework-internal but visible to apps via `this.on(...)`) | the **socket** instance | Sending a reply via `this.message('response', ...)` or calling socket methods | Calling enclosing-class methods |

#### Examples across the contexts

UI handler that needs the source element — method shorthand inside `this.exports`:

```javascript
this.exports = {
    expandRow(data, event) {
        UI.toggleClass(this, 'expanded');         // 'this' is the DOM source element
    }
};
```

UI handler that needs View context (no DOM `this`) — arrow inside `this.exports`. The lexical `this` *is* the View, which is what the body needs:

```javascript
this.exports = {
    login: () => this.login()                     // 'this' is the View
};
```

UI handler with **mixed context** (needs both DOM `this` *and* View context) — thin method-shorthand wrapper inside `this.exports`, arrow closure above does all the work:

```javascript
import(exports) {
    const { startJob } = exports;
    const { toggleClass } = UI;

    const confirmAndStart = (target, data, event) => {
        const { job } = data;
        const aborted = () => this.showToast('Job aborted', 'danger');
        const doWork  = async () => {
            toggleClass(target, 'starting');
            await startJob(job, event);
            toggleClass(target, 'completed');
        };
        this.onConfirmed('Start job', `Run on ${job}?`).then(doWork, aborted);
    };

    this.exports = {
        startJob(data, event) { confirmAndStart(this, data, event); }
    };
}
```

CachedData `onData` option form (driver context):

```javascript
const onData = function(addresses, node) {
    const { catalog } = this.channels;        // 'this' is the driver
    const { storeDHCPHosts } = catalog.channelExports;
    if (node === DHCP_SERVER) { storeDHCPHosts({ addresses }); }
};
```

CachedData subclass form (method shorthand, driver context):

```javascript
class DeploymentData extends CachedData {
    onData(data, node) {                      // method shorthand; 'this' is the driver
        const { batch } = data;
        const { batches } = this.channel;
        batches.get(batch)?.targets.get(node)?.ingest(data);
    }
}
```

`this.on(...)` accepting emitter context (socket-bound, needs to reply to specific socket):

```javascript
this.on('terminalAttach', function ({ streamId, uid }) {
    telemetry.subscribeStream(streamId, uid, this);   // 'this' is the socket
    this.message('response', { key: 'terminalAttach', result: { /* ... */ } });
});
```

`this.on(...)` overriding to lexical context (the surrounding Node's methods):

```javascript
constructor(devices, settings) {
    super(devices);
    // Arrow because we want 'this' to be the Node, not the emitter,
    // so this.abort(reason) resolves to the Node's abort method:
    this.on('abort', ({ reason }) => this.abort(reason));
    this.connect(() => this.init());
}
```

#### The parameterized factory pattern

When a handler needs to capture a parameter lexically *and* receive the framework context as `this`, the canonical shape is an outer arrow returning an inner `function`:

```javascript
const trackOnboarding = domain => {
    return function (data) { this.trackOnboardingStatus(domain, data); };
};
this.loadDriver('lifecycle')
    .process(new CachedData('netdata',   { /* ... */ onData: trackOnboarding('netdata') }))
    .process(new CachedData('landscape', { /* ... */ onData: trackOnboarding('landscape') }));
```

The outer arrow captures `domain` from its lexical scope. The inner `function` receives the driver as `this` when the framework calls it. Trying to write this with two arrows loses the driver context; trying to write it with two functions loses the captured `domain`.

---

## 8. Code Style Within Application Classes

### 8.1 No underscore-prefixed methods

Application code is the final consumer; nothing else reads it as a library. The public/private distinction is meaningless and only obscures readability.

**Methods do not get `_` prefixes.** Default everything to public.

The **only** legitimate use of `_` prefix is **backing storage for getter/setter pairs**, accessed *only* inside the getter and setter:

```javascript
// CORRECT — backing storage for an accessor pair:
class Auth extends Operations {
    set CurrentUser(user) {
        this._current_user = user;
        this.updateUserMenu(user.displayname);
    }
    get CurrentUser() {
        return this._current_user || { userid: 0, loggedin: false, displayname: '' };
    }
}

// WRONG — plain field with no getter/setter:
class Foo {
    _replayQueues = new Map();   // should be: replayQueues = new Map();
}

// WRONG — "private" helper method:
class Foo {
    _doTheThing() { /* ... */ }   // should be: doTheThing() { /* ... */ }
}
```

### 8.2 Helper extraction: by abstraction, not by tidiness

Extracting code from a method body into a separate function/method is a positive engineering act *only* when the extraction names a coherent unit of behavior. It is **not** justified by the desire to make the calling method shorter, neater, or "cleaner."

**Extract when** the extracted name describes a transformation, computation, or operation reusable by definition — a developer reading the name and signature alone can predict what it does and recognize when it would apply elsewhere:

- Normalizers, parsers, formatters: `normalizeNodeId(raw)`, `parseTimecode(str)`.
- Predicates / queries: `isReplayInProgress(nodeId)`, `hasActiveSubscribers()`.
- Lookups / accessors over internal collections: `findQueueByAgent(id)`.
- Named state transitions: `markReplayComplete(nodeId)`, `enqueueJob(job)`.

**Do not extract when** the name is just a paraphrase of "the next chunk of the calling method." If `dispatchReplay` is called once from `requestArchiveReplay` and its body is "the steps that come after the queue check," then renaming it `step2OfRequestArchiveReplay` would not change its meaning. That is a section header. Inline it.

The discriminating question, to ask at the moment of extraction:

> *Does this method's name describe the operation independently — such that a hypothetical second caller would already know what to expect — or does its meaning collapse to "the part of `<calling method>` that follows the part above it"? If the latter, inline it.*

### 8.3 Helper placement

In order of preference:

1. **External utility class, imported** — when the helper is genuinely general-purpose across multiple projects. Goes in a shared utils module.
2. **Inline `const` arrow function** — when the helper is highly specialized for the current method and used only there.
3. **Static class method** — when the helper is project-specialized and used in more than one method of the class.

**Never duplicated** across classes. Promote to a shared utility module the moment a second class needs it.

### 8.4 Constructors call setters, not backing storage

When a constructor initializes state that has a getter/setter pair, it goes through the setter:

```javascript
// CORRECT:
constructor() {
    super();
    this.CurrentUser = defaultUser;   // through the setter
}

// WRONG (without strong reason):
constructor() {
    super();
    this._current_user = defaultUser;   // bypasses setter side effects
}
```

The only exception is when application behavior by design **must** bypass the setter's side effects for a specific edge case — and even that pattern is discouraged.

### 8.5 The flatness premise

Every Claude instinct toward *additional indirection* in application code — privacy markers, helper extraction for tidiness, wrapper exports in Channel, fat private methods called from thin exports, defensive try/catch around framework calls — is wrong in SC3 application code.

Flatness is what makes the code human-readable. The framework provides whatever indirection is required by correctness. Application code does not manufacture more.

### 8.6 Method shorthand inside object literals

When defining methods inside object literals — handler objects passed to `.subscribe(...)` / `.publish(...)`, configuration objects with function-valued properties — use ES6 method shorthand, not the verbose `key: function () { ... }` form.

```javascript
// CORRECT:
this.handlers = {
    progress(data, node, socket) { /* ... */ return shouldPublish; },
    history(data, node, socket)  { /* ... */ return shouldPublish; }
};

// WRONG (verbose without semantic benefit):
this.handlers = {
    progress: function (data, node, socket) { /* ... */ },
    history:  function (data, node, socket) { /* ... */ }
};
```

The two forms are semantically equivalent for framework callbacks — both honor the framework's `.call(driver, ...)` binding. This rule is purely about readability.

Method shorthand is **not** equivalent to arrow functions here. Arrows ignore the framework's binding; method shorthand honors it (same as `function`). Arrow placement is governed by the function-vs-arrow rule, not this one. The shorthand-vs-verbose choice is stylistic; the shorthand-vs-arrow choice is semantic.

---

## 9. Refactoring and Debugging Discipline

### 9.1 Preserve framework-fixture wiring shape

When refactoring code that wires a Channel/Driver/Node into the framework — `loadDriver` instantiation, `CachedData` pipeline registration via `.process(...)`, helper closures invoked by fixture-registration, service-level callbacks feeding those helpers — **retain the shape used when the subclass was first built and working.**

Shape means: where the binding lives (constructor-local `const` vs instance field vs prototype method vs arrow-field) AND how it is referenced from other wiring (closure identifier vs `this.<name>` access). Shape changes during a broader refactor are forbidden — a shape change must be its own commit, justified on its own merits.

The framework's dispatch, cache replay, and handshake plumbing depend on existing shape in ways application code cannot reason about.

### 9.2 Framework as black box during regression investigation

When a regression surfaces after refactoring SC3-facing code:

1. **Read the git diff** of changed application files against the pre-refactor baseline (`git diff`, `git show HEAD:<path>`). Do not rely on memory.
2. **Trace from symptom backward to source** within the application layer. UI regression → start at the View method receiving the event → walk back through the application's emit helpers → reach the fixture-registration site. The break is inside that span.
3. **Environmental probes (curls, log tails, process inspection) come last** and only if diff analysis is exhausted.

**Forbidden during regression investigation:**

- Reading, grepping, or tracing files in the framework package. The framework is not at fault. Its internals are not diagnostic input.
- Hypotheses whose confirmation requires framework-internal knowledge (dispatch order, property enumeration, handshake state machine).
- Advancing to environmental probes before exhausting application-layer diff analysis.

### 9.3 No bulk search-and-replace on framework-adjacent code

`sed`, `awk`, `perl -pi`, `find ... -exec sed`, `grep -l ... | xargs sed` against files containing framework-fixture wiring (Channel/Driver/Node subclasses and their wiring helpers) is **forbidden**. Edits to these files are made one site at a time via reviewable per-edit operations.

Bulk renames produce diffs that obscure shape changes (rule 9.1), over-matched patterns, and missed sites. On framework-adjacent code, the consequences are silent runtime failures with no console signal — debug cost vastly exceeds the cost of deliberate per-site edits.

### 9.4 Driver-level diagnostics: when no Nodes appear

When a Channel reports its driver loaded but no Nodes ever come up, the driver has likely been substituted with the MISSING placeholder due to a startup failure (see 5.4). The MISSING substitution is silent — there is no log message announcing it. Investigate in this order:

1. **Check the driver file's effective permissions for the service user.** The service may run as a different OS user than the development environment, and a file readable by the developer may not be readable by the service. **This has surfaced more than once. Do not skip this check, even when permissions seem unlikely.**

   ```bash
   sudo -u <serviceuser> ls -la <project>/drivers/<domain>.js
   ```

2. **Run the driver standalone as the service user.** The driver is an independent program that runs in its own process when spawned by the framework. Running it manually surfaces problems the framework's silent failure mode hides:

   ```bash
   sudo -u <serviceuser> node <project>/drivers/<domain>.js
   ```

   What to look for in the output:
   - `Cannot find module ...` — missing dependency.
   - `SyntaxError`, parse errors — broken file.
   - Constructor-time exceptions — prerequisite missing.
   - Any text on stdout *before* the JSON object — output pollution (someone added a `console.log`, or a third-party import did).
   - No output at all — the spawn succeeded but the file produced nothing parseable.

3. **Verify stdout cleanliness.** The first thing on stdout from a successful standalone run must be a valid JSON object representing the devices structure. Anything else — startup banners, dotenv warnings, debug logs, deprecation notices — corrupts the framework's parse and triggers the MISSING substitution.

4. **Then check application-layer wiring** in the Channel constructor: is the `loadDriver(name)` call using the right name? Does `<domain>.js` exist at the expected path?

This is *application-layer* investigation despite touching subprocess concerns — the driver file is application code, even though its execution context (subprocess managed by Worker) is framework territory. Rule 9.2's "framework as black box" still applies; the driver file itself is fair game for investigation.

---

## 10. Detection: Text Shapes That Should Trigger Self-Correction

When you are about to type any of the following in application code, **stop and reconsider**. These are the keystroke-level signatures of the violations above.

### Channel layer

- `request<X> = async (...) =>` on a Channel subclass → that's an `exports` key, not a class field.
- `this.request<X> =` in a Channel constructor → same problem.
- `<exportName>: args => this.<methodName>(args)` in `exports` → thin wrapper; inline the logic.
- `await this.exports.<method>(` on a Channel → wrong dispatcher; use `channelExports`.
- `await this.driver.request('<method>',` → forbidden messaging-pattern bypass.
- `<exportName>: args => this.<otherChannel>.<method>(args)` in a Channel `exports` → wrapping a Node export the framework has already bubbled; delete the wrapper.

### Cache and CachedData

- `this.controller.state.cache` → bypassing the accessor; use `this.controller.cache(path)`.
- `getCurrentStatus: async () => this.controller.cache(...)` as an RPC export → CachedData already publishes; this is redundant.
- `socket.data(<type>, ` in application code → CachedData's emitter does this; the application should not.
- `channel.send(` or any direct call to a framework messaging primitive (`socket.send`, `ws.send`, etc.) → these are framework internals; use CachedData configuration, RPC exports, or `this.emit(...)` from a Node.
- `this.statusByNode = new Map()` on a Channel → parallel cache; Controller owns state.
- `class <X>Data extends CachedData { onData = (data) => ` (class-field arrow) → loses framework's bound `this` to the driver; use method shorthand `onData(data) { ... }` instead.
- A CachedData subclass that overrides `collector`, `emitter`, or the constructor → these are framework semantics; the only legitimate override is `onData`.
- `const <name> = new CachedData(...)` followed by *any* use of `<name>` other than passing it to `.process(...)` → the constructor returns a `{source, sink}` config, not an instance with methods.
- `this.<field> = new CachedData(...)` where the field is read elsewhere → same problem; nothing to retain.
- `this.controller.cache([<driver-domain>, ...])` from inside a callback already in driver context → use the driver-scoped `this.cache([...])` instead.

### View layer

- `element.addEventListener(...)` or `document.addEventListener(...)` or `window.onpopstate`/`onhashchange` in a View (or in any application code outside `ui.js` / `app.js`) → for per-element events, use `data-*` attribute routing; for new global event types, extend `app.js` (see 7.1, 7.6).
- `<button>.onclick = ` → same; use `data-click` + `this.exports`.
- `this.exports.<name> = ...` (standalone assignment) instead of populating `this.exports = { ... }` as a single object literal in `import(exports)` → not the canonical shape; build the whole exports surface in one literal so the form choice (arrow / method shorthand / property shorthand) is visible per-handler in one place.
- Inline arrow `name: (args) => UI.toggleClass(this, ...)` inside `this.exports` where `this` is meant to be the source element → arrow loses `.call()` context (it captures lexical View `this` instead); use method shorthand `name(args) { UI.toggleClass(this, ...) }` for DOM-`this` handlers, or use the mixed-context workaround if the handler also needs View context (7.3).
- An RPC export named `getInitial<X>` called from `import` → typed-data replay covers this; remove.
- A class method named `import`, `online`, `offline`, `latency`, or any other typed-data name (`devices`, `status`, `nodes`, etc.) being placed inside `this.exports` → these are class-level lifecycle/routing methods.

### RPC signatures

- `<exportName>: async (arg1, arg2) =>` → multi-arg signature; framework passes one object.
- `try { await this.channelExports.<x>(...) } catch` for "hardening" → framework bubbles errors; remove.
- Manufacturing a `node` value when the driver is single-node → leave `node` undefined.

### Node files (`<project>/drivers/<domain>.js`)

- `console.log`, `console.warn`, `console.error`, `this.debug`, or `this.log` *anywhere* in a Node constructor body → corrupts the driver JSON-on-stdout contract; the driver becomes MISSING and never spawns workers. Move all diagnostics to `init()` or the `connect(callback)` callback.
- Any method call in a Node constructor that might log transitively (calling `this.someMethod()` whose body logs) → same risk; if uncertain, defer to the connect callback.
- Module-scope code in `<domain>.js` other than `import` statements, top-level `const` declarations, and the final `new SomeNode(...)` instantiation → likely emitting output before the framework's JSON serialization. Move it inside the Node class or into the connect callback.
- Top-level `await` or top-level Promise-returning side effects in `<domain>.js` → may delay or pollute the JSON emission. Move into the connect callback.

### Polling and timing

- `setInterval(` *anywhere* in application code → wrong tool. Node `this.interval` + `this.poll` is the framework-provided periodic mechanism. Nothing else is correct.
- `setTimeout(...)` whose callback body re-schedules another `setTimeout` to do the same work, directly or via a helper → polling loop in disguise; same fix.
- `while (true) { await fn(); await sleep(N); }`, async-iterator polling, generator-based polling → same.
- A new method whose only job is to call `setTimeout(self, N)` to re-enter itself → same.
- `setTimeout` for a genuine bounded delay (debounce, cleanup-after-N, abort-after-deadline, deferred single action that does not re-schedule) → fine; leave it.

### Code style

- `_<methodName>(` in application code → drop the underscore unless it is backing storage for a getter/setter pair.
- `this._<field> =` in a constructor where a getter/setter exists → call the setter.
- A new class method that has exactly one caller, also in the same class → inline it unless its name describes a reusable abstraction.

---

## 11. The Decision Procedure

Before writing or modifying SC3 code, walk these in order:

1. **What layer am I in?** Determine by `extends` clause and file location. Different layers have different idioms; the same syntax means different things in different layers.

2. **What is the data flow?** Identify the source (Node `this.emit`, RPC call, UI event) and the consumer (View typed method, RPC handler, side-effect callback).

3. **Is there a framework mechanism for this?** If yes, the entire wiring is *configuration at the right declaration point*. If no, write minimal application code at the appropriate hook.

4. **What is the canonical shape?** Find an analogous case in existing application code in this codebase. Match its shape, not generic JavaScript conventions.

5. **What instinct am I about to override?** Privacy markers, helper extraction, defensive error wrapping, "exposing" things at higher layers, manual subscription/replay — every one of these is a generic instinct that produces an SC3 violation. Suspend the instinct in favor of the framework idiom.

The framework is invariant. The application's job is to declare intent at the configuration moments and stop.