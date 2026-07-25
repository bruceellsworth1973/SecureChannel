# Building Applications on SecureChannel 3
## A Developer's Guide

---

## Table of Contents

- [Welcome](#welcome)
- [The Shape of an SC3 Application](#the-shape-of-an-sc3-application)
- [The Big Idea: Trust the Framework](#the-big-idea-trust-the-framework)
- [A Complete Example](#a-complete-example)
  - [The Node](#the-node)
  - [The Channel](#the-channel)
  - [The View](#the-view)
  - [Putting it together](#putting-it-together)
- [Writing Nodes](#writing-nodes)
  - [Where Nodes live](#where-nodes-live)
  - [The constructor's four jobs](#the-constructors-four-jobs)
  - [Polling: use what the framework gives you](#polling-use-what-the-framework-gives-you)
  - [Event-driven data is not polling](#event-driven-data-is-not-polling)
  - [Emitting data upward](#emitting-data-upward)
  - [Exposing RPC methods from a Node](#exposing-rpc-methods-from-a-node)
  - [Two flavors of Node: `Node` and `Passthrough`](#two-flavors-of-node-node-and-passthrough)
  - [A Node's full lifecycle](#a-nodes-full-lifecycle)
- [Writing Channels](#writing-channels)
  - [The Channel constructor: a declarative manifesto](#the-channel-constructor-a-declarative-manifesto)
  - [Understanding CachedData](#understanding-cacheddata)
  - [RPC exports: where they go, and how to call them](#rpc-exports-where-they-go-and-how-to-call-them)
  - [The Channel's call-pattern asymmetry](#the-channels-call-pattern-asymmetry)
  - [Beyond CachedData: custom handlers](#beyond-cacheddata-custom-handlers)
  - [Sparse drivers: nodes spawned at runtime](#sparse-drivers-nodes-spawned-at-runtime)
  - [The rest of the Channel](#the-rest-of-the-channel)
- [The Cache and Shared State](#the-cache-and-shared-state)
  - [`this.controller.cache(...)` and `this.controller.nodes(...)`](#thiscontrollercache-and-thiscontrollernodes)
  - [`this.controller.nodes(...)` is for node availability](#thiscontrollernodes-is-for-node-availability)
  - [Driver-scoped accessors](#driver-scoped-accessors)
  - [The auto-creation footgun](#the-auto-creation-footgun)
  - [What goes in the cache](#what-goes-in-the-cache)
  - [What about reading another channel's cache](#what-about-reading-another-channels-cache)
- [Writing Views](#writing-views)
  - [The Client routes; the View declares](#the-client-routes-the-view-declares)
  - [`import(exports)`: subscribing to the RPC provision](#importexports-subscribing-to-the-rpc-provision)
  - [Subscribing to data streams: define a method by the data type's name](#subscribing-to-data-streams-define-a-method-by-the-data-types-name)
  - [The UI base: `ui.js` and `app.js`](#the-ui-base-uijs-and-appjs)
  - [UI event handlers: data attribute routing](#ui-event-handlers-data-attribute-routing)
  - [Structural primitives from `ui.js`](#structural-primitives-from-uijs)
- [Binary Streams](#binary-streams)
  - [What binary streams are for](#what-binary-streams-are-for)
  - [The two-stream model: collator and fanout](#the-two-stream-model-collator-and-fanout)
  - [Opening a stream from a Node](#opening-a-stream-from-a-node)
  - [Opening a stream from a Channel](#opening-a-stream-from-a-channel)
  - [The browser side](#the-browser-side)
  - [The framework handles everything in between](#the-framework-handles-everything-in-between)
  - [What the application must not do](#what-the-application-must-not-do)
- [A Final Word](#a-final-word)

---

## Welcome

SecureChannel 3 (SC3) is a framework for building real-time, multi-tenant applications where data flows from somewhere — a network of devices, a database, an external service, a stream of events — through a server-side application out to a set of browser clients, all over a single bidirectional connection per client.

SC3 is layered and opinionated. It handles a great deal automatically: caching state at the right layer, replaying it to newly-connected clients, multiplexing data streams, routing RPC calls, deduplicating updates, and recovering from disconnects. Your application declares intent at the configuration and lifecycle hooks the framework provides; the framework does the rest.

This guide walks through the architecture, the data flow, and the canonical patterns for each layer. You'll see complete application code rather than API stubs, and you'll see why the idioms exist — not just what they look like. By the end, you'll be able to write SC3 applications that read like declarations of intent: short, structurally clear, largely free of orchestration plumbing.

---

## The Shape of an SC3 Application

Before you can write SC3 code, you need a picture of where the code goes. SC3 applications have layers, and each layer has a specific job. The same syntactic surface can mean different things in different layers, so knowing which layer you're working in is the foundation of every other decision.

Imagine you're building a system that monitors network devices. Your application needs to:

- Connect to each device, poll it for status, and watch for changes.
- Cache the latest state so newly-connected browsers can see it immediately.
- Forward updates in real time to subscribed browsers.
- Allow browsers to send commands back to specific devices.
- Survive devices going down and coming back up without manual intervention.

Here's how the layers fit together to do this:

**The Node** runs in its own subprocess. One Node represents one device. It connects to the device, polls it, emits typed data ("here's the latest status"), and accepts commands. Nodes are isolated — if one crashes, others keep running, and the framework restarts the dead one. SC3 provides two sibling base classes for Nodes: `Node` for direct device management (the application owns the protocol — SSH, HTTP, database queries, etc.), and `Passthrough` for bridging to another SC3 application running as its own micro-service (the framework owns the protocol — it's always SC3-over-WebSocket). Both are subprocesses, both look identical to upstream layers, and most non-trivial applications use a mix.

**The Worker** is a framework-internal lifecycle manager. There's exactly one Worker per Node. It spawns the Node's subprocess, routes data through inter-process communication, detects crashes, and respawns. You never write Worker code directly; you just need to know it exists and that it's the layer that keeps Nodes alive.

**The Driver** represents a *class* of nodes — a "domain" in SC3 terminology. A "cisco" driver might manage many cisco devices, each one a Node. The Driver knows how to spawn Workers for its domain and routes data between Nodes and the Channel above. You don't write Driver code as a developer either, but you configure drivers extensively through a fluent API on the Channel.

**The Channel** is the application's main public interface. It loads Drivers, declares what data flows through, exposes RPC methods that browsers can call, and serves WebSocket connections to browsers. Each Channel runs as its own HTTPS server on its own port, with its own WebSocket interface. An application can have multiple Channels — one for authentication, one for monitoring, one for administration — keeping their namespaces and message traffic separate.

**The Controller** is the root of the server-side application. There's one per app. It owns the cached application state, holds references to every Channel and Driver, and provides the shared substrate that lets Channels coordinate. Your application's main class is typically a Controller subclass, and your application's entry point typically constructs it once.

**The View** is the browser side. A View is a JavaScript class that runs in the browser. It imports RPC method handles from the Channel during the WebSocket handshake, subscribes to typed data streams from the Channel by defining methods named after the data types, and dispatches user interface events to handlers. Different Views can connect to different Channels — your app might have an auth View, a dashboard View, an admin View, all running on the same page.

When data flows from a device to a browser, it traces this path: the Node polls the device and emits typed data, the Worker delivers it through IPC to the Driver, the Driver runs it through a configured pipeline (caching, dedup, publication), the Channel pushes it over WebSocket to subscribed browsers, the View receives it via a method named after the data type, and the browser updates accordingly. The View's subscription to a data type is *the act of defining a method by that name* — not a separate registration step. A method named `status(data)` on the View is, by virtue of its name, a subscription to `'status'`-typed data. The framework's contract is that named methods on the View are subscription declarations; the contract is satisfied by writing the method.

None of this requires application code beyond two declaration points: the Channel constructor's pipeline declaration, and the View's subscription methods named after the data types it consumes. Everything between them is framework-managed.

When a browser sends a command back to a specific device, it traces the reverse path: the View invokes an RPC method on its imported `exports` object, which routes through the WebSocket to the Channel, which dispatches to the right Driver, which routes to the right Worker, which sends an IPC message to the Node, which executes the command. Again, the application code is small: the Channel exposes the RPC method as one entry in `this.exports`, and the View invokes it as a function call. The dispatching, marshalling, and routing are framework-managed.

This is what people mean when they say SC3 is a framework, not a library. You don't call SC3 from your code; SC3 calls your code at specific points, and you fill in the blanks. The blanks are smaller than you'd expect.

---

## The Big Idea: Trust the Framework

Every recurring SC3 bug new developers introduce comes from one underlying instinct: when the framework's mechanism isn't *visible* at the point you're writing code, you reach for an explicit, application-side replacement. That replacement is the bug.

Here are some examples of the same instinct manifesting in different ways.

You're working in a Channel constructor. You've declared a CachedData processor for `'status'` data:

```javascript
this.loadDriver('adscan')
    .process(new CachedData('status', { publishDataStream, nodeInData }));
```

A few minutes later, you're writing the View. You think: "I need to fetch the initial status to show the user." You reach for an RPC export — `getCurrentStatus` — that returns the cached data so the View can call it on startup.

Don't. The CachedData processor's `publishDataStream` flag means that *every connected client receives the cached state on connect, and every update thereafter, through whichever method on the View matches the data type's name*. Your `getCurrentStatus` RPC is not just redundant — it's a parallel mechanism that can drift from the framework's canonical one. The View subscribes to status data by defining a `status(data)` method; that's the subscription, and the framework honors it. No fetch needed.

Different scenario, same instinct. You're writing a Node. You want to know whether it started up correctly, so you add `console.log("MyNode started")` at the top of the constructor. The next time you run the application, the Node never starts. There's no error message. The Channel reports its driver loaded, but no Nodes appear. Hours later, you find that the framework spawns the Node file as a subprocess, reads its stdout expecting a single valid JSON string describing the devices it manages, and silently substitutes a placeholder driver if the parse fails. Your `console.log` corrupted that JSON. There's no error path because the framework treats the misparsed output as "no devices" and proceeds normally — just with no Nodes.

Different scenario again. You want to poll a remote service every thirty seconds. You write `setInterval(refresh, 30000)` in the Node constructor. It works, until you realize the polling cycle keeps running after errors that should have stopped it. You add error handling. Then you realize it's not coordinating with the Worker's "ready" signal, and the Channel sometimes pushes stale data to clients during transient failures. By the time you've reproduced what the framework's `interval`/`poll` properties already do, you've spent several days writing buggy code that the framework would have handled correctly with two lines.

These aren't strawmen. They're the bugs SC3 developers actually introduce, repeatedly, for understandable reasons. The framework does a great deal automatically; the automatic mechanisms are invisible at the call site; the developer's instinct to "do something" produces an application-side parallel; the parallel is wrong because the framework's version was already correct.

The mental discipline this requires sounds simple but takes practice: **before writing any code that moves, fetches, caches, replays, or transforms data, ask whether SC3 already does this for you.** The answer is almost always yes. The remaining cases — where SC3 genuinely doesn't have a mechanism — exist, but they're far rarer than your habits will lead you to assume.

The chapters that follow walk through the framework's mechanisms in enough detail that you can answer that question confidently. Until then, hold onto this one rule: when in doubt, write less code, not more.

---

## A Complete Example

Let's build a small but real application: a status monitor for a fleet of network devices. We'll write:

- A Node that connects to a device and polls its status endpoint.
- A Driver registration in a Channel constructor that streams status updates to browsers and caches the latest values.
- A View that displays the device list and reacts to status changes.

This example introduces every layer in a working configuration. Subsequent chapters will go deeper into each piece.

### The Node

The Node is the smallest standalone piece. It runs in its own subprocess, polls a device, and emits typed data. Here's a minimal one:

```javascript
import { Node } from 'securechannel';
import { fetchJSON } from '../utils/fetchAPI.js';

const DEVICES = {
    'router-1': { address: '10.0.0.1' },
    'router-2': { address: '10.0.0.2' },
    'switch-1': { address: '10.0.0.10' }
};

class DeviceStatusNode extends Node {
    exports = {
        // browsers can force an immediate refresh between scheduled polls
        refreshNow: async () => {
            await this.refresh();
            return { ok: true, at: Date.now() };
        },

        // browsers can issue a reboot command to a specific device
        sendReboot: async () => {
            await fetchJSON(`https://${this.address}/api/reboot`, { method: 'POST' });
            return { acknowledged: true };
        }
    };

    async refresh() {
        const url = `https://${this.address}/api/status`;
        const status = await fetchJSON(url);
        this.emit('status', status);
    }

    constructor(devices) {
        super(devices);
        const init = () => {
            const device = this.getDevice(devices);
            this.address = device.address;
            this.interval = 30;             // poll every 30 seconds
            this.poll = this.refresh;       // start the polling cycle
        };
        this.connect(init);
    }
}

new DeviceStatusNode(DEVICES);
```

A few things are happening here. The file declares a `DEVICES` constant: an object whose keys are device identifiers and whose values are per-device configuration. When the framework spawns this file, the framework reads stdout expecting a JSON string describing these devices, then instantiates one Worker per key. So this single file is the "DeviceStatus driver" — but the framework will run multiple instances of it in separate subprocesses, one per device.

The constructor is deliberately tiny. It calls `super(devices)`, schedules an initialization function with `this.connect(init)`, and stops. **It must not log, write to stdout, or do any setup work synchronously.** The framework reads stdout immediately after `super(devices)` returns; anything that pollutes stdout breaks the JSON parse.

The real initialization happens inside `init`, which runs after the framework has registered the Node with its Worker. There you read the device's configuration (`getDevice` returns the config object for the specific node this subprocess represents), set `this.interval` to the polling cadence in seconds, and set `this.poll` to the function the framework should call each cycle. The framework handles the rest: invoking `refresh` on schedule, signaling "ready" on success, propagating errors, suppressing the next tick if the previous one is still running.

`refresh` does the actual work — fetch the status, then `this.emit('status', status)`. That `emit` call sends typed data upward through the framework. Every connected browser whose View has a `status` method will receive it automatically.

The `exports` object is where this Node lives its second life: as a target for browser-initiated RPC. `refreshNow` lets a user click a button and force an immediate poll without waiting for the next scheduled tick. `sendReboot` sends a reboot command to the specific device this Node represents. Both methods will be callable from the browser as if they were local functions, with the framework taking care of routing the call to the correct Node based on the `node` argument.

**This is where most exports actually live in SC3 applications: in the Node, not the Channel.** The Node knows the device. The Node knows how to talk to it. The Node has the open SSH session, the cached configuration, the connection state. Putting the export in the Node puts the logic next to the data and the connection it operates on.

You'll see the Channel below has no exports of its own — and that's typical. The framework propagates Node-defined exports upward through the Driver and Worker layers and merges them into the Channel's exposed namespace automatically. By the time a browser calls `refreshNow`, the framework has already routed it to the right Node based on the call's `node` argument. The Channel didn't need to expose, wrap, or re-declare anything. This is the trust principle from the previous chapter, manifesting concretely.

### The Channel

The Channel declares what data flows through the application. Here's a minimal version of ours, before we add anything Channel-specific:

```javascript
import { Channel, CachedData } from 'securechannel';

class MonitorChannel extends Channel {
    constructor(id, controller, options) {
        const { connection } = Channel.getConnection(id, options);
        super(id, connection).join(controller);

        this.loadDriver('devicestatus')
            .process(new CachedData('status', {
                publishDataStream: true,
                nodeInData: false
            }));
    }
}
```

That's a complete Channel for the case we've built so far. No `exports` object. No method definitions. Just a constructor that loads the driver and registers a CachedData processor for the `'status'` data type.

The driver name `'devicestatus'` corresponds to the Node file we just wrote (`<project>/drivers/devicestatus.js`). When the constructor calls `loadDriver('devicestatus')`, the framework spawns one subprocess per device in the file's `DEVICES` constant and starts the data flow.

The CachedData configuration tells the framework what to do with `'status'` data when it arrives from the Node: cache the latest value per device, push each update to subscribed clients, and replay the cached state to newly-connected clients. None of that is in your code. It's the configuration's effect.

And the exports we defined in the Node — `refreshNow` and `sendReboot` — are now reachable from any browser connected to this Channel, with no Channel-side code required. The framework merged them into the Channel's exposed namespace during the driver's startup. When a browser calls `refreshNow`, the framework's RPC dispatcher routes the call through the Channel, through the Driver, to the right Worker, into the Node subprocess, and invokes the export. The return value travels back the same way.

If you're tempted to add a `rebootDevice` wrapper to this Channel — something like `exports = { rebootDevice: async (args) => this.channelExports.sendReboot(args) }` — don't. The wrapper accomplishes nothing the framework hasn't already done. The Node's `sendReboot` is *already* part of the Channel's namespace. Wrapping it just adds an indirection layer that obscures where the real handler lives, and in some configurations the wrapper is shadowed by the Node export anyway and never executes. Define exports where the work happens; let the framework propagate them.

#### When a Channel export is the right answer

So when *do* you write Channel-level exports? The cleanest example is sparse-driver orchestration — operations that need to spawn or coordinate work across Nodes that don't yet exist at the moment the call arrives.

Suppose our application also lets users push firmware updates to one or more devices in parallel. We want a "deploy firmware" button that takes a list of device hostnames and a firmware package, and starts a tracked batch operation that runs across all of them concurrently. Each device-update is its own subprocess managed by a sparse driver — the Workers don't exist before the user clicks the button, and they're torn down when the work finishes.

The export that starts this work has nowhere to live except the Channel. There's no Node yet to put it on; the export's whole purpose is *to create* the Nodes. So we add a `firmware` driver and a Channel export to drive it:

```javascript
import { Channel, CachedData } from 'securechannel';

class MonitorChannel extends Channel {
    activeDeployments = new Map();

    exports = {
        deployFirmware: async ({ targets, packageName }) => {
            const batchId = crypto.randomUUID();
            const batch = { id: batchId, targets, packageName, started: Date.now() };
            this.activeDeployments.set(batchId, batch);

            // spawn one Worker per target on the sparse 'firmware' driver
            for (const hostname of targets) {
                const nodeId = `${batchId}:${hostname}`;
                await this.firmware.addWorker(nodeId, { hostname, packageName, batchId });
            }

            return { batchId };
        },

        cancelDeployment: async ({ batchId }) => {
            const batch = this.activeDeployments.get(batchId);
            if (!batch) throw `unknown batch ${batchId}`;
            // ... abort logic ...
            this.activeDeployments.delete(batchId);
            return { acknowledged: true };
        }
    };

    constructor(id, controller, options) {
        const { connection } = Channel.getConnection(id, options);
        super(id, connection).join(controller);

        this.loadDriver('devicestatus')
            .process(new CachedData('status', {
                publishDataStream: true,
                nodeInData: false
            }));

        this.firmware = this.loadDriver('firmware')
            .process(new CachedData('progress', {
                publishDataStream: true,
                nodeInData: true
            }));
    }
}
```

`deployFirmware` is doing something no Node could do: creating a new batch, registering it in Channel-owned state, then spawning Workers via `this.firmware.addWorker(...)`. The Workers don't exist until the export runs, so a Node-level export wouldn't have a Node to live on. `cancelDeployment` similarly operates on Channel-owned state — the `activeDeployments` map — that no individual Node has visibility into.

This is the pattern. Channel exports are for operations that *are about* the Channel's own state, the cross-driver coordination, or the lifecycle of Workers themselves. Once Workers are running and producing data through `this.emit(...)`, that data flows through the same CachedData mechanisms we've already seen — `publishDataStream: true` on the `'progress'` type means each Worker's progress updates reach subscribed clients automatically, and the View can render a `progress(data)` method to receive them.

Notice also that we kept a reference to the firmware driver as `this.firmware`. You can reach for the loaded driver later if you need to call its dynamic-orchestration methods (`addWorker`, `dropWorker`); the `loadDriver(...)` chain returns the driver itself, so storing it is just a matter of catching the return value. The Writing Channels chapter covers sparse-driver orchestration in detail.

#### How the Channel's namespace gets populated

Here's the full picture of what a browser sees in `import(exports)` when it connects to this Channel:

- `refreshNow` — defined in the `devicestatus` Node, bubbled up automatically.
- `sendReboot` — defined in the `devicestatus` Node, bubbled up automatically.
- `deployFirmware` — defined in this Channel's `exports` object.
- `cancelDeployment` — defined in this Channel's `exports` object.

These four names live in a single flat namespace. The browser doesn't see them as "Channel exports" versus "Node exports" — they're all just methods that can be called. The framework merges Node-bubbled exports and Channel-defined exports into one object that gets handed to the View's `import` lifecycle method.

This raises a real concern that's the application's responsibility to manage: **name collisions silently overwrite, with no warning**. If you defined a Channel export named `refreshNow` (perhaps to mean "refresh all devices at once"), it would collide with the Node-bubbled `refreshNow` (which refreshes one device). The framework arbitrates the collision by precedence rules, and one of the two methods becomes invisible. There's no error. The application just behaves wrong.

The collision rule, when it occurs, is that **the Node export wins**. Node exports are dynamic (resolved at runtime as Workers come up) while Channel exports are static (defined when the Channel class is instantiated), and the framework's merge favors the dynamic side. So if you accidentally name a Channel export the same as something a Node exposes, your Channel export silently doesn't run.

The discipline is straightforward: choose names deliberately. Keep Channel exports semantically distinct from Node exports — if the Node has `sendReboot`, don't name a Channel export `sendReboot`; use something like `rebootAll` or `cascadeReboot` to communicate that this is a different operation. When in doubt, search the Node files in the drivers your Channel loads and check what names they export, before adding a Channel export that might collide.

A subtle thing to file away: when you need to *call* a Channel-defined export from elsewhere in the same Channel, you call it through `this.channelExports`, not `this.exports`. So if `deployFirmware` needed to internally invoke `cancelDeployment` (say, on a validation failure), it would use `const { cancelDeployment } = this.channelExports` to get the call surface, not `this.exports.cancelDeployment`. The Channel is the only layer where define-site and call-site differ. The Writing Channels chapter covers why; for now just be aware the asymmetry exists.

### The View

The View runs in the browser. Here's a version that exercises both Node-bubbled exports and Channel-defined exports:

```javascript
class MonitorView extends Operations {
    status(data) {
        // data arrives automatically: initial state on connect, updates as they happen
        const tbody = UI.getElement('status-table-body');
        UI.setHTML(tbody, '');
        for (const [nodeId, status] of Object.entries(data)) {
            const row = UI.createElement(`
                <tr>
                    <td>${nodeId}</td>
                    <td>${status.up ? 'UP' : 'DOWN'}</td>
                    <td>${status.latency}ms</td>
                    <td>
                        <button class="btn btn-secondary" data-click="refresh" data-node="${nodeId}">
                            Refresh
                        </button>
                        <button class="btn btn-danger" data-click="reboot" data-node="${nodeId}">
                            Reboot
                        </button>
                    </td>
                </tr>
            `);
            UI.append(row, tbody);
        }
    }

    progress(data) {
        // batch deployment progress for any active firmware deployments
        this.renderDeploymentProgress(data);
    }

    import(exports) {
        const { refreshNow, sendReboot, deployFirmware, cancelDeployment } = exports;
        this.exports = {
            // Single-statement arrow, no DOM `this` needed:
            refresh: ({ node }) => refreshNow({ node }),

            // Block-body arrow — multi-statement, View `this` for the confirm dialog:
            reboot: async ({ node }) => {
                if (await this.confirm('Reboot device', `Reboot ${node}?`)) {
                    await sendReboot({ node });
                }
            },

            deploy: async ({ targets, package: packageName }) => {
                const targetList = targets.split(',');
                if (await this.confirm('Deploy firmware',
                    `Deploy ${packageName} to ${targetList.length} devices?`)) {
                    const { batchId } = await deployFirmware({ targets: targetList, packageName });
                    this.activeBatchId = batchId;
                }
            },

            // Single-statement arrow, View `this` for instance state:
            cancel: () => cancelDeployment({ batchId: this.activeBatchId })
        };
        this.Ready = true;
    }
}
```

Three methods plus the lifecycle hook, doing distinct things.

`status(data)` and `progress(data)` are subscriptions to typed data streams from the Channel. The Client invokes them whenever the Channel publishes data of the matching type — including the initial cached state on connect. `import(exports)` is the subscription to the Channel's complete RPC namespace, delivered once per successful handshake. The Writing Views chapter covers the subscription protocol and the rest of the View-reserved methods (`online`, `offline`, `latency`, `nodes`) in detail.

The shape of what `import` does is what matters in this example: destructure the RPC methods you need, then build `this.exports` with handlers. Some are thin pass-throughs (`refresh: ({ node }) => refreshNow({ node })`); others run user-interaction logic before invoking the RPC (`reboot` and `deploy`, both with confirmation dialogs). View-side wrappers are appropriate because they're doing something the RPC method itself shouldn't — asking the user for confirmation, parsing form input, displaying progress. This is *not* the kind of wrapper we warned against in the Channel section; Channel-side wrappers around Node exports are inappropriate because they're not doing anything, they're just re-exposing what the framework has already exposed.

From the View's perspective, there's no distinction between Channel-defined exports and Node-bubbled exports — `refreshNow` and `sendReboot` (from the Node) sit alongside `deployFirmware` and `cancelDeployment` (from the Channel) in one flat namespace.

Look at the buttons: `data-click="refresh" data-node="router-1"`. The clicked button's `data-click` value names a handler in `this.exports`; the rest of its `data-*` attributes are passed as the call's argument. Writing Views covers the mechanism in detail.

### Putting it together

The page that hosts this View has a specific structure that matters for how the application boots. External library and class definitions go in the `<head>`; the inline script that constructs the View and connects to the Channel goes at the end of `<body>`:

```html
<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <title>Device Monitor</title>
    <script src="scripts/ui.js"></script>
    <script src="scripts/operations.js"></script>
    <script src="scripts/monitor.js"></script>
</head>
<body>
    <header>
        <h1>Device Monitor</h1>
    </header>
    <main>
        <table>
            <thead>
                <tr><th>Device</th><th>Status</th><th>Latency</th><th>Actions</th></tr>
            </thead>
            <tbody id="status-table-body"></tbody>
        </table>
    </main>
    <script>
        const monitorView = new MonitorView();
        new Client(`wss://${location.hostname}/channels/monitor`, [monitorView]);
    </script>
</body>
</html>
```

The placement is deliberate, and uses a guarantee built into every browser: scripts are parsed and executed in document order, and a script doesn't run until everything before it has finished loading. By placing the external `<script src="...">` tags in the `<head>`, the browser starts fetching them as early as possible — they load in parallel with the HTML body parsing, and by the time the body finishes, all the class definitions are available. By placing the inline boot script at the end of `<body>`, you guarantee two things at once: every class it references is already loaded, and every DOM element it might query is already parsed.

This is why the boot script doesn't need any of the timing-management code typical of other web applications. There's no `window.addEventListener('load', ...)`, no `DOMContentLoaded` handler, no `setTimeout` to defer initialization. The browser's parsing order does the synchronization for you. When the inline script runs, the page is ready; when it constructs `new MonitorView()`, every class it depends on is defined; when it constructs `new Client(...)`, every DOM element the View will manipulate exists.

If you put the inline boot script at the top of the page instead — in the `<head>`, or at the start of `<body>` — you'd have to add explicit timing logic to wait for the DOM to be parsed before the View tries to query elements like `#status-table-body`. If you put the external script tags at the bottom of `<body>`, you'd lose the parallel-loading benefit and the page would feel slower. The standard placement (external scripts in `<head>`, boot script at end of `<body>`) gets both timing correctness and load efficiency for free.

`Client` is the SC3 browser-side WebSocket connector. It opens a connection to the Channel, performs the handshake, calls `monitorView.import(exports)` with the RPC methods it received, and starts routing data streams to View methods by name. From that point, everything happens through the data flow we set up.

That's a complete SC3 application. A handful of files, on the order of two hundred lines, and it gives you: real-time device monitoring, automatic state replay for late-joining clients, RPC commands from browser to specific devices, parallel firmware deployment with progress reporting, batch cancellation, automatic Node respawning if a poll fails, and centralized event handling on the page. You wrote no event listeners. You wrote no fetch logic on the browser side. You wrote no caching. You wrote no DOM-ready handler. You declared subscriptions to data streams by defining methods on the View, not by calling explicit registration functions. You wrote two kinds of exports — the Node kind, where the work happens next to the device, and the Channel kind, where the work spans devices that don't yet exist.

The rest of this guide goes deeper into each piece, but this is the shape. Everything else is elaboration.

---

## Writing Nodes

A Node is the smallest unit of SC3 application code that runs as its own process. It represents one external entity — a device, a service, a database connection, a file watcher, a remote SC3 application. It has a clear lifecycle, a tight set of responsibilities, and a few rules that, if violated, cause it to fail in ways that are surprisingly hard to diagnose.

### Where Nodes live

Node files live in a project's `drivers/` directory, one file per driver/domain. The filename matches the driver name: `<project>/drivers/devicestatus.js` corresponds to a driver named `devicestatus`. When a Channel constructor calls `this.loadDriver('devicestatus')`, the framework spawns this exact file as a subprocess.

The file's structure follows a strict shape:

```javascript
import { Node } from 'securechannel';
// other imports...

const DEVICES = { /* ... */ };

class MyNode extends Node {
    // class body
}

new MyNode(DEVICES);
```

That's it. Imports at the top, a `DEVICES` constant defining the static device list, a class definition extending `Node`, and a single instantiation at the bottom. Nothing else at module scope — no logging, no top-level `await`, no side effects in imports. You'll learn why the moment you violate this rule and watch your driver silently turn into a placeholder.

The `DEVICES` object's keys are device identifiers; the values are per-device configuration. A static driver, like the one above, defines this list at the top of the file. A *sparse* driver, which we'll cover later, leaves the list empty and creates devices dynamically at runtime.

### The constructor's four jobs

The Node constructor does four things, and four only:

1. Calls `super(...)` with the devices object and any other framework arguments.
2. Stores constructor-time configuration as instance fields.
3. Registers event handlers via `this.on(...)`.
4. Schedules real initialization with `this.connect(callback)`.

Anything else — including diagnostic logging, configuration validation, prerequisite fetches — happens in the connect callback, not the constructor. The reason is the framework's startup contract: the moment the subprocess starts running, the framework reads stdout. Anything you write to stdout before the framework's own JSON emission (which it does inside `super(...)` and shortly after) corrupts the parse, and the framework treats the corrupted parse as "this driver has no devices" and substitutes a placeholder. The Channel reports the driver loaded; nothing actually runs.

This is the single most common "Node won't start" cause new developers hit. The fix is to keep the constructor mute. Here's a properly-structured Node with realistic complexity:

```javascript
import { Node } from 'securechannel';
import { SSHConnection } from '../utils/ssh-client.js';

const DEVICES = { 'host-1': { ip: '10.0.0.5' } };

class HostMonitorNode extends Node {
    async checkLoad() {
        const result = await this.ssh.executeCommand('uptime');
        this.emit('load', { node: this.node, output: result.stdout });
    }

    async initialize() {
        const device = this.getDevice(DEVICES);
        this.ip = device.ip;
        this.ssh = new SSHConnection({ host: this.ip });
        await this.ssh.connect();
        this.interval = 60;
        this.poll = this.checkLoad;
        this.ready();
    }

    constructor(devices) {
        super(devices);
        this.on('disconnect', () => this.ssh?.close());
        this.connect(() => this.initialize());
    }
}

new HostMonitorNode(DEVICES);
```

The constructor is trivial. The `initialize` method does the actual work — read device config, open the SSH connection, set up polling, signal ready. By the time `initialize` runs, the framework has finished its handshake and stdout is yours to use freely.

Notice the `this.on('disconnect', ...)` registration in the constructor. Event handler registration is permitted in the constructor because handlers must be in place before `connect()` fires its callback — otherwise the handler can miss events. This is the one piece of "real work" the constructor is allowed to do.

Notice also `this.ready()`. The framework's polling mechanism calls this for you on the first successful tick, so you usually don't need to call it explicitly inside a `poll`-driven Node. But for one-shot Nodes that don't poll — Nodes that do their work once and stay alive to handle commands — you call `ready()` yourself when initialization completes. This signals to the Worker that the Node is up and ready to handle requests. The placement matters: `ready()` must be called inside the connect callback (or a method it invokes), never in the constructor or before `connect()` fires. Calling it too early breaks the framework's startup sequence in ways that aren't recoverable. The full discussion of placement is in the lifecycle recap at the end of this chapter.

### Polling: use what the framework gives you

When you set `this.interval` to a number of seconds and `this.poll` to a function, the framework takes over a job that's surprisingly tricky to get right: invoke the function repeatedly, but only after the previous invocation completes; signal "ready" after the first successful run; propagate errors through the framework's standard error path; clean up correctly on shutdown. You don't think about any of that. You just declare the cadence and the function.

What you absolutely do not do is reach for `setInterval`. Every time you do, you are reproducing the framework's mechanism, badly. The framework's version handles re-entrancy (overlapping ticks if a previous one is still running), error propagation (an exception in your `refresh` becomes a framework error, not a UnhandledPromiseRejection in your subprocess), readiness coordination (the Worker doesn't think the Node is up until the first tick succeeds), and shutdown (cancelling the next scheduled tick when the Node is being torn down). Your `setInterval` does none of those things, and adding them piecemeal recreates the framework code one bug at a time.

The same applies to `setTimeout` patterns that re-schedule themselves. If your `setTimeout` callback ends with another `setTimeout` to do the same thing again, you've written `setInterval` with extra steps. Use `interval` and `poll`.

`setTimeout` is fine for genuine one-shot delays — debounce, cleanup-after-N-seconds, abort-after-deadline. The test is whether the scheduled callback re-schedules itself. If yes, it's a polling loop in disguise; replace it with `interval`/`poll`. If no, it's a true timeout; leave it.

### Event-driven data is not polling

Some data sources push updates rather than waiting to be polled — filesystem watchers, message queues, native event sources. For these, you use the appropriate event mechanism (`fs.watch`, socket listeners, library callbacks) and emit data as it arrives. This isn't polling; it's event-driven.

A Node can use both at the same time. The repository monitor in our codebase uses `fs.watch` to react to filesystem changes immediately and `interval`/`poll` to do periodic comprehensive scans. They're complementary, not alternatives. The polling rule is "don't manually poll"; it's not "don't react to events."

### Emitting data upward

Inside any Node method (other than the constructor), you can emit typed data with `this.emit(type, payload)`. The type is a string; the payload is whatever data you want to send. The framework routes the emission through the Worker, into the Driver's pipeline, and out to the Channel — where the data type determines what happens next.

Whether the data gets cached, deduped, published to clients, or just discarded depends entirely on what the *Channel* has configured for that type. From the Node's perspective, you emit and the framework handles it. You don't know or care whether the Channel has subscribed clients, whether the data made it through, or whether anyone's listening. This is by design — Nodes are isolated, and their job is to produce data, not to manage its delivery.

If you emit a type that no Channel-side processor handles, the data is silently dropped. This is fine; it's the framework's "no subscribers, no work" behavior. But if you intended the data to be visible to clients and it isn't, the bug is on the Channel side — the Channel hasn't declared a processor for that type — not on the Node side.

### Exposing RPC methods from a Node

Data flowing upward via `this.emit(...)` is one half of the Node's communication with the rest of the system. The other half is RPC: methods callable *from* the rest of the system, executing on the Node, with results returned to the caller. These live in `this.exports`:

```javascript
class HostMonitorNode extends Node {
    exports = {
        runDiagnostics: async () => {
            const result = await this.ssh.executeCommand('diagnostic-suite');
            return { output: result.stdout, exitCode: result.code };
        },

        rebootHost: async ({ delay = 0 } = {}) => {
            const command = delay > 0 ? `shutdown -r +${delay}` : 'reboot';
            await this.ssh.executeCommand(command);
            return { acknowledged: true, scheduled: delay };
        },

        forcePoll: async () => {
            await this.checkLoad();
            return { ok: true };
        }
    };

    async checkLoad() {
        const result = await this.ssh.executeCommand('uptime');
        this.emit('load', { node: this.node, output: result.stdout });
    }

    // ... constructor and initialize as before ...
}
```

These exports are reachable from the browser as soon as the Channel loads this driver. **No Channel-side code is required to expose them.** The framework propagates Node exports upward through the Driver and Worker layers and merges them into the Channel's exposed namespace automatically. A browser calling `runDiagnostics({ node: 'host-3' })` will reach this Node's `runDiagnostics` export, with the `node` argument used by the framework to route the call to the right subprocess.

This is where most exports in an SC3 application live. The Node has the open SSH session, the cached configuration, the connection state, the device's specific knowledge. Putting the export at the Node puts the logic next to the data and the connection it operates on. A Channel-side wrapper that just calls a Node's export with the same arguments is nearly always wrong — the framework has already exposed the export, and the wrapper accomplishes nothing.

The signature conventions are the same as for any RPC method: a single object argument, async or Promise-returning, errors propagated through Promise rejection.

A few Node-specific things to note about exports:

**The export body has access to everything the Node has.** `this` inside an export is the Node instance. Connection objects, cached configuration, helpers from the rest of the class — all available. This is the framework's `.call(node, ...)` binding doing its job; it's the same `this` you'd see inside a regular method.

**Exports run in the Node's subprocess.** When a browser calls `runDiagnostics`, the call travels through the Channel to the Worker to the Node's subprocess, where the export executes. This means the export has access to the Node's local state (the SSH session, the polling state, the device's configuration) but cannot reach into the Channel or Controller directly. Cross-Node coordination, where it's needed, goes through the Channel — but more often you want to design the Node so that coordination isn't needed in the first place.

**You don't have to worry about routing.** The framework uses the `node` argument in the RPC call to route the request to the correct Worker, and from there the correct Node subprocess. Your export body just runs against the Node it's a member of. From inside the export, `this.node` is the node id of the current subprocess, and you can act accordingly.

### Two flavors of Node: `Node` and `Passthrough`

`Node` and `Passthrough` are sibling base classes. Both are driver implementations — both run as their own subprocess, both manage a single connection to a "device," both participate in the framework's data flow the same way. What differs is *what they connect to*.

A `Node` connects to whatever the application defines as the data source. The application subclasses `Node` and writes the device-management logic itself: opening an SSH session to a switch, querying a SQL database, polling a REST endpoint, watching a filesystem, talking to a hardware device over a serial port, anything where the application owns the protocol and the data acquisition. The Node we wrote earlier in this chapter is the canonical shape — `extends Node`, custom `refresh` method that calls `fetchJSON`, `this.emit('status', ...)` to push data upward.

A `Passthrough` connects to another SC3 application running somewhere else. The "device" in question isn't a database or a switch or a sensor — it's another full SC3 instance, typically a micro-service running independently on its own host or container. From the parent application's perspective, the Passthrough behaves like any other Node: it has node ids, it emits typed data, it exposes RPC methods that bubble upward into the parent Channel's namespace. From the implementation perspective, the Passthrough delegates the actual data acquisition and command execution to the downstream SC3 application, forwarding traffic in both directions over a WebSocket connection.

This is the canonical mechanism for **distributed micro-service workflows in SC3**. You decompose your system into multiple SC3 applications — each running independently, each managing its own concerns, each potentially deployed and scaled separately — and connect them through Passthroughs. A central monitoring application might Passthrough to one SC3 instance per data center, with each data center's instance directly managing its local devices through plain `Node` subclasses. The hierarchy can extend further: regional SC3 apps that Passthrough to data-center apps that have local Nodes. RPC calls and data streams flow through the chain seamlessly, with the framework handling the routing.

Both flavors live in `<project>/drivers/<domain>.js` files with the same overall shape (imports, `DEVICES` constant, class definition, instantiation at the bottom). Both follow the same constructor minimalism rule. Both emit data upward and accept RPC calls. Both are subprocesses managed by the framework's Worker layer. The choice between them is *what kind of remote endpoint* the driver represents.

A typical project has a mix. Application code subclasses `Node` for direct device management, and subclasses `Passthrough` (or uses it directly) when bridging to another SC3 application. The two coexist freely in the same Channel — each `loadDriver(...)` call loads whichever flavor the corresponding driver file uses, and the Channel doesn't need to know or care which is which.

#### A Node subclass

The Node we wrote earlier is the typical shape for a `Node` subclass. It has its own `refresh` method, polling configuration, error handling — all custom logic for whatever protocol the device speaks. The application owns everything about the connection.

#### A Passthrough subclass

A `Passthrough` subclass is much smaller because the framework owns the protocol — it's always WebSocket-based SC3-to-SC3 communication. The application's job is just to specify which remote application to connect to:

```javascript
import { Passthrough } from 'securechannel';

const DEVICES = { 'remote-monitor': {} };
const CONNECTION = () => ({ port: 443, path: '/channels/monitor/socket' });

class RemoteMonitor extends Passthrough {
    constructor(connection, devices) {
        super(devices);
        const { node, channel } = this;
        connection.address = node;
        const sources = () => channel.connect(connection);
        this.on('connect', () => this.debug('connecting', { node }));
        this.connect(sources);
    }
}

new RemoteMonitor(CONNECTION(), DEVICES);
```

The body sets up address, port, and path for the remote SC3 application's WebSocket endpoint, then `channel.connect(connection)` does the rest — handshake, multiplex, RPC routing, data forwarding. There's no custom polling logic, no custom protocol handling, no custom data acquisition; the framework provides all of it because both ends of the connection are SC3 instances and SC3 knows its own protocol.

#### Choosing between them

Use `Node` when:
- The data source is something your application code knows how to talk to directly (database, hardware, third-party API, filesystem).
- You're writing the protocol-handling logic — SQL queries, SSH commands, HTTP requests, parsing, etc.
- The application is the data acquisition layer.

Use `Passthrough` when:
- The data source is another SC3 application.
- You're bridging across micro-service boundaries, deployment boundaries, or network boundaries between SC3 instances.
- The downstream SC3 application is the data acquisition layer, and your application just needs to consume what it provides.

#### Passthrough chains: distributed micro-service composition

When you have multiple SC3 applications composed into a hierarchy via Passthrough, you've built what amounts to a distributed micro-service system speaking SC3's protocol. A typical deployment looks something like this:

- A **leaf application** runs close to the data — at an edge site, on a per-host basis, in a single data center. Its drivers are mostly `Node` subclasses talking directly to local devices, databases, or services.
- An **aggregating application** runs upstream of one or more leaf applications. Its drivers are mostly `Passthrough` subclasses, each one connecting to one leaf instance.
- A **client-facing application** sits at the top, exposing the unified namespace to browsers and clients.

Each level is a separately-deployable, separately-scalable SC3 application. Each speaks SC3-over-WebSocket to the level above and below. Browsers connect to the top level and see a single namespace; the framework routes RPC calls and data flows through the chain transparently.

This composition gives you several practical benefits. **Failure isolation:** a leaf application crashing doesn't bring down its siblings or the aggregator. **Independent deployment:** you can update a leaf without touching the aggregator. **Geographic distribution:** leaf applications can run physically near the devices they manage, with the aggregator and client-facing layer running centrally. **Security boundaries:** each layer can enforce its own access controls, with the aggregator only seeing what the leaf chooses to expose.

##### RPC routing through cascades

When a client at the top of the hierarchy calls an RPC method on a node that lives several layers down, the framework routes the call automatically using the array form of the `node` argument. The first element identifies the local Passthrough (which sends the rest of the array onward); each layer strips its own element off the head and forwards what remains. A two-level cascade looks like `node: ['edge-cluster-east', 'host-7']`; a three-level cascade looks like `node: ['datacenter-2', 'rack-7', 'host-3']`.

From the leaf node's perspective, the call arrived with a string `node` argument identifying *itself* — there's no indication of how many layers it passed through. From the originating client's perspective, the call returned through the same chain with the framework's standard Promise-based result. The chain is transparent in both directions.

##### Data flow through cascades

Typed data emissions and CachedData publication work the same way through Passthroughs. A leaf Node emits `'status'`, the leaf Channel publishes it via CachedData, the aggregator's Passthrough receives it and re-publishes upward, the client-facing application's Passthrough does the same, and the browser View's `status(data)` method receives it. Each layer's Channel can configure its own caching and publication semantics — the leaf might cache while the aggregator notify-and-pulls, or vice versa, depending on data shape and traffic patterns. The cache at each level is the local Controller's cache for that SC3 instance; there's no shared cache across the chain.

##### When not to use Passthrough

The Passthrough pattern shines when you have genuinely distributable concerns — separate operational domains that benefit from independent deployment, geographic distribution, or failure isolation. It's worth the architectural complexity those bring. It's the wrong tool when:

- The "downstream" component isn't actually an SC3 application. If you're connecting to a non-SC3 service (a database, a third-party API, a hardware device), use a `Node` subclass with the appropriate protocol library.
- The decomposition is purely organizational. Splitting one logical application into two SC3 instances "for cleanliness" mostly adds operational complexity without benefit. The composition pattern earns its keep when each level genuinely needs to be a separate runtime.
- You're using Passthrough to work around a perceived problem in the framework. The framework handles single-application multi-driver, multi-channel architectures cleanly; reaching for Passthrough as a workaround usually means the actual issue is somewhere else.

### A Node's full lifecycle

To recap the lifecycle from the Node's perspective:

1. The Channel constructor calls `this.loadDriver('mydomain')`. The framework spawns `<project>/drivers/mydomain.js` as a subprocess. The subprocess reads the file, runs through the imports and class definition, and reaches `new MyNode(DEVICES)`. The Node constructor runs.
2. Inside `super(devices)`, the framework registers the device list with the parent Worker via stdout. Stdout pollution at this point is fatal.
3. The constructor schedules `connect(callback)` and returns. The framework completes the handshake.
4. The framework invokes the `connect` callback. From here on, you can log freely, do async work, and use any framework APIs. This is where you open the underlying connection to whatever the Node manages — SSH session, database client, HTTP client, hardware handle, whatever the device speaks.
5. **The Node signals readiness.** This is where two cases diverge:
    - **Polling Nodes.** If you've set `this.interval` and `this.poll`, the framework calls `this.ready()` for you automatically after the first successful poll tick completes. You don't call it yourself. The first successful tick *is* the readiness signal — if the polling logic can talk to the device, the Node is up.
    - **Non-polling Nodes.** If the Node doesn't poll — it's command-driven, event-driven, or otherwise just sits and waits for work — **you must call `this.ready()` explicitly** once your connection is established and your initialization is complete. The framework has no way to determine when your custom initialization is done; only your code knows. Calling `ready()` is what tells the Worker "this Node is up and willing to accept RPC calls." The call must happen *inside the connect callback* (or inside a method the connect callback invokes) — never in the constructor, never before `connect()` fires. Calling `ready()` before the framework's handshake completes is fatal; the Worker will register the Node as ready while its transport is still being set up, and the resulting state corruption is not recoverable.
6. The Worker registers the Node as ready. RPC calls and event handlers can now run. Without this signal, RPC calls targeting this Node will be rejected as "worker not ready," even if the Node is otherwise running fine.
7. The Node runs until something tears it down — a graceful `this.end(code)`, a process exit, an aborted batch (in sparse drivers), or a Worker-detected failure.

The Worker handles step 7 from the framework side: detecting that the Node is no longer alive, optionally restarting it, cleaning up its registry. None of that is your responsibility; you just write the lifecycle from the Node's perspective.

#### Where (and where not) to call `ready()`

The rule is straightforward and absolute: **`ready()` must be called inside the connect callback or one of its called methods, only on the success path, and only when the Node is actually ready to handle work.** Calling it anywhere else is a bug — and depending on which "anywhere else," the bug is either silent or fatal.

The most common readiness mistake in non-polling Nodes is forgetting to call `this.ready()` at all. The Node's constructor runs, the connect callback runs, the connection opens successfully — and then the Node sits there, fully initialized, but the Worker still thinks it's coming up. RPC calls targeting the Node fail with "worker not ready" errors. The View shows nothing happening when buttons are clicked. There's no error in the Node's own logs because nothing went wrong from the Node's perspective. The Worker still considers the Node mid-startup because no one signaled otherwise.

The fix is always to call `this.ready()` at the end of the connect callback's success path, after every prerequisite is genuinely in place:

```javascript
async initialize() {
    const device = this.getDevice(DEVICES);
    this.address = device.address;
    this.client = new SomeClient({ host: this.address });
    await this.client.connect();
    // ... any other setup that must complete before RPC can be served ...
    this.ready();           // tells the Worker we're up
}
```

If your initialization can fail in ways that should keep the Node "not ready" (the connection couldn't be established, a critical prerequisite is missing), don't call `ready()` on those paths. The framework treats absence of `ready()` as "still coming up," which is the right state during a failed startup. The Worker's retry/respawn logic will handle the rest if the Node exits, or the Node can stay in this not-ready state until conditions change.

The opposite mistake — calling `ready()` *too early* — is more dangerous than forgetting it. **Never call `ready()` in the constructor.** Never call it before the connect callback has fired. The framework's startup sequence assumes "ready" follows "connected"; asserting readiness before the framework has finished its handshake means the Worker registers the Node as ready while its transport layer is still being set up. RPC calls and event traffic start being routed to a Node whose connection isn't actually established yet. The resulting state is not recoverable from within the Node — by the time symptoms appear, the framework's view of the Node and the Node's actual condition have diverged. The only safe placement for `ready()` is inside the connect callback (or inside a method the connect callback invokes), after the connection itself is confirmed open.

If you mix patterns — a Node that does some initial setup before starting a polling loop — you typically don't need to call `ready()` yourself, because the framework will call it after the first successful poll. But if there's meaningful setup *before* polling starts and you want the Node to be considered ready before the first tick completes, calling `ready()` explicitly at the end of your setup is fine; the framework's call later is idempotent. The same placement rule still applies: only inside the connect callback or its callees, never in the constructor.

#### `this.error()`: the fatal-state signal

`ready()` has a counterpart that tells the framework the Node has reached an unrecoverable state: **`this.error(message)`**. The name is misleading and worth being absolutely clear about — `this.error()` is *not* a logging function. It's a framework-state signal that **crashes the Node**.

When you call `this.error(message)`:

1. The framework logs the message (so you also get logging behavior, which is part of the confusion).
2. The framework immediately calls `this.end(code)` on your behalf to tear the Node down.
3. The Worker observes the exit and, depending on whether the Node is persistent or ephemeral, either respawns it or removes it from the registry.

The Node does not continue executing after `this.error()` returns control. There's no "log this error and keep running" semantic here. Treat the call as terminal — anything written after it on the same code path will not run reliably, and design your code on the assumption that the Node is gone the moment the call is made.

##### When to call it

Use `this.error(message)` when the Node has reached a state where continuing to run would be wrong: a connection that can't be re-established, a fatal protocol mismatch with the device, an irrecoverable inconsistency in state, a configuration problem the Node can't work around. The right framing is: "this Node cannot do its job, and the only correct response is to tear it down so the Worker can decide whether to respawn or give up."

A common case during initialization:

```javascript
async initialize() {
    const device = this.getDevice(DEVICES);
    this.address = device.address;
    try {
        this.client = new SomeClient({ host: this.address });
        await this.client.connect();
    } catch (e) {
        this.error(`could not connect to ${this.address}: ${e.message}`);
        return;   // unreachable, but a defensive habit
    }
    this.ready();
}
```

If the connection fails irrecoverably, the Node calls `this.error()` and is gone. The Worker handles the rest: log visibility, restart attempts, sparse-driver cleanup, etc.

A common case during runtime:

```javascript
this.on('disconnect', () => {
    this.error('connection dropped, exiting for restart');
});
```

When the device connection drops mid-flight and the Node has no recovery path, `this.error()` is the right call. The Worker will respawn the Node (if persistent), which gets a fresh chance at connecting.

##### When *not* to call it

The misconception worth correcting head-on: **`this.error()` is not for logging recoverable errors.** If a problem happens that the Node can recover from — a transient network blip, a single failed RPC the caller can retry, a temporary inconsistency that resolves on the next poll — calling `this.error()` is wrong because it crashes the Node over a problem that didn't actually require the Node to be torn down.

For recoverable errors and ordinary diagnostic logging, use `this.debug(message)` (or whatever logging facility your application has standardized on). `this.debug()` writes to logs without altering the Node's lifecycle. That's what most code that "logs an error" actually wants.

The mental rule:

- **`this.debug(message)`** — record information; keep running.
- **`this.error(message)`** — record information; immediately crash the Node.

These look like cousins from their names, but they have opposite consequences. `this.debug` is a notification; `this.error` is a state transition. Use the one that matches what you actually intend the Node to do next.

##### Symmetry with `ready()`

Together, `ready()` and `error()` are the two terminal signals a Node sends about its own startup and runtime state:

| Signal | Meaning | Effect |
|---|---|---|
| `this.ready()` | "I'm up and willing to accept work." | Worker registers the Node as ready; RPC calls start being routed. |
| `this.error(message)` | "I'm fatally compromised; tear me down." | Worker logs and triggers `this.end()`; Node exits, possibly respawns. |

Both belong in the connect callback (or its callees) for startup signaling, and both can be called later during runtime when the Node's state genuinely changes. Neither belongs in the constructor — `ready()` because the connection isn't established yet, `error()` because the Worker isn't yet ready to receive the signal cleanly. As with `ready()`, the placement rule is: inside `connect()`'s scope, when the Node has actually reached the state being signaled.

---

## Writing Channels

The Channel is where the application's data flow is declared. It loads drivers, configures pipelines, serves WebSocket connections, and provides the platform on which Node-defined RPC exports become reachable from the browser. It's also the layer where SC3's most distinctive idioms appear — and where the most common call-pattern mistakes happen.

A Channel does *less* than its central position suggests. Most Channels are mostly the constructor's pipeline declarations. The RPC methods that browsers can invoke usually live in Nodes and bubble up automatically. The data that flows to clients is usually configured through CachedData and routed by the framework. The Channel is the assembly point for these mechanisms more than it is a place where you write a lot of code.

That said, *some* logic does belong at the Channel layer — operations that span multiple drivers, orchestration that creates work for sparse drivers, coordination that doesn't have a natural home in any single Node. We'll cover those cases too. But hold onto the picture: a typical Channel is much smaller than its responsibilities make it sound.

### The Channel constructor: a declarative manifesto

A Channel constructor declares what data the channel handles and how. The body is largely a sequence of `loadDriver(...).process(...).process(...)` chains, one per driver:

```javascript
constructor(id, controller, options) {
    const { connection } = Channel.getConnection(id, options);
    super(id, connection).join(controller);

    this.loadDriver('devicestatus')
        .process(new CachedData('status', {
            publishDataStream: true, nodeInData: false
        }));

    this.loadDriver('alerting')
        .process(new CachedData('alert', {
            publishDataStream: true, overwrite: true, nodeInData: true
        }))
        .process(new CachedData('history', {
            publishDataStream: true, nodeInData: true
        }));

    this.loadDriver('inventory')
        .process(new CachedData('devices', { publishDataStream: true }));
}
```

Each `loadDriver(name)` call asks the framework to spawn the driver corresponding to `<project>/drivers/<name>.js`. The framework instantiates the Driver, spawns one Worker per device in the file's `DEVICES` constant, and connects the resulting pipeline to this Channel. The fluent chain — `.process(...)`, `.subscribe(...)`, `.publish(...)` — declares which data types the driver handles and how each one should be processed.

Look at this constructor and notice what's *not* there. There's no manual subscription wiring. There's no manual cache management. There's no manual broadcast logic. There's no event registration or listener setup. The constructor is a declaration of intent: "this channel handles these data types from these drivers, with these caching and publication semantics." The framework wires it all up.

This is what people mean when they call SC3 declarative. You're not writing the data flow; you're describing it. The framework executes the description.

### Understanding CachedData

The most common entry in a `.process(...)` chain is `new CachedData(type, options)`. This is the workhorse that handles a wide range of data-flow patterns — but how it behaves depends substantially on which flags you set, and the flags reflect a real design choice the developer needs to make.

A few things about CachedData are worth understanding clearly.

**It's a configuration object factory, not an instance you keep.** `new CachedData(...)` looks like a constructor call but actually returns a configuration object — `{source, sink}` — that gets consumed by `.process(...)`. There's no CachedData *instance* with methods you can call later. Holding onto the result, calling methods on it, or trying to update it after registration are all category errors:

```javascript
// All of these are wrong — there's nothing to retain or update:
const cached = new CachedData('status', { publishDataStream: true });
cached.start();                  // there is no start method
cached.update(payload);          // there is no update method
this.cachedStatus = cached;      // nothing useful here to keep

// The only legitimate destination for the result:
this.loadDriver('mydomain').process(new CachedData('status', { publishDataStream: true }));
```

After `.process(...)` consumes the configuration, the entire purpose of `new CachedData(...)` is fulfilled.

#### Three delivery patterns

CachedData supports three distinct data-flow patterns, and the most important design decision is choosing which one fits the data you're moving. All three are framework-supported, all three are event-driven from the application's perspective. The differences are about *where the data lives*, *whether it has cacheable identity*, and *how clients see it*.

**Cached push.** The framework caches each update in the Controller's cache, and the cached state is what flows to subscribed clients — both as live updates when changes happen and as replays when clients reconnect after a backoff gap. The View receives the data through its `<typename>(data)` method. This is the natural choice when the data has a meaningful "current value" — device status, configuration state, batch progress, inventory snapshots — where someone joining the conversation midway should see the current state, not start from blank. The server caches the full payload; the wire carries the full payload; the View renders the full payload; replay is free.

**Volatile push.** The framework forwards each update directly to subscribed clients without caching anything. Live updates flow; reconnecting clients don't get replay (because there's no cache to replay from), but that's fine because the data is too transient to make stale samples useful. Telemetry, real-time price ticks, sensor readings, audio or video samples. The data isn't a "state" with a meaningful current value — it's a stream of moments, and only the live moments are useful.

**Notify-and-pull.** A change-notification message travels to subscribed clients ("the `inventory` data has changed for node `host-7`"), but the actual data lives somewhere the framework's cache doesn't: a relational database, a large blob store, a paginated feed. The View receives the notification and decides whether and when to fetch — usually by invoking an RPC method that runs a query. This is the natural choice when the data is too large to push wholesale (a million-row table, gigabytes of historical logs, content the user only needs when they navigate to a specific view). The application carries the size cost only on demand.

All three patterns are configured through CachedData's flags. The difference between them is which flags you set.

#### Choosing the delivery pattern

The relevant flags map to delivery patterns as follows.

**For push, choose between `publishPayload` and `publishDataStream`.** These two are *mutually exclusive* — set one or the other, not both. They model fundamentally different kinds of data, and the choice between them is about whether the data has a meaningful "current value" worth caching, or whether it's so volatile that caching is pointless.

- `publishDataStream: true` — the framework caches each update as it arrives, and the cached state is what gets pushed to clients. Newly-connected clients receive the current cached state on connect; ongoing changes flow as fresh updates. Use this when the data has an identity beyond each individual update — a "current value" that's meaningful to know between changes. Device status, configuration state, inventory snapshots, batch progress, anything where "what does it look like right now?" is a meaningful question. The cache is what makes replay possible.

- `publishPayload: true` — the framework forwards each update directly to subscribed clients without caching. There's no cached state, and consequently no replay on reconnect. Use this when the data is so volatile that caching would be pointless — the cached value would be stale by the time anyone read it, and replay would just deliver an obsolete sample that's no more useful than waiting for the next live update. Streaming telemetry samples, real-time price ticks, sensor readings firing dozens of times per second, audio or video frame data — anything where the live flow *is* the data and the past is by definition uninteresting.

The mutex isn't a framework limitation; it reflects the two genuinely different data lifetimes. You can't meaningfully cache something that's stale within milliseconds, and you can't meaningfully replay something whose current value is an entirely different sample from the one a client missed during disconnect. CachedData expresses this by making the two flags conceptually exclusive: you're either declaring "this data has cacheable identity" (`publishDataStream`) or declaring "this data is purely a live stream" (`publishPayload`).

If someone does set both flags — through legacy configuration, copy-paste error, or genuine confusion — the framework guarantees that **`publishPayload` wins**. The data flows as a volatile stream with no caching and no replay; `publishDataStream`'s cache-and-emit machinery is suppressed. This is a deterministic safety net rather than a license to set both: there's no design case in which "I want both" makes sense, because the two flags answer the same question with opposite answers. But knowing the precedence rule is useful when reading older code that may have set both flags and behaves as if only `publishPayload` were set (it does, because effectively only `publishPayload` is set), or when making sense of a misconfigured pipeline that's misbehaving in this specific way.

Either way, the View subscribes the same way — by defining a method named after the data type. The difference is purely on the publication side: whether the framework tracks state in the Controller cache, and whether replay is possible on reconnect.

**For notify-and-pull, choose `publishStatus` or define a custom equivalent.** `publishStatus: true` enables a built-in notification message — when a change is detected, the framework sends a `'status'`-typed message to subscribed clients indicating *that* the named type has changed for a specific node. It does not send the data itself. The View receives the notification (typically through a `status(data)` method), looks at what changed, and decides whether to call an RPC to fetch the current details.

This pattern is what you reach for when:

- The data is large enough that pushing it on every change would be wasteful.
- The data lives in a database the framework doesn't cache.
- Different Views need different subsets of the data and bulk push would deliver more than each View needs.
- The View renders a navigable detail view and only one record is on screen at a time.

Application code can also define its own notification mechanism — a custom typed message that signals "this kind of data is dirty" — when `publishStatus`'s shape doesn't fit. Either way, the View handles the notification and triggers the actual data fetch via RPC.

**For both patterns, `dedup: true` is usually right.** When set, the framework only fires the publication (push or notify) if the new data actually differs from what's cached. This prevents redundant work on both ends — clients don't receive identical-to-current updates, the View's render method doesn't re-execute on no-op changes. The only time to leave `dedup` off is when each "update" represents a discrete event the application wants to react to even if the value is the same as last time (a heartbeat, a counter tick, an event with semantic meaning beyond its value).

#### Other flags worth knowing about

A few additional flags shape data shape and storage semantics:

- `nodeInData: true` — the data emitted by the Node carries node identification *inside the payload* rather than as a separate routing argument. Use this when a Node naturally knows multiple nodes' worth of data in a single emission (a Node that polls a controller and returns state for several downstream devices at once). Without this flag, each emission is associated with the emitting Node's id by default.
- `overwrite: true` — when caching, the new value replaces the old wholesale. Without this flag, the framework merges object updates into the cached value, preserving fields that aren't in the new payload. Choose `overwrite: true` when each update is a complete fresh snapshot; leave it off when updates are partial deltas.
- `onData` — an application-side callback that runs after the cache write and publication. The `onData` parameter has its own subsection below; it's the place where server-side preprocessing, cross-channel coordination, or other per-update side effects belong.

#### Choosing among the three patterns

The choice isn't always obvious, and the right answer depends on application specifics. A rough guide:

- **Has a meaningful "current value," fits comfortably in memory, replay is desirable** → cached push with `publishDataStream`. This is the most common case. Device status, configuration state, batch progress, inventory snapshots, anything where you'd answer "yes" to "does it make sense to ask what the current state is?" The cache makes replay free; new clients see current state on connect.
- **Live stream where past samples are uninteresting and updates are too frequent to cache meaningfully** → volatile push with `publishPayload`. Telemetry, sensor readings, real-time price ticks, audio/video frames. Replay would deliver stale junk; the live stream is the data.
- **Bulky data, infrequent updates, selective consumption, or data that lives in a database** → notify-and-pull with `publishStatus` (or a custom equivalent), with an RPC method that fetches actual details on demand. The View receives change notifications and decides whether to fetch.

A useful test for the first two: ask whether you'd want a newly-connected client to see the most recent value. If yes, the data has cacheable identity (`publishDataStream`). If "the most recent value" is meaningless because by the time you read it there's already a newer one and the state is fundamentally a stream of samples rather than a stateful current value, you want `publishPayload`.

A useful test for notify-and-pull: ask whether you'd be willing to push the data to every connected client on every change. If "no, that would be too much data" or "no, most clients won't care about most updates," notify-and-pull is the right pattern.

A common hybrid is the index-and-detail pattern: push a summary or index of items through `publishDataStream` (which Views render in a list), and expose an RPC method that returns details for a specific entry. The View calls the RPC when the user clicks an entry to drill in. This works well when the list is small enough to push but each entry's details are large.

#### Reconnect implications, by flow type

The three CachedData flow patterns — cached push (`publishDataStream`), volatile push (`publishPayload`), and notify-and-pull (`publishStatus` or custom) — each have different reconnect behavior, and the choice has consequences for what your application needs to do on `online`.

**Cached push (`publishDataStream`) gives you free reconnection-resilience.** The framework's automatic replay-on-backoff (covered in the connection-lifecycle methods chapter) re-delivers the cached state to subscribed View methods automatically. The View renders the post-reconnect data by virtue of receiving it again through its `<typename>(data)` method. No application code is needed. This is the easiest case to reason about and the right default choice when the data fits.

**Volatile push (`publishPayload`) doesn't replay on reconnect — and that's correct.** Because there's no cache, there's nothing to replay. The View misses any updates that happened during the disconnect window, and the next update it sees is the next live one to arrive. This is the right behavior for the kind of data this flag is designed for: a missed price tick is just a missed price tick, and the next tick is along in milliseconds. Trying to replay a stale sample would be misleading rather than helpful. Application code typically doesn't need to do anything special on reconnect for `publishPayload` flows; the live stream resumes and that's what matters.

If you find yourself wanting to fill in the gap for a `publishPayload` flow — say, by querying a historical store for what was missed — you've moved into a different design space. That's a notify-and-pull pattern (or a hybrid), and it should be configured as such.

**Notify-and-pull doesn't get free replay either, but for a different reason.** The data isn't in the cache to begin with — only the change-notification trail was. If the View was showing a database-backed detail page when the connection dropped, its data may be stale after reconnect. This is exactly the case mentioned in the connection-lifecycle chapter where applications keep a manual refresh trigger and call it from `online(sessionid)`. Pull-style data flows are often the reason you'd reach for a manual refresh on reconnect rather than relying on framework replay.

You can mix all three patterns in one Channel. A monitoring application might push status snapshots through `publishDataStream` (cached, replayable, the "current state" is meaningful), push real-time signal samples through `publishPayload` (volatile, live, no replay needed), and notify-and-pull for bulky historical logs (database-backed, fetched on demand). Each `.process(...)` call configures one type independently, so a single Channel can host a mix of all three.

#### The configuration is still the entire wiring

Whether you choose push or notify-and-pull, **the configuration of CachedData is the entire wiring on the data-flow side**. You don't write subscription code in the Channel; you don't write replay code; you don't write fetch endpoints to expose cached state. The View subscribes by defining a method matching the data type's name — that's the View's side of the contract — and the rest is configuration.

If you find yourself writing an RPC method called `getCurrentStatus` purely to return cached data on startup, you've reproduced what push-mode CachedData already does. Delete the RPC method. If, on the other hand, you're writing an RPC method that runs a database query to return current details on demand and the View calls it in response to a `status` notification, that RPC method is doing real work and is exactly right.

#### `onData`: hooking application logic into the data flow

CachedData covers caching and publication. Most of the time that's everything you need from the data flow. Sometimes you also want application logic to run when data arrives — preprocessing, side-effect coordination, computed derivations. The hook for that is `onData`.

`onData` is a callback the framework invokes after CachedData's standard cache write and publication, taking no responsibility for either of those. The callback runs in driver context (so `this` is the driver instance), receives the incoming data and node id, and is purely additive — whatever it does is on top of the framework's normal handling.

##### When to reach for `onData`

Two main motivations:

1. **Centralizing preprocessing.** When incoming data needs interpretation, normalization, derivation, or transformation that all connected clients would otherwise do identically — parsing a status code into a human-readable message, computing a derived metric from raw counters, normalizing units, joining against a lookup table — `onData` is the place to do it once on the server. Connected Views then receive already-prepared data and just render. The alternative — letting every browser do the same work on receipt — costs N times the CPU for N clients and risks drift if different Views implement the transformation slightly differently. The trade-off is that the cache holds the processed form rather than the raw form; fine when that's what every consumer wants, less ideal if some Views need access to the raw data.

2. **Side-effect coordination.** When something other than client publication needs to know an update happened — a local batch tracker that aggregates progress across nodes, a sibling Channel that needs to react, a metrics collector, an audit log — `onData` is where that side effect runs. The data still flows to clients normally; the side effect just happens alongside.

Both motivations share the same shape: standard CachedData behavior plus an extra hook.

##### Two ways to supply it

There are two equivalent ways to supply `onData`. Pick the one that reads better in context.

**Constructor option.** Pass a function on the options object:

```javascript
const onData = function (data, node) {
    // 'this' is the driver
    const { batch } = data;
    const { batches } = this.channel;
    batches.get(batch)?.targets.get(node)?.ingest(data);
};

this.loadDriver('deployment').process(new CachedData('batch', {
    publishDataStream: true,
    nodeInData: true,
    onData
}));
```

This works well for short, contextual logic that captures surrounding closures, or for one-off configurations where you don't want to introduce a named subclass.

**Subclass override.** Define `onData` as a method on a subclass:

```javascript
class DeploymentData extends CachedData {
    onData(data, node) {
        const { batch } = data;
        const { batches } = this.channel;
        batches.get(batch)?.targets.get(node)?.ingest(data);
    }
}

this.loadDriver('deployment').process(new DeploymentData('batch', {
    publishDataStream: true,
    nodeInData: true
}));
```

This works well for non-trivial logic that has a clear name, that you want to reuse across multiple `.process(...)` registrations, or that benefits from being a documented type.

The framework checks for a subclass method first and falls back to the option-passed function. Don't supply both for the same data type — pick one form.

##### Function vs arrow inside `onData`

A subtle reminder from the function-vs-arrow rule: the framework calls `onData` with `this` bound to the driver via `.call(driver, data, node)`. The function form (a regular `function` expression, or method shorthand on a subclass) accepts that binding and gives you `this.channel`, `this.cache(...)`, and other driver-context conveniences. An arrow function ignores the binding — `this` will be whatever was lexically in scope at the arrow's definition site, typically the Channel.

Both can be valid:

- Use **function form** (or method shorthand on the subclass) when the body wants driver context — accessing the cache via `this.cache`, reaching the channel via `this.channel`, calling other driver methods.
- Use **arrow form** when the body wants to capture the lexical scope where the arrow was written — accessing instance state on the surrounding Channel directly via `this.someChannelField`.

When you subclass CachedData, **method shorthand** is the right form for the override:

```javascript
class DeploymentData extends CachedData {
    onData(data, node) { /* this is the driver */ }   // correct
}

class WrongDeploymentData extends CachedData {
    onData = (data, node) => { /* this is whatever was in scope */ }  // wrong shape
}
```

Class-field arrows look like methods but behave like arrows; they're a different shape than method shorthand and they lose framework binding. Use method shorthand on the subclass.

##### Don't override anything other than `onData`

When you subclass CachedData, override **only** `onData`. The other methods on CachedData — `collector`, `emitter`, the constructor — implement the framework's caching, deduplication, and publication semantics. Overriding them disrupts the framework's invariants in ways that aren't easy to recover from. `onData` is the framework's documented extension point on CachedData; it is the only legitimate one.

If you find yourself wanting to override something else, that's a sign you don't actually want CachedData — you want a custom handler registered through `.subscribe(...)` or `.publish(...)` instead, where you have a clean slate. The Beyond CachedData section below covers that case.

### RPC exports: where they go, and how to call them

Channels can expose RPC methods through an `exports` object — but before we look at how, a reminder about *when* you should. **Most exports in an SC3 application live in Nodes, not Channels, and the framework propagates them upward into the Channel's exposed namespace automatically.** A Channel-level export is appropriate when the operation genuinely lives at the Channel layer: coordinating across multiple drivers, aggregating data from many Nodes for a single response, or orchestrating something the Channel owns rather than any specific device.

The example below is a Channel-level export precisely because the operation belongs at the Channel layer — `startJob` creates a new job entry in a Channel-owned Map and orchestrates work across the whole driver. There's no Node where this logic could live, because the job doesn't exist until the Channel creates it. That's the right kind of case for a Channel export.

If your impulse is to add a Channel export that just calls a Node's export with the same arguments, stop and put the export in the Node instead. The framework will surface it at the Channel layer for free.

Channel exports look like this:

```javascript
class MonitorChannel extends Channel {
    activeJobs = new Map();

    exports = {
        startJob: async ({ target, params }) => {
            const jobId = crypto.randomUUID();
            this.activeJobs.set(jobId, { target, params, started: Date.now() });
            // ... spawn the work ...
            return { jobId };
        },

        cancelJob: async ({ jobId }) => {
            const job = this.activeJobs.get(jobId);
            if (!job) throw `job ${jobId} not found`;
            // ... cancel the work ...
            this.activeJobs.delete(jobId);
        },

        listJobs: async () => Array.from(this.activeJobs.entries())
            .map(([jobId, job]) => ({ jobId, ...job }))
    };

    constructor(id, controller, options) {
        // ... pipeline declarations ...
    }
}
```

A few things about this shape are non-negotiable. They look like style choices but aren't.

**Every RPC method is an entry in `this.exports`, never anywhere else.** Not a class arrow field, not a constructor-bound closure, not a regular instance method. The framework's RPC dispatcher specifically looks up `this.exports[command]`. Methods anywhere else are invisible to it. If you see an RPC handler defined as `requestArchiveReplay = async (...) =>` at class-field level, that handler doesn't work, regardless of how reasonable the syntax looks.

**The body of the export contains the logic.** It's tempting to write thin exports that delegate to "the real method":

```javascript
// Don't do this — the export wraps a class method that holds the actual logic:
async doStartJob({ target, params }) {
    // ... actual logic here ...
}
exports = {
    startJob: args => this.doStartJob(args)
};
```

This adds an indirection layer with no benefit. The framework calls every export with the Channel instance as `this`, so writing logic in a class method versus in the export body is mechanically identical — they both have the same `this`, the same access to instance state, the same everything. Putting the logic in `doStartJob` and calling it from `startJob` just makes the code harder to read. The export *is* the canonical home for the operation; helpers exist when they describe a coherent named abstraction (`normalizeJobParams`, `validateTarget`), not when they're "the part of `startJob` that comes after the validation."

**Each handler takes one argument: an object.** Signatures look like `async ({ ...namedArgs }) => { ... }`. Multi-argument signatures don't work — the framework's dispatcher passes one object, so writing `async (target, params) => { ... }` results in `target` holding the whole `{ target, params }` object and `params` undefined. There's no warning, just a method that mysteriously misbehaves.

**Each handler is `async` (or returns a Promise).** Errors propagate through the Promise chain to the caller. Don't wrap framework calls in defensive `try/catch` to "harden" them — the framework's error path is the application's error path, and reflexive error swallowing reformats errors that callers needed to see. Catch errors at deliberate boundaries (UI handlers showing a user-facing toast, top-level request handlers), not reflexively at every call site.

**Calling exports from inside the Channel uses a different surface than defining them.** The next subsection covers it.

### The Channel's call-pattern asymmetry

In a Channel, you *define* exports on `this.exports`. You *call* exports through `this.channelExports`. They are different objects, and reading from `this.exports` to invoke an export does not work.

```javascript
exports = {
    startJob: async ({ target, params }) => { /* ... */ },
    startBatch: async ({ targets, params }) => {
        const { startJob } = this.channelExports;
        return Promise.all(targets.map(target => startJob({ target, params })));

        // WRONG — would silently fail:
        //     const { startJob } = this.exports;
    }
};
```

#### Why the asymmetry exists

Channels are the only SC3 layer where multiple instances coexist in the same address space, each with its own export namespace. A Node has one `this.exports` and no peer Nodes visible from inside it. A View has one `this.exports` it owns as its UI surface. A Channel lives alongside other Channels in the Controller's registry, so "the exports" is ambiguous — you have to say *whose*. `this.channelExports` answers "this Channel's"; `this.controller.channels.<name>.channelExports` answers "that Channel's." `this.exports` on a Channel is define-only because if it were also the call surface, every Channel's `this.exports` would mean only "mine" — there'd be no uniform way to address a sibling.

#### The same form works everywhere in the main server thread

Channels, Drivers, Workers, and the Controller all run in one Node.js process. Wherever code in that thread invokes a Channel's exports — Controller methods, sibling Channels, helper classes the application owns, `onData` callbacks — it does so through `channelExports` on a held Channel reference. The destructured form is preferred:

```javascript
const { startJob, cancelJob } = this.channelExports;
```

The proxy resolves on every property access, so destructuring doesn't capture stale references — exports added at runtime become visible at call time.

#### Resolve channels through the registry

The Controller maintains the canonical channel registry. Channels self-register on construction, so application code does not store them in instance fields. From inside the Controller, channels are reachable as `this.channels.<name>`. From anywhere else in the main thread — Channels, driver-context callbacks, helper classes — the same registry is reachable via `this.controller.channels.<name>`.

Don't shortcut the registry by capturing individual references — captured method references freeze whatever was defined at capture time, and exports added later are invisible. Don't write getters that return individual export methods — that's just direct method access in disguise. Don't reach for `this.driver.request('startJob', args)` — it works, but it puts the messaging seam back into application code that the framework spent effort hiding.

#### The Controller is the common cross-Channel caller

Application code typically subclasses Controller, and cross-channel orchestration naturally lives there:

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

Same rule, no exception for the Controller's position. The two-step destructure — pulling channels off `this.channels`, then exports off `channelExports` — is the canonical form, and it's what most production code looks like.

### Beyond CachedData: custom handlers

Most data flowing through a Channel fits CachedData's model — incoming data should be cached, optionally deduped, and published to clients. But sometimes it doesn't. You might have:

- A stream of events that shouldn't be cached because they're transient.
- Data that needs custom transformation before it's published.
- A flow where the publication trigger is something other than a new value arriving.

For these cases, the driver's pipeline accepts custom handlers via `.subscribe(...)` and `.publish(...)`:

```javascript
this.lifecycleStreamSources = {
    progress(data, node, socket) {
        // 'this' is the driver
        // ... custom handling, maybe transform before forwarding ...
        return shouldPublish;       // truthy → fire the corresponding publisher
    },
    history(data, node, socket) {
        // ... custom handling ...
        return shouldPublish;
    }
};

this.loadDriver('lifecycle')
    .process(new CachedData('connectivity', { publishDataStream: true, nodeInData: true }))
    .process(new CachedData('batch', { publishDataStream: true }))
    .subscribe(this.lifecycleStreamSources);
```

`.subscribe(sourcesObject)` registers source handlers — the entry point for data flowing through the pipeline. The argument is an object whose keys are data types and whose values are functions that handle incoming data. `.publish(sinksObject)` registers optional sink handlers — emitters that fire when the corresponding subscriber returns truthy. The relationship is asymmetric: `.subscribe()` is what makes data flow at all; `.publish()` is an optional outbound step layered on top. A `.publish()` registration without a corresponding `.subscribe()` for the same type does nothing — there's no trigger to fire it.

The handler functions follow specific signatures. A source handler receives `(data, node, socket)` — the incoming payload, the originating node id, and the socket the data came from (or the channel for broadcast). It returns a truthy value to indicate that the corresponding publisher should fire (if one is registered), or falsy to suppress. A sink handler receives `(data, socket)` — the outgoing payload and the destination.

A subscriber registered alone can publish to clients directly via `socket.data(type, payload)` and return `false` to ensure no registered publisher fires for that data. This is how the framework's own `publishPayload` flag is implemented internally: live events flow out without caching or replay. Custom subscribers reach for the same shape when the application needs to push live events outside the CachedData model — alert streams, notification feeds, real-time event ticks where each event is a moment, not a state worth replaying.

**Both must be regular functions, not arrow functions.** The framework calls them with the driver as `this`, and arrow functions ignore `.call()`'s context binding.

**Multiple chain calls accumulate.** Calling `.process(...)`, `.subscribe(...)`, and `.publish(...)` repeatedly on the same driver doesn't overwrite previous registrations — each call adds to the driver's handler registry. You can chain a dozen `.process(...)` calls in a constructor and they all stick. This is what makes the canonical "one `.process()` per data type" pattern work.

### Sparse drivers: nodes spawned at runtime

The drivers we've seen so far have static device lists — a `DEVICES` constant at the top of the Node file, defining all the Workers the driver will ever spawn. This works for stable inventories: a list of network devices, a set of monitored services, a fixed cluster of hosts.

Sometimes the device list isn't static. Consider a deployment system where each "device" represents a running deployment to a specific host, started by user action and torn down when the deployment finishes. You don't know in advance which hosts will be deployed to or when. The static-driver model doesn't fit.

A *sparse driver* solves this. The Node file looks almost the same as a static driver's, but the `DEVICES` constant is empty:

```javascript
import { Node } from 'securechannel';

const DEVICES = {};        // empty — no nodes at startup

class DeploymentNode extends Node {
    // ... same shape as a normal Node ...
}

new DeploymentNode(DEVICES);
```

The framework still needs the file to emit valid JSON describing its devices, even if the device list is empty — that's part of the framework's startup contract. So `DEVICES` is `{}`, not omitted. The Node file is still spawned; it still registers; it just has no Workers initially.

Workers come from the Channel side, which spawns them dynamically. The driver returned by `loadDriver(...)` exposes `addWorker(node, data)` to spawn a new Worker for a fresh node id, with the supplied data passed to the Node's constructor as initial configuration. The Node then runs as if it had been part of a static device list — same lifecycle, same API, same emit/RPC mechanisms.

```javascript
class DeploymentChannel extends Channel {
    batches = new Map();

    exports = {
        startDeployment: async ({ targets, packageName }) => {
            const batchKey = this.uniqueKey;
            const batch = new Batch(batchKey, targets.length);
            this.batches.set(batchKey, batch);

            for (const target of targets) {
                const nodeId = this.uniqueKey;
                const connection = { batch: batchKey, hostname: target.hostname, packageName };
                await this.deploymentDriver.addWorker(nodeId, connection);
                batch.targets.set(nodeId, target);
            }

            return { batch: batchKey };
        },

        abortDeployment: async ({ batch: batchKey }) => {
            const batch = this.batches.get(batchKey);
            if (!batch) throw `batch ${batchKey} not found`;
            batch.abortController.abort('aborted by user');
            return 'acknowledged';
        }
    };

    constructor(id, controller, options) {
        const { connection } = Channel.getConnection(id, options);
        super(id, connection).join(controller);

        this.deploymentDriver = this.loadDriver('deployment')
            .process(new DeploymentData('batch', { publishDataStream: true, nodeInData: true }));
    }
}
```

To tear down a Worker explicitly, use `dropWorker(node)`. It returns a Promise that resolves when the shutdown completes, or rejects after a timeout if the Worker isn't responsive.

Workers can also be marked as ephemeral by setting `worker.persistent = false` (typically in the Node-side configuration). Ephemeral Workers automatically remove themselves from the driver's registry when they go down — the right behavior for one-shot tasks like deployments. Persistent Workers stay registered across down/up cycles.

In practice, sparse-driver applications wrap `addWorker`/`dropWorker` in project-defined orchestration classes — `Target` for one node, `Batch` for a group — that also track per-job state, abort signals, and result aggregation. The exact shape of those wrappers depends on the application; the underlying primitives are `addWorker` and `dropWorker`.

### The rest of the Channel

Most Channels are mostly the constructor's pipeline declarations. Some have a small `exports` object for Channel-level operations; many have no `exports` at all because every RPC method the application needs lives in a Node and bubbles up. Beyond that there's a thin perimeter — instance fields for transient operational state, helper methods for work that doesn't fit RPC's request/response shape, occasional `this.on(...)` event handlers for socket lifecycle. None of it changes the basic shape. A Channel is fundamentally a pipeline declaration; everything else is incidental.

The Channel does *not* hold cached application state. That lives on the Controller, accessed through `this.controller.cache(...)`. We'll get to the cache shortly, because it's where Channels coordinate with each other and with the rest of the framework.

---

## The Cache and Shared State

The Controller owns a cache. It's the application's shared state — the place where data flows in from drivers (via CachedData processors) and is read from when the framework replays state to newly-connected clients. Channels write to the cache, read from it, and notify clients about changes through it. Application code interacts with this cache through a small, deliberate API.

### `this.controller.cache(...)` and `this.controller.nodes(...)`

Both methods have variable arity, but the common forms are:

```javascript
// Read:
const status = this.controller.cache(['mydomain', 'status', nodeId]);

// Write:
this.controller.cache(['mydomain', 'status', nodeId], newPayload, true);

// Write and broadcast to a channel's subscribers:
this.controller.cache(channelInstance, ['mydomain', 'status', nodeId], newPayload, true);
```

The path is always an array describing where in the cache hierarchy the value lives. The standard hierarchy is `[domain, type, node]` — though some flows store data differently when `nodeInData: true` is set in the CachedData configuration (the node id is then keyed inside the payload, not in the path). Maintain the hierarchy the framework expects; don't invent ad-hoc nesting levels.

The third argument (`overwrite`) controls whether an existing value at the path is replaced wholesale or merged with the new data. `true` replaces; `false` (the default) merges if the existing value is an object.

The four-argument form, with a channel as the first argument, performs the write *and* notifies the channel's subscribers about the change. Use it when you want clients to see the update; use the three-argument form when you want a silent write.

### `this.controller.nodes(...)` is for node availability

The cache has a sibling structure for tracking node availability — whether a node is ready, online, registered, or absent. You read and write it through `this.controller.nodes(...)`, which has the same shape as `this.controller.cache(...)`:

```javascript
const ready = this.controller.nodes(['mydomain', 'host-3']);
this.controller.nodes(['mydomain', 'host-3'], true, true);
```

You'll rarely need to access this directly. The framework manages it as Workers come up and go down. But it's there for cases where application logic needs to know whether a specific node is currently usable.

### Driver-scoped accessors

Inside any code running in driver context — `onData` callbacks, custom source/sink handlers, any other framework callback called with the driver as `this` — there's a shorter form:

```javascript
class DeploymentData extends CachedData {
    onData(data, node) {
        // 'this' is the driver
        const cached = this.cache(['batch', node]);     // resolves to ['deployment', 'batch', node]
        // ...
    }
}
```

`this.cache(path)` on a driver automatically prepends the driver's domain to the path. `this.nodes(path)` does the same. These are preferred when you're in driver context because they eliminate a class of pathing typos and make the code read as "this driver's cache" rather than "the global cache, scoped by string concatenation."

The full `this.controller.cache(...)` form is correct outside driver context (Channel constructor, RPC handler bodies, View lifecycle hooks) and inside driver context when the access is genuinely cross-domain.

The driver-scoped versions also accept the optional channel-as-first-arg form:

```javascript
this.cache(this.channel, ['status', node], payload, true);
```

This writes the cache and broadcasts the change to the channel's subscribers, all in driver context. It's the canonical "I am the source of this change; mutate cache and notify clients" idiom from inside a driver callback.

### The auto-creation footgun

The cache has a non-obvious behavior that bites new developers: **reads never fail.** If you query a path that doesn't exist, the framework walks the cache, materializes empty placeholder objects along the way, and returns the empty placeholder.

```javascript
// Both of these "succeed" — even if the path doesn't exist:
const value1 = this.controller.cache(['mydomain', 'status', 'host-typo']);
// returns: {}
const value2 = this.controller.cache(['typo', 'whatever', 'whatever']);
// returns: {}

// But now the cache has new entries in it:
//   state.cache.mydomain.status['host-typo'] === {}
//   state.cache.typo.whatever.whatever === {}
```

This means a typo in a node id, a domain name, or a data type doesn't cause an error — it silently creates a nonsense cache path and returns an empty object. Your code receives the empty object and proceeds as if there's no data. You spend some time wondering why your dashboard isn't showing anything before realizing you typed `'host-typo'` instead of `'host-3'`.

The fix is to be careful about what goes into cache paths. Validate path components when they come from user input or from external sources before using them. Use the driver-scoped `this.cache(...)` when you can, because it eliminates the domain typo. And accept that the framework won't tell you the read was wrong; that's a tradeoff the framework makes for the benefit of always-succeeds behavior elsewhere.

What you do *not* do is reach into `this.controller.state.cache` directly to bypass the accessor and check existence first. That's the framework's internal storage, and the rule is "all access through the accessor." Application code accepts the auto-creation behavior; the framework's own internals have other tools for the rare cases where existence-check matters.

### What goes in the cache

Generally: anything published to clients via `publishDataStream` that should survive disconnect/reconnect cycles. Status data, current configurations, lists, snapshots. Things that have a notion of "current value" worth replaying. Data published via `publishPayload` is *not* cached — that's the whole point of the volatile-push pattern — so it doesn't appear in `this.controller.cache` paths and doesn't replay on reconnect.

What does *not* belong in the cache: per-connection transient state (active requests, in-progress streams), application-internal bookkeeping (request counters, log buffers), one-shot events (alerts that fire once and aren't reusable). For these, use Channel instance fields, dedicated tracking maps, or stream-based mechanisms — not the cache.

### What about reading another channel's cache

The Controller's cache is shared across all channels — that's its purpose. Any channel can read from any path, and the framework doesn't enforce per-channel boundaries. Channels coordinate through it.

That said, the cleaner pattern for cross-channel coordination is RPC — invoke the other channel's exports rather than reaching into its cached data directly. The cache is the framework's machinery for moving data; the exports are the channel's logical interface. Reading another channel's cache is fine when you genuinely need data the framework has already cached; calling the other channel's exports is right when you want to invoke its semantic operations.

A reasonable test: if you're reading raw data the other channel has published to clients, the cache is fine. If you're invoking an operation that the other channel implements, use exports.

---

## Writing Views

A View is a JavaScript class that runs in the browser and represents one piece of the user interface. A page can have multiple Views — an auth View, a dashboard View, a settings View — each connected to its own Channel.

### The Client routes; the View declares

A View doesn't open the WebSocket or speak the wire protocol. The SC3 browser-side `Client` does. When the page boots, application code constructs a `Client` and hands it the View(s) it should serve:

```javascript
new Client(`wss://${location.hostname}/channels/monitor`, [monitorView]);
```

The Client opens the WebSocket, performs the handshake, receives the export list pushed from the server, dispatches incoming typed-data messages to View methods named after the data type, manages reconnection, and calls the View's reserved methods (`import`, `online`, `offline`, `latency`, `nodes`) as the corresponding events occur. The View doesn't write WebSocket code, parse wire messages, manage reconnection, or know which Node an RPC call ends up at — the Client handles all of that.

What the View does is declare. Three responsibilities:

1. **Subscribe to the RPC provision** by defining the reserved method `import(exports)`. The Client calls this once per handshake, with the Channel's full export namespace as the argument.
2. **Subscribe to typed data streams** by defining methods named after the data types being published. Defining the method *is* the subscription; there is no separate `subscribe(...)` call.
3. **Dispatch UI events** to handlers stored in `this.exports`, via data attribute routing. A separate section in this chapter covers the mechanism.

The first two are declarative: the subscription is encoded in the View class's structure. Define the method, and you're subscribed; remove it, and you're not. The Client recognizes specific method names as subscription declarations and routes flows to them as those flows happen.

### `import(exports)`: subscribing to the RPC provision

`import` is a reserved method name. Defining it subscribes the View to the RPC handshake: when the Client receives the Channel's full export namespace from the server, it calls `import(exports)` on the View with that namespace as the argument. The body is the View's main initialization site:

```javascript
class DashboardView extends Operations {
    devices(data) {
        this.renderDevices(data);
    }

    status(data) {
        this.renderStatus(data);
    }

    import(exports) {
        const { startJob, cancelJob, listJobs, updateUserSettings } = exports;
        const { toggleClass } = UI;

        // Arrow closure above — handles the mixed-context case (DOM element +
        // View context for the confirm dialog). Receives the source element
        // as `target` and the standard `(data, event)` as the rest:
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

        // Closure for the closure-reference handler below — captures View `this`:
        const refreshJobList = async () => this.renderJobs(await listJobs());

        this.exports = {
            // Thin wrapper — captures DOM `this` and forwards to the closure above.
            // Mixed context: DOM element AND View work both happen in the closure.
            start(data, event) { confirmAndStart(this, data, event); },

            // Arrow inside this.exports — single statement, no DOM `this` needed:
            cancel: ({ jobId }) => cancelJob({ jobId }),

            // Closure reference — same effect as `() => refreshJobList()`, just shorter:
            refreshJobs: refreshJobList,

            // Property shorthand — raw RPC re-exposure, callable as data-click="updateUserSettings":
            updateUserSettings
        };

        refreshJobList();         // initial population
        this.Ready = true;
    }
}
```

Several patterns to notice here.

**Form choice in `this.exports` is per-handler, driven by what `this` should be in the body.** Three productive forms inside the literal, plus one workaround:

- **Arrow form `name: (args) => ...` (or block-body `name: (args) => { ... }`)** — when the handler needs `this` to be the View instance (`this.onConfirmed`, `this.getView`, `this.State`, `this.renderJobs`), or doesn't use `this` at all. This is the most common form in practice. The `cancel` entry above takes this shape; so does any handler that just calls a sibling View method or fires an RPC.
- **Method shorthand `name(args) { ... }`** — when the handler needs `this` to be the **source DOM element**. The framework dispatches UI events as `handler.call(sourceElement, data, event)`, and method-shorthand bodies honor that binding. Most often this appears as a thin wrapper that captures `this` and forwards to a closure (the `start` entry above), or as a body that manipulates the source element directly via `this`.
- **Property shorthand `name`** — raw re-exposure of a destructured RPC by its own name (the `updateUserSettings` entry). Listed directly on `this.exports`, callable from `data-click="updateUserSettings"` with no intermediate logic.
- **Closure reference `name: helperName`** — when the handler body is exactly an existing closure defined above (the `refreshJobs: refreshJobList` entry). Shorter than wrapping the closure in another arrow; works whenever the closure already captures the right `this`.

**Mixed-context handlers — needing both DOM `this` and View context — use the arrow-above-the-exports workaround.** The `start` handler is the canonical case: it eventually needs to manipulate the source button (`toggleClass(target, 'starting')`) *and* needs `this.onConfirmed(...)` for the dialog flow plus the RPC call. Neither pure form covers this — an arrow inside `this.exports` loses the DOM binding, method shorthand inside loses lexical View access. The split that works: a `const` arrow closure above `this.exports` (`confirmAndStart`) captures lexical View `this` for the View-side work and accepts the source element as an explicit `target` parameter; a thin method-shorthand wrapper inside `this.exports` does nothing but capture `this` (the framework-bound source element) and forward `(this, data, event)` to the closure. **All the actual logic — DOM manipulation, dialog flow, RPC, error handling — lives in the closure**, where `this` is unambiguously the View and `target` is unambiguously the DOM element. The wrapper is pure pass-through with no logic to follow. This is a **workaround** for the cases where neither pure form fits, not the default. Most handlers need one form or the other and inline directly into `this.exports`.

**Helper closures are arrows above `this.exports`** when they're used by mixed-context handlers, when they're called repeatedly inline (`refreshJobList` is also called once during init for initial population), or when extracting them keeps the literal readable. They capture the destructured RPC methods lexically and preserve the View as their `this`. They're not promoted to class methods because there's no second call site outside `import`, and lifting them would force you to pass RPC methods as arguments or store them on `this` — both worse than the closure scope, which is exactly right.

**Re-exposing raw RPC methods is valid but skips application-side gating.** Listing `updateUserSettings` directly on `this.exports` makes the RPC callable from `data-click="updateUserSettings"` with no intermediate logic — no confirmation prompts, no validation, no precondition checks. For low-stakes idempotent operations this is fine. For anything destructive or stateful (a `cancel` that aborts an in-flight job, a delete, anything that costs real resources or carries security implications), wrap the RPC in a closure that adds the appropriate gating before forwarding the call. The `confirmAndStart` closure above shows the shape: prompt, await user response, branch into success or failure paths. Pick the form per-action: raw re-exposure for safe operations, wrapped closure for everything else.

### Subscribing to data streams: define a method by the data type's name

When the Channel publishes data of a certain type — through a `CachedData` processor with `publishDataStream: true`, or any of the related mechanisms — the View subscribes by defining a method on the View class *named after the type*:

```javascript
class DashboardView extends Operations {
    // Subscribes to 'devices' data — receives every update, plus cached state on connect:
    devices(data) {
        this.renderDevices(data);
    }

    // Subscribes to 'alert' data:
    alert(data) {
        this.showAlert(data);
        this.flashAlertCounter();
    }
}
```

A traditional event-driven library would have you call `channel.on('devices', handler)` — the imperative form, where the subscription happens at runtime via an explicit call. SC3 inverts this: the subscription is encoded in the View class's structure. Reading the View class's method names gives you a complete inventory of the data types it consumes, and a subscribe-handler mismatch (subscribing to `'devices'` but handling `'device'` because of a typo) is impossible by construction.

If your View doesn't define a method matching a published type, the data is silently ignored *for this View*. Other Views on the page can still subscribe by defining their own method. Multiple Views each subscribe independently.

The first reaction many new developers have is "this can't possibly work; I should add an explicit fetch on connect to be sure." The fetch isn't needed. The Client's delivery covers initial-state replay (cached state arrives when the connection is established) and ongoing updates, through the same method. Adding a fetch reproduces the framework's mechanism in application code and creates a parallel path that can drift from the canonical one.

A few method names are reserved for subscriptions to framework-supplied flows. Don't use these names for application-typed data:

- `import(exports)` — RPC provision flow. The Channel's full export namespace arrives as the argument, once per successful handshake. Covered above.
- `online(sessionid)` — channel-up events. Fires whenever the WebSocket connection is established or re-established. The argument is a session identifier the Channel assigns. Optional.
- `offline()` — channel-down events. Fires whenever the connection drops, including transient drops the Client will reconnect from. Optional.
- `latency(ms)` — latency measurement stream. Fires periodically with the round-trip time to the Channel in milliseconds. Optional.
- `nodes(data)` — node-lifecycle observability flow. Receives a nested object describing every node the framework is currently managing, with per-node `error` and `timestamp` fields. Optional, with a synchronous-completion constraint covered below.

Everything else is fair game for application-typed data.

#### What the connection-lifecycle methods are for

`online(sessionid)`, `offline()`, and `latency(ms)` are the application's window into the Client's connection management. The Client tracks the connection regardless of whether your View defines these methods; defining them is purely about whether you want to expose connection state to users.

The Client also handles reconnection automatically. **You do not write reconnection logic in your application.** No `setTimeout` retry loops, no socket-error watchers, no manual reconnection cycling. Reproducing this in application code is the same trust-the-framework antipattern we've discussed in other forms.

##### When to implement them

Most applications benefit from at least a minimal connection indicator — a small UI element that shows green when connected and red (or grayed-out) when disconnected. Even on a passive dashboard, communicating connection state matters because **stale data with no indicator is worse than no data at all**. If the connection has been down for ten minutes, a user looking at the dashboard could be making decisions based on data that's gone stale.

The minimum viable implementation is a tiny indicator updated by `online` and `offline`:

```javascript
class DashboardView extends Operations {
    online(sessionid) {
        UI.toggleClass(UI.getElement('connection-indicator'), 'connected', true);
    }

    offline() {
        UI.toggleClass(UI.getElement('connection-indicator'), 'connected', false);
    }
}
```

For richer feedback, `latency(ms)` lets you show connection quality, not just up/down. A typical use is grading the latency into bands — excellent, average, poor — and reflecting that in the indicator's color or numeric display:

```javascript
latency(ms) {
    const status = UI.getElement('connection-indicator');
    const grade = ms > 100 ? 'poor' : ms > 25 ? 'average' : 'excellent';
    UI.toggleClass(status, 'poor', grade === 'poor');
    UI.toggleClass(status, 'average', grade === 'average');
    UI.toggleClass(status, 'excellent', grade === 'excellent');
    UI.setText(UI.find(status, '.latency-value'), `${ms}ms`);
}
```

For applications where data going stale matters more — administrative consoles, control panels, anything where a user might attempt an RPC operation — consider a "service not available" overlay that gates user interaction while disconnected. RPC calls placed during disconnection will fail (the WebSocket isn't there to carry them), so disabling controls or showing a clear "reconnecting…" state is more user-friendly than letting the user try and silently fail:

```javascript
offline() {
    this.showReconnectingOverlay();   // disables interaction, shows reconnect spinner
}

online(sessionid) {
    this.hideReconnectingOverlay();
}
```

For purely passive read-only displays — wall-mounted dashboards, kiosks — connection state may matter less. But communicating *staleness* still matters. A dashboard showing yesterday's numbers under the impression they're live is misleading; a dashboard with a clear "Disconnected — last updated 14:32" banner is honest.

##### When `online`, `offline`, and replay actually fire

The Client distinguishes two reconnect cases, and they fire methods differently.

**Clean reconnect** — the Client's first reconnect attempt succeeds quickly enough that no data is treated as lost. `online(sessionid)` fires (it always fires on a fresh connect), but `offline()` is *never* called and no replay happens. The user may not notice the blip at all.

**Recovered after gap** — the first attempt fails and the Client enters its retry behavior. Once that's happened, the gap is long enough that data may have been lost. `offline()` fires immediately. When the connection eventually comes back, a fresh handshake runs: `import(exports)` fires with a new session id, cached state replays automatically to subscribed View methods, and `online(sessionid)` fires.

So the rule is: **`online` always fires on connect, but `offline` only fires when the gap is long enough that data may have been lost.** Likewise, **automatic replay only happens after a recovery from a gap, not after a clean reconnect.**

For most applications, this is the right behavior. Where the distinction matters is when an application needs absolute certainty that its data is current, regardless of how brief the disconnection was. For those cases, keep a manual refresh trigger and call it from `online`:

```javascript
online(sessionid) {
    this.hideReconnectingOverlay();
    // optional: force a refresh even on clean reconnects, when staleness is unacceptable
    this.refreshAllPanels();
}
```

This pattern comes up most often in applications that don't carry their full data sets through CachedData — pull-style designs where CachedData carries only a notification that something changed, and the application queries for the current data on demand. Pull-style designs use `online` as a trigger to requery, because the Client's replay only delivers what was previously cached.

##### When you don't need them

If your View doesn't need to communicate connection state to the user — perhaps it's a transient utility component, a partial inside another View that already shows the indicator, or a development-mode screen — leave the methods undefined. The Client's connection management still works; your View just doesn't observe it. Don't add these methods speculatively; add them when the UI you're building actually needs the state they expose.

#### What `nodes(data)` is for

`nodes(data)` is the application's window into the framework's node-lifecycle tracking. The framework already tracks which Workers it has spawned, which are ready to handle requests, which are in error states, and which have died and are awaiting respawn — this is how Worker supervision works, how RPC routing knows whether to dispatch a call, and how non-persistent workers get cleaned up after exit. The Client calls `nodes(data)` whenever any of that state changes, so the application can render per-node health UI if it wants to.

##### The shape of the `nodes(data)` payload

The data is a nested object: outer keys are domains (driver names), and each domain's value is an object whose keys are node ids and whose values describe per-node state. Conceptually:

```javascript
{
    devicestatus: {
        'router-1':  { error: null,        timestamp: 1730492100000 },
        'router-2':  { error: null,        timestamp: 1730492101240 },
        'switch-1':  { error: 'timeout',   timestamp: 1730491020000 }
    },
    firmware: {
        'batch-1234:host-7': { error: null, timestamp: 1730492100050 }
    },
    auth: {
        'session-store': { error: null, timestamp: 1730491999000 }
    }
}
```

The structure represents every node the framework is currently aware of, across every domain (driver) the Channel manages. Static drivers contribute entries for each pre-defined device. Sparse drivers contribute entries for whatever Workers happen to be running at the moment the Client delivers the update — these come and go as orchestration spawns and tears down work.

Each per-node value carries at least `error` (null when healthy, a message string when in an error state) and `timestamp` (the last time the framework observed a state change for this node). Specific fields beyond these may vary; treating `error` and `timestamp` as the contract is safe.

A typical handler iterates the structure and updates per-node UI:

```javascript
nodes(data) {
    const { isEqual, iterable } = Helpers;
    const update = () => {
        for (const [domain, nodes] of iterable(data)) {
            if (isEqual('display', domain)) {
                for (const [node, { error, timestamp }] of iterable(nodes)) {
                    this.setInstance(node, { error, timestamp });
                }
            }
        }
    };
    this.onReady(update);
}
```

Here the View only cares about the `display` domain, so it filters by domain name in the outer loop, then walks each node's state in the inner loop. Other Views might iterate every domain and update a unified per-domain health panel; what you do with the data is application logic.

##### Don't build parallel tracking

Don't build parallel tracking in application code. If you find yourself maintaining a Map of "which devices are up" through manual `status(data)` subscription, hand-rolling exception detection from emitted typed data, or subscribing to "device went down" events you've defined yourself, you're reproducing the framework's lifecycle tracking. Use `nodes(data)` instead — the framework already has the state; defining the method is how you consume it.

And: defining `nodes(data)` is optional. If your UI doesn't visualize per-device health, leave the method undefined. Don't add it speculatively — and if you do add it, the body must complete synchronously, covered next.

#### The `nodes(data)` synchronous-completion constraint

Most reserved methods can be `async` — `import(exports)`, `online(sessionid)`, the various data-stream methods. They run on their own timeline; the Client awaits them or fires them off and forgets. `nodes(data)` is the exception.

The Client calls `nodes(data)` synchronously *before* it triggers `import`. The startup sequence treats `nodes` as a prerequisite step that must complete before RPC handles are delivered to the View. That means the body cannot `await` anything that depends on the View being fully ready — most notably, it cannot await `this.Ready`, because `this.Ready` resolves only after `import` has run, and `import` won't run until `nodes` returns.

If you put `await this.Ready` (or any other promise that depends on later initialization) inside `nodes(data)`, the View deadlocks: `nodes` waits for `Ready`, `Ready` waits for `import`, `import` waits for `nodes` to return. There's no error message; the View just never finishes initializing.

The canonical pattern is to capture the data into a synchronous closure and defer the actual work via `this.onReady(...)`, which schedules the closure to run after `import` completes. The example above already shows this: `nodes(data)` defines `update`, hands it to `onReady`, and returns. The Client gets its synchronous completion. When `import` finishes and the View transitions to ready state, `onReady` fires the deferred `update`, which then does the real work using the `data` captured in the closure.

If you find yourself wanting to do something in `nodes(data)` that depends on `this.exports`, `this.Ready`, RPC handles from `import`, or any state populated during the import phase, defer it with `onReady`. The synchronous-completion constraint isn't a style preference — it's a hard ordering requirement.

### The UI base: `ui.js` and `app.js`

All browser-side Views in an SC3 application are built on a two-file foundation: `ui.js` (the framework's base UI utility) and `app.js` (a project-specific extension of it). Every View in the project extends the class defined in `app.js`. Together, these two files install every event listener the application uses — clicks, changes, focus, blur, scroll, hover, drag, submit, keyboard input, `popstate`, `hashchange`, every event type the project handles. Application code outside `ui.js` and `app.js` never calls `addEventListener` directly, never assigns `onclick`, never binds handlers to specific elements. The single-listener-per-event-type-on-document model is what makes the rest of the framework work — dynamic content keeps working because handlers live globally, the system stays composable, and there's exactly one place to look for "how does this kind of event get handled in this app."

`ui.js` ships with the framework. It provides the data-attribute routing for the per-element events the framework knows about (`click`, `dblclick`, `contextmenu`, `change`, `focus`, `blur`, `mouseover`, `mouseout`, `submit`, etc.), the structural primitives (`Panel`, `Menu`, `MutexTabGroup`, `MutexPanelGroup`), the dialog primitives (`alert`, `confirm`), and the page-global handlers the framework knows about (history routing via `popstate`/`hashchange`, capture-phase keydown for modal escape, etc.). The `UI` class itself is a static utility — don't `new UI()`; its constructor does nothing.

`app.js` is the project's customized extension. The filename is conventional, not magic — different projects use different names — but every SC3 application has one, structured the same way: a class that subclasses `ui.js`'s base, adding whatever event handling and cross-cutting UI behavior the project needs that isn't in `ui.js`. The class is often named `Operations`, `Core`, `App`, or some project-meaningful name. Every View extends this class, so every View inherits both the framework-supplied event handling from `ui.js` and the project-specific event handling from `app.js`. Common contents of `app.js`: user session state (login, logout, current user), application-wide spinner or loading state, project-specific dialog primitives layered on top of `ui.js`'s, and any custom global event handlers the project's UI requires.

When a View needs to react to an event type that isn't already handled by `ui.js` + `app.js`, the discipline is to **add the handler to `app.js`**, not to install it ad-hoc anywhere else in the application. Adding a new event type to `app.js` means it's then available to every View, registered through the same single-listener-on-document model the rest of the system uses. This is the only framework-compliant way to extend the event coverage.

### UI event handlers: data attribute routing

For the per-element event types `ui.js` handles, the View wires UI to behavior through two parts: (a) a `data-<event>="handlerName"` attribute on the element, and (b) a `handlerName` entry in `this.exports`. When the event fires, the global listener installed by `ui.js` finds the closest element with the matching `data-*` attribute and looks up the named handler.

```html
<button class="btn btn-primary" data-click="startJob" data-job="host-1">
    Start job
</button>
```

When the user clicks this button:

1. A global `click` listener installed on `document` (by `ui.js`) catches the event.
2. It walks up from the click target looking for the closest element with a `data-click` attribute.
3. It finds the button. The `data-click` value is `"startJob"`.
4. It looks up `this.exports.startJob` on the View.
5. It invokes the handler via `handler.call(sourceElement, data, event)`. `this` is the button DOM element, `data` is `{ job: 'host-1' }` (the other `data-*` attributes), `event` is the original DOM event.

Your handler — a thin method-shorthand wrapper inside `this.exports` that captures `this` and forwards to an arrow closure above. The closure does all the actual work:

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
        // Thin wrapper — captures `this` (the source DOM element) and forwards:
        startJob(data, event) { confirmAndStart(this, data, event); }
    };
}
```

This is the canonical mixed-context pattern. The wrapper inside `this.exports` has no logic — it exists solely to capture `this` (the framework-bound source element) and forward `(this, data, event)` to the closure. Inside the closure, `target` is the DOM element (passed in explicitly) and `this` is the View (captured lexically by the arrow); both are usable simultaneously without the per-line "which `this` do I have here" reasoning that mixing logic into the wrapper would require.

If a View needs to handle an event type the framework doesn't already wire (a custom DOM event from a third-party widget, a less-common keyboard interaction, anything not in the standard list), don't reach for `addEventListener` in the View. Add the event type to `app.js` so it gets the same data-attribute treatment as the rest, and Views consume it the same way — `data-<newevent>="handlerName"` on the element, `handlerName` in `this.exports`.

### Structural primitives from `ui.js`

`ui.js` provides reusable structural primitives — `Panel`, `MutexPanelGroup`, `MutexTabGroup`, `Menu` — that handle common UI patterns through callback parameters at construction time. You don't attach event listeners to manipulate these; you provide callbacks when you build them, and they call you back when state changes.

For example, building a panel with state-driven rendering:

```javascript
const dashboardPanel = new Panel(
    'dashboard',
    async (path) => {
        // called when the panel is rendered
        await this.renderDashboard(path);
        return path;
    },
    (visible) => {
        // called when visibility changes
        UI.toggleVisibility(this.elements.dashboard, visible);
    }
);
```

The structural primitives are the legitimate alternative to per-element event binding when the data-attribute model isn't enough. Use them for tabs, panels, menus, and similar structural concerns; use data attributes for per-element actions inside them.

---

## Binary Streams

Everything we've covered so far — CachedData, exports, typed data streams — deals in JSON. You emit a JavaScript object, the framework serializes it, caches it, pushes it to browsers, and the browser receives a JavaScript object. That model covers most application needs.

But some data isn't objects. It's bytes. An SSH terminal session produces a continuous stream of raw ANSI escape codes. A deployment process writes binary output to stdout. A file transfer moves chunks of arbitrary data. These use cases share a trait: the data is opaque binary content, potentially high-throughput, potentially long-lived, and the application wants it to arrive at the browser as raw bytes — not serialized into JSON, not cached and replayed, not deduplicated. It needs to flow continuously from a source to one or more consumers, in real time, with minimal overhead.

SC3's binary stream system exists for exactly this. It provides named, multiplexed, bidirectional binary pipes that work across the entire SC3 stack — from a Node subprocess, through Workers and Channels, across Passthrough bridges to other SC3 services, and into the browser — using native binary frames on both network hops (WebSocket) and process boundaries (IPC child processes are forked with advanced serialization, so binary frames cross IPC natively). The framework handles all the relay, framing, and multiplexing. Your application opens a stream, writes bytes into it, and reads bytes out of it at the other end.

### What binary streams are for

Binary streams solve a specific problem that CachedData cannot: continuous, stateless byte delivery. CachedData is designed for *state* — the latest value, deduplicated, cached for replay to late joiners. Binary streams are designed for *flow* — an ongoing sequence of bytes where each chunk matters in order, nothing is cached, and there's no "latest value" to replay.

Here are the use cases that motivated the system:

**Interactive SSH terminals.** A user opens a browser-based terminal to a remote server. Every keystroke the user types must travel from the browser to the SSH process's stdin. Every byte the SSH process writes to stdout — ANSI escape sequences, cursor movements, color codes, raw binary — must travel to the browser and be rendered by a terminal emulator. This is full-duplex: data flows in both directions simultaneously, indefinitely, until the session ends.

**Deployment output streaming.** A deployment process runs a script on a remote server via SSH. The script's stdout and stderr produce a mix of text and ANSI formatting. The operator watches this output in real time in a browser terminal popup, and can type responses to interactive prompts (sudo password, apt confirmation, etc.).

**Any future use case** where the application needs to move raw bytes between a server-side process and a browser client without JSON serialization overhead.

CachedData would be wrong for all of these. You don't want to cache terminal output — it's a continuous stream, not a latest-value snapshot. You don't want to deduplicate it — every byte matters. You don't want to replay it to late joiners — they should see the session from the point they connect, not from the beginning. And you don't want to serialize it through JSON — binary terminal data contains arbitrary byte sequences that don't survive JSON round-trips cleanly.

### The two-stream model: collator and fanout

A `SubstreamDuplex` is not a single bidirectional pipe. It's two completely independent unidirectional streams that share a `streamId` but never exchange data with each other.

**The collator** is a many-to-one stream. Multiple writers push data in; one reader consumes it. Think of browser keystrokes arriving from multiple connected clients: they all feed into the same collator, and a single pump reads them out and delivers them to the SSH process's stdin.

**The fanout** is a one-to-many stream. One writer pushes data in; multiple consumers each receive an independent copy. Think of SSH stdout: the process writes output once, and every connected browser client gets its own copy through the fanout.

```
Collator (many → one):                    Fanout (one → many):

Browser A writes ─→                                  SSH stdout
Browser B writes ─→  QueueIterator             writes to fanout
                        │                           │
                   single reader              AsyncFanout
                        │                    ╱          ╲
                        ▼              consumer A   consumer B
                    SSH stdin               │            │
                                            ▼            ▼
                                       Browser A    Browser B
```

These two streams never cross. Data entering the collator never appears in the fanout. This separation is maintained at every layer of the stack. When data crosses a process boundary (IPC) or a network boundary (WebSocket), the relay bridges collator-to-collator and fanout-to-fanout — never collator-to-fanout.

Why does this matter? Because the mental model of "a bidirectional pipe" leads developers to assume that writing to a stream means the data will come back out the other side of the same stream. It won't. Writing to the collator (`stream.process(frame)`) delivers data to the collator reader. Writing to the fanout (`stream.write(frame)`) delivers data to fanout consumers. They're separate mailboxes that happen to live on the same object. The collator is a `QueueIterator`; the fanout is an `AsyncFanout`.

### Opening a stream from a Node

The most common pattern is a Node that manages a long-running process — an SSH session, a deployment command — and wants to stream its binary output to the browser while accepting binary input back.

```javascript
import { Node } from 'securechannel';

class TerminalNode extends Node {
    async startSession() {
        const streamId = `session-${this.node}`;
        const stream = this.openStream(streamId);

        // Fanout direction: SSH output → browser(s)
        // stream.write() pushes to the fanout; all consumers receive a copy
        const sshProcess = await this.connectToHost();
        (async () => {
            for await (const chunk of sshProcess.stdout)
                stream.write(chunk);
        })();

        // Collator direction: browser keystrokes → SSH stdin
        // stream.collator is the collator; one reader, many writers
        (async () => {
            for await (const { data } of stream.collator)
                sshProcess.stdin.write(data);
        })();
    }
    // ...
}
```

That's the Node's entire involvement with the stream. It calls `this.openStream(streamId)` to create the SubstreamDuplex, writes SSH output into the fanout via `stream.write()`, and reads browser input from the collator via `stream.collator`. Everything between the Node and the browser — the IPC relay to the Worker, the binary frame encoding on the WebSocket, the Passthrough bridge if there's one in the path, the consumer pump management — is framework-managed.

When `this.openStream(streamId)` is called, the framework:
1. Registers a SubstreamDuplex on the Node, minting the stream's uid
2. Starts a fanout consumer pump that reads the fanout and sends binary frames to the Worker over IPC
3. Calls `publishStreams()`, which emits a `streams` advertisement (`{ streams: [{ streamId, uid }] }`) upward
4. The Worker reconciles the advertisement against its child uid namespace, opens the corresponding stream on the channel, and re-publishes upward

The `streamId` is an application-chosen string — something meaningful like `session-router-1` or `deploy-batch42-host3`. The framework internally maps it to a compact uint32 uid for binary frame headers, but the application never sees or manages that mapping. You use the string; the framework handles the rest.

### Streams originate at the Node

The Node is the application's entry point into the stream system. Streams flow up the stack from there: the Worker, Channel, Passthrough, and browser each own a `StreamIndex` registry and reconcile against the bottom-up `streams` advertisement, opening and closing their local SubstreamDuplex instances to match. There is no Channel-level `openStream` for the application to call, and no `{ action: 'open' }` advertisement to emit — the advertisement is the declarative `streams` message, and the upstream layers converge on it automatically.

A browser becomes a consumer of a stream by subscribing to it (covered next). When it does, the Channel attaches a per-socket fanout consumer pump and broadcasts a `subscriptions` delta downward, so the producing Node knows the stream has a consumer.

### The browser side

The browser client provides a `StreamConsumer` (in `dist/client.js`) with an event-based interface that fits naturally into browser View patterns. A View obtains the consumer through the client's `openStream(streamId)` export, which **subscribes then opens** — it issues the `subscribeStream` command to obtain the stream's uid from the server, then constructs the local `StreamConsumer`:

```javascript
class TerminalView {
    onStreamData = chunk => {
        const bytes = chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : chunk;
        this.terminal.write(bytes);
    }
    onStreamEnd = () => this.setStatus('Disconnected');

    async online() {
        // subscribe-then-open: returns the StreamConsumer once the server assigns a uid
        const substream = await this.actions.openStream(this.streamId);

        // SSH output (fanout → browser)
        substream.on('data', this.onStreamData);
        // stream torn down
        substream.on('end', this.onStreamEnd);
        // keystrokes (browser → collator)
        this.terminal.onData(str => substream.write(str));

        this.substream = substream;
    }

    offline() {
        if (this.substream) {
            this.substream.off('data', this.onStreamData);
            this.substream.off('end', this.onStreamEnd);
            this.substream = null;
        }
    }
}
```

Data arrives as `ArrayBuffer` instances on the browser side. The `data` event fires for each binary frame the server sends. `substream.write(data)` encodes the data and sends it back as a binary WebSocket frame, where the server routes it into the collator.

The pattern for the browser is: subscribe-and-open through the client's `openStream` export, attach `on('data')` / `on('end')` listeners, wire input, and clean up with `off()` when disconnecting. Named handler functions with `on()`/`off()` are strongly preferred over inline closures — they make cleanup reliable and prevent listener leaks across reconnections. See `SecureChannel/docs/binary streams.md` for the full browser stream API and the `StreamConsumer` lifecycle.

### The framework handles everything in between

Between the Node's `stream.write()` and the browser's `substream.on('data')`, the data crosses multiple process and network boundaries. Here's what the framework does at each one — and why you never need to think about it:

**Node → Worker (binary IPC):** The Node's fanout consumer pump reads from the fanout and sends binary `BinaryFrame` buffers over IPC (the child is forked with advanced serialization, so buffers cross natively). The Worker receives them, resolves the stream against its child uid namespace (`_childStreamIndex`), rewraps the frame from the child uid into the channel uid, and writes it into the channel's SubstreamDuplex fanout.

**Channel → Browser (WebSocket):** The Channel's per-socket fanout consumer pump reads from the fanout and sends a compact 6-byte-header binary frame — a sentinel byte, a frame type, a uint32 stream uid, and the payload — as a native binary WebSocket message. The browser's `onmessage` handler detects the sentinel, parses the header, looks up the stream by uid in its `streamMap`, and delivers the payload to the matching `StreamConsumer`.

**Through a Passthrough:** If the data path crosses an SC3 service boundary (Channel A → Passthrough → Channel B), the Passthrough's embedded WebSocket client receives binary frames from the remote, routes them through a local SubstreamDuplex, and relays them as binary frames over IPC to the parent Worker. The parent Worker rewraps and writes them into its SubstreamDuplex, and the Channel's consumer pump sends them to the browser. The reverse direction works symmetrically, and the Passthrough mirrors subscription deltas onto the remote channel. No application code is needed in the Passthrough subclass.

**Multiplexing:** Multiple streams share the same WebSocket connection and the same IPC channel. Each binary frame carries a uint32 uid in its header, so the framework routes each frame to the correct SubstreamDuplex. You can have dozens of concurrent streams — one per deployment target, one per SSH session — all multiplexed over a single connection per client.

### What the application must not do

Binary streams follow the same trust principle as the rest of SC3: the framework handles the plumbing, and application code that duplicates it is the bug.

**Don't manage UIDs.** The framework assigns uint32 identifiers for binary frame headers, owned by each link's `StreamIndex`. The application uses string streamIds exclusively. If you find yourself reading the uid mapping or passing a `uid` value in a message, you're reaching into framework internals.

**Don't relay stream data manually.** If you're writing code that reads from a SubstreamDuplex and forwards the data to another SubstreamDuplex, something is wrong. The framework's relay system — through Workers, Passthroughs, and Channels — handles this automatically. Manual relay code creates parallel paths that compete with the framework's path.

**Don't cache stream data.** Binary streams are stateless flow, not cached state. If you need to persist stream data (log files, session history), do that as a side effect alongside the stream — write to a file while also writing to the SubstreamDuplex. Don't try to replay binary stream data to late-joining clients through the stream itself; use a separate mechanism (like reading a log file via an RPC export) for history.

**Don't use CachedData for binary content.** CachedData is for JSON-serializable state snapshots. Binary stream data may contain arbitrary byte sequences that don't survive JSON round-trips. Even if the data happens to be valid UTF-8 text, CachedData's deduplication and caching semantics are wrong for continuous byte streams.

**Don't create SubstreamDuplex instances directly.** Always use `this.openStream(streamId)` at the layer you're working in. The framework's `openStream` method handles registration, UID mapping, consumer pump creation, and inter-layer sharing. Constructing a `new SubstreamDuplex()` directly bypasses all of this.

For complete API reference, frame format specification, and detailed data flow diagrams, see `SecureChannel/docs/binary streams.md`.

---

## A Final Word

SC3 rewards developers who learn the model. The framework is opinionated but consistent — once you understand the layers, the data flows, and the trust principle, the framework feels less like a constraint and more like a platform that handles the boring parts so you can focus on the application.

The hardest mental shift is the one from "I should write this carefully" to "I should write less of this." Most of the bugs new SC3 developers introduce come from doing too much work, not too little. The framework wants you to declare intent and stop. Your habits from other systems will pull in the other direction. Resist them.

Read other people's SC3 code. Pay attention to what *isn't* there. The absences — no manual subscription wiring, no event listener attach calls, no defensive try/catch, no fetch endpoints for cached data, no setInterval — are as informative as the presences. They tell you what the framework handles and what your application doesn't need to.

When in doubt: ask whether the framework already does this. The answer is almost always yes. The mental discipline of asking is the difference between writing buggy SC3 code and writing the kind that just works.

Welcome to the platform. Have fun building.