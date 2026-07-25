type LoggerFn = (type: string, message: any, meta?: object) => void;

declare class Emitter {
	on(event: string, listener: (...args: any[]) => void): this;
	off(event: string, listener: (...args: any[]) => void): this;
	once(event: string, listener: (...args: any[]) => void): this;
	addListener(event: string, listener: (...args: any[]) => void): this;
	removeListener(event: string, listener: (...args: any[]) => void): this;
	removeAllListeners(event?: string): this;
	emit(event: string, ...args: any[]): boolean;
}

export class BinaryFrame {
	static readonly sentinel: number;
	static readonly data: number;
	static readonly open: number;
	static readonly close: number;
	static readonly error: number;
	static readonly headerSize: number;
	static toBuffer(data: any): Buffer;
	static build(frameType: number, uid: number, data?: any): Buffer;
	static parse(buffer: Buffer): { frameType: number; uid: number; payload: Buffer } | null;
	static mintUID(streamIndex: StreamIndex): number;
}

export class QueueIterator extends Emitter {
	queue: any[];
	resolve: Function | null;
	ended: boolean;
	error: any;
	finalPacket: { value: undefined; done: true };
	get depth(): number;
	push(value: any): void;
	consume(onData?: (frame: any) => void, onFail?: (error: any) => void, onEnd?: () => void, abortSignal?: AbortSignal): () => Promise<void>;
	write(value: any): void;
	end(aborted?: boolean): void;
	close(): void;
	fail(error: any): void;
	next(): Promise<{ value: any; done: boolean }>;
	return(): Promise<{ value: undefined; done: true }>;
	[Symbol.asyncIterator](): this;
	constructor();
}

export class AsyncFanout extends QueueIterator {
	consumers: Set<QueueIterator>;
	broadcast(fire: (consumer: QueueIterator) => void): void;
	consumer(): QueueIterator;
	[Symbol.asyncIterator](): this;
	constructor();
}

declare class SubstreamDuplex extends Emitter {
	ended: boolean;
	fanout: AsyncFanout;
	collator: QueueIterator;
	sockets: Set<any>;
	get isSubscribed(): boolean;
	process(frame: any): void;
	write(frame: any): void;
	end(): void;
	close(): void;
	fail(reason: any): void;
	[Symbol.asyncIterator](): QueueIterator;
	constructor();
}

export class StreamIndex {
	next: number;
	byUID: Map<number, string>;
	byStreamId: Map<string, number>;
	streams: Map<string, SubstreamDuplex>;
	subscriptions: string[];
	keys(): IterableIterator<string>;
	values(): IterableIterator<SubstreamDuplex>;
	entries(): IterableIterator<[string, SubstreamDuplex]>;
	list(): Array<{ streamId: string; uid: number }>;
	intersect(test: (streamId: string, stream: SubstreamDuplex) => any): Array<[string, SubstreamDuplex]>;
	getActiveStreams(): string[];
	getUID(id: string | number): number | undefined;
	getStreamId(id: string | number): string | undefined;
	has(id: string | number): boolean;
	get(id: string | number): SubstreamDuplex | undefined;
	add(streamId: string, uid?: number, stream?: SubstreamDuplex): boolean;
	delete(streamId: string, onDelete?: (stream: SubstreamDuplex) => void): void;
	subscribe(list: string[], onSubscribed?: (streamId: string) => void, onUnsubscribed?: (streamId: string) => void, onChanged?: (list: string[]) => void): void;
	reconcileStreams(streams: Array<{ streamId: string; uid: number }>, open?: (streamId: string, uid: number) => void, close?: (streamId: string) => void): void;
	clear(onDelete?: (stream: SubstreamDuplex) => void): void;
	constructor();
}

export class Logger {
	constructor(types?: string[]);
}

export class Dispatcher {
	sink: (source: any) => boolean;
	use(parser: Function): this;
	reduce(message: any): this;
	transact(query: any, prefix?: string, timeout?: number): Promise<any>;
	trigger: (type: string, message: any, socket?: any) => boolean;
	emit: (type: string, message: any, socket?: any) => boolean;
	off: (type: string) => this;
	on: (type: string, callback: Function) => this;
	bind(events: Record<string, Function>): this;
	constructor(events?: Record<string, Function>, context?: any);
}

export class SecureChannel {
	static readonly serverip: string;
	static time(moment?: Date): Date & { toSQL: () => string };
	streamIndex: StreamIndex;
	get logger(): LoggerFn;
	set logger(fn: LoggerFn);
	get isClient(): boolean;
	get clients(): any[];
	get SessionID(): string;
	log(type: string, message: any, metadata?: object): void;
	pipeline(...transforms: Function[]): any;
	sockets(action: Function): void;
	terminate(): void;
	write(payload: any): Function;
	send(payload: any, ws?: any): boolean;
	message(type: string, message?: any, ws?: any): boolean;
	data(type: string, message: any): boolean;
	sendBinary(frameType: number, streamId: string, payload: any, ws?: any): void;
	publishStreams(ws?: any): void;
	registerStream(streamId: string, uid?: number): SubstreamDuplex;
	unregisterStream(streamId: string): void;
	subscribeStream(streamId: string, uid: number, ws: any): SubstreamDuplex | null;
	unsubscribeStream(streamId: string, ws: any): void;
	emit: (type: string, message: any, ws?: any) => boolean;
	trigger: (type: string, message: any, ws?: any) => boolean;
	listen(options: object): this;
	disconnect(): void;
	connect(options: object): this;
	bind(events: Record<string, Function>): this;
	import(properties: object): this;
	constructor(routes?: Record<string, Function>, clientName?: string | false);
}

export class Channel extends SecureChannel {
	static getConnection(id: string, options: object): { id: string; connection: object };
	drivers: Record<string, Driver>;
	sources: Record<string, Function>;
	sinks: Record<string, Function>;
	exports: Record<string, Function>;
	get channelExports(): any;
	get status(): Record<string, boolean>;
	get channels(): Record<string, Channel> | undefined;
	get channelReady(): boolean;
	set channelReady(ready: boolean);
	get onReady(): Promise<any>;
	messageAll(type: string, message: any): void;
	reconcileSubscriptions(): void;
	request(command: string, args: any, key?: any, address?: string, ws?: any): Promise<any>;
	passthrough: (command: string) => (args: any) => Promise<any>;
	dispatch: (data: any, socket?: any) => void;
	emitCache: (path?: string[], socket?: any) => void;
	pushState(socket?: any): void;
	join(controller: Controller): this;
	use(middleware: any): this;
	export(exports: Record<string, Function>): this;
	handle(exports: Record<string, Function>): this;
	createDriver(id: string): Driver;
	get loadDriver(): (id: string) => Driver;
	start(): Promise<void>;
	end(): Promise<void>;
	constructor(id: string, connection?: object, logger?: LoggerFn);
}

export class Driver {
	get domain(): string;
	get sessionid(): string | undefined;
	get controller(): Controller | undefined;
	get channels(): Record<string, Channel> | undefined;
	get sources(): Record<string, Function>;
	set sources(sources: Record<string, Function>);
	get sinks(): Record<string, Function>;
	set sinks(sinks: Record<string, Function>);
	get workers(): Record<string, Worker>;
	get hasWorkers(): boolean;
	get exportsLoaded(): boolean;
	set exportsLoaded(status: boolean);
	get status(): Record<string, boolean>;
	get domainHealthy(): boolean;
	get domainReady(): string | boolean | undefined;
	set domainReady(ready: boolean);
	get onReady(): Promise<any>;
	get onHealthy(): Promise<any>;
	get logger(): LoggerFn;
	set logger(fn: LoggerFn);
	log(type: string, message: any, metadata?: object): void;
	messageAll(type: string, message: any): void;
	emit(type: string, node?: string, socket?: any): void;
	pipeline: (type: string, node: string) => (data: any, socket?: any) => Promise<void>;
	cache(...args: any[]): any;
	nodes(...args: any[]): any;
	request(command: string, args: { node?: string | string[]; [key: string]: any }): Promise<any>;
	join(channel: Channel): this;
	leave(): this;
	publish(sinks: Record<string, Function>): this;
	subscribe(sources: Record<string, Function>): this;
	process(config: { source: Record<string, Function>; sink: Record<string, Function> }): this;
	createWorker(workers: Record<string, object>): (node: string) => Promise<any>;
	addWorker(node: string, data?: object): Promise<Worker>;
	dropWorker(node: string): Promise<void>;
	stopAllWorkers(): Promise<void>;
	start(): Promise<void>;
	reset(devices: object): Promise<boolean>;
	end(): Promise<void>;
	constructor(id: string, logger?: LoggerFn);
}

export class Worker {
	_queue: Record<string, Function>;
	_childStreamIndex: StreamIndex;
	get respawnTime(): number;
	get driverPath(): string;
	get key(): number;
	get exports(): Record<string, Function>;
	get streamIndex(): StreamIndex;
	get controller(): Controller | undefined;
	get channel(): Channel;
	get sources(): Record<string, Function>;
	get sinks(): Record<string, Function>;
	get domain(): string;
	get node(): string;
	set nodeChanged(timestamp: string);
	get nodeChanged(): string;
	get nodeReady(): boolean;
	set nodeReady(ready: boolean);
	get nodeDown(): boolean;
	set nodeDown(down: boolean);
	get nodeError(): any;
	set nodeError(error: any);
	get onReady(): Promise<any>;
	get onDown(): Promise<any>;
	set persistent(persistent: boolean);
	get persistent(): boolean;
	send(message: any): boolean;
	sendBinary(frameType: number, uid: number, payload: any): boolean | undefined;
	message(type: string, message: any): void;
	request(request: object): Promise<any>;
	abort(key: any): Promise<string>;
	registerStream(streamId: string, childUid: number): SubstreamDuplex;
	openStream(streamId: string, childUid: number): SubstreamDuplex;
	closeStream(streamId: string): void;
	connectPipeline(): void;
	disconnectPipeline(): void;
	startGarbageCollector(): void;
	stopGarbageCollector(): void;
	destroy(): void;
	end(): Promise<any>;
	start(): void;
	import(properties: object): this;
	constructor(driver: Driver, id: string, sessionid: string, data?: object);
}

export class Node {
	exports: Record<string, Function>;
	interface: any;
	get streams(): Map<string, SubstreamDuplex>;
	get streamIndex(): StreamIndex;
	get logger(): LoggerFn;
	set logger(fn: LoggerFn);
	get node(): string;
	get domain(): string;
	get SessionID(): string;
	get interval(): number;
	set interval(seconds: number);
	set poll(poll: Function | false);
	get poll(): any;
	get onReady(): Promise<any>;
	get isReady(): boolean;
	set isReady(ready: boolean);
	log: (message: string, meta?: any, ...rest: any[]) => void;
	debug: (message: string, meta?: any, ...rest: any[]) => void;
	verbose: (message: string, meta?: any, ...rest: any[]) => void;
	getDevice(devices: object): any;
	send(frame: any): this | undefined;
	sendBinary(frameType: number, streamId: string, payload: any): void;
	emit(type: string, message: any): void;
	publishStreams(): void;
	openStream(streamId: string): SubstreamDuplex;
	closeStream(streamId: string): void;
	error(error: any): void;
	ready(nodes?: object): boolean;
	render(): void;
	dispatch(type: string, message: any): void;
	connect(init: Function): Promise<void>;
	end(): Promise<void>;
	destroy(message?: string): Promise<void>;
	import(properties: object): this;
	on(type: string, callback: Function): this;
	off(type: string): this;
	constructor(devices: object, logger?: LoggerFn, iface?: any);
}

export class Passthrough extends Node {
	channel: SecureChannel;
	get streams(): Map<string, SubstreamDuplex>;
	get streamIndex(): StreamIndex;
	end(): Promise<void>;
	openStream(streamId: string, uid?: number): SubstreamDuplex;
	closeStream(streamId: string): void;
	connect(init: Function | object, options?: { timeout?: number }): Promise<void>;
	constructor(devices: object, logger?: LoggerFn, iface?: any);
}

export class Controller {
	static getDevices(path: string): Promise<object>;
	get appReady(): Promise<any>;
	set appReady(ready: boolean);
	get devices(): Record<string, object>;
	set devices(devices: object);
	get channels(): Record<string, Channel>;
	set channels(channels: object);
	get state(): { cache: object; nodes: object };
	set state(state: object);
	get respawnTime(): number;
	set respawnTime(seconds: number);
	get driverPath(): string;
	set driverPath(path: string);
	get logger(): LoggerFn;
	set logger(fn: LoggerFn);
	setState: (path: string[], value: any) => this;
	getState: (path?: string[]) => any;
	cache: (...args: any[]) => any;
	nodes: (...args: any[]) => any;
	createChannel(id: string, options?: object): Channel;
	reply(response: Function, result: any): void;
	log(type: string, message: any, metadata?: object): void;
	destroy(message?: string): void;
	bind(events: Record<string, Function>): this;
	import(properties: object): this;
	emit(type: string, data: any): void;
	constructor(state?: object, driverPath?: string, respawnTime?: number, logger?: LoggerFn);
}

export class CachedData {
	onData?(data: any, node: string, socket: any): void;
	collector(type: string, overwrite: boolean, dedup: boolean, publishStatus: boolean, publishPayload: boolean, nodeInData: boolean, onData?: Function): Function;
	emitter(type: string, nodeInData: boolean, publishDataType?: string): Function;
	constructor(type: string, options: {
		overwrite?: boolean;
		dedup?: boolean;
		publishStatus?: boolean;
		publishPayload?: boolean;
		publishDataStream?: boolean;
		nodeInData?: boolean;
		onData?: Function;
		publishDatatype?: string;
	});
}

export class SystemCommand {
	constructor(options?: object);
}

export class ExpressMiddleware {
	constructor(options?: object);
}

export class Queue {
	constructor();
}

export class Transaction {
	transact(query: any, timeout?: number): Promise<any>;
	constructor(dispatcher: Dispatcher, prefix?: string);
}

export class TransactionQueue {
	transact(query: any, prefix?: string, timeout?: number): Promise<any>;
	constructor();
}

export function toReadable(asyncIterable: AsyncIterable<any>, options?: object): NodeJS.ReadableStream;
export function toWritable(sink: { write: (chunk: any) => void; end: () => void; fail?: (error: any) => void }, options?: object): NodeJS.WritableStream;

export class ClientProtocol extends Emitter {
	socket: any;
	end: () => void;
	get streamIndex(): StreamIndex;
	get exportsLoaded(): boolean;
	set exportsLoaded(value: boolean);
	get isReady(): boolean;
	set isReady(value: boolean);
	get onReady(): Promise<any>;
	get onExports(): Promise<any>;
	checkin(message?: any): void;
	import(message?: any): void;
	dispatch(type: string, message: any): void;
	reconcileStreams(streams: Array<{ streamId: string; uid: number }>): void;
	send(payload: any): boolean;
	message(type: string, message?: any): void;
	subscribeStream(streamId: string): void;
	unsubscribeStream(streamId: string): void;
	getStream(streamId: string | number): SubstreamDuplex | undefined;
	hasStream(streamId: string | number): boolean;
	openStream(stream: SubstreamDuplex): void;
	transact(command: string, args?: object, maxWait?: number, controller?: AbortController): Promise<any>;
	constructor(socket: any, routes?: Record<string, Function>);
}

export class ServerProtocol extends Emitter {
	host: any;
	context: any;
	socket: any;
	streamIndex: StreamIndex;
	end?: () => void;
	get exports(): Record<string, Function>;
	get onReady(): Promise<any> | boolean;
	get unwrapFrames(): boolean;
	get routes(): Record<string, Function>;
	log(...args: any[]): void;
	invoke(action: Function, args: any, key: any, context: any): any;
	decorate(args: any, context: any, envelope: any): any;
	execute(command: string, args?: object, key?: any, context?: any): Promise<any>;
	request(envelope: { key: any; request: { command: string; [key: string]: any } }, context: any): void;
	publishExports(context: any): Promise<void>;
	pushState(context: any): void;
	checkin(context: any): Promise<void>;
	streamSubscribe(message: { streamId: string }, context: any): void;
	streamUnsubscribe(message: { streamId: string }, context: any): void;
	reconcileSubscriptions(): void;
	send(payload: any): boolean;
	message(type: string, message?: any): void;
	sendBinary(frameType: number, streamId: string, payload: any): void;
	process(frame: any, validStream: { uid: number; payload: any }): void;
	dispatch(type: string, message: any, frame?: any): void;
	constructor(host: any, context?: any, socket?: any);
}

declare class Session {
	channel: any;
	time: Function;
	get streamIndex(): StreamIndex;
	log(...args: any[]): void;
	emit(type: string, message: any, ws?: any): boolean;
	binary(stream: SubstreamDuplex | undefined, frame: any): void;
	handshake(type: string, message: any, ws: any, address?: string, SessionID?: string): boolean;
	data(frame: any, ws: any, address: string): boolean;
	parse(payload: any, ws: any, address: string): boolean;
	constructor(channel: any, time: Function);
}

export class ServerSession extends Session {}

export class ClientSession extends Session {}

export class ProcessInterface extends Emitter {
	argv: string[];
	stdin: any;
	stdout: any;
	stderr: any;
	peer: any;
	connected: boolean;
	exit(): void;
	send(frame: any): void;
	constructor(child: any, driver: Function, argv: string[]);
}

export class ChildInterface {
	static fork(driver: Function, args?: any[]): Emitter & { stdin: any; stdout: any; stderr: any; peer: any; connected: boolean; send(frame: any): void };
}

declare const securechannel: {
	SecureChannel: typeof SecureChannel;
	Channel: typeof Channel;
	Driver: typeof Driver;
	Worker: typeof Worker;
	Node: typeof Node;
	Passthrough: typeof Passthrough;
	Controller: typeof Controller;
	CachedData: typeof CachedData;
	Logger: typeof Logger;
	Dispatcher: typeof Dispatcher;
	SystemCommand: typeof SystemCommand;
	ExpressMiddleware: typeof ExpressMiddleware;
	Queue: typeof Queue;
	Transaction: typeof Transaction;
	TransactionQueue: typeof TransactionQueue;
	BinaryFrame: typeof BinaryFrame;
	StreamIndex: typeof StreamIndex;
	QueueIterator: typeof QueueIterator;
	AsyncFanout: typeof AsyncFanout;
	ClientProtocol: typeof ClientProtocol;
	ServerProtocol: typeof ServerProtocol;
	ServerSession: typeof ServerSession;
	ClientSession: typeof ClientSession;
	ProcessInterface: typeof ProcessInterface;
	ChildInterface: typeof ChildInterface;
	toReadable: typeof toReadable;
	toWritable: typeof toWritable;
};

export default securechannel;
