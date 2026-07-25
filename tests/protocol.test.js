const {EventEmitter} = require('events');
const {assign} = require('helpers');
const {ClientProtocol, ServerProtocol} = require('./utilities/protocol.js');
let passed = 0, failed = 0;
const check = (label, condition) => {
	condition ? passed++ : failed++;
	console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`);
};
const tick = () => new Promise(resolve => setImmediate(resolve));
const run = async () => {
	// ---- ServerProtocol unit cases ----
	const logs = [];
	const host = {
		exports: {
			echo: async args => ({echoed: args}),
			context: async function() {return this === host;},
			boom: async () => {throw new Error('native fault');},
			strfail: async () => {throw 'string failure';},
			emptyfail: async () => {throw '';},
			objfail: async () => {throw {code: 500};},
			never: () => new Promise(() => {})
		},
		log: (...args) => logs.push(args),
		onReady: Promise.resolve(true)
	};
	const sp = new ServerProtocol(host);
	const sent = [];
	const context = {Address: '1.2.3.4', SessionID: 'client@1.2.3.4', message: (type, message) => sent.push({type, message})};

	// dispatch: result, undefined args normalization, context binding
	check('execute echoes args', (await sp.execute('echo', {a: 1}, 1, context)).echoed.a === 1);
	check('execute normalizes undefined args to {}', JSON.stringify((await sp.execute('echo', undefined, 2, context)).echoed) === '{}');
	check('default invoke binds host context', await sp.execute('context', {}, 3, context) === true);
	// dispatch: error normalization
	const expectThrow = async (command, expected, label) => {
		try {await sp.execute(command, {}, 0, context); check(label, false);}
		catch (error) {check(label, JSON.stringify(error) === JSON.stringify(expected));}
	};
	await expectThrow('nope', 'unknown command: nope', 'unknown command throws string');
	await expectThrow('boom', 'native fault', 'native Error stringified via reason()');
	await expectThrow('strfail', 'string failure', 'framework string passes untouched');
	await expectThrow('emptyfail', 'runtime exception in emptyfail', 'empty throw hits fallback');
	await expectThrow('objfail', {code: 500}, 'application object passes through (v3 parity)');
	check('local log captured raw exception', logs.some(([, msg, meta]) => /boom failed/.test(msg) && meta?.error instanceof Error));
	check('log meta carries request origin address', logs.some(([, , meta]) => meta?.address === '1.2.3.4'));

	// request: wire envelope round trip with Channel-style decoration
	assign({decorate: (args, l, envelope) => ({...args, sessionid: envelope?.SessionID || null})}).to(sp);
	sp.request({key: 77, request: {command: 'echo', x: 9}, SessionID: 'sess@9.9.9.9'}, context);
	await tick();
	const reply = sent.find(({type, message}) => type === 'response' && message.key === 77);
	check('response envelope shape {key, result:{result}}', !!reply && reply.message.result.result.echoed.x === 9);
	check('decorate injected envelope SessionID as sessionid', reply.message.result.result.echoed.sessionid === 'sess@9.9.9.9');
	sp.request({key: 78, request: {command: 'nope'}}, context);
	await tick();
	const errReply = sent.find(({message}) => message.key === 78);
	check('error response envelope {key, result:{error}}', errReply.message.result.error === 'unknown command: nope');

	// provider handshake halves
	sent.length = 0;
	let statePushed = null;
	assign({pushState: socket => statePushed = socket}).to(sp);
	await sp.publishExports(context);
	const imported = sent.find(({type}) => type === 'import');
	check('publishExports advertises live command list', imported && imported.message.exports.includes('echo') && imported.message.exports.includes('boom'));
	host.exports.late = async () => 'added after construction';
	sent.length = 0;
	await sp.publishExports(context);
	check('exports accessor is live (dynamic addition visible)', sent[0].message.exports.includes('late'));
	sent.length = 0;
	await sp.checkin(context);
	check('checkin pushes state then signals ready', statePushed === context && sent[0].type === 'ready');

	// subscription clearing house: first-touch subscription must mint against the stream index (v3 crash path)
	const {StreamIndex} = require('./utilities/substreamDuplex.js');
	const subHost = {
		exports: {},
		streamIndex: new StreamIndex(),
		subscribed: [],
		subscribeStream(streamId, uid, ws) {this.subscribed.push({streamId, uid, ws}); this.streamIndex.add(streamId, uid);},
		unsubscribeStream(streamId, ws) {this.subscribed = this.subscribed.filter(s => s.streamId !== streamId);},
		reconcileSubscriptions() {this.reconciled = (this.reconciled || 0) + 1;}
	};
	const sp2 = new ServerProtocol(subHost);
	sp2.streamSubscribe({streamId: 'shell-1'}, context);
	check('first-touch subscribe mints uid without crashing', subHost.subscribed[0]?.uid === 1 && subHost.reconciled === 1);
	sp2.streamSubscribe({streamId: 'shell-1'}, context);
	check('resubscribe reuses existing uid', subHost.subscribed[1]?.uid === 1);
	sp2.streamUnsubscribe({streamId: 'shell-1'}, context);
	check('unsubscribe routes through host and reconciles', subHost.subscribed.length === 0 && subHost.reconciled === 3);

	// ---- Node seat configuration: bare invoke, fixed context ----
	const ipcSent = [];
	const fixedContext = {message: (type, message) => ipcSent.push({type, message})};
	let observedContext = 'unset';
	const nodeHost = {
		exports: {
			probe: async function(args, key) {observedContext = this; return {args, key};}
		},
		onReady: Promise.resolve(true)
	};
	const np = new ServerProtocol(nodeHost, fixedContext);
	assign({invoke: (action, args, key) => action(args, key)}).to(np);
	const {request: nodeRequest, exports: nodeExports, checkin: nodeCheckin} = np.routes;
	nodeRequest.call({notAContext: true}, {key: 5, request: {command: 'probe', q: 1}});
	await tick();
	const nodeReply = ipcSent.find(({message}) => message.key === 5);
	check('fixed context carries response when caller context is not usable', nodeReply?.message.result.result.args.q === 1);
	check('bare invoke passes (args, key) positionally', nodeReply?.message.result.result.key === 5);
	check('bare invoke does not bind host context (lexical contract)', observedContext !== nodeHost);
	ipcSent.length = 0;
	await nodeExports.call(undefined);
	await nodeCheckin.call(undefined);
	check('provider handshake over fixed context', ipcSent[0]?.type === 'import' && ipcSent[0]?.message.exports.includes('probe') && ipcSent[1]?.type === 'ready');

	// ---- Worker seat configuration: handshake seams, wildcard dispatch, binary translation ----
	const {BinaryFrame} = require('./utilities/substreamDuplex.js');
	const driverState = {exportsLoaded: false};
	const workerWire = [];
	const makeWorkerClient = () => {
		const socket = new EventEmitter();
		socket.send = payload => workerWire.push(payload.type);
		const protocol = new ClientProtocol(socket);
		assign({
			checkin: () => protocol.message(driverState.exportsLoaded ? 'checkin' : 'exports'),
			import: () => {
				driverState.exportsLoaded = true;
				protocol.message('checkin');
			}
		}).to(protocol);
		return {socket, protocol};
	};
	const workerA = makeWorkerClient();
	workerA.socket.emit('message', {type: 'checkin', message: {nodes: {}}});
	workerA.socket.emit('message', {type: 'import', message: {exports: ['x']}});
	const workerB = makeWorkerClient();
	workerB.socket.emit('message', {type: 'checkin', message: {nodes: {}}});
	check('domain-level export gating across instances', JSON.stringify(workerWire) === JSON.stringify(['exports', 'checkin', 'checkin']));
	const seen = [];
	assign({dispatch: (type, message) => seen.push(type)}).to(workerA.protocol);
	workerA.socket.emit('message', {type: 'telemetry', message: {cpu: 1}});
	workerA.socket.emit('message', {type: 'flags', message: {ready: true}});
	check('dispatch seam preserves wildcard delivery', JSON.stringify(seen) === JSON.stringify(['telemetry', 'flags']));
	const packets = [];
	workerA.protocol.on('binaryPacket', (frame, uid, payload) => packets.push({uid, payload: payload.toString()}));
	workerA.socket.emit('message', BinaryFrame.build(BinaryFrame.data, 42, 'child-data'));
	check('binary frames surface via binaryPacket without touching an empty index', packets[0]?.uid === 42 && packets[0]?.payload === 'child-data');

	// ---- StreamIndex rewire: child respawn remap ----
	const {StreamIndex: SI} = require('./utilities/substreamDuplex.js');
	const childIndex = new SI();
	childIndex.add('shell-7', 5);
	const survivor = childIndex.get('shell-7');
	let opened = 0, closed = 0;
	childIndex.reconcileStreams([{streamId: 'shell-7', uid: 9}], () => opened++, () => closed++);
	check('reconcile rewires surviving stream instead of reopening', opened === 0 && closed === 0 && childIndex.getUID('shell-7') === 9);
	check('rewire releases the stale uid and keeps the stream object', childIndex.get(9) === survivor && childIndex.get(5) === undefined);
	check('rewire to the same uid is a no-op truth', childIndex.rewire('shell-7', 9) === true && childIndex.getUID('shell-7') === 9);

	// ---- socket-owning ServerProtocol: binary unwrap policy and raw-frame forwarding ----
	const engineSocket = new EventEmitter();
	engineSocket.send = () => true;
	const engineHost = {exports: {}, onReady: Promise.resolve(true)};
	const engine = new ServerProtocol(engineHost, {message: () => {}}, engineSocket);
	const received = [];
	engine.streamIndex.add('pty-1', 11);
	const pump = engine.streamIndex.get('pty-1').stdin.consume(data => received.push(data));
	pump();
	engineSocket.emit('message', BinaryFrame.build(BinaryFrame.data, 11, 'unwrapped'));
	await tick();
	check('unwrapFrames default feeds payload to the collator', received[0]?.toString() === 'unwrapped');
	engineHost.unwrapFrames = false;
	engineSocket.emit('message', BinaryFrame.build(BinaryFrame.data, 11, 'raw'));
	await tick();
	check('unwrapFrames false feeds the raw frame', BinaryFrame.parse(received[1])?.payload.toString() === 'raw');
	// passthrough pattern: responder duties neutralized, raw frames forwarded via the dispatch seam
	const forwarded = [];
	assign({
		request: () => {},
		publishExports: () => {},
		checkin: () => {},
		dispatch: (type, message, frame) => forwarded.push(frame)
	}).to(engine);
	const rawRequest = {type: 'request', message: {key: 3, request: {command: 'remote'}}};
	engineSocket.emit('message', rawRequest);
	await tick();
	check('neutralized responder forwards the raw frame verbatim', forwarded[0] === rawRequest);

	// ---- dispatcher context regression: routes must reply on the requesting socket ----
	const {Dispatcher} = require('./utilities/dispatcher.js');
	const dispatchHost = {exports: {ping: async () => 'pong'}, onReady: Promise.resolve(true)};
	const dp = new ServerProtocol(dispatchHost);
	const dispatcher = new Dispatcher({}, {});
	// the dispatcher's own bind preserves dynamic context; the helpers bind would freeze it
	dispatcher.bind(dp.routes);
	const makeSocket = () => ({out: [], message(type, message) {this.out.push({type, message});}});
	const wsA = makeSocket(), wsB = makeSocket();
	dispatcher.emit('request', {key: 1, request: {command: 'ping'}}, wsA);
	dispatcher.emit('request', {key: 2, request: {command: 'ping'}}, wsB);
	await tick();
	check('responses route to the requesting socket', wsA.out[0]?.message.key === 1 && wsB.out[0]?.message.key === 2);
	check('no cross-socket leakage', wsA.out.length === 1 && wsB.out.length === 1);

	// ---- session tier: role-split handshake and binary routing ----
	const {Session, ServerSession, ClientSession} = require('./utilities/protocol.js');
	const emitted = [];
	const named = [];
	const mockChannel = () => ({
		streamIndex: new SI(),
		activeWriters: new Set(),
		log: () => {},
		emit: (type, message, ws) => emitted.push({type, message, ws}),
		sessions: ws => named.push(ws.SessionID),
		get SessionID() {return 'minted';}
	});
	const serverChannel = mockChannel();
	const server = new ServerSession(serverChannel, () => 'TS');
	const socket = {SessionID: 'orig@1.1.1.1', keepalive: 7, sent: [], message(type, message) {this.sent.push({type, message});}};
	server.data(JSON.stringify({type: 'sessionid', message: {SessionID: 'alice'}}), socket, '1.1.1.1');
	check('sessionid renames the socket and broadcasts sessions', socket.SessionID === 'alice@1.1.1.1' && named[0] === 'alice@1.1.1.1');
	check('sessionid emits up under the new name', emitted.some(({type, message}) => type === 'up' && message.SessionID === 'alice@1.1.1.1'));
	check('enriched event keeps the pre-rename identity', emitted.some(({type, message}) => type === 'sessionid' && message.SessionID === 'orig@1.1.1.1'));
	server.data(JSON.stringify({type: 'newsession', message: {}}), socket, '1.1.1.1');
	check('newsession reissues the handshake', socket.sent[0]?.type === 'up' && socket.sent[0]?.message.timestamp === 'TS' && socket.sent[0]?.message.SessionID === 'minted' && socket.sent[0]?.message.keepalive === 7);
	emitted.length = 0;
	server.data(JSON.stringify({type: 'hello', message: {x: 1}}), socket, '1.1.1.1');
	check('unconsumed types forward generic message then the typed event', emitted[0]?.type === 'message' && emitted[1]?.type === 'hello' && emitted[1]?.message.x === 1);
	serverChannel.streamIndex.add('pty-2', 21);
	const collated = [];
	const drainServer = serverChannel.streamIndex.get('pty-2').stdin.consume(data => collated.push(data));
	drainServer();
	server.data(BinaryFrame.build(BinaryFrame.data, 21, 'inbound'), socket, '1.1.1.1');
	await tick();
	check('server binary feeds the collator with the raw frame', BinaryFrame.parse(collated[0])?.payload.toString() === 'inbound');
	emitted.length = 0;
	serverChannel.streamIndex.add('bad', 22, () => ({process() {throw new Error('pump fault');}}));
	server.data(BinaryFrame.build(BinaryFrame.data, 22, 'x'), socket, '1.1.1.1');
	check('binary failure normalizes and emits error', emitted[0]?.type === 'error' && emitted[0]?.message.reason === 'pump fault');
	const clientChannel = mockChannel();
	const clientSession = new ClientSession(clientChannel, () => 'TS');
	const sessionSocket = {SessionID: 'myname', sent: [], message(type, message) {this.sent.push({type, message});}};
	emitted.length = 0;
	clientSession.data(JSON.stringify({type: 'up', message: {keepalive: 9, SessionID: 'server@here'}}), sessionSocket, '9.9.9.9');
	check('client up syncs keepalive', sessionSocket.keepalive === 9);
	check('up emits for application consumers (case and enriched)', emitted.filter(({type}) => type === 'up').length === 2);
	check('client identity takes precedence in the up event', emitted.every(({message}) => message.SessionID === 'myname'));
	clientChannel.streamIndex.add('pty-3', 31);
	const fanned = [];
	const drainClient = clientChannel.streamIndex.get('pty-3').stdout.consume(data => fanned.push(data));
	drainClient();
	clientSession.data(BinaryFrame.build(BinaryFrame.data, 31, 'downbound'), sessionSocket, '9.9.9.9');
	await tick();
	check('client binary feeds the fanout with the raw frame', BinaryFrame.parse(fanned[0])?.payload.toString() === 'downbound');
	check('garbage payloads drop silently', clientSession.data('not json at all', sessionSocket, '9.9.9.9') === false);
	check('session base is exported for extension', Session && Object.getPrototypeOf(ServerSession) === Session);

	// passthrough construction order: the host's stream index getter may depend on
	// state that does not exist until after the protocol is constructed
	const lateHost = {exports: {}, get streamIndex() {return this.channel?.streamIndex;}};
	const lateProtocol = new ServerProtocol(lateHost, {message: () => {}});
	check('adoption probe survives a late-initializing host index', !!lateProtocol.streamIndex);
	lateHost.channel = {streamIndex: new SI()};
	lateProtocol.streamIndex = lateHost.channel.streamIndex;
	check('late adoption rebinds to the host transport index', lateProtocol.streamIndex === lateHost.channel.streamIndex);

	// ---- full loopback: ClientProtocol against a socket-owning ServerProtocol ----
	const wire = [];
	const clientSocket = new EventEmitter();
	const serverSocket = new EventEmitter();
	const serverHost = {
		exports: {
			add: async ({a, b}) => a + b,
			fail: async () => {throw new Error('server side fault');},
			never: () => new Promise(() => {})
		},
		onReady: Promise.resolve(true)
	};
	const serverContext = {message: (type, message) => clientSocket.emit('message', {type, message})};
	const serverProtocol = new ServerProtocol(serverHost, serverContext, serverSocket);
	clientSocket.send = payload => {
		wire.push(payload.type);
		serverSocket.emit('message', payload);
	};
	const client = new ClientProtocol(clientSocket);
	// server announces checkin; consumer half should negotiate exports -> import -> checkin -> ready
	clientSocket.emit('message', {type: 'checkin', message: {nodes: {}}});
	await tick(); await tick(); await tick();
	check('loopback handshake completes (exportsLoaded)', client.exportsLoaded === true);
	check('loopback handshake completes (isReady)', client.isReady === true);
	check('handshake wire sequence', JSON.stringify(wire) === JSON.stringify(['exports', 'checkin']));
	check('transaction result round trip', await client.transact('add', {a: 2, b: 3}, 1000) === 5);
	check('transaction error round trip as string', await client.transact('fail', {}, 1000).then(() => false, error => error === 'server side fault'));
	check('maxWait expiry settles pending transaction', await client.transact('never', {}, 50).then(() => false, error => /timed out: never after 50ms/.test(error)));
	const controller = new AbortController();
	const aborted = client.transact('never', {}, 0, controller);
	controller.abort();
	check('abort settles pending transaction', await aborted.then(() => false, error => error === 'aborted'));
	serverHost.exports.inspect = async args => Object.keys(args);
	const sigController = new AbortController();
	const sigPending = client.transact('never', {signal: sigController.signal}, 0);
	sigController.abort();
	check('args signal aborts the transaction', await sigPending.then(() => false, error => error === 'aborted'));
	const preAborted = new AbortController();
	preAborted.abort();
	check('pre-aborted args signal rejects immediately', await client.transact('never', {signal: preAborted.signal}, 0).then(() => false, error => error === 'aborted'));
	const wireKeys = await client.transact('inspect', {signal: new AbortController().signal, x: 1}, 1000);
	check('signal property never crosses the wire', JSON.stringify(wireKeys) === JSON.stringify(['x']));
	client.end();
	check('end aborts in-flight and detaches', await client.transact('add', {a: 1, b: 1}, 1000).then(() => true, () => true));
	serverProtocol.end();
	const ghost = [];
	clientSocket.on('message', frame => ghost.push(frame));
	serverSocket.emit('message', {type: 'request', message: {key: 99, request: {command: 'add', a: 1, b: 1}}});
	await tick();
	check('server end detaches inbound parsing', ghost.length === 0);

	console.log(`\n${passed} passed, ${failed} failed`);
	process.exit(failed ? 1 : 0);
};
run();
