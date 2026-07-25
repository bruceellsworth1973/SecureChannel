/* eslint no-self-assign:off */
const DEBUG = false;
class AsyncSemaphore //eslint-disable-line
{
	get hasOpened() {return this._has_opened;}
	get isOpen() {return this._is_open;}
	get status()
	{
		const awaitOpenEvent = resolve => this._on_open = resolve;
		if (this._status) {return this._status;}
		this._is_open = false;
		this._status = new Promise(awaitOpenEvent);
		this._status.then(() => {
			this._is_open = true;
			this._has_opened = true;
		});
		return this._status;
	}
	set status(open)
	{
		if (open)
		{
			if (this._on_open)
			{
				this._on_open(open);
				this._on_open = undefined;
			}
			this._status = Promise.resolve(open);
			this._is_open = true;
			this._has_opened = true;
		} else {
			this._status = undefined;
			this._is_open = false;
		}
	}
	open() {this.status = true;}
	close() {this.status = false;}
	constructor(open) {
		this.status = open;
		this._has_opened = false;
	}
}
class Helpers
{
	static get KEYS() {return 'keys';}
	static get VALUES() {return 'values';}
	static get isArray() {return Array.isArray;}
	static get parse() {return JSON.parse;}
	static get stringify() {return JSON.stringify;}
	static get min() {return Math.min;}
	static get max() {return Math.max;}
	static get ceil() {return Math.ceil;}
	static get floor() {return Math.floor;}
	static get abs() {return Math.abs;}
	static round(x, scale) {return ((x + Number.EPSILON) * scale) / scale;}
	static resolve(x) {return Promise.resolve(x);}
	static reject(x) {return Promise.reject(x);}
	static apply(fn, ...args) {return fn.apply(this, args);}
	// this is not as powerful as the node deep-diff module, and there are many limitations,
	// but it is lightweight and will test basic equality of primitives as well as objects, arrays and functions
	static deepEqual(x, y)
	{
		// first test basic equality
		if (x === y) {return true;}
		// next compare data types
		if (typeof x !== typeof y) {return false;}
		// perform deep comparison
		switch (true)
		{
			case Helpers.isArray(x):
			{
				if (x.length !== y.length) {return false;}
				for (let i = 0; i < x.length; i++) {
					let found = false;
					for (let j = 0; j < y.length; j++) {
						if (Helpers.deepEqual(x[i], y[j])) {
							found = true;
							break;
						}
					}
					if (!found) return false;
				}
				return true;
			}
			case Helpers.isObject(x):
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
					if (typeof (x[p]) === 'undefined') {return false;}
				}
				break;
			}
			case Helpers.isFunction(x):
			{
				if (typeof y === 'undefined' || x.toString() !== y.toString()) return false;
				break;
			}
			// if we are here, inequality of basic comparison is already established at the top of the algorithm
			default: {return false;}
		}
		// if the switch statement falls through then the comparison succeeds
		return true;
	}
	static isEqual(a, b) {return Helpers.isUndefined(b) ? b => Helpers.deepEqual(a, b) : Helpers.deepEqual(a, b);}
	static notEqual(a, b) {return Helpers.isUndefined(b) ? b => a !== b : a !== b;}
	static branch(ifTruthy, ifFalsy) {return test => (test ? Helpers.isFunction(ifTruthy) && ifTruthy() : Helpers.isFunction(ifFalsy) && ifFalsy(), test);}
	static isObject(x) {return x && 'object' === typeof x;}
	static isString(x) {return 'string' === typeof x;}
	static isNumber(x) {return 'number' === typeof x;}
	static isFunction(x) {return 'function' === typeof x;}
	static isUndefined(x) {return 'undefined' === x + '';}
	static isNumeric(x) {return Helpers.isNumber(x) || Helpers.isString(x) && !isNaN(x) && !isNaN(parseFloat(x));}
	static singleElement(arr) {return Helpers.isEqual(arr?.length, 1);}
	static first(arr) {return arr?.[0];}
	static unary(fn) {return x => fn(x);}
	static isNull(x) {return x === null;}
	static exists(x) {return !(Helpers.isNull(x) || Helpers.isUndefined(x));}
	static isEmpty(x) {return Helpers.isNull(x) || Helpers.isUndefined(x) || ((Helpers.isArray(x) || Helpers.isString(x)) && x.length === 0) || Object.keys(x).length === 0 || x.size === 0;}
	static getFunction(fn) {return Helpers.isFunction(fn) ? fn : () => {};}
	static assign(props) {return {to:obj => Object.assign(obj, props)};}
	static bind(handlers)
	{
		return {to:emitter => {
			for (const [event, listener] of Helpers.iterable(handlers)) {emitter.on(event, listener);}
			return emitter;
		}};
	}
	static iterable(obj, type = 'entries') {return Helpers.isObject(obj) && type in Object ? Object[type](obj) : [];}
	static getMicros() {return window.performance.now();}
	static chain(request, response) {return request.then(result => response({result}), error => response({error}));}
	static unchain = response => response.then(({result, error}) => error ? Helpers.reject(error) : Helpers.resolve(result));
	static split(delimiter) {return str => str.split(delimiter);}
	static join(arr, delimiter = '') {return arr.join(delimiter);}
	static tee(...fns) {return x => fns.forEach(fn => fn(x));}
	static tap(fna, fnb) {return x => (fna(x), fnb ? fnb(x) : x);}
	static trace(label, fn = console.info) {return Helpers.tap(x => fn({[label]:x}));}
	static map(ctx, fn) {return [].map.call(ctx, fn);}
	static prop(x) {return z => Helpers.isString(x) ? z[x] : Helpers.isString(z) ? x[z] : null;}
	static toInt(str) {return +str;}
	static toString(v) {return Helpers.exists(v) ? ''+v : '';}
	static pad(v, n = 2) {return Helpers.toString(v).padStart(n, '0');}
	static toHMS(x) {return `${parseInt((x/(60*60))%24)}:${Helpers.pad(parseInt((x/60)%60))}:${Helpers.pad(parseInt(x%60))}`;}
	static sum(a, b) {return Helpers.isUndefined(b) ? b => +a + +b : +a + +b;}
	static reverse(arr) {return arr.reverse();}
	static index(column, arr) {return Helpers.isEmpty(arr) ? [] : [].reduce.call(arr, (obj, row) => ({...obj, [row[column]]:row}), {});}
	static identity(v) {return v;}
	static arrayColumn(arr, str)
	{
		return Helpers.isUndefined(str)
			? str => arr.map(Helpers.prop(str))
			: arr.map(Helpers.prop(str));
	}
	// example syntax for sorting an array of objects that have shared property names (columns): arr.sort(by(column('date', 'desc')).and(column('key')).and(column('part')));
	static by(prev)
	{
		const next = {
			and(next) {return Helpers.by((a, b) => this(a, b) || next(a, b));}
		};
		return Helpers.assign(next).to(prev);
	}
	static column(column, direction = 'asc', caseSensistive = false, numeric = false)
	{
		const {isEqual, isObject, toLowerCase, apply} = Helpers;
		const ordinal = ascending => ascending
			? (a, b) => a - b
			: (a, b) => b - a;
		const alphabetic = ascending => ascending
			? (a, b) => a > b ? 1 : a < b ? -1 : 0
			: (a, b) => a > b ? -1 : a < b ? 1 : 0;
		if (isObject(column))
		{
			if (column.direction) {direction = column.direction;}
			if (column.caseSensistive) {caseSensistive = column.caseSensistive;}
			if (column.numeric) {numeric = column.numeric;}
			column = column.name || 'name';
		}
		direction = !isEqual('desc', toLowerCase(direction));
		return numeric
			? (a, b) => apply(ordinal(direction), a[column], b[column])
			: caseSensistive
				? (a, b) => apply(alphabetic(direction), a[column], b[column])
				: (a, b) => apply(alphabetic(direction), toLowerCase(a[column]), toLowerCase(b[column]));
	};
	static includes(needle)
	{
		const {isArray, isString, isObject} = Helpers;
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
		else
		{
			return {in:haystack => isArray(haystack) || isString(haystack) ? haystack.includes(needle) : isObject(haystack) && (needle in haystack)};
		}
	}
	static inject(obj, key, x, overwrite)
	{
		!overwrite && Helpers.isObject(x) && Helpers.includes(key).in(obj) ? Helpers.assign(x).to(obj[key]) : (obj[key] = x);
		return obj;
	}
	static distinct(jumble)
	{
		return [...new Set(jumble)].filter(v => !Helpers.isUndefined(v));
	}
	static findAll(needle, haystack, index)
	{
		const select = !Helpers.isUndefined(index);
		let m, r = [];
		while (!Helpers.isNull(m = needle.exec(haystack))) {r.push(select && index in m ? m[index] : m);}
		return Helpers.distinct(r);
	}
	static multiReplace(subject, filter)
	{
		if (!Helpers.isUndefined(filter))
		{
			// match anything string surrounded by curly braces {}
			const tags = /\{([^}]+)\}/g;
			// match against the subject string and store all hits in an array
			const hits = Helpers.findAll(tags, subject, 1);
			// perform a global search and replace using keys from the filter object as a lookup matrix
			for (const key of hits) {(key in filter) && (subject = subject.replace(new RegExp(`{${key}}`, 'g'), filter[key]));}
		}
		return subject;
	}
	static past(moment)
	{
		const now = new Date();
		return moment < now;
	}
	static today(moment)
	{
		const now = new Date();
		// must create a new date object to prevent mutation of the source object
		return new Date(moment).setHours(0, 0, 0, 0) === now.setHours(0, 0, 0, 0);
	}
	static future(moment)
	{
		const now = new Date();
		return moment > now;
	}
	static stripUnicode(str)
	{
		str = str || '';
		return str.replace(/’/g, "'")
			.replace(/[\u2018\u2019]/g, "'")
			.replace(/[\u201C\u201D]/g, '"')
			.replace(/[\u2013\u2014]/g, '-')
			.replace(/[\u2026]/g, '...');
	}
	static toLowerCase(str)
	{
		return str ? ''.toLowerCase.call(str) : '';
	}
	static toUpperCase(str)
	{
		return str ? ''.toUpperCase.call(str) : '';
	}
	static UTCtoLocalDate(moment)
	{
		const date = new Date(moment);
		date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
		return date.toISOString().substring(0, 10);
	}
	static UTCtoLocalTime(moment)
	{
		const date = new Date(moment);
		date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
		return date.toISOString().substring(11, 19);
	}
	static UCFirst(str)
	{
		const word = str => str[0].toUpperCase() + str.slice(1);
		return str.split(' ').map(word).join(' ');
	}
}
class BinaryFrame
{
	static sentinel = 0xFE;
	static data = 0x01;
	static open = 0x02;
	static close = 0x03;
	static error = 0x04;
	static headerSize = 6;
	static build(frameType, uid, payload)
	{
		const {headerSize, sentinel} = BinaryFrame;
		const data = payload instanceof Uint8Array
			? payload
			: payload
				? new TextEncoder().encode(payload)
				: new Uint8Array(0);
		const frame = new Uint8Array(headerSize + data.length);
		frame[0] = sentinel;
		frame[1] = frameType;
		new DataView(frame.buffer).setUint32(2, uid, false);
		frame.set(data, headerSize);
		return frame;
	}
	static parse(frame)
	{
		const {headerSize, sentinel} = BinaryFrame;
		if (!(frame instanceof ArrayBuffer) || frame.byteLength < headerSize) return null;
		const view = new DataView(frame);
		if (view.getUint8(0) !== sentinel) return null;
		const frameType = view.getUint8(1);
		const uid = view.getUint32(2, false);
		const payload = new Uint8Array(frame, headerSize, frame.byteLength - headerSize);
		return {frameType, uid, payload};
	}
}
class EventEmitter {
	_listeners = new Map();
	on(event, listener)
	{
		if (!this._listeners.has(event)) this._listeners.set(event, new Set());
		this._listeners.get(event).add(listener);
		return this;
	}
	off(event, listener)
	{
		this._listeners.get(event)?.delete(listener);
		return this;
	}
	once(event, listener)
	{
		const wrapper = (...args) => {
			this.off(event, wrapper);
			listener(...args);
		};
		return this.on(event, wrapper);
	}
	addEventListener(event, listener) {return this.on(event, listener);}
	removeEventListener(event, listener) {return this.off(event, listener);}
	removeAllListeners() {this._listeners = new Map();}
	emit(event, ...args)
	{
		this._listeners.get(event)?.forEach(fn => fn(...args));
		return this;
	}
}
class QueueIterator extends EventEmitter {
	queue = [];
	resolve = null;
	ended = false;
	error = null;
	finalPacket = {value: undefined, done: true};
	get depth() {return this.queue.length;}
	push(value)
	{
		const {resolve} = this;
		if (resolve)
		{
			this.resolve = null;
			resolve(value);
		}
		else if (!this.ended) {this.queue.push(value);}
	}
	// callback-style consumption with optional AbortSignal detach;
	// resolves through Symbol.asyncIterator, so consuming an AsyncFanout
	// automatically takes a private consumer
	consume(onData, onFail, onEnd, abortSignal)
	{
		const iterator = this[Symbol.asyncIterator]();
		const onAbort = () => {iterator.return?.();};
		return async () => {
			if (abortSignal?.aborted) {return onEnd?.();}
			abortSignal?.addEventListener('abort', onAbort);
			try
			{
				for await (const payload of iterator) {onData?.(payload);}
				onEnd?.();
			}
			catch (error) {onFail?.(error.reason || error);}
			finally {abortSignal?.removeEventListener('abort', onAbort);}
		};
	}
	// called by source to queue next packet
	write(value)
	{
		if (this.ended) return;
		this.push({value, done: false});
		this.emit('write', value);
	}
	// called by source to indicate normal completion
	end(aborted = false)
	{
		// idempotent - only emit 'end' once
		if (!this.ended) {this.emit('end');}
		this.ended = true;
		// aborted path kills the queue because consumer is gone and will never call next()
		if (aborted) {this.queue = [];}
		this.push(this.finalPacket);
	}
	close() {this.end();}
	// called by source to indicate fatal error
	fail(error)
	{
		if (!this.ended)
		{
			this.error = error;
			this.emit('fail', error);
			this.end();
		}
	}
	// called by consumer pump to capture next packet
	next()
	{
		if (this.depth > 0) return Promise.resolve(this.queue.shift());
		if (this.error) return Promise.reject(this.error);
		if (this.ended) return Promise.resolve(this.finalPacket);
		return new Promise(resolve => this.resolve = resolve);
	}
	// called on early exit from the consumer
	return()
	{
		this.end(true);
		return Promise.resolve(this.finalPacket);
	}
	[Symbol.asyncIterator]() {return this;}
	constructor() {super();}
}
class AsyncFanout extends QueueIterator
{
	consumers = new Set();
	// the fanout never queues data on itself - payloads live only in consumer queues.
	// the base class write()/end()/fail() still emit their events, and the constructor
	// bindings below relay those events to every registered consumer.
	push() {}
	broadcast(fire) {for (const consumer of this.consumers) fire(consumer);}
	consumer()
	{
		if (this.error) throw this.error;
		const {consumers} = this;
		const consumer = new QueueIterator();
		Helpers.bind({fail: () => consumers.delete(consumer), end: () => consumers.delete(consumer)}).to(consumer);
		consumers.add(consumer);
		if (this.ended) {consumer.push(this.finalPacket);}
		return consumer;
	}
	[Symbol.asyncIterator]() {return this.consumer();}
	constructor()
	{
		super();
		Helpers.bind({
			write: value => this.broadcast(consumer => consumer.write(value)),
			fail: error => this.broadcast(consumer => consumer.fail(error)),
			end: () => this.broadcast(consumer => consumer.end())
		}).to(this);
	}
}
class SubstreamDuplex extends EventEmitter
{
	ended = false;
	streamId = null;
	fanout = new AsyncFanout();
	collator = new QueueIterator();
	views = new Map();
	get stdin() {return this.collator;}
	get stdout() {return this.fanout;}
	get isSubscribed() {return this.views.size > 0;}
	// the per-view consumer IS the subscription: the browser mirror of the server
	// seat, where stream.sockets maps each websocket to its fanout consumer. the
	// view reference disambiguates consumers sharing one duplex, the map carries
	// the lifecycle, and ending the consumer is the one and only teardown - the
	// same membership-cannot-carry-lifecycle rule, enforced for the same reason
	subscribe(view, onData, onFail = error => console.error('stream consumer failed', this.streamId, error))
	{
		if (this.ended || !view || this.views.has(view)) {return false;}
		const consumer = this.fanout.consumer();
		this.views.set(view, consumer);
		const pump = consumer.consume(onData, onFail);
		pump();
		return true;
	}
	unsubscribe(view)
	{
		const consumer = this.views.get(view);
		if (!consumer) {return false;}
		this.views.delete(view);
		consumer.end();
		return true;
	}
	// called by the View side to queue an outbound payload
	process(data)
	{
		if (this.ended) return;
		this.collator.write(data);
		this.emit('process', data);
	}
	// called by the protocol to queue an inbound payload for all fanout consumers
	write(data)
	{
		if (this.ended) return;
		this.fanout.write(data);
		this.emit('write', data);
	}
	end()
	{
		if (this.ended) return;
		this.ended = true;
		this.collator.end();
		this.fanout.end();
		this.views.clear();
		this.emit('end');
	}
	close() {this.end();}
	fail(reason)
	{
		if (this.ended) return;
		this.ended = true;
		this.collator.fail(reason);
		this.fanout.fail(reason);
		this.views.clear();
		this.emit('fail', reason);
	}
	// each iteration takes a private fanout consumer, so any number of Views
	// can consume the same stream independently and detach without side effects
	[Symbol.asyncIterator]() {return this.fanout.consumer();}
	constructor(streamId = null)
	{
		super();
		this.streamId = streamId;
	}
}
class StreamIndex
{
	// the client trusts server-minted uids and never mints its own;
	// uid translation between cascading services happens in the Worker layer.
	// streams and subscriptions are application-owned: a duplex stands up when
	// the application opens a stream and lives until the application closes it.
	// uid bindings are wire-owned: bound while the stream is advertised, unbound
	// on loss. a stream is wired iff its uid is bound in byStreamId.
	byUID = new Map();
	byStreamId = new Map();
	streams = new Map();
	subscriptions = new Set();
	advertised = new Map();
	keys() {return this.streams.keys();}
	values() {return this.streams.values();}
	entries() {return this.streams.entries();}
	list() {return Array.from(this.byStreamId, ([streamId, uid]) => ({streamId, uid}));}
	isSubscribed(streamId) {return this.subscriptions.has(streamId);}
	isWired(streamId) {return this.byStreamId.has(streamId);}
	getUID(id) {return this.byStreamId.get(id) || (this.byUID.has(id) && id) || undefined;}
	getStreamId(id) {return this.byUID.get(id) || (this.streams.has(id) && id) || undefined;}
	has(id) {return this.streams.has(id) || this.byUID.has(id);}
	get(id) {return this.streams.get(this.getStreamId(id));}
	open(streamId)
	{
		// optimistic standup: the duplex exists from open to close regardless of wire health
		this.subscriptions.add(streamId);
		if (!this.streams.has(streamId)) {this.streams.set(streamId, new SubstreamDuplex(streamId));}
		return this.streams.get(streamId);
	}
	wire(streamId, uid)
	{
		// bind or rebind the server-minted uid; true only on the unwired->wired transition
		const previous = this.byStreamId.get(streamId);
		if (previous === uid) {return false;}
		if (previous !== undefined) {this.byUID.delete(previous);}
		this.byStreamId.set(streamId, uid);
		this.byUID.set(uid, streamId);
		return previous === undefined;
	}
	unwire(streamId)
	{
		const uid = this.byStreamId.get(streamId);
		if (uid === undefined) {return false;}
		this.byUID.delete(uid);
		this.byStreamId.delete(streamId);
		return true;
	}
	unwireAll(onUnwired)
	{
		for (const streamId of [...this.byStreamId.keys()]) {this.unwire(streamId) && onUnwired?.(streamId);}
	}
	delete(streamId, onDelete)
	{
		this.unwire(streamId);
		this.subscriptions.delete(streamId);
		const stream = this.streams.get(streamId);
		if (stream)
		{
			onDelete?.(stream);
			this.streams.delete(streamId);
		}
	}
	reconcile(streams, onWire, onUnwire)
	{
		// presence in the advertisement wires a subscribed stream; absence unwires it.
		// unsubscribed streams never enter the uid maps, but the full inventory is
		// retained so a later openStream can wire immediately from the last advert
		this.advertised = new Map(streams.map(({streamId, uid}) => [streamId, uid]));
		for (const {streamId, uid} of streams)
		{
			if (!this.isSubscribed(streamId)) {continue;}
			if (this.wire(streamId, uid)) {onWire?.(streamId);}
		}
		for (const streamId of [...this.byStreamId.keys()]) {if (!this.advertised.has(streamId)) {onUnwire?.(streamId);}}
	}
	clear(onDelete) {for (const streamId of [...this.keys()]) {this.delete(streamId, onDelete);}}
}
class ClientProtocol extends EventEmitter
{
	// browser mirror of the backend ClientProtocol:
	// owns transactions, the stream index, uid<->streamId translation,
	// frame wrap/unwrap, and the stream loss/heal lifecycle.
	// Views live entirely in (streamId, payload) space; frames and uids
	// exist only between data()/#send() and the wire.
	// streams are opened optimistically and held until the application closes
	// them: the View wires its pumps to the duplex once and leaves them wired.
	// the wire-facing legs are gated by the uid binding, which socket health
	// and the streams advertisement control. subscriptions never expire on
	// loss - the client restates them until the stream rewires or the
	// application closes it. health transitions surface as streamUp/streamDown.
	#queue = new Map();
	#streamIndex = new StreamIndex();
	#signature = 0;
	#notReady = 'socket not ready';
	channel = null;
	requestMs = 30000;
	isReady = false;
	get #transactionID()
	{
		do {this.#signature = this.#signature ? this.#signature + 1 : Helpers.getMicros();}
		while (this.#queue.has(this.#signature));
		return this.#signature;
	}
	// ---- inbound ----
	data(frame)
	{
		// returns true when the frame was consumed by the protocol layer
		const fields = BinaryFrame.parse(frame);
		if (!fields) {return false;}
		const {frameType, uid, payload} = fields;
		// only data frames are supported; other frame types are deprecated and dropped.
		// frames for unwired uids resolve no stream and drop harmlessly
		if (frameType === BinaryFrame.data) {this.#streamIndex.get(uid)?.write(payload);}
		return true;
	}
	streams(streams)
	{
		// the server tags subscriptions per socket on the stream object itself, and the
		// tag dies with the stream or the socket - so every unwired->wired transition
		// restates the subscription; subscribeStream is idempotent on the server
		const onWire = streamId => {
			if (this.isReady) {this.channel.message('streamSubscribe', {streamId});}
			this.emit('streamUp', streamId);
		};
		const onUnwire = streamId => this.#lose(streamId);
		this.#streamIndex.reconcile(streams, onWire, onUnwire);
		this.emit('streams', streams);
	}
	response({key, result})
	{
		const transaction = this.#queue.get(key);
		if (transaction)
		{
			const {error, result: value} = result ?? {};
			error ? transaction.reject(error) : transaction.resolve(value);
		}
	}
	// ---- transactions ----
	transact(command, args, maxWait = this.requestMs, controller = new AbortController())
	{
		const {signal} = controller;
		const key = this.#transactionID;
		const request = (resolve, reject) =>
		{
			if (!this.isReady) {reject(this.#notReady); return;}
			if (signal.aborted) {reject('aborted'); return;}
			const settle = (error, value) =>
			{
				clearTimeout(timeout);
				if (!this.#queue.has(key)) {return;}
				this.#queue.delete(key);
				error ? reject(error) : resolve(value);
			};
			const abort = () => settle('aborted');
			const timeout = maxWait
				? setTimeout(() => settle(`request timed out: ${command} after ${maxWait}ms`), +maxWait)
				: undefined;
			signal.addEventListener('abort', abort, {once: true});
			const transaction = {resolve: value => settle(null, value), reject: error => settle(error), controller};
			this.#queue.set(key, transaction);
			this.channel.message('request', {key, request: {command, ...args}});
		};
		return new Promise(request);
	}
	// ---- streams: open / write / loss / heal ----
	openStream(streamId)
	{
		// optimistic: the duplex is returned immediately and survives line loss;
		// only closeStream tears it down. the stdin drain is permanent for the
		// duplex lifetime and ends when closeStream ends the collator.
		// an already-advertised stream wires from the retained advert before this
		// returns, so the caller can read the live state through isStreamUp
		if (!this.#streamIndex.has(streamId))
		{
			this.#drainStdin(this.#streamIndex.open(streamId));
			const {advertised} = this.#streamIndex;
			if (advertised.has(streamId)) {this.#streamIndex.wire(streamId, advertised.get(streamId));}
			if (this.isReady) {this.channel.message('streamSubscribe', {streamId});}
		}
		return this.#streamIndex.get(streamId);
	}
	closeStream(streamId) {this.#teardown(streamId);}
	getStream(streamId) {return this.#streamIndex.get(streamId);}
	hasStream(streamId) {return this.#streamIndex.has(streamId);}
	isStreamUp(streamId) {return this.#streamIndex.isWired(streamId);}
	write(streamId, payload) {this.#streamIndex.get(streamId)?.stdin.write(payload);}
	#send(streamId, payload)
	{
		// uid is resolved per payload, so writes during a heal pick up the rewired uid,
		// and writes during an outage drop here instead of queueing - stale input
		// must never replay into a healed stream
		const uid = this.#streamIndex.getUID(streamId);
		if (uid === undefined) {return;}
		this.channel.sendBinary(BinaryFrame.build(BinaryFrame.data, uid, payload));
	}
	#drainStdin(stream)
	{
		const {streamId} = stream;
		const pump = stream.stdin.consume(payload => this.#send(streamId, payload));
		pump();
	}
	#teardown(streamId)
	{
		// the application closing the stream is the only event that removes the
		// subscription and ends the duplex. explicit user intent rides the message
		// when the line is up; a downed socket is already untagged server-side by
		// the implicit close-time unsubscribe
		if (!this.#streamIndex.has(streamId)) {return;}
		if (this.isReady) {this.channel.message('streamUnsubscribe', {streamId});}
		this.#streamIndex.delete(streamId, stream => stream.end());
		this.emit('streamClosed', streamId);
	}
	#lose(streamId)
	{
		// loss never expires the subscription: unwire and notify. the restatement
		// happens on the next unwired->wired transition, because the server cannot
		// hold a tag for a stream object that does not exist yet
		this.#streamIndex.unwire(streamId);
		this.emit('streamDown', streamId);
	}
	// ---- transport lifecycle ----
	suspend()
	{
		// transport lost: hold duplexes and subscriptions, unwire every stream
		this.isReady = false;
		for (const {controller} of [...this.#queue.values()]) {controller.abort();}
		this.#streamIndex.unwireAll(streamId => this.emit('streamDown', streamId));
	}
	resume()
	{
		// transport restored: restate every held subscription; the advertisement rewires
		this.isReady = true;
		for (const streamId of [...this.#streamIndex.subscriptions]) {this.channel.message('streamSubscribe', {streamId});}
	}
	end()
	{
		this.suspend();
		this.#streamIndex.clear(stream => stream.end());
	}
	constructor()
	{
		super();
	}
}
class SecureChannel
{
	// this is a client implementation compatible with the Chrome WebSocket API
	// other browsers may also work without modification
	// provides the following upgrades to the basic WebSocket class:
	// local event listeners can be triggered on user-defined message types
	static subscribe(channel, viewports)
	{
		const {hostname} = window.location;
		return new Client(`wss://${hostname}/channels/${channel}`, viewports);
	}
	routes = {}
	protocol = null
	set SessionID(SessionID)
	{
		this._session_id = SessionID;
		// rename server side of the connection
		this.message('sessionid', {SessionID});
	}
	get SessionID()
	{
		return this._session_id || null;
	}
	on(event, listener) {this.routes[event] = listener;}
	bind(handlers)
	{
		const {iterable} = Helpers;
		for (let [event, listener] of iterable(handlers)) {this.on(event, listener);}
		return this;
	}
	toSQLDate(moment)
	{
		// this = date object
		const [utcString] = moment.toJSON().split('.');
		return utcString.replace('T', ' ');
	}
	time(moment = new Date())
	{
		const {assign} = Helpers;
		return assign({toSQL:() => this.toSQLDate(moment)}).to(moment);
	}
	// factory function to return a write method that sends on a websocket context
	write(message)
	{
		return function()
		{
			this.isActive() ? this.send(message) : this.close(3001, 'socket not ready');
		}
	}
	send(object) // converse of 'onmessage' method
	{
		const {stringify} = Helpers;
		const payload = stringify(object);
		this.write(payload).call(this.ws);
		return false;
	}
	message(type, message = {}) {return this.send({type, message});}
	emit(type, message)
	{
		const handler = this.routes[type];
		handler?.call(this, {...message, timestamp:this.time().toSQL()});
	}
	disconnect()
	{
		this.persistent = false;
		this.ws.close();
	}
	sendBinary(frame)
	{
		// frames sent while the transport is down are dropped; stream healing restores flow on reconnect
		if (this.ws?.isActive?.()) {this.ws.send(frame);}
	}
	constructor(routes = {})
	{
		const {assign, isEqual, isObject, parse, min, max} = Helpers;
		this.bind(routes);
		// propagate incoming messages to local event listeners
		// propagate outgoing messages to remote hosts connected to a socket
		this.connect = (url, reconnectDelay, persistent = true) => {
			reconnectDelay = +reconnectDelay || 0;
			let retries = -1;
			this.persistent = persistent;
			this.ws = {
				isActive() {return false},
				close:() => {},
				readyState:false
			};
			const init = () => {
				const channel = this;
				// if socket is open then do nothing
				if (this.ws.isActive()) {return;}
				// define custom WebSocket object methods
				const socketMethods = {
					isActive() {return isEqual(this.readyState, WebSocket.OPEN);},
					onmessage({data})
					{
						// binary frames belong to the protocol layer; JSON falls through to the routes
						if (channel.protocol?.data(data)) {return;}
						try
						{
							const payload = parse(data);
							const {type, message} = payload;
							if (type && isObject(message))
							{
								if (isEqual('up', type)) {this.SessionID = message.SessionID;}
								const {SessionID} = this;
								channel.emit(type, {...message, url, SessionID});
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
						retries && channel.emit('connect', {url});
					},
					onclose(event)
					{
						if (channel.persistent)
						{
							// 'down' messages are generated locally when a connection is severed and the first reconnection attempt fails
							++retries && channel.emit('down', {url, retries, event});
							// reestablish connection
							// by default, the first reconnection attempt is immediate, and subsequent retries occur at progressively longer intervals (capped at 5 seconds)
							const interval = max(reconnectDelay, min(retries, 5)) * 1000;
							this.respawnTimeout = setTimeout(() => init(), interval);
						}
						else {channel.emit('down', {url, event});}
					},
					onerror(reason) {channel.emit('error', {url, reason})},
					message:(event, message) => channel.message(event, message)
				};
				// bind events to socket
				this.ws = assign(socketMethods).to(new WebSocket(url));
				this.ws.binaryType = 'arraybuffer';
			};
			// socketMethods extend the WebSocket prototype
			init();
			return this;
		}
	}
}
class Client extends ClientProtocol
{
	// browser client implementation of the Channel handshake protocol.
	// JSON message handling and viewport publication live here;
	// streams, transactions, loss/heal, and frame translation are inherited.
	checkedin = false;
	routes = {
		reconnect: event => console.info(event.timestamp, 'connection reestablished'),
		connect: event =>
		{
			DEBUG && console.info(this.id, event.timestamp, 'connecting to host');
			this.publish('connecting', event);
			this.publish('latency');
		},
		down: event =>
		{
			this.checkedin = false;
			this.suspend();
			DEBUG && console.info(this.id, event.timestamp, event.retries ? `connection lost (${event.retries} retries)` : 'connection closed');
			this.publish('offline', event);
		},
		up:event =>
		{
			this.isReady = true;
			DEBUG && console.info(this.id, event.timestamp, 'connection established');
			this.publish('online', event.SessionID);
		},
		checkin: async ({nodes}) =>
		{
			DEBUG && console.info(this.id, 'checkin', nodes);
			if (!this.checkedin)
			{
				// wait for client to process nodes, then request the backend action methods
				await this.publish('nodes', nodes);
				this.message('exports');
			}
		},
		import: async ({exports: methods}) =>
		{
			// dispatch outbound requests through the inherited transaction queue
			const request = ({command, ...args}) => this.transact(command, args);
			for (const viewport of this.viewports)
			{
				// default methods to control the local client connection
				const exports = {
					setSessionID: SessionID => (this.SessionID = SessionID),
					getSessionID: () => this.SessionID,
					newSession: () => this.message('newsession', {}),
					disconnectSocket: () => this.disconnect(),
					connectSocket: () => this.connect(),
					openStream: streamId => this.openStream(streamId),
					writeStream: (streamId, payload) => this.write(streamId, payload),
					closeStream: streamId => this.closeStream(streamId),
					isStreamUp: streamId => this.isStreamUp(streamId)
				};
				// append exports published from downstream
				const generateAction = command => exports[command] = args => request({command, ...(args || {})});
				methods.forEach(generateAction);
				// publish exports to frontend views
				await this.publish('import', exports, [viewport]);
			}
			// complete the checkin cycle, which triggers a dump of the current channel state
			this.message('checkin');
			this.checkedin = true;
		},
		ready: () =>
		{
			// resume before publishing so Views' ready handlers find live streams
			this.resume();
			this.publish('ready', true);
			DEBUG && console.info(this.id, 'ready');
		},
		latency: ({latency}) => this.publish('latency', latency),
		streams: ({streams}) => this.streams(streams),
		response: ({key, result}) => this.response({key, result}),
		// sync UI with backend metadata push
		data: ({type, message}) => this.publish(type, message),
		error: ({error}) => this.publish('exception', error)
	};
	get SessionID() {return this.channel.SessionID;}
	set SessionID(sessionid) {this.channel.SessionID = sessionid;}
	// dispatch to viewport methods by name (formerly Client.emit; renamed because
	// EventEmitter.emit is inherited from ClientProtocol and keeps listener semantics)
	publish(type, data, context)
	{
		const {isEqual} = Helpers;
		let response;
		for (const viewport of context || this.viewports)
		{
			const method = viewport[type];
			if (method)
			{
				if (isEqual(type, 'nodes') && !response) {response = method.call(viewport, data);}
				else {method.call(viewport, data);}
			}
		}
		return response;
	}
	message(...args) {this.channel.message(...args);}
	disconnect() {this.channel.disconnect();}
	connect() {this.channel.connect(this.url);}
	destroy()
	{
		this.end();
		this.channel.disconnect();
	}
	constructor(url, viewports)
	{
		super();
		const {isArray, bind} = Helpers;
		this.url = url;
		this.viewports = isArray(viewports) ? viewports : [viewports];
		this.id = this.viewports[0].name;
		this.channel = new SecureChannel(this.routes);
		this.channel.protocol = this;
		// surface inherited protocol events to the viewports
		bind({
			streams: streams => this.publish('streams', streams),
			streamUp: streamId => this.publish('streamUp', streamId),
			streamDown: streamId => this.publish('streamDown', streamId),
			streamClosed: streamId => this.publish('streamClosed', streamId)
		}).to(this);
		// open connection to server
		this.connect();
	}
}
