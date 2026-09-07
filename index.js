const {isNull, isEmpty, isFunction, isNumeric, isObject, isArray, isString, isEqual, notEqual, LazyObject, AsyncSemaphore, nsresolution, microseconds, stat, concurrent, exists, assign, includes, inject, bind, setOrGet, initKey, populate, chain, dir, run, stringify, iterable, reason, KEYS, VALUES} = require('helpers');
const {USER, DRIVERS, NODE, SERVER_ADDRESS, SERVERIP, LOG_LEVELS} = require('./utilities/config.js');
const WebSocket = require('ws');
const WebSocketServer = WebSocket.Server;
const {Logger} = require('./utilities/logger.js');
const {BinaryFrame, StreamIndex, QueueIterator, AsyncFanout, toReadable, toWritable} = require('./utilities/substreamDuplex.js');
const {CachedData} = require('./utilities/cachedData.js');
const {Dispatcher} = require('./utilities/dispatcher.js');
const {SystemCommand} = require('./utilities/systemCommand.js');
const {ExpressMiddleware} = require('./utilities/expressMiddleware.js');
const {Queue, Transaction, TransactionQueue} = require('./utilities/transactionQueue.js');
const {ClientProtocol, ServerProtocol, ServerSession, ClientSession} = require('./utilities/protocol.js');
const {ProcessInterface, ChildInterface} = require('./utilities/processInterface.js');
const time = () => SecureChannel.time().toSQL();
const logger = new Logger((LOG_LEVELS || 'telemetry').split(','));
// max time to live for requests
const maxTTL = 20 * nsresolution;
class SecureChannel
{
	static get serverip() {return SERVERIP;}
	static time(moment = new Date())
	{
		const localOffset = new Date().getTimezoneOffset();
		const toSQL = () => {
			// this = date object
			const UTC = new Date(moment.getTime() - localOffset * 60 * 1000);
			const [utcString] = UTC.toJSON().split('.');
			return utcString.replace('T', ' ');
		};
		return assign({toSQL}).to(moment);
	}
	streamIndex = new StreamIndex();
	activeWriters = new Set();
	get logger() {return isFunction(this._logger) ? this._logger : this.controller?.logger || logger;}
	set logger(logger) {this._logger = logger;}
	get isClient() {return this?.ws?.isActive();}
	get clients() {return this.wss?.clients || [];}
	// generate random keys to identify unique sessions
	get SessionID()
	{
		const {randomBytes} = require('crypto');
		return randomBytes(16).toString('base64');
	}
	// _socketMethods run on the websocket context
	// inbound message routing is owned by the role session mounted in listen() or connect()
	get _socketMethods()
	{
		const channel = this;
		return {
			isActive() {return isEqual(this.readyState, WebSocket.OPEN);},
			// propagate new event to remote host (converse of the session data path)
			message(type, message) {return channel.message(type, message, this);},
			// send a generic "data" envelope with payload protected from property pollution
			data(type, message) {return this.message('data', {type, message});}
		};
	}
	log(type, message, metadata = {}) {this.logger(type, message, {source:this.id || 'channel', address:SERVER_ADDRESS, ...metadata});}
	// this is to be retained
	pipeline(...transforms)
	{
		const composeFunctions = (result, transform) => transform(result);
		return transforms.reduce(composeFunctions);
	}
	// run the same action against all connected sockets
	sockets(action) {if (isFunction(action)) for (const client of this.clients) action.call(client);}
	// terminates socket in current context
	terminate()
	{
		return function() {this.terminate();}
	}
	// closes duplicate client connections (as indicated by the same SessionID)
	purgeDuplicate(ws)
	{
		return function()
		{
			ws && notEqual(this, ws) && isEqual(this.SessionID, ws.SessionID) && this.close(3000, 'client migrated to new socket');
		}
	}
	// factory method to return a write function that sends on a websocket context
	write(payload)
	{
		return function()
		{
			const onException = error => error && this.emit('error', error);
			this.isActive() ? this.send(payload, onException) : this.close(3001, 'socket not ready');
		}
	}
	send(payload, ws)
	{
		if (!Buffer.isBuffer(payload)) {payload = stringify(payload);}
		if (ws) {this.write(payload).call(ws);}
		else
		{
			this.ws && this.write(payload).call(this.ws);
			this.wss && this.sockets(this.write(payload));
		}
		return true;
	}
	streamReader(ws)
	{
		return (onFail, onEnd) =>
		{
			const queue = new QueueIterator();
			const handlers = {write: payload => this.write(payload).call(ws)};
			if (onFail) {handlers.fail = onFail;}
			if (onEnd) {handlers.end = onEnd;}
			bind(handlers).to(queue);
			return queue;
		};
	}
	streamWriter(ws)
	{
		return (stream, onFail, onEnd, signal) => {
			const writer = {
				ws,
				write:payload => {
					try {stream.write(payload);}
					catch (error) {onFail?.(error);}
				}
			};
			if (signal?.aborted) {
				onEnd?.();
				return;
			}
			const onAbort = () => {
				this.activeWriters.delete(writer);
				onEnd?.();
			};
			this.activeWriters.add(writer);
			signal?.addEventListener('abort', onAbort, { once: true });
		}
	}
	message(type, message = {}, ws) {
		this.log('verbose', '>>', {type, message});
		return this.send({type, message}, ws);
	}
	data(type, message) {return this.message('data', {type, message});}
	sendBinary(frameType, streamId, payload, ws)
	{
		const uid = this.streamIndex.getUID(streamId);
		if (uid === undefined) {return;}
		this.send(BinaryFrame.build(frameType, uid, payload), ws);
	}
	// publishes stream advertisements to channel subscribers
	publishStreams(ws)
	{
		const streams = this.streamIndex.list().filter(({streamId}) => this.isSourced?.(streamId) ?? true);
		this.message('streams', {streams}, ws);
	}
	// registerStream has a race between stream advertisement and stream subscription
	// both paths converge here, and after both sides wire their pumps, the stream flows
	registerStream(streamId, uid)
	{
		this.streamIndex.add(streamId, uid);
		return this.streamIndex.get(streamId);
	}
	unregisterStream(streamId) {this.streamIndex.delete(streamId, stream => stream.close());}
	// subscribes a specific websocket to a stream published on the channel
	subscribeStream(streamId, ws)
	{
		if (!streamId || !ws) {return null;}
		const stream = this.registerStream(streamId);
		const onFail = error => this.log('debug', 'stream consumer failed', {streamId, error: error?.message || error});
		if (stream.subscribe(ws, frame => this.send(frame, ws), onFail)) {this.reconcileSubscriptions?.();}
		return stream;
	}
	unsubscribeStream(streamId, ws)
	{
		if (!streamId || !ws) {return;}
		if (this.streamIndex.get(streamId)?.unsubscribe(ws)) {this.reconcileSubscriptions?.();}
		this.reapStream?.(streamId);
	}
	emit = (type, message, ws) => this.dispatcher.emit(type, {...message, timestamp:time()}, ws);
	trigger = this.emit
	// SecureChannel server
	listen(options)
	{
		const channel = this;
		const {_socketMethods, emit} = channel;
		const {createReadStream} = require('fs');
		const {join} = require('path');
		const keepalive = options.keepalive || 0;
		const {address, port, cert, key} = options;
		const path = options.path || '/';
		const ready = () => emit('listening', {address, port});
		// the server seat of the session tier owns inbound routing for every connection
		const session = channel.serverSession = new ServerSession(channel, time);
		const ping = () => function()
		{
			const ws = this;
			if (!ws.isActive()) {return ws.terminate();}
			ws.sendTime = microseconds();
			ws.ping(() => {});
			// terminate the server side of the connection if two consecutive ping responses are missed
			if (ws.missedPongs > 1)
			{
				emit('error', {reason:'two consecutive heartbeats missed, terminating'}, ws);
				return ws.terminate();
			}
			const timedout = () => {
				emit('error', {reason:'missed heartbeat signal'}, ws);
				ws.missedPongs++;
			};
			ws.pingTimeout = setTimeout(timedout, keepalive * 1000 * 2);
		};
		channel.sessions = ws => {
			const sessions = [];
			const collateSessions = function() {sessions.push(this.SessionID);}
			channel.sockets(collateSessions);
			emit('sessions', {sessions}, ws);
		};
		channel.destroy = () => {
			for (const stream of channel.streamIndex.values()) stream.close();
			channel.streamIndex.clear();
			clearInterval(this.healthCheck);
			this.sockets(this.terminate());
			return true;
		};
		// upon request from the /securechannel/ URL path, return content from static dist/client.js
		const staticClient = async ({url}, res) => {
			if (url.startsWith('/securechannel'))
			{
				this.log('verbose', 'static client', {address});
				const filePath = join(__dirname, 'dist', 'client.js');
				const {size} = await stat(filePath);
				res.writeHead(200, {'Content-Type': 'text/javascript', 'Content-Length': size});
				const readStream = createReadStream(filePath);
				const endStream = () => readStream.end();
				res.on('error', endStream);
				readStream.pipe(res);
			}
		};
		const {createServer} = require(cert ? 'https' : 'http');
		const server = channel.server = cert ? createServer({cert, key}, staticClient) : createServer(staticClient);
		server.listen(port, address, ready);
		const connection = (ws, req) => {
			const {SessionID} = channel;
			const {getClientAddress} = require('./utilities/clientAddress.js');
			const address = getClientAddress(req);
			// socket events run on the websocket context
			const serverSocketEvents = {
				message(frame) {session.data(frame, ws, address);},
				// receives ping frame response from client
				pong()
				{
					const latency = Math.trunc((microseconds() - ws.sendTime) / (2 * nsresolution) * 10000) / 10000;
					// propagate server event
					emit('heartbeat', {address, sessionid:ws.SessionID, latency}, ws);
					// inform connected client
					ws.message('latency', {latency});
					ws.Latency = latency;
					// reset countdown
					clearTimeout(this.pingTimeout);
					ws.missedPongs = 0;
				},
				close(code)
				{
					channel.streamIndex.unsubscribe(ws);
					channel.reconcileSubscriptions?.();
					channel.reapStreams?.();
					emit('close', {address, sessionid:ws.SessionID, reason:code}, ws);
					channel.sessions(ws);
				},
				error(reason) {channel.emit('error', {address, sessionid:ws.SessionID, reason}, ws);}
			};
			// bind custom methods to websocket
			assign(_socketMethods).to(ws);
			// bind event listeners to websocket
			bind(serverSocketEvents).to(ws);
			ws.Address = address;
			ws.keepalive = keepalive;
			ws.SessionID = `${SessionID}@${address}`;
			ws.missedPongs = 0;
			channel.sessions(ws);
			// inform client that connection is up
			ws.message('up', {timestamp:time(), SessionID, keepalive});
			// inform server that new client has connected
			emit('open', {address}, ws);
		};
		channel.wss = bind({connection}).to(new WebSocketServer({server, path}));
		// send periodic ping frames to all sockets and await pong responses
		keepalive && (this.healthCheck = setInterval(() => this.sockets(ping()), keepalive * 1000));
		return this;
	}
	// gets overridden once the connect method is called
	disconnect() {}
	// SecureChanel client
	// manage and maintain a persistent full duplex connection to a remote server
	connect(options)
	{
		const channel = this;
		const {_socketMethods} = channel;
		const {address, port, signal, uri} = options;
		const path = options.path || '';
		const reconnect = options.reconnect || 5;  // units are seconds
		const handshakeTimeout = options.handshakeTimeout || 2000; // units are millis
		const rejectUnauthorized = options.enforceSSLVerification || false;
		const service = `${address}:${port}`;
		const url = uri || `wss://${service}${path}`;
		const origin = url.startsWith('wss://') ? `https://${service}` : `http://${service}`;
		this.logger('verbose', 'client options', {address, port, url, reconnect});
		let ws = channel.ws = {
			isActive() {return false;},
			terminate:() => {},
			readyState:false,
			SessionID:this.clientName
		};
		const emit = (type, event) => channel.emit(type, event, ws);
		// the client seat of the session tier owns inbound routing for this connection
		const session = channel.clientSession = new ClientSession(channel, time);
		// socket events run on the websocket context
		const clientSocketEvents = {
			// monitor socket health, and terminate the connection if two consecutive ping frames are missed
			// the keepalive value is set on the server side and is propagated to the client during the "up" event
			ping()
			{
				const {keepalive} = ws;
				const timedout = () => {
					emit('error', {address, reason:'two consecutive heartbeats missed, terminating'});
					ws.terminate();
				};
				if (keepalive)
				{
					clearTimeout(ws.pingTimeout);
					ws.pingTimeout = setTimeout(timedout, keepalive * 1000 * 2);
					emit('heartbeat', {address});
				}
			},
			message(frame) {session.data(frame, ws, address);},
			open()
			{
				clearTimeout(ws.respawnTimeout);
				ws.respawnTimeout = false;
				// emit an initial heartbeat locally
				// further pings will be periodically sent from the server end if this is a persistent connection
				ws.ping();
				// the "connect" event is only a confirmation that the local end of the connection is open
				// the connection is not fully established until an "up" message arrives from the server
				emit('connect', {address});
			},
			error({code}) {emit('error', {address, reason:code});},
			close()
			{
				clearTimeout(ws.pingTimeout);
				if (ws.keepalive) {ws.respawnTimeout = setTimeout(startConnection, reconnect * 1000);}
				// 'down' events are generated locally when a connection is severed for any reason
				emit('down', {address});
			}
		};
		const abortConnection = () => channel.disconnect();
		if (signal)
		{
			if (signal.aborted) {return this;}
			signal.addEventListener('abort', abortConnection);
		}
		const startConnection = () => {
			// if socket is open then do nothing
			if (ws.isActive()) {return;}
			channel.disconnect = () => {
				signal && signal.removeEventListener('abort', abortConnection);
				channel.streamIndex.clear(stream => stream.close());
				ws.keepalive = 0;
				ws.terminate();
				channel.disconnect = () => {};
			};
			ws = channel.ws = assign({SessionID:this.clientName, ..._socketMethods}).to(new WebSocket(url, {origin, handshakeTimeout, rejectUnauthorized}));
			// listeners run under websocket context
			// bind events to websocket
			bind(clientSocketEvents).to(ws);
		};
		startConnection();
		return this;
	}
	bind(events) {return bind(events).to(this);}
	import(properties) {return assign(properties).to(this);}
	constructor(routes = {}, clientName = false)
	{
		const {on, off} = this.dispatcher = new Dispatcher(routes, this);
		this.import({on, off, clientName});
	}
}
class Channel extends SecureChannel
{
	static getConnection(id, options)
	{
		const {ports, ...props} = options;
		if (ports)
		{
			const port = ports[id];
			return {id, connection:{...props, port}};
		}
		else {return {id, connection:options};}
	}
	drivers = {};
	sources = {};
	sinks = {};
	exports = {};
	// returns an object capable of directly calling exports through the channel context
	get channelExports() {return new LazyObject(this.passthrough);}
	get status()
	{
		const status = {};
		for (const [domain, {domainReady}] of iterable(this.drivers)) {status[domain] = domainReady;}
		return status;
	}
	get channels() {return this.controller?.channels;}
 	// returns false if any domain is not ready
 	get channelReady()
 	{
 		for (const ready of iterable(this.status, VALUES)) {if (!ready) return false;}
 		return true;
 	}
 	// set channelReady to any truthy value to refresh the onReady status and potentially trigger waiting functions
	set channelReady(ready)
	{
		if (!ready) return;
		this._ready_semaphore.status = this.channelReady;
		this.controller.appReady = ready;
	}
	// provide a gate that can be awaited and opens when the channel is ready
	get onReady() {return this._ready_semaphore.status;}
	// broadcasts a message downward to every worker in every domain
	messageAll(type, message) {for (const driver of iterable(this.drivers, VALUES)) {driver.messageAll(type, message);}}
	// rebuilds the subscription set from every stream's socket set, broadcasting downward on change
	reconcileSubscriptions()
	{
		const onChanged = subscriptions => this.messageAll('subscriptions', subscriptions);
		const active = this.streamIndex.getActiveStreams();
		this.streamIndex.subscribe(active, null, null, onChanged);
	}
	// a registration is held alive by demand (socket tags) or supply (a worker
	// claiming the streamId in its child advert namespace); reap when neither holds
	isSourced(streamId)
	{
		for (const driver of iterable(this.drivers, VALUES))
		{
			for (const worker of iterable(driver.workers, VALUES)) {if (worker.hasStream?.(streamId)) {return true;}}
		}
		return false;
	}
	reapStream(streamId)
	{
		const stream = this.streamIndex.get(streamId);
		if (!stream) {return;}
		if (!stream.isSubscribed && !this.isSourced(streamId))
		{
			this.unregisterStream(streamId);
			this.publishStreams();
		}
	}
	reapStreams() {for (const {streamId} of this.streamIndex.list()) {this.reapStream(streamId);}}
	async request(command, args, key, address, ws)
	{
		return this.protocol.execute(command, args, key, ws);
	}
	// factory method to produce an action function with a curried command baked in
	passthrough = command => args => this.request(command, args);
	// pushes data through the driver pipeline, as if arriving directly from a source
	dispatch = (data, socket) => {
		const {drivers, sources} = this;
		// routes message to correct handler based on metadata envelope
		for (const [domain, state] of iterable(data))
		{
			if (sources[domain])
			{
				const driver = drivers[domain];
				for (const [type, nodes] of iterable(state))
				{
					for (const [node, message] of iterable(nodes))
					{
						const emit = driver.pipeline(type, node);
						emit(message, socket || this);
					}
				}
			}
		}
	}
	// fires sink methods using the passed socket as context and using the path to walk the state cache
	emitCache = (path = [], socket = this) => {
		const {cache} = this.controller;
		const {drivers} = this;
		const walkNodes = (driver, type) => {
			const {domain} = driver;
			for (const node of iterable(cache([domain, type]), KEYS)) {driver.emit(type, node, socket);}
		};
		const emitType = (driver, type, node) => {
			node ? driver.emit(type, node, socket) : walkNodes(driver, type);
		};
		const walkTypes = (driver) => {
			const {domain} = driver;
			for (const type of iterable(cache([domain]), KEYS)) {emitType(driver, type);}
		};
		const emitDomain = (domain, type, node) => {
			const driver = drivers[domain];
			driver && (type ? emitType(driver, type, node) : walkTypes(driver));
		};
		const walkDomains = () => {
			for (const driver of iterable(drivers, VALUES)) {walkTypes(driver);}
		};
		const [domain, type, node] = path;
		domain ? emitDomain(domain, type, node) : walkDomains();
	}
	// synchronizes client state on connection
	pushState(socket)
	{
		const {controller} = this;
		// emit the cache state (an empty path array indicates the entire cache should be published)
		this.emitCache([], socket);
		// emit the nodes state
		socket.data(controller.nodes());
		// emit the stream map so reconnecting clients discover preexisting streams
		this.publishStreams(socket);
	}
	join(controller)
	{
		this.controller = controller;
		controller.channels[this.id] = this;
		return this;
	}
	use(middleware)
	{
		this.middleware = middleware;
		return this;
	}
	export(exports)
	{
		assign(exports).to(this.exports);
		return this;
	}
	handle(exports) {return this.export(exports);}
	createDriver(id) {return new Driver(id).join(this);}
	get loadDriver() {return this.createDriver;}
	async end()
	{
		const {drivers} = this;
		this.destroy();
		const endDriver = driver => driver.end();
		await concurrent(iterable(drivers, VALUES), endDriver);
	}
	async start()
	{
		const {connection, drivers, middleware} = this;
		// start listeneng for events
		this.logger('verbose', `starting server`);
		this.listen(connection);
		if (middleware) {this.server.on('request', middleware);}
		// start child worker processes
		this.logger('verbose', `starting drivers`);
		const startDriver = driver => driver.start();
		await concurrent(iterable(drivers, VALUES), startDriver);
	}
	constructor(id, connection, logger)
	{
		// emitted by serverSocketEvents message
		const channelEvents = {
			// triggered on server initialization, before any clients connect
			listening({address, port}) {channel.log('telemetry', 'server listening', {address, port});},
			// triggered whenever a client establishes a socket connection
			async open({address})
			{
				const {controller, onReady} = channel;
				await onReady;
				const nodes = controller.nodes();
				this.message('checkin', {nodes});
				channel.log('telemetry', 'connection opened, sending checkin', {address});
			},
			async up({address, SessionID})
			{
				channel.log('telemetry', 'received session token:', {address, SessionID});
			},
			// triggered whenever a client handshakes a new SessionID
			async sessions({address, sessions})
			{
				const {controller, onReady} = channel;
				await onReady;
				controller.emit('sessionsChanged', {id, sessions});
				channel.log('verbose', 'sessions changed', {address, sessions});
			},
			// triggered after client acknowledges checkin and starts the "exports" transaction
			// the "exports", "checkin", "request", "streamSubscribe" and "streamUnsubscribe"
			// events are served by the ServerProtocol routes merged in below
			// generic data event allows remote triggering of arbitrary event types from the application layer
			data:({type, message}) => channel.emit(type, message, this),
			heartbeat({address, sessionid}) {channel.log('debug', 'heartbeat received', {address, sessionid});},
			// triggered whenever a client connection is closed
			close({address, reason}) {channel.log('telemetry', 'connection closed:', {address, reason});},
		};
		const channel = super(channelEvents);
		this.import({id, connection, logger});
		this._ready_semaphore = new AsyncSemaphore(false);
		const protocol = this.protocol = new ServerProtocol(channel);
		assign({
			decorate:(args, context, envelope) => ({...args, sessionid:envelope?.SessionID || null}),
			pushState:socket => channel.pushState(socket)
		}).to(protocol);
		// merge through the dispatcher's own bind, which preserves the per-socket
		// dynamic context; the helpers bind would lock the handlers to the channel
		// and every response would broadcast instead of replying to the requester
		this.dispatcher.bind(protocol.routes);
	}
}
class Driver
{
	get domain() {return this.id;}
	get sessionid() {return this.channel?.id;}
	get controller() {return this.channel?.controller;}
	get channels() {return this.controller?.channels;}
	get sources()
	{
		if (!this._sources) {this._sources = {};}
		return this._sources;
	}
	set sources(sources) {assign(sources).to(this.sources);}
	get sinks()
	{
		if (!this._sinks) {this._sinks = {};}
		return this._sinks;
	}
	set sinks(sinks) {assign(sinks).to(this.sinks);}
	get workers()
	{
		const {controller, domain} = this;
		return controller?.devices ? initKey(controller.devices, domain) : null;
	}
	get hasWorkers()
	{
		const {length} = iterable(this.workers, KEYS);
		return length > 0;
	}
	get exportsLoaded() {return this._exports_loaded || false;}
	set exportsLoaded(status) {this._exports_loaded = status;}
	get status()
	{
		const ready = {};
		const getStatus = ([node, worker]) => ready[node] = worker.nodeReady;
		if (this.workers) {iterable(this.workers).forEach(getStatus);}
		return ready;
	}
	// returns false if any node in the domain is not ready
	// returns true if all nodes are ready or there are no nodes
	get domainHealthy()
	{
		const {status} = this;
		for (const ready of iterable(status, VALUES)) {if (!ready) return false;}
		return true;
	}
	// returns the first available node if the domain is ready
	// returns true if the domain has no nodes (vacuously ready)
	// returns false if no nodes are are ready
	// returns undefined if no nodes have finished checking in
	get domainReady()
	{
		const {status, exportsLoaded} = this;
		if (isEmpty(status)) {return this.hasWorkers ? undefined : true;}
		if (!exportsLoaded) {return undefined;}
		for (const [node, ready] of iterable(status)) {if (ready) return node;}
		return false;
	}
	// set domainReady to any value to refresh the onReady status and trigger waiting events if the state changes to ready
	set domainReady(ready)
	{
		const {controller, channel, domain, domainReady} = this;
		// the ready semaphore will open if there are no nodes or at least one node has checked in
		if (ready)
		{
			this._ready_semaphore.status = !(this.domainReady === false);
			this._healthy_semaphore.status = this.domainHealthy;
		}
		else {this.exportsLoaded = false;}
		channel.channelReady = ready;
		// the state value for domainReady can be true, false or undefined
		controller.setState(['domainReady', domain], domainReady && true);
	}
	get onReady() {return this._ready_semaphore.status;}
	get onHealthy() {return this._healthy_semaphore.status;}
	get logger() {return isFunction(this._logger) ? this._logger : this.channel?.logger || logger;}
	set logger(logger) {this._logger = logger;}
	log(type, message, metadata = {}) {this.logger(type, message, {source:this.domain, address:SERVER_ADDRESS, ...metadata});}
	// broadcasts a message to every worker in this domain
	messageAll(type, message)
	{
		for (const worker of iterable(this.workers, VALUES)) {worker.message(type, message);}
	}
	emit(type, node, socket)
	{
		const {controller, channel, domain, sinks} = this;
		const emitter = sinks[type];
		if (isFunction(emitter))
		{
			// the controller.cache method will allocate cache storage in the process of walking the cache path
			// don't create storage here for message types that don't need to be cached by the application
			// allow the application to create cache entries only for things that need it
			const path = [domain, type];
			const cache = includes(path).in(controller.state.cache) && controller.cache(path);
			// a deleted node emits a null tombstone: undefined would be dropped by
			// JSON serialization and the deletion would vanish from the wire
			const message = node ? {[node]:cache[node] ?? null} : cache;
			emitter.call(this, message, socket || channel);
		}
	}
	// create a pipeline to cache the state of sources,
	// push notifications to sinks on change,
	// and echo the cache to sinks on new connection
	pipeline = (type, node) => async (data, socket) => {
		const {channel, sources} = this;
		const collector = sources[type];
		// allow the collector method to complete before attempting to call a corresponding emitter
		const publishData = await collector.call(this, data, node, socket || channel);
		// only fire the emitter if the collector provides a truthy result
		// this allows the collector to filter spurious events and only trigger updates when changes are detected
		if (publishData) {this.emit(type, node, socket);}
	}
	// the cache state holds primary data emitted by connected source nodes
	cache(...args)
	{
		const {id, controller} = this;
		const channel = (args.length && isObject(args[0])) ? args.shift() : null;
		// args.shift() produces a null value if args is empty
		let [path, value, overwrite] = args;
		path = path ? [id, ...path] : [id];
			return channel
			? controller.cache(channel, path, value, overwrite)
			: controller.cache(path, value, overwrite);
	}
	// the nodes state holds metadata pertaining to source node health and availability
	nodes(...args)
	{
		const {id, controller} = this;
		const channel = (args.length && isObject(args[0])) ? args.shift() : null;
		// args.shift() produces a null value if args is empty
		let [path, flag, overwrite] = args;
		path = path ? [id, ...path] : [id];
		return channel
			? controller.nodes(channel, path, flag, overwrite)
			: controller.nodes(path, flag, overwrite);
	}
	async request(command, {node, ...args})
	{
		const {domain, workers, hasWorkers, status} = this;
		if (!hasWorkers) {throw (`no workers available for ${domain} domain`);}
		if (!node) {node = this.domainReady;}
		if (!node) {throw (`no workers ready for ${domain} domain`);}
		if (isArray(node))
		{
			const [first, ...remainder] = node;
			node = first;
			if (remainder.length > 1) {args.node = remainder;}
			else if (remainder.length === 1) {args.node = remainder[0];}
		}
		const worker = workers[node];
		// ensure device is present and ready before committing query
		if (worker)
		{
			const ready = status[node];
			if (ready) {return await worker.request({command, ...args});}
			else {throw `worker ${domain}/${node} is not ready`;}
		}
		throw (`worker ${domain}/${node} is invalid`);
	}
	join(channel)
	{
		const {domain, sources, sinks} = this;
		this.channel = channel;
		channel.sinks[domain] = sinks;
		channel.sources[domain] = sources;
		channel.drivers[domain] = this;
		return this;
	}
	leave()
	{
		const {domain, channel} = this;
		if (channel)
		{
			delete channel.drivers[domain];
			delete channel.sources[domain];
			delete channel.sinks[domain];
		}
	}
	publish(sinks)
	{
		this.sinks = sinks;
		return this;
	}
	subscribe(sources)
	{
		this.sources = sources;
		return this;
	}
	process({source, sink})
	{
		this.publish(sink);
		this.subscribe(source);
		return this;
	}
	createWorker(workers) {
		return node => {
			const {domain, sessionid} = this;
			if (this.workers[node] instanceof Worker) { throw `${domain}/${node} already exists`; }
			// spawn a child process to monitor and control each node of a specific device class
			// upgrade the device node to a Driver instance
			const data = workers[node] ?? {};
			const worker = new Worker(this, node, sessionid, data);
			this.workers[node] = worker;
			return worker.onReady;
		}
	}
	async addWorker(node, data = {}) {
		const {domain, controller} = this;
		if (!this.domainReady) {throw `${domain} not ready`;}
		const workers = {[node]: data};
		const createWorker = this.createWorker(workers);
		const removeNode = () => controller.nodes.remove(domain, node);
		const workerReady = createWorker(node);
		await workerReady;
		const worker = this.workers[node];
		if (worker.persistent === false) {worker.onDown.then(removeNode);}
		return worker;
	}
	dropWorker(node) {
		let timer;
		const removeWorker = (resolve, reject) => {
			const {workers, domain} = this;
			const worker = workers[node];
			if (!worker) {reject(`${domain}/${node} not found`);}
			delete workers[node];
			timer = setTimeout(() => reject(`${domain}/${node} not responding`), 5000);
			worker.end().then(resolve);
		};
		const settle = message => {
			message && this.debug(message);
			clearTimeout(timer);
		};
		return new Promise(removeWorker).then(settle, settle);
	}
	async stopAllWorkers()
	{
		const nodes = iterable(this.workers, KEYS);
		if (nodes.length)
		{
			this.domainReady = false;
			return await concurrent(nodes, node => this.dropWorker(node));
		}
	}
	async start()
	{
		// upgrades each device object to an instance of Driver
		// returns a promise that resolves on worker ready
		const {workers, domain} = this;
		this.log('debug', `starting ${domain} driver`);
		this.domainReady = false;
		// initialize nodes for domain
		this.nodes();
		const nodes = iterable(workers, KEYS);
		if (nodes.length) {return await concurrent(nodes, this.createWorker(workers));}
		this.domainReady = true;
	}
	async reset(devices)
	{
		const {domain, controller} = this;
		const workers = devices[domain];
		if (workers)
		{
			const deadline = new Promise((_, reject) => setTimeout(() => reject(`${domain} reset failed: workers did not shut down within 10 seconds`), 10000));
			await Promise.race([this.stopAllWorkers(), deadline]);
			controller.devices[domain] = workers;
			await this.start();
			return true;
		}
		return false;
	}
	end()
	{
		this.leave();
		return this.stopAllWorkers();
	}
	constructor(id, logger)
	{
		this.id = id;
		this.logger = logger;
		this._ready_semaphore = new AsyncSemaphore(false);
		this._healthy_semaphore = new AsyncSemaphore(false);
	}
}
class Worker
{
	_has_responded = false;
	_childStreamIndex = new StreamIndex();
	_activePumps = new Set();
	_ready_semaphore = new AsyncSemaphore();
	_down_semaphore = new AsyncSemaphore();
	// the node map holds the child's own uid namespace, translated against the channel uid namespace
	_child_buffer = '';
	// the "checkin", "import", "ready", "streams" and "response" events are served by
	// the ClientProtocol wired in by connectProtocol; the handlers below carry the
	// host policies that ride the worker dispatcher
	_NodeEvents = {
		error:({error}) => {
			const {driver} = this;
			this.nodeError = error;
			driver.log('error', 'error', {error, source:`${this.domain}/${this.node}`});
		},
		flags:flags => {
			const {driver, node, channel} = this;
			for (const [type, flag] of iterable(flags)) {driver.nodes(channel, [node, type], flag);}
			// trigger any routines waiting for ready
			const {ready, error} = flags;
			if (ready || error) {driver.domainReady = true;}
		}
	}
	get respawnTime()
	{
		if (this.persistent === false) {return 0;}
		if (exists(this._respawnTime)) {return this._respawnTime;}
		return this.driver.respawnTime || 10;
	}
	get driverPath()
	{
		const {driverPath} = this.driver;
		return driverPath || DRIVERS;
	}
	get exports() {return this.channel.exports;}
	get streamIndex() {return this.channel.streamIndex;}
	get controller() {return this.driver.controller;}
	get channel() {return this.driver.channel;}
	get sources() {return this.driver.sources;}
	get sinks() {return this.driver.sinks;}
	get domain() {return this.driver.id;}
	get node() {return this.id;}
	set nodeChanged(timestamp)
	{
		this._node_changed = timestamp;
		this.emit('flags', {timestamp});
	}
	get nodeChanged() {return this._node_changed || time();}
	get nodeReady()
	{
		const {controller, domain, node} = this;
		return controller.nodes([domain, node, 'ready']);
	}
	set nodeReady(ready)
	{
		// suppress duplicate events
		if (ready !== this.nodeReady)
		{
			this.nodeChanged = time();
			this.emit('flags', {ready});
			// import downstream exports
			this._ready_semaphore.status = ready;
			if (ready)
			{
				this.message('exports');
				this.nodeDown = false;
				// an explicit ready signal clears any previous errors
				this.nodeError = false;
			}
		}
	}
	get nodeDown()
	{
		const {controller, domain, node} = this;
		return controller.nodes([domain, node, 'down']);
	}
	set nodeDown(down)
	{
		// only trigger onDown promise when explicitly going DOWN
		if (down === true)
		{
			this.nodeChanged = time();
			this.emit('flags', {down});
			this._down_semaphore.status = down;
			if (down) {this.nodeReady = false;}
			// the worker is the definitive authority on node lifetime: an ephemeral
			// worker's death is its data's death, on the happy path or a crash alike.
			// persistent workers retain their footprint as last-known state across respawns
			if (!this.persistent) {this.evictCache();}
		}
	}
	// removes every cache entry keyed by this worker's node across the domain's types.
	// the null-delete carries the channel context, so each eviction publishes through
	// the driver's emitter and tombstones downstream replicas automatically
	evictCache()
	{
		const {controller, channel, domain, node} = this;
		for (const type of iterable(controller.cache([domain]), KEYS))
		{
			const cache = controller.cache([domain, type]);
			if (isObject(cache) && node in cache) {controller.cache(channel, [domain, type, node], null);}
		}
	}
	get nodeError()
	{
		const {controller, domain, id} = this;
		return controller.nodes([domain, id, 'error']);
	}
	set nodeError(error)
	{
		// suppress duplicate events
		if (error !== this.nodeError)
		{
			this.nodeChanged = time();
			this.emit('flags', {error});
		}
	}
	get onReady() {return this._ready_semaphore.status;}
	get onDown() {return this._down_semaphore.status;}
	set persistent(persistent) {this._persistent = persistent !== false;}
	get persistent() {return this._persistent !== false;}
	send(message)
	{
		if (!this.child?.connected) return false;
		try
		{
			this.child.send(message, error => error && this.driver.log('worker send failed'));
			return true;
		}
		catch
		{
			this.driver.log('worker not connected');
			return false;
		}
	}
	sendBinary(frameType, uid, payload) {if (uid !== undefined) return this.send(BinaryFrame.build(frameType, uid, payload));}
	message(type, message) {this.send({type, message});}
	// wires the requester seat onto a freshly forked child:
	// the protocol owns transactions and the consumer half of the capability handshake,
	// while the seam overrides carry the worker policies that differ from the defaults
	connectProtocol()
	{
		const {driver, node} = this;
		const source = `${this.domain}/${this.node}`;
		// end any prior protocol so in-flight transactions abort instead of dangling across a respawn
		this.lineProtocol?.end();
		const protocol = this.lineProtocol = new ClientProtocol(this.child);
		assign({
			// only request exports once per domain
			checkin:({nodes}) => {
				this.subIDs = nodes;
				driver.exportsLoaded ? protocol.message('checkin') : protocol.message('exports');
				driver.log('info', 'worker started', {source});
			},
			// captures exports provided by the worker process
			import:({exports:commands}) => {
				const request = command => args => driver.request(command, {node, ...args});
				const exports = populate(commands, request);
				assign(exports).to(this.exports);
				driver.exportsLoaded = true;
				// complete the checkin cycle, which triggers a dump of the current channel state
				protocol.message('checkin');
				driver.log('info', 'exports populated', {source});
			},
			// receives the child's stream advertisement carrying the child uid namespace,
			// reconciles worker pump state, translating between child and channel uid spaces
			reconcileStreams:streams => {
				this._childStreamIndex.reconcileStreams(streams, (streamId, uid) => this.openStream(streamId, uid), streamId => this.closeStream(streamId));
				this.channel.publishStreams();
			},
			// terminal dispatch routes every child event into the worker dispatcher,
			// preserving wildcard delivery to pipelines and application listeners
			dispatch:(type, message) => this.emit(type, message)
		}).to(protocol);
		protocol.on('ready', ready => {
			if (ready)
			{
				this.nodeReady = true;
				driver.log('info', 'ready for commands', {source});
			}
		});
		// child frames carry the child uid namespace; resolve the stream against the node map,
		// then rewrap into the channel uid namespace before writing to the channel fanout
		protocol.on('binaryPacket', (frame, childUID, payload) => {
			const stream = this._childStreamIndex.get(childUID);
			const validStream = BinaryFrame.parse(frame);
			if (stream && validStream)
			{
				const streamId = this._childStreamIndex.getStreamId(childUID);
				const channelUID = this.streamIndex.getUID(streamId);
				if (channelUID !== undefined) {stream.write(BinaryFrame.build(validStream.frameType, channelUID, payload));}
			}
		});
		return protocol;
	}
	// dispatch outbound request to worker process through the protocol transaction queue
	request({command, ...args})
	{
		return this.lineProtocol.transact(command, args, maxTTL / 1e6);
	}
	// abort request in flight
	// transaction keys are private to the protocol queue, so the v3 key lookup can no longer match;
	// retained for signature compatibility and always reports the request missing
	async abort(key)
	{
		throw 'request not found';
	}
	// reports whether this worker's child currently advertises the stream (the supply predicate)
	hasStream(streamId) {return this._childStreamIndex.has(streamId);}
	// records the child uid namespace mapping and registers the stream on the channel uid namespace
	registerStream(streamId, childUID)
	{
		const stream = this.channel.registerStream(streamId);
		this._childStreamIndex.add(streamId, childUID, () => stream);
		return stream;
	}
	// starts the active IPC-facing stream pump
	// the converse direction is already wired and only requires streamIndex registration to work
	openStream(streamId, childUID)
	{
		const stream = this.registerStream(streamId, childUID);
		// one IPC pump per registration: a re-advert after supply loss rebinds the
		// child namespace onto the surviving duplex without stacking a second pump
		if (this._activePumps.has(streamId)) {return stream;}
		this._activePumps.add(streamId);
		// channel collator carries channel-uid frames coming down toward the child;
		// rewrap each into the child uid namespace before sending to the child
		const forwardToIPC = async () => {
			try
			{
				for await (const frame of stream.collator)
				{
					if (!this.child.connected) break;
					const validStream = BinaryFrame.parse(frame);
					if (validStream)
					{
						const {frameType, payload} = validStream;
						// resolve the child uid per frame so frames during a respawn pick up the rewired uid
						const uid = this._childStreamIndex.getUID(streamId);
						this.sendBinary(frameType, uid, payload);
					}
				}
			}
			catch(error) {this.driver.log(reason(error));}
			finally {this._activePumps.delete(streamId);}
		};
		forwardToIPC();
		return stream;
	}
	closeStream(streamId)
	{
		// unbind the child namespace first so the reap predicate sees supply gone;
		// the registration survives while subscriber tags hold it, and the sourced
		// advert filter drops it either way so clients unwire and hold their intent
		this._childStreamIndex.delete(streamId);
		this.channel.reapStream?.(streamId);
	}
	// add channel subscriptions to source message types
	connectPipeline()
	{
		const {driver, sources, node} = this;
		const createPipeline = type => this.on(type, driver.pipeline(type, node));
		iterable(sources, KEYS).forEach(createPipeline);
	}
	disconnectPipeline()
	{
		const {sources} = this;
		const removePipeline = type => this.off(type);
		iterable(sources, KEYS).forEach(removePipeline);
	}
	destroy()
	{
		this._respawnTime = 0;
		this.lineProtocol?.end();
		this.disconnectPipeline();
		for (const streamId of [...this._childStreamIndex.keys()]) {this.closeStream(streamId);}
		if (this.child)
		{
			this.child.removeAllListeners();
			this.child.kill();
			this.child = null;
		}
	}
	// returns an async result
	end()
	{
		this.destroy();
		return this.onDown;
	}
	// creates a captured subprocess by launching a driver matching the domain name, configured to respond to a unique node name
	start()
	{
		const {id:node, domain, driverPath} = this;
		const {join} = require('path');
		const {fork} = require('child_process');
		const executable = join(driverPath, `${domain}.js`);
		const error = error => this.nodeError = error;
		const close = code => {
			this.nodeDown = true;
			if (code > 0 && this._child_buffer) {error(this._child_buffer);}
			// unblock callers waiting on onReady if checkin never completed
			if (!this.nodeReady) {this._ready_semaphore.status = true;}
			if (this.child)
			{
				const {stdout, stderr} = this.child;
				stdout.removeAllListeners();
				stderr.removeAllListeners();
				this.child = null;
			}
			if (!this.persistent) {this.destroy();}
			else if (this.respawnTime) {setTimeout(connect, this.respawnTime * 1000);}
		};
		// the protocol owns message routing; this listener only marks first contact for output buffering
		const message = () => this._has_responded = true;
		const forwardOutput = buffer => {
			const message = buffer?.toString() || '';
			// use the native console for output to avoid reformatting the message
			if (this._has_responded) {console.info(message);}
			else {this._child_buffer += message;}
		};
		const connect = () => {
			const {env} = process;
			const {driver, sessionid} = this;
			driver.log('debug', `starting worker`, {SessionID:sessionid, env, source:`${this.domain}/${this.node}`});
			const {stdout, stderr} = this.child = fork(executable, [node, sessionid], {env, silent:true, serialization:'advanced'});
			bind({close, error, message}).to(this.child);
			stdout.on('data', forwardOutput);
			stderr.on('data', forwardOutput);
			this._ready_semaphore = new AsyncSemaphore();
			this._down_semaphore = new AsyncSemaphore();
			this._child_buffer = '';
			this.nodeReady = false;
			this.connectProtocol();
		};
		connect();
	}
	import(properties) {return assign(properties).to(this);}
	constructor(driver, id, sessionid, data = {})
	{
		const {on, off, emit} = new Dispatcher(this._NodeEvents, this);
		const persistent = data.persistent !== false;
		this.import({driver, id, sessionid, ...data, persistent, on, off, emit});
		// add source routes to listeners for this domain
		this.connectPipeline();
		this.start();
	}
}
class Node
{
	// supply any exports here that should be published by the driver
	// this placehoder provides the action framework, and it is designed to be extended by child classes
	// all properties of the exports object must have keys that correspond to command names, and whose values are functions that return promises
	unwrapFrames = true;
	exports = {}
	// additional event types can be added through the "on" method
	_localEvents = {
		// the "exports", "checkin" and "request" events are served by the
		// ServerProtocol routes merged in by the constructor
		// receives the full subscription list from the channel, replaces the local set, reevaluates active streams
		subscriptions:streamIds => {
			this.streamIndex.subscribe(streamIds);
			this.publishStreams();
		},
		exit:message => {
			this.debug('ipc exit', message);
			this.destroy(message);
		}
	}
	_streams = new Map()
	// handle incoming signals from the process container; the 'message' stream
	// from the upstream controller process is owned by the ServerProtocol
	_interfaceSignals = {
		disconnect:() => this.destroy('received disconnect signal'),
		SIGINT:() => this.destroy('received interrupt signal'),
		SIGTERM:() => this.destroy('received terminate signal'),
		unhandledRejection:error => this.debug('unhandled rejection:', reason(error))
	}
	get streams() {return this._streams;}
	get streamIndex() {return this.protocol?.streamIndex;}
	get logger() {return isFunction(this._logger) ? this._logger : logger;}
	set logger(logger) {this._logger = logger;}
	get node() {return this.remote;}
	get domain() {return this.type;}
	get SessionID() {return this.id;}
	// the interval property specifies the dwell time between polling events
	get interval() {return this._interval ? +this._interval : 0;}
	set interval(interval) {this._interval = interval;}  // seconds units
	// supplied poll function will be called on an interval
	// set "this.interval" to the number of seconds between checks before calling this method
	// any time "this.interval" is set to 0, the polling process stops
	set poll(poll)
	{
		if (isFunction(poll))
		{
			// establish polling cycle
			const tick = () => this.poll = poll;
			this.interval && (this._repeat = setTimeout(tick, this.interval * 1000));
			const performRefresh = async () => await poll.call(this);
			const sendReady = () => this.ready();
			const onException = error => this.error(error);
			performRefresh().then(sendReady, onException);
		}
		// stops polling cycle
		else
		{
			this.interval = 0;
			clearTimeout(this.poll);
		}
	}
	get poll() {return this._repeat;}
	get onReady() {return this._ready_semaphore.status;}
	get isReady() {return this._ready_semaphore.isOpen;}
	set isReady(ready)
	{
		this._ready_semaphore.status = ready;
		ready && this.dispatch('ready');
	}
	log = (message, meta, ...rest) => {
		const source = `${this.domain}/${this.node}`;
		if (isObject(meta))
		{
			this.logger('activity', message, {source, address:SERVER_ADDRESS, ...meta});
		}
		else
		{
			this.logger('activity', [message, meta, ...rest].filter(Boolean).join(' '), {source, address:SERVER_ADDRESS});
		}
	}
	debug = (message, meta, ...rest) => {
		const source = `${this.domain}/${this.node}`;
		if (isObject(meta))
		{
			this.logger('debug', message, {source, address:SERVER_ADDRESS, ...meta});
		}
		else
		{
			this.logger('debug', [message, meta, ...rest].filter(Boolean).join(' '), {source, address:SERVER_ADDRESS});
		}
	}
	verbose = (message, meta, ...rest) => {
		const source = `${this.domain}/${this.node}`;
		if (isObject(meta))
		{
			this.logger('verbose', message, {source, address:SERVER_ADDRESS, ...meta});
		}
		else
		{
			this.logger('verbose', [message, meta, ...rest].filter(Boolean).join(' '), {source, address:SERVER_ADDRESS});
		}
	}
	getDevice(devices)
	{
		const {node} = this;
		const device = devices[node];
		if (device) {return device;}
		this.destroy('unknown device: ' + node);
	}
	send(frame)
	{
		if (this.interface.connected)
		{
			if (Buffer.isBuffer(frame))
			{
				this.protocol.send(frame);
				return this;
			}
			else
			{
				const {type, message} = frame;
				const payload = (type === 'data')
					? message
					: frame;
				this.protocol.send(payload);
				return this;
			}
		}
		else {this.destroy('process disconnected');}
	}
	sendBinary(frameType, streamId, payload)
	{
		const uid = this.streamIndex.getUID(streamId);
		if (uid !== undefined) {this.send(BinaryFrame.build(frameType, uid, payload));}
	}
	emit(type, message) {this.send({type, message});}
	// publishes the active set upward
	publishStreams()
	{
		const onChanged = streamIds => {
			const streams = streamIds.map(streamId => ({streamId, uid: this.streamIndex.getUID(streamId)}));
			this.emit('streams', {streams});
			this.dispatch('streams', {streams});
		};
		this.streamIndex.subscribe([...this.streamIndex.keys()], null, null, onChanged);
	}
	// application declares stream intent; the node mints its own uid and reevaluates the active set
	openStream(streamId)
	{
		if (!this.streamIndex.has(streamId))
		{
			this.streamIndex.add(streamId);
			const stream = this.streamIndex.get(streamId);
			const onFail = error => this.debug(error.reason || error);
			// this does the transition from application-facing API, transforming raw payloads to framework-facing binary frames
			const feedIPC = stream.fanout.consume(payload => this.sendBinary(BinaryFrame.data, streamId, payload), onFail);
			feedIPC();
			this.publishStreams();
		}
		return this.streamIndex.get(streamId);
	}
	closeStream(streamId)
	{
		this.streamIndex.delete(streamId, stream => stream.close());
		this.publishStreams();
	}
	error(error)
	{
		this.emit('error', {error});
		this.destroy();
	}
	ready(nodes = {})
	{
		// suppress duplicate events
		if (!this.isReady)
		{
			this.emit('checkin', {nodes});
			this.isReady = true;
		}
		return true;
	}
	// this method requests a refresh of the current worker state
	render()
	{
		// override this method
	}
	dispatch(type, message) {this.dispatcher.emit(type, message);}
	async connect(init)
	{
		try
		{
			this.emit('flags', {ready:false});
			if (isFunction(init))
			{
				await init.call(this);
				this.dispatch('connect');
			}
		}
		catch(error) {this.error(error || 'could not connect');}
	}
	// this method stops all processing that would prevent a clean shutdown
	async end()
	{
		// override this method if needed for the worker implementation
		this.debug('exiting gracefully');
		this.interval = 0;
		this.poll = false;
	}
	// this method attempts a clean shutdown, then forces an exit if that takes too long
	async destroy(message)
	{
		const exit = () => this.interface.exit();
		message && this.debug(message);
		const exitTimeout = setTimeout(exit, 2000);
		await this.end();
		clearTimeout(exitTimeout);
		exit();
	}
	import(properties) {return assign(properties).to(this);}
	constructor(devices, logger, iface)
	{
		this.interface = iface || process;
		const {argv} = this.interface;
		const {length} = argv;
		// if called without remote server name argument, emit devices and exit
		if (devices && length < 3)
		{
			// export devices to console for discovery
			console.log(stringify(devices));
			// no resources to clean up, exit immediately
			this.interface.exit();
		}
		const {basename} = require('path');
		// gather commandline arguments
		const [, scriptName, remote, id] = argv;
		this.type = basename(scriptName, '.js');
		// get remote server name from second commandline parameter
		this.remote = remote || '';
		const domain = `${this.type}/${this.remote}`;
		// get optional id from third commandline parameter
		this.id = id || domain;
		bind(this._interfaceSignals).to(this.interface);
		const {on, off} = this.dispatcher = new Dispatcher(this._localEvents, this);
		this._ready_semaphore = new AsyncSemaphore(false);
		// forward methods to dispatcher
		this.import({on, off, logger});
		// the responder seat: the protocol owns the interface message stream and the
		// stream index; exports invoke bare to honor their lexical context, and the
		// terminal dispatch routes every event into the node dispatcher, preserving
		// the raw "message" fallback that passthrough forwarding relies on
		const context = {message:(type, message) => this.emit(type, message)};
		const protocol = this.protocol = new ServerProtocol(this, context, this.interface);
		assign({
			invoke:(action, args, key) => action(args, key),
			log:(type, message, metadata) => this.debug(message, metadata),
			dispatch:(type, message, frame) => {
				// type and data will be undefined if message is not an object or has no properties to enumerate
				type && this.dispatch(type, message) || this.dispatch('message', frame);
			}
		}).to(protocol);
	}
}
// simple message forwarding class intended to run inside a worker module
// this is designed to cascade connection to a downstream SecureChannel server
class Passthrough extends Node
{
	unwrapFrames = false;
	get streams() {return this.channel?.streamIndex.streams;}
	get streamIndex() {return this.channel?.streamIndex;}
	async end()
	{
		this.channel.disconnect();
		await super.end();
	}
	openStream(streamId, uid)
	{
		const socket = this.channel;
		if (socket.streamIndex.has(streamId)) {return socket.streamIndex.get(streamId);}
		const stream = socket.registerStream(streamId, uid);
		const abortController = new AbortController();
		const {signal} = abortController;
		const onFail = error => this.debug(error.reason || error);
		const guard = fn => frame => {
			if (!socket.isClient) {return abortController.abort();}
			fn(frame);
		};
		const consumeIPC = stream.collator.consume(guard(frame => socket.send(frame)), onFail, null, signal)
		const consumeChannel = stream.fanout.consume(guard(frame => this.send(frame)), onFail, null, signal)
		consumeIPC();
		consumeChannel();
		return stream;
	}
	closeStream(streamId) {this.channel.streamIndex.delete(streamId, stream => stream.close());}
	async connect(init, options = {})
	{
		try
		{
			this.emit('flags', {ready:false});
			if (isFunction(init))
			{
				await init.call(this);
				this.dispatch('connect');
			}
			else
			{
				const device = init;
				if (!device) {throw 'device not found';}
				const {timeout:maxWait} = options;
				const timeout = maxWait && setTimeout(() => this.error('connection timeout exceeded'), maxWait * 1000);
				this.verbose(`Connecting to remote`, {address:SERVER_ADDRESS, device});
				this.channel.connect(device);
				await this.onReady;
				clearTimeout(timeout);
			}
		}
		catch(error) {this.error(error || 'could not connect');}
	}
	constructor(devices, logger, iface)
	{
		super(devices, logger, iface);
		// node (host name) and SessionID (connection name) are provided by Node superclass
		const {node, SessionID} = this;
		node || this.destroy('unspecified node');
		const populateStreams = ({streams}) => this.streamIndex.reconcileStreams(streams, (streamId, uid) => this.openStream(streamId, uid), (streamId) => this.closeStream(streamId));
		// receives the subscription list from the parent worker; mirrors it onto the remote channel per delta
		const reconcileSubscriptions = requests => {
			const onSubscribe = streamId => this.channel.message('streamSubscribe', {streamId});
			const onUnsubscribe = streamId => this.channel.message('streamUnsubscribe', {streamId});
			this.streamIndex.subscribe(requests, onSubscribe, onUnsubscribe)
		};
		const forwardToSocket = payload => {
			this.channel.send(payload);
			this.verbose(`Forwarded to remote: ${payload.type}`, {address:SERVER_ADDRESS});
		};
		const forwardToIPC = frame => {
			// intercept binary frames and write to the appropriate fanout stream
			const validStream = BinaryFrame.parse(frame);
			if (validStream) {StreamIndex.resolveStream(validStream, this.streamIndex)?.write(frame);}
			else
			{
				const {type, message} = frame;
				switch (type)
				{
					case 'streams': {
						populateStreams(message);
						break;
					}
					case 'ready': {
						this.isReady = true;
						break;
					}
				}
				this.emit(type, message);
				this.verbose(`Forwarded to parent: ${type}`, {address:SERVER_ADDRESS});
			}
		};
		const socketEvents = {
			error:error => this.error(error?.reason || error?.message || error),
			down:() => this.error('ECONNDROPPED'),
			message:forwardToIPC
		};
		const IPCEvents = {
			message:forwardToSocket
		};
		bind(IPCEvents).to(this);
		// don't handle protocol level events at this layer;
		// the raw "message" dispatch fallback forwards them to the remote channel
		assign({request:() => {}, publishExports:() => {}, checkin:() => {}}).to(this.protocol);
		// mirror the subscription list onto the remote channel
		this.on('subscriptions', reconcileSubscriptions);
		// create communication channel to remote service
		this.channel = new SecureChannel(socketEvents, SessionID);
		// binary frames resolve against the remote channel's stream index
		this.protocol.streamIndex = this.channel.streamIndex;
	}
}
class Controller
{
	static async getDevices(path)
	{
		// this method gathers device metadata from all drivers found in the specified path (works with Node class)
		const {join, basename} = require('path');
		const extension = '.js';
		const jsFiles = name => /.js$/.test(name);
		const stripExt = name => basename(name, extension);
		const devices = {};
		try
		{
			const files = await dir(path);
			const domains = files.filter(jsFiles).map(stripExt).sort();
			for (const domain of domains)
			{
				devices[domain] = {};
				const driver = join(path, `${domain}${extension}`);
				// run driver once to discover static nodes
				const nodes = await run(`${NODE} ${driver}`);
				// nodes could not be discovered because driver is crashing on startup
				if (isString(nodes)) {inject(devices[domain], 'MISSING', {});}
				// store discovered nodes
				else {for (const [node, data] of iterable(nodes)) inject(devices[domain], node, isObject(data) ? data : {});}
			}
			logger('debug', devices);
		}
		catch(error) {logger('error', error);}
		return devices;
	}
	// returns false if any channel is not ready
	get appReady()
	{
		for (const {channelReady} of iterable(this.channels, VALUES)) {if (!channelReady) return false;}
		return true;
	}
	// set appReady to any truthy value to refresh the onReady status and potentially trigger waiting functions
	set appReady(ready) {this.appSemaphore.status = this.appReady;}
	get onReady() {return this.appSemaphore.status}
	get devices()
	{
		if (!this._devices) {this._devices = {};}
		return this._devices;
	}
	set devices(devices) {this._devices = devices;}
	get channels()
	{
		if (!this._channels) {this._channels = {};}
		return this._channels;
	}
	set channels(channels) {if (isObject(channels)) this._channels = channels;}
	get state()
	{
		if (!this._state) {this._state = {};}
		return this._state;
	}
	set state(state) {if (isObject(state)) this._state = state;}
	get respawnTime() {return this._respawn_time || 10;}
	set respawnTime(seconds) {if (isNumeric(seconds)) {this._respawn_time = seconds;}}
	get driverPath() {return this._driver_path || DRIVERS;}
	set driverPath(path) {if (isString(path)) this._driver_path = path;}
	get logger() {return isFunction(this._logger) ? this._logger : logger;}
	set logger(logger) {this._logger = logger;}
	setState = (path = [], value) => {
		setOrGet(this.state, path, value);
		return this;
	}
	getState = (path = []) => setOrGet(this.state, path)
	// can be called without context
	uncache = (path = []) => {
		if (!path.length) {return undefined;}
		const parent = setOrGet(this.state.cache, path.slice(0, -1));
		const key = path[path.length - 1];
		if (isObject(parent)) {delete parent[key];}
		return undefined;
	}
	// can be called without context
	cache = (...args) => {
		// this method has variable arity
		// if the first argument is a regular object (not an array) then the object is assigned to the server value
		// if the first argument is an array then there is no server value, and the array is assigned to the path value
		// value === null deletes the key at path; value === undefined reads; anything else writes
		const channel = (args.length && isObject(args[0])) ? args.shift() : null;
		const [path, value, overwrite] = args;
		const state = isNull(value)
			? this.uncache(path)
			: setOrGet(this.state.cache, path || [], value, overwrite);
		if (channel instanceof Channel) {channel.emitCache(path);}
		return state;
	}
	nodes = (...args) => {
		const socket = (args.length && isObject(args[0])) ? args.shift() : null;
		const [path, flag, overwrite] = args;
		const {nodes} = this.state;
		const state = setOrGet(nodes, path || [], flag, overwrite);
		if (exists(flag) && isFunction(socket?.data))
		{
			const [domain, node] = path;
			socket.data('nodes', {[domain]:{[node]:state}});
		}
		return state;
	}
	createChannel(id, options)
	{
		const {connection} = Channel.getConnection(id, options);
		return new Channel(id, connection).join(this);
	}
	reply(response, result)
	{
		try
		{
			response.header('Content-Type', 'application/json');
			response.send(result);
		}
		catch(error) {this.log('error', error);}
	}
	log(type, message, metadata = {})
	{
		const {name, version} = this.getState(['application']);
		const source = name && version ? `${name}@${version}` : 'controller';
		this.logger(type, message, {source, ...metadata});
	}
	destroy(message)
	{
		this.log(message);
		process.exit();
	}
	bindProcessExceptions()
	{
		const exceptions = {
			SIGINT:() => this.destroy('received interrupt signal'),
			SIGTERM:() => this.destroy('received terminate signal'),
			unhandledRejection:error => this.log('debug', 'unhandled rejection:', error.message || error)
		};
		bind(exceptions).to(process);
	}
	async end(message)
	{
		this.log('info', 'shutting down all channels');
		const closeWorkers = async ([id, channel]) => {
			this.log('info', `closing workers`, {domain:id});
			const clear = setTimeout(() => this.destroy(message), 2000);
			await channel.end();
			clearTimeout(clear);
		};
		await iterable(this.channels).map(closeWorkers);
		this.destroy(message);
	}
	async start()
	{
		try
		{
			this.bindProcessExceptions();
			this.devices = await Controller.getDevices(this.driverPath);
			const startChannel = channel => channel.start();
			await concurrent(iterable(this.channels, VALUES), startChannel);
		}
		catch(error) {this.log('error', error);}
	}
	bind(events) {return bind(events).to(this);}
	import(properties) {return assign(properties).to(this);}
	constructor(state = {}, driverPath = DRIVERS, respawnTime = 10, logger)
	{
		const {on, off, emit} = new Dispatcher({}, this);
		this.import({state, driverPath, respawnTime, chain, on, off, emit, logger})
		this.appSemaphore = new AsyncSemaphore();
		// ensure required root properties exist in state object
		['cache', 'nodes'].forEach(key => initKey(state, key));
		this.log('info', 'new controller', {process_context:USER});
		this.nodes.remove = (domain, node) => {
			const {nodes} = state;
			if (domain in nodes && node in nodes[domain]) {delete nodes[domain][node];}
		};
	}
}
module.exports = {
	SecureChannel,
	Node,
	Passthrough,
	Transaction,
	Queue,
	TransactionQueue,
	Dispatcher,
	SystemCommand,
	Worker,
	Channel,
	Driver,
	Controller,
	ExpressMiddleware,
	CachedData,
	Logger,
	BinaryFrame,
	StreamIndex,
	QueueIterator,
	AsyncFanout,
	ClientProtocol,
	ServerProtocol,
	ServerSession,
	ClientSession,
	ProcessInterface,
	ChildInterface,
	toReadable,
	toWritable
};
