/**
 * Binary Stream Relay Tests
 *
 * Verifies the SubstreamDuplex stream transport end-to-end:
 * - Frame protocol: buildFrame/parseFrame round-trip, frame constants, type coverage
 * - Channel stream API: openStream, closeStream, streamMap mapping, inbound routing
 * - WebSocket hops: native binary frames with uint streamId mapping, JSON coexistence
 * - IPC hops: streamData/streamEnd/streamError JSON messages with string streamId
 * - Node API: Node.openStream advertisement + data upstream
 * - Full-chain echo: client buildFrame → Channel → Worker → Node echo → back to client
 * - Passthrough relay: fanout (remote→local ws) and collator (local ws→remote) through real Passthrough
 */
import {SecureChannel, Driver, Worker} from 'securechannel';
import {BinaryFrame, StreamIndex, QueueIterator} from '../utilities/substreamDuplex.js';
import WebSocket, {WebSocketServer} from 'ws';
import {join, dirname} from 'path';
import {fileURLToPath} from 'url';
import {AsyncSemaphore, exists, isFunction, setOrGet} from 'helpers';
import {EventEmitter} from 'events';
import {PassThrough} from 'stream';

const __dirname = dirname(fileURLToPath(import.meta.url));

let passed = 0;
let total = 0;
const failures = [];
async function test(description, testFn)
{
	total++;
	try
	{
		await testFn();
		console.log(`✓ ${description}`);
		passed++;
	}
	catch (error)
	{
		console.log(`✗ ${description}`);
		console.log(`  Error: ${error.message || error}`);
		failures.push(description);
	}
}
function assert(condition, message = 'Assertion failed')
{
	if (!condition) throw new Error(message);
}
function race(promise, ms = 3000, label = 'operation')
{
	return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(`${label} timed out after ${ms}ms`), ms))]);
}
function waitFor(predicate, ms = 3000, label = 'condition')
{
	return new Promise((resolve, reject) =>
	{
		const start = Date.now();
		const check = setInterval(() =>
		{
			if (predicate()) { clearInterval(check); resolve(); }
			else if (Date.now() - start > ms) { clearInterval(check); reject(`${label} timed out after ${ms}ms`); }
		}, 10);
	});
}
function serverWsOf(channel) { return [...(channel.wss?.clients || [])].find(c => c.readyState === WebSocket.OPEN); }

// --- Helpers ---

function onStreamData(channel, collector)
{
	channel.on('data', data => {
		if (data.type === 'stream') collector.push(data.message);
	});
}

function sendStreamData(channel, ws, payload)
{
	channel.send({type: 'data', message: {type: 'stream', message: payload}}, ws);
}

function createLoopbackPair()
{
	return new Promise(resolve =>
	{
		const serverChannel = new SecureChannel();
		const clientChannel = new SecureChannel();
		const clientFrames = [];
		let serverWs, clientWs;
		const wss = new WebSocketServer({port: 0}, () =>
		{
			const {port} = wss.address();
			wss.on('connection', ws =>
			{
				serverWs = ws;
				Object.assign(serverWs, {isActive() { return this.readyState === WebSocket.OPEN; }});
				serverWs.on('message', message =>
				{
					if (Buffer.isBuffer(message) && message.length >= BinaryFrame.headerSize && message[0] === BinaryFrame.sentinel)
					{
						const parsed = BinaryFrame.parse(message);
						if (!parsed) return;
						const {frameType, uid, payload} = parsed;
						const streamId = serverChannel.streamIndex.getStreamId(uid);
						if (!streamId) return;
						const stream = serverChannel.streamIndex.get(uid);
						if (!stream) return;
						if (frameType === BinaryFrame.data) stream.process(payload);
						else if (frameType === BinaryFrame.close || frameType === BinaryFrame.error) serverChannel.unregisterStream(streamId);
						return;
					}
					try
					{
						const parsed = JSON.parse(message.toString());
						const {type} = parsed;
						if (type) serverChannel.emit(type, parsed.message);
					}
					catch(_) {}
				});
				if (clientWs && clientWs.readyState === WebSocket.OPEN) resolve({serverChannel, serverWs, clientWs, clientChannel, clientFrames, wss});
			});
			clientWs = new WebSocket(`ws://127.0.0.1:${port}`);
			clientWs.binaryType = 'nodebuffer';
			clientWs.isActive = function() { return this.readyState === WebSocket.OPEN; };
			clientWs.on('message', message =>
			{
				if (Buffer.isBuffer(message) && message.length >= BinaryFrame.headerSize && message[0] === BinaryFrame.sentinel)
				{
					const parsed = BinaryFrame.parse(message);
					if (parsed) clientFrames.push(parsed);
					return;
				}
				try
				{
					const parsed = JSON.parse(message.toString());
					const {type} = parsed;
					if (type) clientChannel.emit(type, parsed.message);
				}
				catch(_) {}
			});
			clientChannel.ws = clientWs;
			clientWs.on('open', () =>
			{
				if (serverWs) resolve({serverChannel, serverWs, clientWs, clientChannel, clientFrames, wss});
			});
		});
	});
}

async function cleanup(pair)
{
	pair.clientWs.close();
	pair.wss.close();
	await new Promise(r => setTimeout(r, 50));
}

function createWorkerSetup(driverName = 'binary-emitter')
{
	const controller = {
		_state: {cache: {}, nodes: {}},
		cache(...args) { const [path, value, overwrite] = args; return setOrGet(this._state.cache, path || [], value, overwrite); },
		nodes(...args) {
			const socket = (typeof args[0] === 'object' && !Array.isArray(args[0])) ? args.shift() : null;
			const [path, flag, overwrite] = args;
			const state = setOrGet(this._state.nodes, path || [], flag, overwrite);
			if (exists(flag) && isFunction(socket?.data))
			{
				const [domain, node] = path;
				socket.data('nodes', {[domain]:{[node]:state}});
			}
			return state;
		},
		channels: {}, devices: {},
		setState(p, v) { setOrGet(this._state, p, v); },
		getState(p) { return setOrGet(this._state, p); }
	};
	const channel = new SecureChannel();
	channel.id = 'test';
	channel.controller = controller;
	channel.drivers = {};
	channel.sources = {};
	channel.sinks = {};
	channel.exports = {};
	channel._ready_semaphore = new AsyncSemaphore(true);
	channel.channelReady = true;
	const driver = new Driver(driverName);
	driver.driverPath = join(__dirname, 'fixtures');
	driver.join(channel);
	driver._ready_semaphore = new AsyncSemaphore(true);
	driver._healthy_semaphore = new AsyncSemaphore(true);
	return {channel, driver};
}

async function spawnWorker(driver, persistent = false)
{
	const node = 'testnode';
	const worker = new Worker(driver, node, `s-${Date.now()}`, {persistent});
	driver.workers[node] = worker;
	await race(worker.onReady, 5000, 'worker ready');
	return worker;
}

function createEchoServer()
{
	return new Promise(resolve =>
	{
		const {channel, driver} = createWorkerSetup('node-emitter');
		channel.listen({port: 0});
		channel.on('listening', async () =>
		{
			const port = channel.server.address().port;
			const worker = await spawnWorker(driver);
			const close = () => { worker.destroy(); channel.server?.close(); channel.wss?.close(); };
			resolve({channel, worker, port, close});
		});
	});
}

function connectClient(port)
{
	return new Promise(resolve =>
	{
		const ws = new WebSocket(`ws://127.0.0.1:${port}`);
		ws.binaryType = 'nodebuffer';
		const frames = [];
		ws.on('open', () => resolve({ws, frames}));
		ws.on('message', message =>
		{
			if (Buffer.isBuffer(message) && message.length >= BinaryFrame.headerSize && message[0] === BinaryFrame.sentinel)
			{
				const parsed = BinaryFrame.parse(message);
				if (parsed) frames.push(parsed);
			}
		});
	});
}

function createRemoteServer()
{
	return new Promise(resolve =>
	{
		const channel = new SecureChannel({
			open() { this.message('checkin', {nodes: {}}); },
			up() {},
			exports() { this.message('import', {exports: []}); },
			checkin() { this.message('ready', {}); },
			data() {}
		});
		channel.listen({port: 0});
		channel.on('listening', () =>
		{
			const port = channel.server.address().port;
			const close = () => { channel.server?.close(); channel.wss?.close(); };
			resolve({channel, port, close});
		});
	});
}

// --- In-process child process: parent and child are isolated, communicating only across this IPC boundary ---

class ChildInterface extends EventEmitter
{
	connected = false
	peer = null
	stdin = null
	stdout = null
	stderr = null
	send(frame) { this.peer.emit('message', frame); }
	kill() { this.connected = false; this.peer.emit('disconnect'); }
	static fork(boot, args = [])
	{
		const child = new ChildInterface();
		const argv = [process.argv[0], boot.name || 'driver', ...args];
		new ProcessInterface(child, boot, argv);
		return child;
	}
	constructor() { super(); }
}

class ProcessInterface extends EventEmitter
{
	connected = true
	peer = null
	argv = null
	stdin = null
	stdout = null
	stderr = null
	exit() { this.peer.connected = false; this.peer.emit('close'); }
	send(frame) { this.peer.emit('message', frame); }
	constructor(child, boot, argv)
	{
		super();
		this.peer = child;
		this.argv = argv;
		this.stdin = new PassThrough();
		this.stdout = new PassThrough();
		this.stderr = new PassThrough();
		child.peer = this;
		child.stdin = this.stdin;
		child.stdout = this.stdout;
		child.stderr = this.stderr;
		child.connected = true;
		setImmediate(() => boot(this));
	}
}

// Parent-side consumer: builds its own stream index from advertisements received over IPC and
// routes inbound binary frames into its own substreams. It never reaches into the child.
class Parent extends EventEmitter
{
	streamIndex = new StreamIndex()
	ready = new AsyncSemaphore(false)
	child = null
	message(type, message) { this.child.send({type, message}); }
	sendInput(streamId, payload)
	{
		const uid = this.streamIndex.getUID(streamId);
		if (uid !== undefined) this.child.send(BinaryFrame.build(BinaryFrame.data, uid, payload));
	}
	streamFor(streamId) { return this.streamIndex.get(streamId); }
	receive(frame)
	{
		const parsed = BinaryFrame.parse(frame);
		if (parsed) { this.streamIndex.get(parsed.uid)?.write(parsed.payload); return; }
		if (!frame || typeof frame !== 'object') return;
		const {type, message} = frame;
		if (type === 'checkin') { this.ready.open(); return; }
		if (type !== 'streams') return;
		const onOpen = (streamId, uid) => { this.streamIndex.add(streamId, uid, new QueueIterator()); this.emit('stream', {action: 'open', streamId}); };
		const onClose = streamId => { this.streamIndex.get(streamId)?.end(); this.streamIndex.delete(streamId); this.emit('stream', {action: 'close', streamId}); };
		this.streamIndex.reconcileStreams(message?.streams || [], onOpen, onClose);
	}
	constructor(child)
	{
		super();
		this.child = child;
		child.on('message', frame => this.receive(frame));
	}
}

async function spawnChild(driverName, args = ['testnode', 'test-session'])
{
	const {default: boot} = await import(`./fixtures/${driverName}.js`);
	const child = ChildInterface.fork(boot, args);
	const parent = new Parent(child);
	await race(parent.ready.status, 5000, 'child checkin');
	return {parent, child};
}

console.log('\n=== Binary Stream Relay Tests ===\n');

// ═══════════════════════════════════════════════════════════════
// SECTION 1: Frame protocol
// ═══════════════════════════════════════════════════════════════

console.log('--- Frame Protocol ---\n');

await test('FRAME-1: buildFrame and parseFrame round-trip', async () =>
{
	const payload = Buffer.from('test data');
	const built = BinaryFrame.build(BinaryFrame.data, 42, payload);
	assert(built[0] === BinaryFrame.sentinel, 'sentinel byte');
	assert(built[1] === BinaryFrame.data, 'frame type');
	assert(built.readUInt32BE(2) === 42, 'stream id');
	const parsed = BinaryFrame.parse(built);
	assert(parsed.frameType === BinaryFrame.data, 'parsed type');
	assert(parsed.uid === 42, 'parsed id');
	assert(parsed.payload.toString() === 'test data', 'parsed payload');
});

await test('FRAME-2: parseFrame rejects invalid frames', async () =>
{
	assert(BinaryFrame.parse(Buffer.from('hello')) === null, 'non-sentinel');
	assert(BinaryFrame.parse(Buffer.alloc(3)) === null, 'too short');
	assert(BinaryFrame.parse('not a buffer') === null, 'not buffer');
});

await test('FRAME-3: frame constants are correct', async () =>
{
	assert(BinaryFrame.sentinel === 0xFE, 'sentinel');
	assert(BinaryFrame.data === 0x01, 'data');
	assert(BinaryFrame.open === 0x02, 'open');
	assert(BinaryFrame.close === 0x03, 'close');
	assert(BinaryFrame.error === 0x04, 'error');
});

await test('FRAME-4: all frame types round-trip', async () =>
{
	for (const [name, type] of [['open', BinaryFrame.open], ['close', BinaryFrame.close], ['error', BinaryFrame.error]])
	{
		const payload = type === BinaryFrame.error ? Buffer.from('error message') : Buffer.alloc(0);
		const built = BinaryFrame.build(type, 100, payload);
		const parsed = BinaryFrame.parse(built);
		assert(parsed.frameType === type, `${name}: parsed type`);
		assert(parsed.uid === 100, `${name}: parsed uid`);
		if (type === BinaryFrame.error) assert(parsed.payload.toString() === 'error message', `${name}: payload`);
	}
});

// ═══════════════════════════════════════════════════════════════
// SECTION 2: Channel stream API
// ═══════════════════════════════════════════════════════════════

console.log('\n--- Channel Stream API ---\n');

await test('API-1: openStream creates SubstreamDuplex', async () =>
{
	const ch = new SecureChannel();
	const stream = ch.registerStream('mystream');
	assert(stream.ended === false, 'not ended');
	assert(ch.streamIndex.has('mystream'), 'registered in streamIndex');
});

await test('API-2: openStream returns same stream for same id', async () =>
{
	const ch = new SecureChannel();
	const s1 = ch.registerStream('s1');
	const s2 = ch.registerStream('s1');
	assert(s1 === s2, 'same reference');
});

await test('API-3: streamMap maps string to uint and back', async () =>
{
	const ch = new SecureChannel();
	ch.registerStream('test-stream');
	assert(ch.streamIndex.has('test-stream'), 'streamId registered');
	const uid = ch.streamIndex.getUID('test-stream');
	assert(ch.streamIndex.getStreamId(uid) === 'test-stream', 'uid resolves back to streamId');
});

await test('API-4: closeStream removes stream and cleans up mapping', async () =>
{
	const ch = new SecureChannel();
	ch.registerStream('cleanup');
	const uid = ch.streamIndex.getUID('cleanup');
	ch.unregisterStream('cleanup');
	assert(!ch.streamIndex.has('cleanup'), 'stream removed');
	assert(ch.streamIndex.getUID('cleanup') === undefined, 'streamId mapping removed');
	assert(ch.streamIndex.getStreamId(uid) === undefined, 'uid mapping removed');
});

await test('API-5: inbound CLOSE frame closes stream', async () =>
{
	const pair = await createLoopbackPair();
	await new Promise(r => setTimeout(r, 50));
	pair.serverChannel.registerStream('close-test');
	const uid = pair.serverChannel.streamIndex.getUID('close-test');
	assert(pair.serverChannel.streamIndex.has('close-test'), 'stream exists');
	pair.clientWs.send(BinaryFrame.build(BinaryFrame.close, uid, null));
	await new Promise(r => setTimeout(r, 200));
	assert(!pair.serverChannel.streamIndex.has('close-test'), 'stream closed by inbound CLOSE');
	await cleanup(pair);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 3: WebSocket stream advertisement transit
// ═══════════════════════════════════════════════════════════════

console.log('\n--- WebSocket Stream Advertisement Transit ---\n');

await test('WS-1: stream advertisement transits WebSocket with payload intact', async () =>
{
	const pair = await createLoopbackPair();
	await new Promise(r => setTimeout(r, 50));
	const received = [];
	onStreamData(pair.clientChannel, received);
	sendStreamData(pair.serverChannel, pair.serverWs, {action: 'open', streamId: 'cam-1', metadata: {codec: 'h264'}});
	sendStreamData(pair.serverChannel, pair.serverWs, {action: 'close', streamId: 'cam-1'});
	await new Promise(r => setTimeout(r, 200));
	assert(received.length === 2, `expected 2, got ${received.length}`);
	assert(received[0].action === 'open' && received[0].streamId === 'cam-1', 'open advertisement');
	assert(received[0].metadata.codec === 'h264', 'metadata preserved');
	assert(received[1].action === 'close' && received[1].streamId === 'cam-1', 'close advertisement');
	await cleanup(pair);
});

await test('WS-2: multiple streamIds disambiguated', async () =>
{
	const pair = await createLoopbackPair();
	await new Promise(r => setTimeout(r, 50));
	const streams = {'s1': [], 's2': [], 's3': []};
	pair.clientChannel.on('data', data => {
		if (data.type === 'stream' && streams[data.message.streamId]) streams[data.message.streamId].push(data.message);
	});
	sendStreamData(pair.serverChannel, pair.serverWs, {action: 'open', streamId: 's1', metadata: {}});
	sendStreamData(pair.serverChannel, pair.serverWs, {action: 'open', streamId: 's2', metadata: {}});
	sendStreamData(pair.serverChannel, pair.serverWs, {action: 'open', streamId: 's3', metadata: {}});
	sendStreamData(pair.serverChannel, pair.serverWs, {action: 'close', streamId: 's1'});
	await new Promise(r => setTimeout(r, 200));
	assert(streams['s1'].length === 2 && streams['s2'].length === 1 && streams['s3'].length === 1, 'stream counts');
	assert(streams['s1'][0].action === 'open' && streams['s1'][1].action === 'close', 'stream 1 lifecycle');
	await cleanup(pair);
});

await test('WS-3: bidirectional advertisement transit', async () =>
{
	const pair = await createLoopbackPair();
	await new Promise(r => setTimeout(r, 50));
	const clientReceived = [];
	const serverReceived = [];
	onStreamData(pair.clientChannel, clientReceived);
	pair.serverChannel.on('data', data => { if (data.type === 'stream') serverReceived.push(data.message); });
	sendStreamData(pair.serverChannel, pair.serverWs, {action: 'open', streamId: 'downstream', metadata: {}});
	pair.clientChannel.send({type: 'data', message: {type: 'stream', message: {action: 'open', streamId: 'upstream', metadata: {}}}});
	await new Promise(r => setTimeout(r, 200));
	assert(clientReceived.length === 1 && clientReceived[0].streamId === 'downstream', 'downstream');
	assert(serverReceived.length === 1 && serverReceived[0].streamId === 'upstream', 'upstream');
	await cleanup(pair);
});

await test('WS-4: native binary frames coexist with stream advertisements', async () =>
{
	const pair = await createLoopbackPair();
	await new Promise(r => setTimeout(r, 50));
	const adverts = [];
	onStreamData(pair.clientChannel, adverts);
	pair.serverChannel.registerStream('bin-test');
	const uid = pair.serverChannel.streamIndex.getUID('bin-test');
	pair.serverChannel.subscribeStream('bin-test', uid, pair.serverWs);
	sendStreamData(pair.serverChannel, pair.serverWs, {action: 'open', streamId: 'other', metadata: {}});
	pair.serverChannel.streamIndex.get('bin-test').write(BinaryFrame.build(BinaryFrame.data, uid, Buffer.from('binary-payload')));
	await new Promise(r => setTimeout(r, 200));
	assert(adverts.length === 1 && adverts[0].streamId === 'other', 'advertisement intact');
	const streamFrames = pair.clientFrames.filter(f => f.frameType === BinaryFrame.data);
	assert(streamFrames.length === 1 && streamFrames[0].payload.toString() === 'binary-payload', 'binary frame intact');
	await cleanup(pair);
});

await test('WS-5: coexists with JSON messages', async () =>
{
	const pair = await createLoopbackPair();
	await new Promise(r => setTimeout(r, 50));
	const streamMessages = [];
	const jsonMessages = [];
	onStreamData(pair.clientChannel, streamMessages);
	pair.clientChannel.on('status', data => jsonMessages.push(data));
	sendStreamData(pair.serverChannel, pair.serverWs, {action: 'open', streamId: 'test', metadata: {}});
	pair.serverChannel.message('status', {ok: true}, pair.serverWs);
	await new Promise(r => setTimeout(r, 200));
	assert(streamMessages.length === 1, 'stream received');
	assert(jsonMessages.length === 1 && jsonMessages[0].ok === true, 'json received');
	await cleanup(pair);
});

await test('WS-6: large metadata payload (64KB)', async () =>
{
	const pair = await createLoopbackPair();
	await new Promise(r => setTimeout(r, 50));
	const received = [];
	onStreamData(pair.clientChannel, received);
	const large = 'x'.repeat(65536);
	sendStreamData(pair.serverChannel, pair.serverWs, {action: 'open', streamId: 'big', metadata: {description: large}});
	await new Promise(r => setTimeout(r, 500));
	assert(received.length === 1 && received[0].metadata.description.length === 65536, '64KB intact');
	await cleanup(pair);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 4: Worker IPC stream transit
// ═══════════════════════════════════════════════════════════════

console.log('\n--- Worker IPC Stream Transit ---\n');

await test('IPC-1: child streams data upstream across the IPC boundary', async () =>
{
	const {parent, child} = await spawnChild('node-emitter');
	try
	{
		const received = [];
		const done = new Promise(resolve => {
			parent.on('stream', msg => {
				if (msg.action !== 'open') return;
				const stream = parent.streamFor(msg.streamId);
				const pump = async () => { for await (const chunk of stream) { received.push(chunk); if (received.length >= 3) {resolve(); break;} } };
				pump();
			});
		});
		parent.message('startStream', {streamId: 'test-42', chunks: ['test1', 'test2', 'test3']});
		await race(done, 3000, 'IPC upstream');
		assert(received.length === 3, `expected 3 DATA, got ${received.length}`);
		assert(received[0].toString() === 'test1' && received[2].toString() === 'test3', 'DATA payloads');
	}
	finally { child.kill(); await new Promise(r => setTimeout(r, 50)); }
});

await test('IPC-2: multiple streamIds disambiguated', async () =>
{
	const {parent, child} = await spawnChild('node-emitter');
	try
	{
		const streams = {};
		const count = {value: 0};
		const bothOpen = new Promise(resolve => {
			parent.on('stream', msg => {
				if (msg.action !== 'open') return;
				streams[msg.streamId] = parent.streamFor(msg.streamId);
				if (++count.value === 2) resolve();
			});
		});
		parent.message('startStream', {streamId: 'stream-1', chunks: ['a', 'b']});
		parent.message('startStream', {streamId: 'stream-2', chunks: ['x']});
		await race(bothOpen, 3000, 'both streams');
		assert(streams['stream-1'] && streams['stream-2'], 'both streams created and disambiguated');
		assert(parent.streamIndex.getUID('stream-1') !== parent.streamIndex.getUID('stream-2'), 'distinct uids');
	}
	finally { child.kill(); await new Promise(r => setTimeout(r, 50)); }
});

await test('IPC-3: large payload (64KB)', async () =>
{
	const {parent, child} = await spawnChild('node-emitter');
	try
	{
		const received = [];
		const done = new Promise(resolve => {
			parent.on('stream', msg => {
				if (msg.action !== 'open') return;
				const stream = parent.streamFor(msg.streamId);
				const pump = async () => { for await (const chunk of stream) { received.push(chunk); resolve(); } };
				pump();
			});
		});
		parent.message('startStream', {streamId: 'big', chunks: ['x'.repeat(65536)]});
		await race(done, 3000, '64KB');
		assert(received.length >= 1 && received[0].length === 65536, '64KB intact through IPC');
	}
	finally { child.kill(); await new Promise(r => setTimeout(r, 50)); }
});

await test('IPC-4: streamEnd closes stream on Worker', async () =>
{
	const {parent, child} = await spawnChild('node-emitter');
	try
	{
		const opened = new Promise(resolve => {
			parent.on('stream', msg => { if (msg.action === 'open') resolve(); });
		});
		parent.message('startStream', {streamId: 'close-test', chunks: ['data'], close: true});
		await race(opened, 3000, 'stream open');
		await new Promise(r => setTimeout(r, 300));
		assert(!parent.streamIndex.has('close-test'), 'stream closed after removal advertisement');
	}
	finally { child.kill(); await new Promise(r => setTimeout(r, 50)); }
});

// ═══════════════════════════════════════════════════════════════
// SECTION 5: Node stream API
// ═══════════════════════════════════════════════════════════════

console.log('\n--- Node Stream API ---\n');

await test('NODE-1: Node subclass openStream sends advertisement + data upstream', async () =>
{
	const {parent, child} = await spawnChild('node-emitter');
	try
	{
		const received = [];
		const done = new Promise(resolve => {
			parent.on('stream', msg => {
				if (msg.action !== 'open') return;
				const stream = parent.streamFor(msg.streamId);
				const pump = async () => { for await (const chunk of stream) { received.push(chunk); if (received.length >= 2) {resolve(); break;} } };
				pump();
			});
		});
		parent.message('startStream', {streamId: 'node-7', chunks: ['alpha', 'beta']});
		await race(done, 5000, 'Node upstream');
		assert(received.length === 2, `expected 2 DATA, got ${received.length}`);
		assert(received[0].toString() === 'alpha' && received[1].toString() === 'beta', 'payloads intact');
	}
	finally { child.kill(); await new Promise(r => setTimeout(r, 50)); }
});

await test('NODE-2: Node subclass echo round-trip via SubstreamDuplex', async () =>
{
	const {parent, child} = await spawnChild('node-emitter');
	try
	{
		const received = [];
		const streamReady = new Promise(resolve => {
			parent.on('stream', msg => {
				if (msg.action !== 'open') return;
				const stream = parent.streamFor(msg.streamId);
				const pump = async () => { for await (const chunk of stream) { received.push(chunk); if (received.length >= 1) break; } };
				pump();
				resolve();
			});
		});
		parent.message('echoStream', {streamId: 'echo-3'});
		await race(streamReady, 5000, 'stream open');
		parent.sendInput('echo-3', 'from-parent');
		await new Promise(r => setTimeout(r, 500));
		assert(received.length >= 1, `expected echo, got ${received.length}`);
		assert(received[0].toString() === 'from-parent', 'echo intact through Node SubstreamDuplex');
	}
	finally { child.kill(); await new Promise(r => setTimeout(r, 50)); }
});

// ═══════════════════════════════════════════════════════════════
// SECTION 6: Full-chain echo (client → Channel → Worker → Node → back)
// ═══════════════════════════════════════════════════════════════

console.log('\n--- Full-Chain Echo ---\n');

// Drives the real server inbound binary path: client ws → channel.listen()'s serverSocketEvents.message
// → resolveStream(channel.streamIndex).process → Worker forwardToIPC → Node echo → fanout → subscribed client.
// This is the keystroke scenario; it exercises the same handler the live shell hit.
async function echoStream(server, streamId)
{
	const ready = waitFor(() => server.channel.streamIndex.has(streamId), 5000, 'stream registered on channel');
	server.worker.message('echoStream', {streamId});
	await ready;
	const uid = server.channel.streamIndex.getUID(streamId);
	server.channel.subscribeStream(streamId, uid, serverWsOf(server.channel));
	await new Promise(r => setTimeout(r, 50));
	return uid;
}

await test('ECHO-1: client binary input echoes back through real server inbound path (client→listen→Worker→Node→client)', async () =>
{
	const server = await createEchoServer();
	const {ws, frames} = await connectClient(server.port);
	try
	{
		const uid = await echoStream(server, 'echo-full-1');
		ws.send(BinaryFrame.build(BinaryFrame.data, uid, Buffer.from('keystroke-abc')));
		await waitFor(() => frames.filter(f => f.frameType === BinaryFrame.data).length >= 1, 5000, 'echoed frame at client');
		const dataFrames = frames.filter(f => f.frameType === BinaryFrame.data);
		assert(dataFrames[0].payload.toString() === 'keystroke-abc', 'payload intact through full chain echo');
	}
	finally { ws.close(); server.close(); await new Promise(r => setTimeout(r, 200)); }
});

await test('ECHO-2: burst of 5 binary inputs echo back in order through real inbound path', async () =>
{
	const server = await createEchoServer();
	const {ws, frames} = await connectClient(server.port);
	try
	{
		const uid = await echoStream(server, 'echo-full-5');
		for (let i = 0; i < 5; i++) ws.send(BinaryFrame.build(BinaryFrame.data, uid, Buffer.from(`key-${i}`)));
		await waitFor(() => frames.filter(f => f.frameType === BinaryFrame.data).length >= 5, 5000, '5 echoed frames at client');
		const dataFrames = frames.filter(f => f.frameType === BinaryFrame.data);
		assert(dataFrames.length === 5, `expected 5 echoed frames, got ${dataFrames.length}`);
		for (let i = 0; i < 5; i++) assert(dataFrames[i].payload.toString() === `key-${i}`, `ordering at ${i}`);
	}
	finally { ws.close(); server.close(); await new Promise(r => setTimeout(r, 200)); }
});

await test('ECHO-3: non-UTF8 binary input echoes back byte-exact through real inbound path', async () =>
{
	const server = await createEchoServer();
	const {ws, frames} = await connectClient(server.port);
	try
	{
		const uid = await echoStream(server, 'echo-full-bin');
		const raw = Buffer.from([0x00, 0x01, 0x7F, 0x80, 0xFE, 0xFF]);
		ws.send(BinaryFrame.build(BinaryFrame.data, uid, raw));
		await waitFor(() => frames.filter(f => f.frameType === BinaryFrame.data).length >= 1, 5000, 'echoed frame at client');
		const dataFrames = frames.filter(f => f.frameType === BinaryFrame.data);
		assert(dataFrames.length === 1, `expected 1 echoed frame, got ${dataFrames.length}`);
		const echoed = dataFrames[0].payload;
		assert(echoed.length === raw.length, `payload length: ${echoed.length}`);
		for (let i = 0; i < raw.length; i++) assert(echoed[i] === raw[i], `byte ${i}: expected ${raw[i]}, got ${echoed[i]}`);
	}
	finally { ws.close(); server.close(); await new Promise(r => setTimeout(r, 200)); }
});

// ═══════════════════════════════════════════════════════════════
// SECTION 7: Passthrough binary relay (real forked Passthrough)
// ═══════════════════════════════════════════════════════════════

console.log('\n--- Passthrough Binary Relay ---\n');

// Boots a real forked Passthrough connected to `remote`, with the local channel listening so the
// Passthrough's parent Worker is wired exactly as in production. Returns once the worker is ready.
async function bootPassthrough(remote)
{
	process.env.RELAY_SERVER_PORT = String(remote.port);
	const {driver, channel} = createWorkerSetup('passthrough-relay');
	channel.listen({port: 0});
	await new Promise(resolve => channel.on('listening', resolve));
	const worker = await spawnWorker(driver);
	await new Promise(r => setTimeout(r, 300));
	return {driver, channel, worker, port: channel.server.address().port};
}

// Drives a real 'streams' advertisement from the remote server. The Passthrough receives it over its
// remote socket → forwardToIPC → populateStreams → Passthrough.openStream, then re-emits upward to the
// local Worker → channel.streamIndex. A throw anywhere in that chain (e.g. socket.streams.has) drops it.
await test('PT-1: stream advertisement propagates remote → Passthrough → local channel (real relay)', async () =>
{
	const remote = await createRemoteServer();
	let pt;
	try
	{
		pt = await bootPassthrough(remote);
		const streamId = 'pt-advert';
		remote.channel.registerStream(streamId);
		remote.channel.publishStreams();
		await waitFor(() => pt.channel.streamIndex.has(streamId), 5000, 'advert propagated through Passthrough to local channel');
		assert(pt.channel.streamIndex.has(streamId), 'remote advertisement reached local channel through Passthrough relay');
	}
	finally
	{
		delete process.env.RELAY_SERVER_PORT;
		if (pt?.worker) pt.worker.destroy();
		pt?.channel.server?.close(); pt?.channel.wss?.close(); remote.close();
		await new Promise(r => setTimeout(r, 200));
	}
});

// Drives a local client's binary keystroke down through the real local server inbound path
// (serverSocketEvents.message → channel collator → Worker → IPC → Passthrough collator → remote socket),
// landing at the remote server's real inbound handler. Exercises both ends' inbound binary routing.
await test('PT-2: local client keystroke reaches remote server via Passthrough collator relay', async () =>
{
	const remote = await createRemoteServer();
	const remoteBinary = [];
	let pt, client;
	try
	{
		pt = await bootPassthrough(remote);
		const streamId = 'pt-collator';
		remote.channel.registerStream(streamId);
		remote.channel.publishStreams();
		await waitFor(() => pt.channel.streamIndex.has(streamId), 5000, 'advert propagated to local channel');
		const uid = pt.channel.streamIndex.getUID(streamId);
		const remoteWs = serverWsOf(remote.channel);
		remoteWs.on('message', message =>
		{
			const parsed = BinaryFrame.parse(message);
			if (parsed && parsed.frameType === BinaryFrame.data) remoteBinary.push(parsed);
		});
		client = await connectClient(pt.port);
		client.ws.send(BinaryFrame.build(BinaryFrame.data, uid, Buffer.from('keystroke-A')));
		client.ws.send(BinaryFrame.build(BinaryFrame.data, uid, Buffer.from('keystroke-B')));
		await waitFor(() => remoteBinary.length >= 2, 5000, 'binary frames at remote server');
		assert(remoteBinary.length >= 2, `expected 2 frames at remote, got ${remoteBinary.length}`);
		assert(remoteBinary[0].payload.toString() === 'keystroke-A', 'keystroke A: client → local listen → Worker → Passthrough → remote');
		assert(remoteBinary[1].payload.toString() === 'keystroke-B', 'keystroke B: full Passthrough collator relay');
	}
	finally
	{
		delete process.env.RELAY_SERVER_PORT;
		if (pt?.worker) pt.worker.destroy();
		client?.ws.close(); pt?.channel.server?.close(); pt?.channel.wss?.close(); remote.close();
		await new Promise(r => setTimeout(r, 200));
	}
});

await test('PT-3: JSON messages unaffected by binary stream relay', async () =>
{
	const remote = await createRemoteServer();
	process.env.RELAY_SERVER_PORT = String(remote.port);
	const jsonReceived = [];
	remote.channel.on('message', (data) => { jsonReceived.push(data); });
	const {driver} = createWorkerSetup('passthrough-relay');
	driver.subscribe({stream() { return false; }});
	let worker;
	try
	{
		worker = await spawnWorker(driver);
		await new Promise(r => setTimeout(r, 300));
		worker.message('message', {type: 'testping', message: {v: 42}});
		await new Promise(r => setTimeout(r, 300));
		const pings = jsonReceived.filter(m => m.type === 'testping');
		assert(pings.length >= 1, `expected JSON at server, got ${pings.length}`);
		assert(pings[0].message.v === 42, 'JSON payload intact');
	}
	finally
	{
		delete process.env.RELAY_SERVER_PORT;
		if (worker) worker.destroy();
		remote.close();
		await new Promise(r => setTimeout(r, 200));
	}
});

// ═══════════════════════════════════════════════════════════════
// SECTION 8: Edge cases
// ═══════════════════════════════════════════════════════════════

console.log('\n--- Edge Cases ---\n');

await test('EDGE-1: empty, null, and undefined payloads via advertisement', async () =>
{
	const pair = await createLoopbackPair();
	await new Promise(r => setTimeout(r, 50));
	const received = [];
	onStreamData(pair.clientChannel, received);
	sendStreamData(pair.serverChannel, pair.serverWs, {action: 'open', streamId: 'e1', metadata: {data: ''}});
	sendStreamData(pair.serverChannel, pair.serverWs, {action: 'open', streamId: 'e2', metadata: {data: null}});
	sendStreamData(pair.serverChannel, pair.serverWs, {action: 'open', streamId: 'e3', metadata: {}});
	await new Promise(r => setTimeout(r, 200));
	assert(received.length === 3, `got ${received.length}`);
	assert(received[0].metadata.data === '', 'empty string preserved');
	assert(received[1].metadata.data === null, 'null preserved');
	await cleanup(pair);
});

await test('EDGE-2: burst of 100 advertisements over WebSocket', async () =>
{
	const pair = await createLoopbackPair();
	await new Promise(r => setTimeout(r, 50));
	const received = [];
	onStreamData(pair.clientChannel, received);
	for (let i = 0; i < 100; i++) sendStreamData(pair.serverChannel, pair.serverWs, {action: 'open', streamId: `burst-${i}`, metadata: {index: i}});
	await new Promise(r => setTimeout(r, 1000));
	assert(received.length === 100, `expected 100, got ${received.length}`);
	for (let i = 0; i < 100; i++) assert(received[i].metadata.index === i, `ordering at ${i}`);
	await cleanup(pair);
});

await test('EDGE-3: burst of 50 stream data over IPC', async () =>
{
	const {parent, child} = await spawnChild('node-emitter');
	try
	{
		const received = [];
		const done = new Promise(resolve => {
			parent.on('stream', msg => {
				if (msg.action !== 'open') return;
				const stream = parent.streamFor(msg.streamId);
				const pump = async () => { for await (const chunk of stream) { received.push(chunk); if (received.length >= 50) resolve(); } };
				pump();
			});
		});
		parent.message('startStream', {streamId: 'burst-ipc', chunks: Array.from({length: 50}, (_, i) => `ipc-${i}`)});
		await race(done, 5000, 'burst IPC');
		assert(received.length === 50, `expected 50, got ${received.length}`);
		for (let i = 0; i < 50; i++) assert(received[i].toString() === `ipc-${i}`, `ordering at ${i}`);
	}
	finally { child.kill(); await new Promise(r => setTimeout(r, 50)); }
});

await test('EDGE-4: special characters in advertisement metadata', async () =>
{
	const pair = await createLoopbackPair();
	await new Promise(r => setTimeout(r, 50));
	const received = [];
	onStreamData(pair.clientChannel, received);
	const special = '\x00\x01\n\r\t"\\{}[]<>&\u0000\uFFFF';
	sendStreamData(pair.serverChannel, pair.serverWs, {action: 'open', streamId: 'special', metadata: {chars: special}});
	await new Promise(r => setTimeout(r, 200));
	assert(received.length === 1 && received[0].metadata.chars === special, 'special chars preserved');
	await cleanup(pair);
});

await test('EDGE-5: nested object in advertisement metadata', async () =>
{
	const pair = await createLoopbackPair();
	await new Promise(r => setTimeout(r, 50));
	const received = [];
	onStreamData(pair.clientChannel, received);
	const nested = {level1: {level2: {arr: [1, 2, {deep: true}]}, flag: false}};
	sendStreamData(pair.serverChannel, pair.serverWs, {action: 'open', streamId: 'nested', metadata: nested});
	await new Promise(r => setTimeout(r, 200));
	assert(received[0].metadata.level1.level2.arr[2].deep === true, 'deep nesting preserved');
	await cleanup(pair);
});

// ═══════════════════════════════════════════════════════════════

console.log(`\n${passed}/${total} tests passed`);
if (failures.length) { console.log('Failures:', failures); process.exit(1); }
process.exit(0);
