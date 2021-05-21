Object.assign(exports, (function() {
	const DRIVERS = 'drivers';
	const NODE = '/usr/bin/node';
	const LOGGING = false;
	const DEBUGGING = false;
	const VERBOSE = false;
	const {KEYS, VALUES, isFalse, isEqual, isFunction, isObject, isString, isArray, assign, iterable, includes, inject, events, bind, setOrGet, initKey, chain, dir, run} = require('helpers');
	const {parse, stringify} = JSON;
	const nsresolution = 1000000000;
	// max time to live for requests
	const maxTTL = 20 * nsresolution;
	function errorLog(e)
	{
		LOGGING && e && console.error(e);
		return (e && e.toString && e.toString() || e);
	}
	function debugLog(...messages)
	{
		DEBUGGING && console.debug(...messages);
	}
	function verboseLog(...messages)
	{
		VERBOSE && console.debug(...messages);
	}
	function activityLog(...messages)
	{
		LOGGING && console.log(...messages);
	}
	class IPC
	{
		// interprocess communication and process control layer
		// this class is designed to run in a child process controlled by a parent instance of the Router class
		trigger(type, data = {})
		{
			const listener = this.listeners[type]||false;
			isFunction(listener) && listener.call(this, data);
			return this;
		}
		end()
		{
			// this void method should be overridden by subclasses to inject a graceful shutdown procedure
		}
		destroy(message)
		{
			this.log(message);
			try {this.end();}
			catch(e) {this.log(e);}
			process.exit();
		}
		get node()
		{
			return this.remote;
		}
		get domain()
		{
			return this.type;
		}
		get SessionID()
		{
			return this.id;
		}
		on(type, listener)
		{
			this.listeners[type] = listener;
			return this;
		}
		executeAsync(fork)
		{
			isFunction(fork) && (setTimeout(fork.bind(this), 0));
			return this;
		}
		import(properties)
		{
			return assign(properties).to(this);
		}
		send(event)
		{
			try {stringify(event) && process.send(event);}
			catch(e) {this.trigger('exit', e);}
			return this;
		}
		emit(type, message)
		{
			this.send({type, message});
		}
		response(response)
		{
			this.emit('response', response);
			return this;
		}
		flags(flags)
		{
			this.emit('flags', flags);
			return this;
		}
		error(error)
		{
			error && this.flags({error});
			this.destroy(error);
		}
		poll(poll)
		{
			if (isFunction(poll))
			{
				let repeat;
				// establish polling cycle
				this.interval && (repeat = setTimeout(() => this.poll(poll), this.interval*1000));
				this.stop = () => clearInterval(repeat);
				try {
					poll.call(this);
					this.ready();
				}
				catch(e) {this.error(e);}
			}
		}
		stop()
		{}
		setInterval(query)
		{
			this.interval = +(query.interval);
			return this;
		}
		async request()
		{
			// this void method should be overridden by subclasses
		}
		ready()
		{
			if (!this.isReady)
			{
				const ready = this.isReady = true;
				this.trigger('ready').flags({ready});
				return true;
			}
			return false;
		}
		async connect(init)
		{
			try
			{
				if (isFunction(init))
				{
					this.trigger('connect');
					await init();
				}
			}
			catch(error) {this.error(error);}
		}
		constructor(devices = {})
		{
			const {argv} = process;
			const len = argv.length;
			// if called without remote server name argument, emit devices and exit
			if (len < 3)
			{
				console.log(stringify(devices));
				process.exit();
			}
			this.log = (...messages) => activityLog(...this.prefix.concat(messages));
			this.debug = (...messages) => debugLog(...this.prefix.concat(messages));
			this.verbose = (...messages) => verboseLog(...this.prefix.concat(messages));
			const {basename} = require('path');
			// get script name from first commandline parameter
			this.type = basename(argv[1], '.js');
			// get remote server name from second commandline parameter
			this.remote = argv[2] || '';
			const domain = this.type+'.'+this.remote;
			// get optional id from third commandline parameter
			this.id = argv[3] || domain;
			this.prefix = [domain, '->'];
			// handle events from parent process
			const parent = {
				message:message => {
					if (message) {for (const type of iterable(this.listeners, KEYS)) {includes(type).in(message) && this.trigger(type, message[type]);}}
					return this;
				},
				disconnect:() => this.destroy('received disconnect signal'),
				SIGINT:() => this.destroy('received interrupt signal'),
				SIGTERM:() => this.destroy('received terminate signal')
			};
			// global listeners are reserved and should not be overridden
			this.listeners = {
				request({key, request}) {this.request(request, key).then(result => ({key, result}), error => ({key, error})).then(response => this.response(response));},
				exit(message) {this.destroy(message);}
			};
			bind(parent).to(process);
			this.events = events;
			this.bind = events;
		}
	}
	class Passthrough extends IPC
	{
		// simple message forwarding class intended to run inside a child-process driver module
		// this is designed to cascade to a downstream SecureChannel server
		end()
		{
			this.channel.disconnect();
			this.log('exiting gracefully');
		}
		message(type, message)
		{
			this.channel.message(type, message);
		}
		query(request, key, abort = false)
		{
			this.message(abort ? 'abort' : 'request', {key, request})
		}
		request(request, key)
		{
			this.query(request, key);
		}
		abort(request, key)
		{
			this.query(request, key, true);
		}
		constructor(devices)
		{
			super(devices);
			// node (host name) and SessionID (connection name) are provided by IPC superclass
			const {node, SessionID} = this;
			const connected = true;
			const events = {
				outgoing:
				{
					message:({type, message}) => this.message(type, message),
					request:({key, request}) => this.request(request, key),
					abort:({key, request}) => this.abort(request, key),
				},
				incoming:
				{
					connect:() => this.flags({connected}),
					error:({reason}) => this.error(reason),
					up:() => this.ready() && this.message('render', {}),
					down:() => this.error('remote connection dropped'),
					message:({type, message}) => this.emit(type, message),
					response:response => this.response(response),
					heartbeat:() => this.debug('heartbeat received')
				}
			};
			this.bind(events.outgoing);
			!node && this.trigger('exit', 'unspecified node');
			// create dedicated communication channel
			this.channel = new SecureChannel(events.incoming, SessionID);
		}
	}
	class SecureChannel
	{
		// provides the following upgrades to the basic WebSocket class:
		// client establishes a persistent connection with the server when a keepalive value > 0 is specified
		// enables heartbeat telemetry by default when establishing persistent connections
		// provides connection latency tracking (using heartbeat mechanism)
		// named connections provide basis for stateful connection tracking
		// unique event listeners can be triggered on user-definable message types
		// bridging connections and passing messages between sockets is simplified
		// a single class instance can simultaneously connect to one remote host and service multiple remote clients on a local port
		toSQLDate()
		{
			// this = date object
			return this.toJSON().slice(0, 19).replace('T', ' ');
		}
		time(time = new Date())
		{
			return assign({toSQL:() => this.toSQLDate.call(time)}).to(time);
		}
		get clients()
		{
			return this.wss && this.wss.clients || [];
		}
		sockets(action)
		{
			if (isFunction(action)) {for (const socket of this.clients) {action.call(socket);}}
		}
		terminate()
		{
			return function() {this.terminate();}
		}
		list()
		{
			return function() {debugLog(this.SessionID);}
		}
		purge(id)
		{
			return function() {isEqual(this.SessionID, id) && this.close(3000, 'client migrated to new socket');}
		}
		formMessage(type, payload)
		{
			return (isString(type) && isObject(payload) || isArray(payload)) ? stringify({type, payload}) : false;
		}
		message(event, message)
		{
			message = this.formMessage(event, message);
			if (message)
			{
				this.ws && this.write(message).call(this.ws);
				this.wss && this.sockets(this.write(message));
				return true;
			}
			return false;
		}
		data(type, message)
		{
			return this.message('data', {type, message});
		}
		noop()
		{}
		constructor(routes = {}, SessionID = false)
		{
			const channel = this;
			const WebSocket = require('ws');
			const {createServer} = require('https');
			const {randomBytes} = require('crypto');
			const generateKey = () => randomBytes(16).toString('base64');
			const timestamp = () => this.time().toSQL();
			// provide means to attach event listeners
			this.events = events;
			this.on = (event, listener) => {
				routes[event] = listener;
				return this;
			};
			// call the function returned by write with a websocket context to send the message on that context
			this.write = message => function() {this.isActive() ? this.send(message, error => error && this.trigger('error', error)) : this.close(3001, 'socket not ready');};
			// socketMethods operate under a WebSocket context as they extend the WebSocket prototype
			const socketMethods = {
				isActive() {return isEqual(this.readyState, WebSocket.OPEN);},
				// propagate new event to local event listener
				trigger(event, message)
				{
					if (event)
					{
						const method = routes[event];
						isFunction(method) ? method.call(this, {...message, timestamp:timestamp()}) : debugLog(`no listener for ${event} event in`, routes);
					}
					else
					{
						debugLog('unknown event for message:', message);
					}
				},
				// propagate new event to remote host (converse of parseMessage)
				message(event, message)
				{
					verboseLog(event, '<<', message, this.SessionID);
					message = channel.formMessage(event, message);
					if (message)
					{
						channel.write(message).call(this);
						return true;
					}
					return false;
				},
				// append channel data method to all WebSockets
				data:this.data,
				// derive events from raw message content
				parseMessage(message, address)
				{
					try
					{
						const {type, payload} = parse(message);
						if (type)
						{
							if (isEqual('sessionid', type))
							{
								// client wants to establish a unique session
								const SessionID = `${payload.SessionID}@${address}`;
								// temporarily set the socket SessionID to a random key
								this.SessionID = generateKey();
								// purge sockets with the same SessionID to drop any stale connections
								channel.sockets(channel.purge(SessionID));
								// set the socket SessionID to the requested value
								this.SessionID = SessionID;
								channel.sessions(this);
							}
							if (isEqual('newsession', type))
							{
								this.message('up', {timestamp:timestamp(), SessionID:generateKey()});
							}
							else if (isEqual('up', type))
							{
								// name the connection using the client-provided value or fallback to the server-provided value or fallback further to a randomly generated key
								const SessionID = this.SessionID || payload.SessionID || generateKey();
								this.SessionID = SessionID;
								// send the SessionID to the server to name the link at both ends
								this.message('sessionid', {SessionID});
							}
							else
							{
								// forward raw message before generating local event
								this.trigger('message', {type, message:payload});
							}
							const {SessionID} = this;
							verboseLog(type, '>>', payload, SessionID);
							this.trigger(type, {...payload, address, SessionID});
						}
						return true;
					}
					catch(_) {return false;}
				}
			};
			// bind custom methods to all WebSocket objects
			assign(socketMethods).to(WebSocket.prototype);
			// SecureChannel server
			this.listen = options => {
				const keepalive = options.keepalive||0;
				const {address, port, cert, key} = options;
				debugLog('server options', {address, port, keepalive});
				const path = options.path || '/';
				const ready = () => isFunction(routes.listening) && routes.listening.call(this, {address, port, timestamp:timestamp()});
				const ping = () => function () {
					if (isEqual(this.isAlive, false)) {return this.terminate();}
					this.isAlive = false;
					channel.sendTime = Date.now();
					this.ping(channel.noop);
				};
				function host(req)
				{
					const forwarded = req.headers['x-forwarded-for'];
					const address = forwarded ? forwarded.split(/\s*,\s*/)[0] : req.connection.remoteAddress;
					const SessionID = address;
					assign({isAlive:true, SessionID}).to(this);
					const listeners = {
						close(code, reason)
						{
							this.trigger('close', {address, sessionid:this.SessionID, reason:reason||code});
							channel.sessions(this);
						},
						error(e) {this.trigger('error', {address, sessionid:this.SessionID, reason:e.Error});},
						message(message) {this.parseMessage(message, address);},
						pong() {(this.isAlive = true) && this.trigger('heartbeat', {address, sessionid:this.SessionID, latency:(Date.now()-channel.sendTime)/2});}
					};
					// bind events to websocket
					bind(listeners).to(this);
					// inform server that new client has connected
					this.trigger('open', {address});
					channel.sessions(this);
					// inform client that connection is ready
					this.message('up', {timestamp:timestamp(), SessionID:generateKey()});
				}
				this.sessions = ws => {
					const sessions = [];
					channel.sockets(function() {sessions.push(this.SessionID);});
					ws.trigger('sessions', {sessions});
				};
				this.destroy = () => {
					clearInterval(this.healthCheck);
					this.sockets(this.terminate());
					return true;
				};
				const server = this.server = createServer({cert, key}).listen(port, address, ready);
				this.wss = new WebSocket.Server({server, path}).on('connection', (ws, req) => host.call(ws, req));
				keepalive && (this.healthCheck = setInterval(() => this.sockets(ping()), keepalive*1000));
				return this;
			};
			// SecureChannel client
			this.connect = options => {
				const {address, port} = options;
				const path = options.path||'';
				const keepalive = options.keepalive||0;
				const reconnect = options.reconnect||5;
				const rejectUnauthorized = options.enforceSSLVerification||false;
				const service = `${address}:${port}`;
				const url = `wss://${service}${path}`;
				const origin = `https://${service}`;
				debugLog('client options', {address, port, keepalive, reconnect});
				this.ws = {
					terminate:channel.noop,
					isActive() {return false;},
					readyState:false,
					SessionID
				};
				const init = () => {
					// if socket is open then do nothing
					if (this.ws.isActive()) {return;}
					// rejectUnauthorized:false allows connections to a server using a self-signed cert
					// traffic is strongly encrypted, but TLS will not attempt to verify authenticity of the certificate chain
					this.ws = assign({SessionID}).to(new WebSocket(url, {origin, rejectUnauthorized}));
					// listeners run under websocket context
					const listeners = {
						ping()
						{
							const timedout = () => {
								this.trigger('error', {address, reason:'no heartbeat received for '+keepalive+' seconds'});
								this.terminate();
							};
							if (keepalive)
							{
								clearTimeout(this.pingTimeout);
								this.pingTimeout = setTimeout(timedout, keepalive*1000+1000);
								this.trigger('heartbeat', {address});
							}
						},
						message(message) {this.parseMessage(message, address);},
						open()
						{
							clearTimeout(this.respawnTimeout);
							this.respawnTimeout = false;
							this.ping();
							// the 'connect' message is only a confirmation that the local end of the connection is established
							// the connection is not considered up until an 'up' message arrives from the server
							this.trigger('connect', {address});
						},
						close()
						{
							clearTimeout(this.pingTimeout);
							if (keepalive) {this.respawnTimeout = setTimeout(init, reconnect*1000);}
							// 'down' messages are generated locally when a connection is severed for any reason
							this.trigger('down', {address});
						},
						error(reason) {this.trigger('error', {address, reason});}
					};
					// bind events to websocket
					bind(listeners).to(this.ws);
					this.disconnect = () => this.ws.terminate();
				};
				init();
				return this;
			}
		}
	}
	class Queue
	{
		// dynamic action queue framework
		// allow reading of queue length
		get length()
		{
			return this.actions.length;
		}
		// add actions to top of queue
		first(...actions)
		{
			this.actions.unshift(...actions);
		}
		// add action to bottom of queue
		defer(...actions)
		{
			this.actions.push(...actions);
		}
		// execute next queued entry
		next()
		{
			if (0 < this.actions.length)
			{
				const action = this.actions.shift();
				isFunction(action) && action();
			}
		}
		// populate new queue with 0 or more actions
		constructor(...actions)
		{
			this.actions = [...actions];
		}
	}
	class Response extends Queue
	{
		// promise-based response handler with queueing extension
		settle(path, response)
		{
			// cancel timeout, if still ticking
			clearTimeout(this.timeout);
			// clear busy flag and continue processing any queued requests in order of receipt
			this.busy = false;
			this.next();
			// settle current request and return response
			isFunction(path) && path(response);
		}
		process(query, timeout = 0)
		{
			// request events temporarily hijack the dispatcher event stream to intercept result messages and errors
			// other message types pass through seamlessly without interrupting request processing
			return new Promise((resolve, reject) => {
				// requests can only be processed serially
				// push request on the stack if waiting for prior request to settle
				if (this.busy) {return this.defer(() => this.process(query).then(resolve, reject));}
				else
				{
					// block simultaneous requests while the current request is processing
					this.busy = true;
					// fail if timeout fires before request settles
					timeout && (this.timeout = setTimeout(() => this.settle(reject, 'timeout'), timeout*1000));
					// capture success or failure, whichever occurs first
					const triggers = {result:r => this.settle(resolve, r), error:e => this.settle(reject, e)};
					bind(triggers).to(this.dispatcher);
					// initiate query
					if (!query()) {return this.settle(reject, 'communication fault');}
				}
			});
		}
		constructor(dispatcher)
		{
			super()
			this.timeout = false;
			this.busy = false;
			this.dispatcher = dispatcher;
		}
	}
	class Dispatcher
	{
		// abstraction layer between an input stream and event consumers
		// facilitates agile message interception and redirection without creating temporary event listeners on the input stream
		timer(mode, abort = () => {}, timeout = 120)
		{
			clearTimeout(this.timeout);
			switch(mode)
			{
				case 'set':
				{
					this.complete = false;
					mode = 'reset';
					break;
				}
				case 'reset':
				{
					if (!this.complete) {this.timeout = setTimeout(abort, timeout*1000);}
					break;
				}
				case 'clear':
				{
					this.complete = true;
					break;
				}
			}
			return this;
		}
		trigger(type, event)
		{
			debugLog({type, event});
			isFunction(this.listeners[type]) && this.listeners[type].call(this, event);
			return this;
		}
		sink(source)
		{
			// propagate unprocessed messages using generic data event
			source && this.trigger('data', source);
			return false;
		}
		use(parser)
		{
			// specify custom message parser
			// parser priority is the inverse of the order in which it is added to the chain
			// therefore, the highest priority parser should be added last
			if (isFunction(parser)) {this.parsers.unshift(parser);}
		}
		reduce(message)
		{
			// custom reduce function that aborts processing on conditional match
			for (const parser of this.parsers)
			{
				if (isFalse(message)) {break;}
				message = parser(message);
			}
		}
		on(event, listener)
		{
			// specify listener for trapped event
			this.listeners[event] = listener;
			return this;
		}
		constructor()
		{
			this.parsers = [this.sink.bind(this)];
			this.listeners = {};
			this.events = events;
			this.bind = events;
		}
	}
	class Driver extends Dispatcher
	{
		// closes the communication loop with a child process running an instance of the IPC superclass
		get key()
		{
			const [s, ns] = process.hrtime();
			return s * nsresolution + ns;
		}
		send(message)
		{
			if (isObject(this.child) && isFunction(this.child.send))
			{
				this.child.send(message);
				return true;
			}
			errorLog('Worker process not running');
			return false;
		}
		emit(type, message)
		{
			verboseLog({[type]:message});
			return this.send({[type]:message});
		}
		destroy()
		{
			clearInterval(this.freeResources);
			try {this.child.kill();}
			catch(_) {return;}
		}
		commit(request)
		{
			const {key, queue, domain} = this;
			return new Promise((result, error) => {
				activityLog(domain, '>>', request);
				// add response object to queue
				queue[key] = {request, result, error};
				// commit request
				this.emit('request', {key, request});
			});
		}
		abort(request)
		{
			const {domain} = this;
			activityLog(domain, '>>', 'abort' , request);
			return this.emit('abort', {request});
		}
		response(response)
		{
			const {domain, queue} = this;
			const {key, result, error} = response;
			if (key)
			{
				if (includes(key).in(queue))
				{
					const {request} = response = queue[key];
					response = error ? response.error : response.result;
					isFunction(response) && response(error || result);
					activityLog(domain, '<<', error ? {failed:request} : {succeeded:request});
					// remove response object from queue
					delete queue[key];
				}
			}
		}
		import(subject)
		{
			return assign(subject).to(this);
		}
		timeout()
		{
			const {key, queue} = this;
			for (const signature of iterable(queue, 'keys')) {if (key > (signature+maxTTL)) {this.response({key, error:'timed out'});}}
		}
		end()
		{
			this.emit('exit', true) || this.destroy();
		}
		// abstraction layer to manage communication with a child process
		constructor(events, sessionid, domain, node, respawn = 10, path = 'drivers')
		{
			const {fork} = require('child_process');
			const {join} = require('path');
			const driver = join(path, domain+'.js');
			respawn = +respawn;
			super();
			// create call stack for requests
			this.import({domain, node, queue:{}});
			this.bind(events);
			const connect = () => {
				try
				{
					this.child = bind(handlers).to(fork(driver, [node, sessionid]));
					this.trigger('connect', 'spawned worker process');
				}
				catch(error)
				{
					this.trigger('flags', {error}) && errorLog(error),
					handlers.close();
				}
			};
			const handlers = {
				close:() => {
					const connected = false;
					this.trigger('flags', {connected});
					respawn && setTimeout(() => connect(), respawn*1000);
				},
				error:error => this.trigger('flags', {error}) && errorLog(error),
				message:({type, message}) => includes(type).in(this.listeners) && this.trigger(type, message)
			};
			connect();
			// start polling cycle to clean up dead requests
			this.freeResources = setInterval(this.timeout.bind(this), 1000);
		}
	}
	class Router
	{
		// central message router handles communication between a SecureChannel server and multiple data sources
		// each data source type is classified as a domain and has a dedicated child process that communicates with the router via IPC
		static async getDevices(path)
		{
			// this method gathers device metadata from all drivers found in the specified path (works with IPC class)
			const extension = '.js';
			const jsFiles = name => /.js$/.test(name);
			const stripJS = name => name.replace(extension, '');
			const devices = {};
			try
			{
				const files = await dir(path);
				const domains = files.filter(jsFiles).map(stripJS).sort();
				for (const domain of domains)
				{
					devices[domain] = {};
					const nodes = await run(`${NODE} ${path}/${domain}${extension}`);
					for (const [node, data] of iterable(nodes)) {inject(devices[domain], node, isObject(data) ? data : {});}
				}
				debugLog({devices});
			}
			catch(e) {errorLog(e)}
			return devices;
		}
		import(subject)
		{
			return assign(subject).to(this);
		}
		cache()
		{
			// this method has variable arity
			// if the first argument is a regular object (not an array) then the object is assigned to the server value
			// if the first argument is an array then there is no server value, and the array is assigned to the path value
			const args = Array.from(arguments);
			const server = (args.length && isObject(args[0])) ? args.shift() : null;
			// args.shift() produces a null value if args is empty
			const path = args.shift();
			const state = setOrGet(this.state.cache, path, args.shift(), args.shift());
			if (server && isFunction(server.emit))
			{
				if (isEqual(path.length, 3))
				{
					const domain = path[0];
					const node = path[1];
					const type = path[2];
					server.emit(server, {[domain]:{[type]:{[node]:state}}});
				}
				else if (isEqual(path.length, 2))
				{
					const domain = path[0];
					const type = path[1];
					server.emit(server, {[domain]:{[type]:state}});
				}
				else if (isEqual(path.length, 1))
				{
					const domain = path[0];
					server.emit(server, {[domain]:state});
				}
			}
			return state;
		}
		nodes(...args)
		{
			const server = (args.length && isObject(args[0])) ? args.shift() : null;
			const path = args.shift();
			const flag = args.shift();
			const overwrite = args.shift();
			if (server && isEqual(path.length, 3))
			{
				const [domain, node, type] = path;
				isFunction(server.dispatch) && server.dispatch(server, {nodes:{[type]:{domain, node, flag}}});
			}
			return setOrGet(this.state.nodes, path, flag, overwrite);
		}
		reply(response, result)
		{
			response.header('Content-Type', 'application/json');
			response.send(result);
		}
		async ready()
		{
			// delay event until application ready
			return this.initialized ? true : await new Promise(resolve => this.queue.push(resolve));
		}
		bind(listeners)
		{
			if (!Object(listeners)) {throw new Error('Required listeners object is empty');}
			let found = false;
			const {servers} = this;
			for (const [channel, response] of iterable(listeners))
			{
				if (includes(channel).in(servers))
				{
					const wss = servers[channel];
					// bind custom request handler to SecureChannel https server
					if (isObject(wss))
					{
						const {server} = wss;
						if (isFunction(Object(server).on)) {server.on('request', response);}
						else {throw new Error('Could not bind requests to route');}
					}
					found = true;
				}
			}
			if (!found) {throw new Error('Matching channel not found');}
			return this;
		}
		end(code)
		{
			activityLog('Shutting down all channels');
			const {channels, servers} = this;
			for (const [channel, instance] of iterable(channels))
			{
				const {devices} = instance;
				activityLog(`Closing ${channel} workers`);
				for (const workers of iterable(devices, VALUES)) {for (const worker of iterable(workers, VALUES)) {isFunction(Object(worker).destroy) && worker.destroy();}}
				const server = servers[channel]||{};
				server.destroy && server.destroy();
			}
			process.exit(code);
		}
		constructor(options)
		{
			const defaults = {
				channels:{},
				servers:{},
				state:{},
				driverPath:DRIVERS,
				respawnTime:10
			};
			const application = this.import({...defaults, ...options});
			// ensure that required root properties exist in state object
			for (const key of ['cache', 'nodes']) {initKey(this.state, key);}
			// append chain function to native methods
			this.chain = chain;
			// create ready queue
			this.queue = [];
			const {channels, servers, state} = this;
			const signalReady = () => {
				if (!this.initialized)
				{
					for (const nodes of iterable(state.nodes, VALUES))
					{
						for (const {ready, error} of iterable(nodes, VALUES))
						{
							if (!ready && !error) {return false;}
						}
					}
					this.initialized = true;
					while (0 < this.queue.length)
					{
						const ready = this.queue.pop();
						isFunction(ready) && ready(true);
					}
					activityLog('server initialized');
				}
			};
			function iteratorFactory(socket)
			{
				return (handler, message) => handler.call(socket, message);
			}
			// routes message to correct handler based on metadata envelope
			function walk(handlers, data, iterator)
			{
				for (const [domain, state] of iterable(data))
				{
					if (includes(domain).in(handlers))
					{
						for (const [type, message] of iterable(state))
						{
							if (includes(type).in(handlers[domain]))
							{
								const handler = handlers[domain][type];
								isFunction(handler) && iterator(handler, message);
							}
						}
					}
				}
			}
			const workers = {
				// worker methods run under the global channel context and broadcast to all sockets listening to the channel
				spawn(channel, domain, node, workers)
				{
					this.channel = channel;
					const {sources, sinks} = channels[channel];
					const {state} = application;
					application.nodes([domain, node], {connected:false, error:false, ready:false});
					const listen = type => {
						// some tests can be skipped for the collector method since the loop calling the listen function is walking the same source object
						const collector = sources[domain][type];
						// a corresponding emitter method may not exist if an application does not need to echo a particular data type to clients
						const emitter = includes([domain, type]).in(sinks) && sinks[domain][type];
						return async data => {
							if (isFunction(collector))
							{
								// allow the collector method to complete before attempting to call a corresponding emitter
								await collector.call(this, {node, data});
								// an emitter method should always fire after a corresponding collector method to ensure that clients are kept in sync
								if (isFunction(emitter))
								{
									// the application.cache method will allocate cache storage in the process of walking the cache path
									// don't create storage here for message types that don't need to be cached by the application
									// allow the application to create cache entries only for things that need it
									let cache;
									includes([domain, type]).in(state.cache) && (cache = application.cache([domain, type]));
									emitter.call(this, cache);
								}
							}
						};
					};
					// global message types appended to sources for all domains
					// these are reserved types and should not be overridden unless you know what you're doing!
					const routes = {
						flags:flags => {
							for (const [type, flag] of iterable(flags)) {application.nodes(this, [domain, node, type], flag);}
							// trigger any routines waiting for ready
							const {ready, error} = flags;
							(ready || error) && signalReady();
						},
						response:response => device.response(response)
					};
					// decorate routes with listeners for defined domain sources
					for (const type of iterable(sources[domain], KEYS)) {routes[type] = listen(type);}
					debugLog({routes, [domain]:node});
					// spawn a child process to manage device messaging and control
					const device = assign(workers[node]).to(new Driver(routes, channel, domain, node, this.respawnTime, this.driverPath));
					workers[node] = device;
				},
				// client -> core logic
				request({request, response})
				{
					const {channel} = this;
					const {sources} = channels[channel];
					if (includes('request').in(sources))
					{
						const methods = sources.request;
						// wrap methods using chain function to capture and forward errors and normal responses
						for (const [type, method] of iterable(methods)) {includes(type).in(request) && chain(method.call(this, request[type]), response);}
					}
				},
				// core logic -> driver
				async query(query)
				{
					const {channel} = this;
					for (const [domain, commands] of iterable(query))
					{
						const {devices} = channels[channel];
						if (includes(domain).in(devices))
						{
							const workers = devices[domain];
							for (const [command, args] of iterable(commands))
							{
								let node, request;
								if (isObject(args))
								{
									// accept query in the form of {[domain]:{[command]:{node, ...}}}
									node = args.node;
									delete args.node;
									request = {command, ...args};
								}
								else
								{
									// accept query in the form of {[domain]:{[command]:node}}
									node = args;
									request = command;
								}
								if (node && isString(node) && includes(node).in(workers))
								{
									const device = workers[node];
									return await device.commit(request);
								}
								throw new Error(`node ${node} is invalid`);
							}
							throw new Error(`domain ${domain} is invalid`);
						}
						throw new Error('no command specified');
					}
					throw new Error('no domain specified');
				},
				// driver -> core logic
				// this executes the source method on the passed data structure
				dispatch(socket, data)
				{
					const {channel} = this;
					const {sources} = channels[channel];
					walk(sources, data, iteratorFactory(socket));
				},
				// core logic -> client
				// this executes the sink method on the passed data structure
				emit(socket, data)
				{
					const {channel} = this;
					const {sinks} = channels[channel];
					walk(sinks, data, iteratorFactory(socket));
				}
			};
			for (const [channel, {sources, devices, events, connection}] of iterable(channels))
			{
				if (!Object(devices)) {throw new Error('required devices object is empty');}
				if (!Object(connection)) {throw new Error('required connection object is empty');}
				// create https and ws channel server
				// decorate channel object with child worker communication methods and identity
				const server = servers[channel] = assign({channel, ...workers}).to(new SecureChannel(events));
				const client = {
					// client methods run under a specific socket context and only respond to the socket from which a request arrived
					methods()
					{
						// expose backend request methods to the client frontend
						const methods = isObject(sources) && isObject(sources.request) ? iterable(sources.request, KEYS) : [];
						this.message('methods', {methods});
					},
					render()
					{
						// push the current application state to the client
						for (const [domain, types] of iterable(state.cache)) {server.emit(this, {[domain]:types});}
						for (const [domain, nodes] of iterable(state.nodes))
						{
							for (const [node, flags] of iterable(nodes))
							{
								for (const [type, flag] of iterable(flags))
								{
									server.emit(server, {nodes:{[type]:{domain, node, flag}}});
								}
							}
						}
					},
					action(request)
					{
						if (isObject(request))
						{
							const {signature} = request;
							// process user events
							const reflect = result => this.message('action', {signature, result});
							const discard = () => {};
							const response = signature ? reflect : discard;
							// call request event handler
							server.request({request, response});
						}
					}
				};
				// bind client events to channel
				bind(client).to(server);
				// start worker processes
				for (const [domain, workers] of iterable(devices))
				{
					for (const node of iterable(workers, KEYS)) {server.spawn(channel, domain, node, workers);}
				}
				// start listeneng for events
				server.listen(connection);
			}
			activityLog('process context:', process.env.USER);
		}
	}
	return ({IPC, Passthrough, SecureChannel, Dispatcher, Driver, Queue, Response, Router});
})());
