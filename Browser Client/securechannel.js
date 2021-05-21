/* eslint no-self-assign:off */
const Helpers = {
	KEYS:'keys',
	VALUES:'values',
	isArray:Array.isArray,
	parse:JSON.parse,
	stringify:JSON.stringify,
	min:Math.min,
	max:Math.max,
	round:(x, scale) => Math.round((x + Number.EPSILON) * scale) / scale,
	resolve:x => Promise.resolve(x),
	reject:x => Promise.reject(x),
	apply:function(fn, ...args) {return fn.apply(this, args);},
	deepEqual:(x, y) => {
		// first test basic equality
		if (x === y) {return true;}
		// next compare data types
		if (typeof x !== typeof y) {return false;}
		// perform deep comparison
		switch (typeof x)
		{
			case 'object':
			{
				// compare all properties in x to properties in y
				for (const p in x)
				{
					if (Object.hasOwnProperty.call(x, p) !== Object.hasOwnProperty.call(y, p)) {return false;}
					// recursively call deepEqual until basic properties at every level have been compared
					if (!Helpers.deepEqual(x[p], y[p])) {return false;}
				}
				// test for properties in y missing from x
				for (const p in y)
				{
					if (Helpers.isUndefined(x[p])) {return false;}
				}
				break;
			}
			case 'function':
			{
				if (Helpers.isUndefined(y) || x.toString() !== y.toString()) {return false;}
				break;
			}
			// inequality of basic comparison is already established at the top of the algorithm
			default: {return false;}
		}
		// if the switch statement falls through then the comparison succeeds
		return true;
	},
	isEqual:(a, b) => Helpers.isUndefined(b) ? b => Helpers.deepEqual(a, b) : Helpers.deepEqual(a, b),
	notEqual:(a, b) => Helpers.isUndefined(b) ? b => a !== b : a !== b,
	isObject:x => 'object' === typeof x,
	isString:x => 'string' === typeof x,
	isNumber:x => 'number' === typeof x,
	isFunction:x => 'function' === typeof x,
	isUndefined:x => 'undefined' === typeof x,
	isNull:x => x === null,
	isEmpty:x => Helpers.isNull(x) || Helpers.isUndefined(x) || ((Helpers.isArray(x) || Helpers.isString(x)) && x.length === 0) || Object.keys(x).length === 0 || x.size === 0,
	assign:props => ({to:obj => Object.assign(obj, props)}),
	iterable:(obj, type = 'entries') => Helpers.isObject(obj) && type in Object ? Object[type](obj) : [],
	getMicros:() => window.performance.now(),
	split:delimiter => str => str.split(delimiter),
	tee:(...fns) => x => fns.forEach(fn => fn(x)),
	tap:(fna, fnb) => x => (fna(x), fnb ? fnb(x) : x),
	trace:(label, fn = console.info) => Helpers.tap(x => fn({[label]:x})),
	prop:x => z => Helpers.isString(x) ? z[x] : Helpers.isString(z) ? x[z] : null,
	pad:str => str.padStart(2, '0'),
	sum:(a, b) => Helpers.isUndefined(b) ? b => a + b : a + b,
	parseInt:str => +str,
	reverse:arr => arr.reverse(),
	index:(column, arr) => Helpers.isEmpty(arr) ? [] : arr.reduce((obj, row) => ({...obj, [row[column]]:row}), {}),
	identity:v => v,
	includes:needle => {
		const {isObject, isArray} = Helpers;
		// reports the presence or absence of an array value or an object property
		// nested properties in objects can be searched by specifying an array as the path
		if (isArray(needle))
		{
			return {
				in:haystack => {
					if (!isObject(haystack)) {return false;}
					let acc = haystack;
					while(needle.length)
					{
						const pointer = needle.shift();
						if (pointer in acc)
						{
							acc = acc[pointer];
							continue;
						}
						return false;
					}
					return true;
				}
			}
		}
		return {in:haystack => isArray(haystack) ? haystack.includes(needle) : isObject(haystack) && (needle in haystack)};
	},
	past(moment)
	{
		const now = new Date();
		return moment < now;
	},
	today(moment)
	{
		const now = new Date();
		// must create a new date object to prevent mutation of the source object
		return new Date(moment).setHours(0, 0, 0, 0) === now.setHours(0, 0, 0, 0);
	},
	future(moment)
	{
		const now = new Date();
		return moment > now;
	},
	UTCtoLocalDate(moment)
	{
		const date = new Date(moment);
		date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
		return date.toISOString().substring(0, 10);
	},
	UTCtoLocalTime(moment)
	{
		const date = new Date(moment);
		date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
		return date.toISOString().substring(11, 19);
	},
	UCFirst(str)
	{
		return str[0].toUpperCase() + str.slice(1);
	}
};
class SecureChannel // eslint-disable-line
{
	// this is an implementation compatible with the Chrome WebSocket API
	// other browsers may also work without modification
	// provides the following upgrades to the basic WebSocket class:
	// unique event listeners can be triggered on user-definable message types
	events(handlers)
	{
		const {iterable} = Helpers;
		for (let [event, listener] of iterable(handlers)) {this.on(event, listener);}
		return this;
	}
	toSQLDate(time)
	{
		// this = date object
		return time.toJSON().slice(0, 19).replace('T', ' ');
	}
	time(time = new Date())
	{
		const {assign} = Helpers;
		return assign({toSQL:() => this.toSQLDate(time)}).to(time);
	}
	formMessage(type, payload)
	{
		const {isArray, isObject, isString, stringify} = Helpers;
		return (isString(type) && isObject(payload) || isArray(payload)) ? stringify({type, payload}) : false;
	}
	write(message)
	{
		return function() {this.isActive() ? this.send(message) : this.close(3001, 'socket not ready');}
	}
	message(event, message) // converse of 'onmessage' method
	{
		message = this.formMessage(event, message);
		if (message)
		{
			this.write(message).call(this.ws);
			return true;
		}
		return false;
	}
	disconnect()
	{
		this.persistent = false;
		this.ws.close();
	}
	set SessionID(SessionID)
	{
		const {isString} = Helpers;
		if (isString(SessionID))
		{
			this._sessionid = SessionID;
			// send the same SessionID to the backend to keep the socket names synchronized on both ends of the link
			this.message('sessionid', {SessionID});
		}
	}
	get SessionID()
	{
		return this._sessionid;
	}
	noop()
	{}
	constructor(routes = {})
	{
		const {assign, isEqual, isObject, isFunction, parse, min, max} = Helpers;
		// propagate incoming messages to local event listeners
		// propagate outgoing messages to remote hosts connected to a socket
		this.connect = (url, reconnectDelay, persistent = true) => {
			reconnectDelay = +reconnectDelay || 0;
			let retries = -1;
			this.persistent = persistent;
			this.ws = {
				close:this.noop,
				isActive() {return false},
				readyState:false
			};
			const init = () => {
				const channel = this;
				// if socket is open then do nothing
				if (this.ws.isActive()) {return;}
				// define custom WebSocket object methods
				const handlers = {
					onmessage({data}) // converse of 'message' method
					{
						try
						{
							const message = parse(data);
							const {type, payload} = message;
							if (type && isObject(payload))
							{
								if (isEqual('up', type))
								{
									// handle reconnection case
									const reconnect = (isEqual(0, retries));
									// reset retries to suppress the next down/connect event pattern
									// normal down/connect event pairs will be emitted if a down/connect/down/connect pattern occurs without an intervening 'up' event
									retries = -1;
									if (reconnect)
									{
										// emit "reconnect" event
										this.trigger('reconnect', {url});
										// carry the existing SessionID value forward from the previous connection
										// this allows the websocket server to free up resources by closing dead connections
										// the client should not need to renegotiate SessionID on a reconnect
										this.SessionID = this.SessionID;
										// don't bubble the normal "up" event on a reconnect
										return;
									}
									else
									{
										// name the connection using the default server-provided value
										this.SessionID = payload.SessionID;
									}
								}
								const SessionID = payload.SessionID = this.SessionID;
								this.trigger(type, {...payload, url, SessionID});
							}
							return true;
						}
						catch(_) {return false;}
					},
					onopen()
					{
						clearTimeout(this.respawnTimeout);
						this.respawnTimeout = false;
						// the 'connect' message is only a confirmation that the local end of the connection is open
						// the connection is not considered up until an 'up' event arrives from the server (passed through the 'message' event listener)
						retries && this.trigger('connect', {url});
					},
					onclose()
					{
						if (channel.persistent)
						{
							// 'down' messages are generated locally when a connection is severed and the first reconnection attempt fails
							++retries && this.trigger('down', {url, retries});
							// reestablish connection
							// by default, the first reconnection attempt is immediate, and subsequent retries occur at progressively longer intervals (capped at 5 seconds)
							const interval = max(reconnectDelay, min(retries, 5))*1000;
							this.respawnTimeout = setTimeout(() => init(), interval);
						}
						else {this.trigger('down', {url});}
					},
					onerror(reason) {this.trigger('error', {url, reason})}
				};
				// bind events to socket
				this.ws = assign(handlers).to(new WebSocket(url));
			};
			// socketMethods extend the WebSocket prototype
			const socketMethods = {
				isActive() {return isEqual(this.readyState, WebSocket.OPEN);},
				trigger:(event, message) => isFunction(routes[event]) && routes[event]({...message, timestamp:this.time().toSQL()}),
				message:(event, message) => this.message(event, message),
			};
			assign(socketMethods).to(WebSocket.prototype);
			init();
			return this;
		}
	}
}
class Client extends SecureChannel // eslint-disable-line
{
	// manage and maintain a persistent bidirectional connection to a remote server
	constructor(url, ui)
	{
		const {sum, isFunction, iterable, resolve, reject, getMicros, isArray} = Helpers;
		const commit = request => {
			// create unique request ID
			const getSignature = (signature = 0) => {
				signature += signature ? 1 : getMicros();
				// get new signature if this one is not unique
				return (signature in this.responses) ? getSignature(signature) : signature;
			};
			// pass user request to backend
			const commit = response => {
				// create unique request ID
				const signature = getSignature();
				// queue response function
				this.responses[signature] = response;
				// commit request
				this.message('action', {...request, signature});
			};
			// capture response
			return new Promise(commit).then(({result, error}) => error ? reject(error) : resolve(result));
		};
		function trigger(type, data)
		{
			const method = ui[type];
			isFunction(method) && method.call(ui, data);
		}
		const maxTTL = 108000000;
		const requestTimeout = () => {
			const now = getMicros();
			for (const key of iterable(this.responses, 'keys')) {now > sum(key, maxTTL) && delete this.responses[key];}
		};
		const routes = {
			error:event => {
				console.error(event);
				trigger('exception', event);
			},
			down:event => {
				const {timestamp, retries} = event;
				console.info(timestamp, retries ? `connection lost (${retries} retries)` : 'conection closed');
				this.initialized = false;
				trigger('offline', event);
			},
			up:event => {
				console.info(event.timestamp, 'connection established');
				trigger('online', event.SessionID);
			},
			connect:event => {
				console.info(event.timestamp, 'connection opened');
				trigger('connecting', event);
			},
			reconnect:event => {
				console.info(event.timestamp, 'connection reestablished');
			},
			ready:event => {
				if (!this.initialized)
				{
					// start polling cycle to clean up dead requests
					clearInterval(this.freeResources);
					this.freeResources = setInterval(() => requestTimeout(), 10000);
					// request the backend action methods
					this.message('methods', {});
				}
				console.info(event.timestamp, 'channel ready');
			},
			methods:({methods, timestamp}) => {
				console.info(timestamp, 'imported backend methods');
				// default methods to control the local client connection
				const reserved = {
					setSessionID:sessionid => (this.SessionID = sessionid),
					newSession:() => this.message('newsession', {}),
					disconnectSocket:() => this.disconnect(),
					connectSocket:() => this.connect(url)
				};
				const reducer = (methods, method) => ({...methods, [method]:query => commit({[method]:query})});
				const actions = isArray(methods) ? methods.reduce(reducer, reserved) : reserved;
				// expose backend action methods to the frontend
				trigger('up', actions);
				// request the complete application state
				this.message('render', {});
				this.initialized = true;
			},
			// sync UI with backend metadata push
			data:({type, message}) => trigger(type, message),
			// pass return values to committed requests
			action:({signature, result}) => {
				if (signature in this.responses)
				{
					const response = this.responses[signature];
					isFunction(response) && response.call(ui, result);
					delete this.responses[signature];
				}
			}
		};
		// bind UI to backend signals
		super(routes);
		this.responses = {};
		// open connection to server
		this.connect(url);
	}
}
