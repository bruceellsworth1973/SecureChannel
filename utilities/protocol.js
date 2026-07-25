const {bind, chain, isObject, isArray, isEmpty, isFunction, iterable, reason, AsyncSemaphore, nsresolution, KEYS} = require('helpers');
const {EventEmitter} = require('events');
const {BinaryFrame, StreamIndex} = require('./substreamDuplex.js');
class ClientProtocol extends EventEmitter
{
	// the requester seat of the wire protocol: owns transactions, the stream index,
	// frame wrap/unwrap, and the consumer half of the capability handshake.
	// the socket is any duplex connection exposing send() and on/off('message')
	#queue = new Map();
	#streamIndex = new StreamIndex();
	#readySemaphore = new AsyncSemaphore(false);
	#exportsSemaphore = new AsyncSemaphore(false);
	#notReady = 'socket not ready';
	get streamIndex() {return this.#streamIndex;}
	get exportsLoaded() {return this.#exportsSemaphore.isOpen;}
	set exportsLoaded(value) {this.#exportsSemaphore.status = value;}
	get isReady() {return this.#readySemaphore.isOpen;}
	set isReady(value)
	{
		this.emit('ready', value);
		this.#readySemaphore.status = value;
	}
	get onReady() {return this.#readySemaphore.status;}
	get onExports() {return this.#exportsSemaphore.status;}
	get #transactionID()
	{
		let key;
		const [s, ns] = process.hrtime();
		do {key = s * nsresolution + ns;}
		while (this.#queue.has(key));
		return key;
	}
	#writeStdout(frame, {uid, payload})
	{
		this.getStream(uid)?.write(payload);
		return this.emit('binaryPacket', frame, uid, payload);
	}
	#writeStdin(streamId, payload)
	{
		const uid = this.#streamIndex.getUID(streamId);
		if (uid === undefined) {return;}
		this.send(BinaryFrame.build(BinaryFrame.data, uid, payload));
	}
	#drainStdin(stream)
	{
		const {streamId} = stream;
		const drainStdin = stream.stdin.consume(payload => this.#writeStdin(streamId, payload));
		drainStdin();
	}
	#data(frame)
	{
		try
		{
			if (!isObject(frame)) {frame = JSON.parse(frame);}
			const validStream = BinaryFrame.parse(frame);
			if (validStream)
			{
				this.#writeStdout(frame, validStream);
				return;
			}
			const {type, message} = frame;
			switch (type)
			{
				case 'checkin':
				{
					this.checkin(message);
					break;
				}
				case 'import':
				{
					this.import(message);
					break;
				}
				case 'ready':
				{
					this.isReady = true;
					return;
				}
				case 'error':
				{
					this.isReady = false;
					break;
				}
				case 'streams':
				{
					this.reconcileStreams(message.streams);
					break;
				}
				case 'response':
				{
					const {key, result} = message;
					const transaction = this.#queue.get(key);
					if (transaction)
					{
						const {error, result:value} = result ?? {};
						error ? transaction.reject(error) : transaction.resolve(value);
					}
					break;
				}
			}
			this.dispatch(type, message);
		}
		catch
		{
			// silently drop malformed packets
		}
	}
	// capability handshake seams: hosts with their own import policy override these
	checkin(message) {this.message(this.exportsLoaded ? 'checkin' : 'exports');}
	import(message)
	{
		this.exportsLoaded = true;
		this.message('checkin');
	}
	// terminal dispatch seam: hosts that route events into their own dispatcher override this
	dispatch(type, message) {this.emit(type, message);}
	// stream advertisement seam: hosts that translate uid namespaces or
	// pump streams themselves override this and drive the index directly
	reconcileStreams(streams)
	{
		const onOpen = (streamId, uid) => this.#streamIndex.add(streamId, uid);
		const onClose = streamId => this.#streamIndex.delete(streamId, stream => stream.end());
		this.#streamIndex.reconcileStreams(streams, onOpen, onClose);
	}
	send(payload)
	{
		if (this.socket)
		{
			this.socket.send(payload);
			return true;
		}
		return false;
	}
	message(type, message) {this.send({type, message});}
	subscribeStream(streamId) {this.message('streamSubscribe', {streamId});}
	unsubscribeStream(streamId) {this.message('streamUnsubscribe', {streamId});}
	getStream(streamId) {return this.#streamIndex.get(streamId);}
	hasStream(streamId) {return this.#streamIndex.has(streamId);}
	openStream(stream) {this.#drainStdin(stream);}
	transact(command, args, maxWait, controller = new AbortController())
	{
		// an optional signal property in args binds the transaction to a caller-held
		// AbortSignal; it is extracted here and never crosses the wire
		const {signal:abortSignal, ...payload} = args ?? {};
		const {signal} = controller;
		const key = this.#transactionID;
		const request = (resolve, reject) =>
		{
			if (!this.isReady) {reject(this.#notReady); return;}
			if (signal.aborted || abortSignal?.aborted) {reject('aborted'); return;}
			const settle = (error, value) =>
			{
				clearTimeout(timeout);
				abortSignal?.removeEventListener('abort', abort);
				if (!this.#queue.has(key)) {return;}
				this.#queue.delete(key);
				error ? reject(error) : resolve(value);
			};
			const abort = () => settle('aborted');
			const timeout = maxWait
				? setTimeout(() => settle(`request timed out: ${command} after ${maxWait}ms`), +maxWait)
				: undefined;
			signal.addEventListener('abort', abort, {once:true});
			abortSignal?.addEventListener('abort', abort, {once:true});
			const transaction = {resolve:value => settle(null, value), reject:error => settle(error), controller};
			this.#queue.set(key, transaction);
			this.message('request', {key, request:{command, ...payload}});
		};
		return new Promise(request);
	}
	constructor(socket, routes = {})
	{
		super();
		this.socket = socket;
		const onMessage = frame => this.#data(frame);
		this.end = () => {
			socket.off('message', onMessage);
			for (const {controller} of [...this.#queue.values()]) {controller.abort();}
			this.#streamIndex.clear(stream => stream.end());
		};
		socket.on('message', onMessage);
		bind(routes).to(this);
	}
}
class ServerProtocol extends EventEmitter
{
	// the responder seat of the wire protocol: parses inbound messages, dispatches
	// request envelopes into the host's living exports table, serves the provider
	// half of the capability handshake, owns the stream index and binary frame
	// translation, and acts as the stream subscription clearing house.
	// the host owns the exports table; the protocol consults it at execute time.
	// a context is any object exposing message(type, message); for per-socket hosts
	// the context is the requesting socket, for single-connection hosts it is fixed.
	// when constructed with a socket (anything exposing send and on/off for
	// 'message' events) the protocol owns inbound parsing and routes every event
	// through the dispatch seam; transport-owning hosts omit the socket and merge
	// the routes map into their own dispatcher instead
	get exports() {return this.host.exports;}
	get onReady() {return this.host.onReady || true;}
	// the unwrapFrames policy controls whether streams receive raw frames or only payloads
	get unwrapFrames() {return this.host.unwrapFrames !== false;}
	log(...args) {this.host.log?.(...args);}
	// invocation seam: default binds the host context (Channel-style exports);
	// hosts whose exports capture context lexically (Node-style) override to call bare
	invoke(action, args, key, context) {return action.call(this.host, args, key, context);}
	// decoration seam: hosts inject per-request metadata into args (e.g. sessionid);
	// the originating envelope is supplied for hosts that consume its metadata
	decorate(args, context, envelope) {return args;}
	async execute(command, args = {}, key, context)
	{
		const action = this.exports[command];
		this.log('debug', `Request >> ${command}`, {address:context?.Address});
		if (!action) {throw `unknown command: ${command}`;}
		try
		{
			const result = await this.invoke(action, args, key, context);
			this.log('debug', `Result << ${command} succeeded`, {address:context?.Address});
			return result;
		}
		catch (exception)
		{
			this.log('debug', `Error << ${command} failed`, {address:context?.Address, error:exception});
			const error = reason(exception);
			throw isEmpty(error) ? `runtime exception in ${command}` : error;
		}
	}
	request(envelope, context)
	{
		const {key, request:{command, ...args}} = envelope;
		const response = result => context.message('response', {key, result});
		chain(this.execute(command, this.decorate(args, context, envelope), key, context), response);
	}
	async publishExports(context)
	{
		await this.onReady;
		const exports = iterable(this.exports, KEYS) || [];
		context.message('import', {exports});
	}
	// state synchronization seam: Channel pushes cache, nodes and streams here;
	// hosts with no state to replay leave this empty
	pushState(context) {}
	async checkin(context)
	{
		await this.onReady;
		this.pushState(context);
		context.message('ready');
	}
	// the subscription seats never resolve or mint uids: the channel mints at
	// registration, and reconciliation is owned by the host's own methods
	streamSubscribe({streamId}, context)
	{
		if (!streamId) {return;}
		this.host.subscribeStream?.(streamId, context);
	}
	streamUnsubscribe({streamId}, context)
	{
		if (!streamId) {return;}
		this.host.unsubscribeStream?.(streamId, context);
	}
	send(payload)
	{
		if (this.socket)
		{
			this.socket.send(payload);
			return true;
		}
		return false;
	}
	message(type, message) {this.send({type, message});}
	sendBinary(frameType, streamId, payload)
	{
		const uid = this.streamIndex.getUID(streamId);
		if (uid !== undefined) {this.send(BinaryFrame.build(frameType, uid, payload));}
	}
	// binary frames resolve against the stream index and feed the stream collator
	process(frame, validStream)
	{
		const data = this.unwrapFrames ? validStream.payload : frame;
		this.streamIndex.get(validStream.uid)?.process(data);
		this.emit('binaryPacket', frame, validStream.uid, validStream.payload);
	}
	// terminal dispatch seam: hosts that route events into their own dispatcher override this;
	// the raw frame is supplied for hosts that forward unhandled traffic verbatim
	dispatch(type, message, frame) {this.emit(type, message);}
	#data(frame)
	{
		try
		{
			if (!isObject(frame)) {frame = JSON.parse(frame);}
			const validStream = BinaryFrame.parse(frame);
			if (validStream)
			{
				this.process(frame, validStream);
				return;
			}
			const {type, message} = frame;
			switch (type)
			{
				case 'request':
				{
					this.request(message, this.context);
					break;
				}
				case 'exports':
				{
					this.publishExports(this.context);
					break;
				}
				case 'checkin':
				{
					this.checkin(this.context);
					break;
				}
				case 'streamSubscribe':
				{
					this.streamSubscribe(message, this.context);
					break;
				}
				case 'streamUnsubscribe':
				{
					this.streamUnsubscribe(message, this.context);
					break;
				}
			}
			this.dispatch(type, message, frame);
		}
		catch
		{
			// silently drop malformed packets
		}
	}
	// handler map for merging into a host dispatcher; handlers invoked with a
	// socket context use it as the response context, otherwise the fixed context applies
	get routes()
	{
		const protocol = this;
		const resolveContext = context => isFunction(context?.message) ? context : protocol.context;
		return {
			request(message) {protocol.request(message, resolveContext(this));},
			exports() {protocol.publishExports(resolveContext(this));},
			checkin() {protocol.checkin(resolveContext(this));},
			streamSubscribe(message) {protocol.streamSubscribe(message, resolveContext(this));},
			streamUnsubscribe(message) {protocol.streamUnsubscribe(message, resolveContext(this));}
		};
	}
	constructor(host, context = null, socket = null)
	{
		super();
		this.host = host;
		this.context = context;
		this.socket = socket;
		// adopt the transport's stream index when the host owns one, otherwise mint a private index
		this.streamIndex = host?.streamIndex || new StreamIndex();
		if (socket)
		{
			const onMessage = frame => this.#data(frame);
			this.end = () => socket.off('message', onMessage);
			socket.on('message', onMessage);
		}
	}
}
class Session
{
	// the session tier of the wire protocol: owns inbound message routing for one
	// role of a SecureChannel transport. binary frames resolve against the channel
	// stream index and route through the role's binary seam; JSON frames run the
	// role's handshake cases, then dispatch upward enriched with the connection
	// identity. transmission, keepalive and reconnection remain transport concerns
	get streamIndex() {return this.channel.streamIndex;}
	log(...args) {this.channel.log(...args);}
	emit(type, message, ws) {return this.channel.emit(type, message, ws);}
	// role seam: route an inbound binary frame to the resolved stream
	binary(stream, frame) {}
	// role seam: handle a role-specific handshake case; returns true when consumed
	handshake(type, message, ws, address, SessionID) {return false;}
	data(frame, ws, address)
	{
		const validStream = BinaryFrame.parse(frame);
		if (validStream)
		{
			try {this.binary(StreamIndex.resolveStream(validStream, this.streamIndex), frame);}
			catch (exception)
			{
				const error = reason(exception);
				this.log('debug', 'inbound binary frame failed', {address, uid:validStream.uid, reason:error});
				this.emit('error', {address, sessionid:ws.SessionID, reason:error}, ws);
			}
			return true;
		}
		return this.parse(frame, ws, address);
	}
	parse(payload, ws, address)
	{
		try
		{
			const data = JSON.parse(payload);
			const {type, message} = data;
			for (const writer of this.channel.activeWriters)
				if (!writer.ws || writer.ws === ws)
					writer.write(data);
			if (type)
			{
				// captured before the handshake so a session rename does not alter this event's identity
				const SessionID = ws.SessionID || message.SessionID;
				// forward generic message traffic before triggering other events
				this.handshake(type, message, ws, address, SessionID) || this.emit('message', {type, message, address, SessionID}, ws);
				this.log('verbose', '<<', {type, message, SessionID});
				// propagate local event based on event type
				const properties = isObject(message) && !isArray(message)
					? message
					: {body:message};
				this.emit(type, {...properties, address, SessionID}, ws);
				return true;
			}
		}
		catch(_) {} // eslint-disable-line
		return false;
	}
	constructor(channel, time)
	{
		this.channel = channel;
		this.time = time;
	}
}
class ServerSession extends Session
{
	// the server seat of the session handshake: names client sessions and reissues
	// the handshake on request; inbound binary frames feed the stream collators
	binary(stream, frame) {stream?.process(frame);}
	handshake(type, message, ws, address)
	{
		switch (type)
		{
			// the SessionID is initially established from the server end of the link,
			// but the client responds to the "up" handshake by sending a "sessionid" event
			// to either agree with the server value or provide a new one
			case 'sessionid':
			{
				// client wants to establish a unique session
				const SessionID = `${message.SessionID}@${address}`;
				// set the socket SessionID to the requested value
				ws.SessionID = SessionID;
				ws.Address = address;
				this.channel.sessions(ws);
				this.emit('up', {address, SessionID}, ws);
				return true;
			}
			// if the client requests a new session, the server responds with a new handshake
			case 'newsession':
			{
				const {keepalive} = ws;
				const {SessionID} = this.channel;
				ws.message('up', {timestamp:this.time(), SessionID, keepalive});
				return true;
			}
		}
		return false;
	}
}
class ClientSession extends Session
{
	// the client seat of the session handshake: adopts the server's session terms;
	// inbound binary frames feed the stream fanouts toward local consumers
	binary(stream, frame) {stream?.write(frame);}
	handshake(type, message, ws, address, SessionID)
	{
		switch (type)
		{
			// the "up" event is the initial handshake to establish the connection is working in full duplex
			// it also synchronizes the keepalive value of the client to match the server ping interval
			case 'up':
			{
				const {keepalive} = message;
				ws.keepalive = keepalive;
				ws.Address = address;
				this.emit('up', {address, SessionID}, ws);
				return true;
			}
		}
		return false;
	}
}
module.exports = {ClientProtocol, ServerProtocol, Session, ServerSession, ClientSession};
