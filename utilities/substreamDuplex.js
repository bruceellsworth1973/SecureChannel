const { Readable, Writable } = require('stream');
const { EventEmitter } = require('events');
const { bind, reason } = require('helpers');
class BinaryFrame
{
	static sentinel = 0xFE;
	static data = 0x01;
	static open = 0x02;
	static close = 0x03;
	static error = 0x04;
	static headerSize = 6;
	static maxUID = 0xFFFFFFFF;
	static mintUID(streamIndex)
	{
		const {byUID} = streamIndex;
		let uid;
		do
		{
			uid = streamIndex.next;
			streamIndex.next = uid >= BinaryFrame.maxUID ? 1 : uid + 1;
		}
		while (byUID.has(uid));
		return uid;
	}
	static toBuffer(data)
	{
		if (!data) return Buffer.alloc(0);
		if (Buffer.isBuffer(data)) return data;
		if (typeof data === 'string') return Buffer.from(data);
		if (data.type === 'Buffer' && Array.isArray(data.data)) return Buffer.from(data.data);
		return Buffer.from(JSON.stringify(data));
	}
	static build(frameType, uid, data)
	{
		const {headerSize, sentinel} = BinaryFrame;
		const payload = BinaryFrame.toBuffer(data);
		const header = Buffer.alloc(headerSize);
		header[0] = sentinel;
		header[1] = frameType;
		header.writeUInt32BE(uid, 2);
		return Buffer.concat([header, payload]);
	}
	static parse(buffer)
	{
		if (!Buffer.isBuffer(buffer) || buffer.length < BinaryFrame.headerSize || buffer[0] !== BinaryFrame.sentinel) return null;
		const frameType = buffer[1];
		const uid = buffer.readUInt32BE(2);
		const payload = buffer.subarray(BinaryFrame.headerSize);
		return {frameType, uid, payload};
	}
}
class QueueIterator extends EventEmitter
{
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
	consume(onData, onFail, onEnd, abortSignal)
	{
		const iterator = this[Symbol.asyncIterator]();
		const onAbort = () => { iterator.return?.(); };
		return async () => {
			if (abortSignal?.aborted) { return onEnd?.(); }
			abortSignal?.addEventListener('abort', onAbort);
			try
			{
				for await (const frame of iterator) { onData?.(frame); }
				onEnd?.();
			}
			catch (error) { onFail?.(reason(error)); }
			finally { abortSignal?.removeEventListener('abort', onAbort); }
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
		// idempotent - only call onEnd() once
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
}
class AsyncFanout extends QueueIterator
{
	consumers = new Set();
	push() {}
	broadcast(fire) {for (const consumer of this.consumers) fire(consumer);}
	consumer()
	{
		if (this.error) throw this.error;
		const {consumers} = this;
		const consumer = new QueueIterator();
		bind({fail: () => consumers.delete(consumer), end: () => consumers.delete(consumer)}).to(consumer);
		consumers.add(consumer);
		if (this.ended) {consumer.push(this.finalPacket);}
		return consumer;
	}
	[Symbol.asyncIterator]() {return this.consumer();}
	constructor()
	{
		super();
		bind({
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
	sockets = new Map();
	get stdin() { return this.collator; }
	get stdout() { return this.fanout; }
	get isSubscribed() {return this.sockets.size > 0;}
	subscribe(ws, onData, onFail)
	{
		if (this.ended || !ws || this.sockets.has(ws)) {return false;}
		const consumer = this.fanout.consumer();
		this.sockets.set(ws, consumer);
		const pump = consumer.consume(onData, onFail);
		pump();
		return true;
	}
	unsubscribe(ws)
	{
		const consumer = this.sockets.get(ws);
		if (!consumer) {return false;}
		this.sockets.delete(ws);
		consumer.end();
		return true;
	}
	// called by source to queue next packet for all fanout consumers
	process(frame)
	{
		if (this.ended) return;
		this.collator.write(frame);
		this.emit('process', frame);
	}
	// called by source to queue next packet for all fanout consumers
	write(frame)
	{
		if (this.ended) return;
		this.fanout.write(frame);
		this.emit('write', frame);
	}
	end()
	{
		if (this.ended) return;
		this.ended = true;
		this.fanout.end();
		this.collator.end();
		this.sockets.clear();
		this.emit('end');
	}
	close() {this.end();}
	fail(reason)
	{
		if (this.ended) return;
		this.ended = true;
		this.fanout.fail(reason);
		this.collator.fail(reason);
		this.sockets.clear();
		this.emit('fail', reason);
	}
	[Symbol.asyncIterator]() {return this.fanout.consumer();}
	constructor(streamId = null)
	{
		super();
		this.streamId = streamId;
	}
}
class StreamIndex
{
	static resolveStream(validStream, streamIndex)
	{
		const {uid} = validStream;
		return streamIndex.get(uid) || null;
	}
	next = 1;
	byUID = new Map();
	byStreamId = new Map();
	streams = new Map();
	subscriptions = [];
	keys() {return this.streams.keys();}
	values() {return this.streams.values();}
	entries() {return this.streams.entries();}
	list() {return Array.from(this.byStreamId, ([streamId, uid]) => ({streamId, uid}));}
	intersect(test) {return [...this.entries()].filter(([streamId, stream]) => test(streamId, stream));}
	getActiveStreams() { return this.intersect((_, stream) => stream.isSubscribed).map(([streamId]) => streamId);}
	getUID(id) {return this.byStreamId.get(id) || (this.byUID.has(id) && id) || undefined;}
	getStreamId(id) {return this.byUID.get(id) || (this.byStreamId.has(id) && id) || undefined;}
	has(id) {return this.byStreamId.has(id) || this.byUID.has(id);}
	get(id) {return this.streams.get(this.getStreamId(id));}
	add(streamId, uid, stream = () => null)
	{
		if (!this.streams.has(streamId))
		{
			if (uid === undefined) {uid = BinaryFrame.mintUID(this);}
			this.streams.set(streamId, stream() || new SubstreamDuplex(streamId));
			this.byStreamId.set(streamId, uid);
			this.byUID.set(uid, streamId);
			return true;
		}
		return false;
	}
	rewire(streamId, uid)
	{
		// remap the uid of a surviving stream after the source mints a new value
		if (!this.streams.has(streamId)) {return false;}
		const previous = this.byStreamId.get(streamId);
		if (previous === uid) {return true;}
		if (previous !== undefined) {this.byUID.delete(previous);}
		this.byStreamId.set(streamId, uid);
		this.byUID.set(uid, streamId);
		return true;
	}
	delete(streamId, onDelete)
	{
		const uid = this.getUID(streamId);
		if (uid !== undefined) {
			onDelete?.(this.streams.get(streamId));
			this.byUID.delete(uid);
			this.byStreamId.delete(streamId);
			this.streams.delete(streamId);
		}
	}
	subscribe(list, onSubscribed, onUnsubscribed, onChanged)
	{
		let changed;
		for (const streamId of list)
		{
			if (!this.subscriptions.includes(streamId))
			{
				onSubscribed?.(streamId);
				changed = true;
			}
		}
		for (const streamId of this.subscriptions)
		{
			if (!list.includes(streamId))
			{
				onUnsubscribed?.(streamId);
				changed = true;
			}
		}
		this.subscriptions = list;
		changed && onChanged?.(list);
	}
	unsubscribe(ws) {for (const stream of this.values()) {stream.unsubscribe(ws);}}
	reconcileStreams(streams, open, close)
	{
		const active = new Set();
		for (const {streamId, uid} of streams)
		{
			this.has(streamId) ? this.rewire(streamId, uid) : open?.(streamId, uid);
			active.add(streamId);
		}
		for (const {streamId} of this.list()) {if (!active.has(streamId)) close?.(streamId);}
	}
	clear(onDelete) {for (const streamId of this.keys()) this.delete(streamId, onDelete);}
}
const toReadable = (asyncIterable, options = {}) => Readable.from(asyncIterable, {objectMode: true, ...options});
const toWritable = (sink, options = {}) => new Writable({
	objectMode: true,
	...options,
	write(chunk, enc, cb)
	{
		try
		{
			sink.write(chunk);
			cb();
		}
		catch (err) {cb(err);}
	},
	final(cb)
	{
		sink.end();
		cb();
	},
	destroy(err, cb)
	{
		if (err && typeof sink.fail === 'function') sink.fail(err);
		else sink.end();
		cb(err);
	}
});
module.exports = {BinaryFrame, StreamIndex, QueueIterator, AsyncFanout, SubstreamDuplex, toReadable, toWritable};
