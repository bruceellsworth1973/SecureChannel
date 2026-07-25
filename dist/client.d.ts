declare class AsyncSemaphore {
	get hasOpened(): boolean;
	get isOpen(): boolean;
	get status(): Promise<any>;
	set status(open: boolean);
	open(): void;
	close(): void;
	constructor(open?: boolean);
}

declare class BinaryFrame {
	static readonly sentinel: number;
	static readonly data: number;
	static readonly open: number;
	static readonly close: number;
	static readonly error: number;
	static readonly headerSize: number;
	static build(frameType: number, uid: number, payload?: Uint8Array | string): Uint8Array;
	static parse(frame: ArrayBuffer): { frameType: number; uid: number; payload: Uint8Array } | null;
}

declare class EventEmitter {
	on(event: string, listener: (...args: any[]) => void): this;
	off(event: string, listener: (...args: any[]) => void): this;
	once(event: string, listener: (...args: any[]) => void): this;
	addEventListener(event: string, listener: (...args: any[]) => void): this;
	removeEventListener(event: string, listener: (...args: any[]) => void): this;
	removeAllListeners(): void;
	emit(event: string, ...args: any[]): this;
}

declare class QueueIterator extends EventEmitter {
	queue: any[];
	resolve: Function | null;
	ended: boolean;
	error: any;
	finalPacket: { value: undefined; done: true };
	get depth(): number;
	push(value: any): void;
	write(value: any): void;
	end(aborted?: boolean): void;
	close(): void;
	fail(error: any): void;
	next(): Promise<{ value: any; done: boolean }>;
	return(): Promise<{ value: undefined; done: true }>;
	[Symbol.asyncIterator](): this;
	constructor();
}

declare class SubstreamDuplex extends EventEmitter {
	ended: boolean;
	fanout: QueueIterator;
	collator: QueueIterator;
	process(data: any): void;
	write(data: any): void;
	end(): void;
	close(): void;
	fail(reason: any): void;
	[Symbol.asyncIterator](): QueueIterator;
	constructor();
}

declare class StreamConsumer extends EventEmitter {
	get collator(): QueueIterator;
	get fanout(): QueueIterator;
	get ended(): boolean;
	data: (data: any) => void;
	fail: (error: any) => void;
	push(frameType: number, data: any): void;
	process(data: any): void;
	write(data: any): void;
	start(): Promise<void>;
	end(): void;
	[Symbol.asyncIterator](): QueueIterator;
	constructor(channel: SecureChannel, streamId: string, uid: number);
}

declare class SecureChannel {
	static subscribe(channel: string, viewports: any): Client;
	routes: Record<string, Function>;
	streams: Map<string, StreamConsumer>;
	streamMap: { byUID: Map<number, string>; byStreamId: Map<string, number> };
	persistent: boolean;
	ws: any;
	get SessionID(): string | null;
	set SessionID(SessionID: string);
	on(event: string, listener: Function): void;
	bind(handlers: Record<string, Function>): this;
	toSQLDate(moment: Date): string;
	time(moment?: Date): Date & { toSQL: () => string };
	write(message: any): () => void;
	send(object: any): boolean;
	message(type: string, message?: any): boolean;
	emit(type: string, message?: any): void;
	disconnect(): void;
	sendBinary(payload: any): void;
	getStreamUID(streamId: string): number | undefined;
	getStreamId(uid: number): string | undefined;
	isWired(streamId: string): boolean;
	openStream(streamId: string, uid: number): StreamConsumer;
	closeStream(streamId: string): void;
	connect(url: string, reconnectDelay?: number, persistent?: boolean): this;
	constructor(routes?: Record<string, Function>);
}

declare class Client {
	routes: Record<string, Function>;
	url: string;
	channel: SecureChannel;
	viewports: any[];
	id: string;
	checkedin: boolean;
	uniqueSignature: (responseQueue: object, signature?: number) => number;
	get SessionID(): string | null;
	set SessionID(sessionid: string);
	emit(type: string, data?: any, context?: any[]): any;
	message(...args: any[]): void;
	disconnect(): void;
	connect(): void;
	destroy(): void;
	constructor(url: string, viewports: any);
}
