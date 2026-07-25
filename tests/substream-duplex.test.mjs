/**
 * Substream Duplex Unit Tests — exhaustive per-method coverage of the pure transport classes.
 *
 * Targets every public method of BinaryFrame, StreamIndex, QueueIterator, AsyncFanout,
 * SubstreamDuplex, and the resolveStream/toReadable/toWritable helpers in utilities/substreamDuplex.js.
 *
 * These classes are deterministic and I/O-free, so they are tested in true isolation — no mocks
 * standing in for framework wiring. Each method is exercised for its documented happy path AND for
 * bad values, wrong types, extra arguments, and boundary conditions where edge cases matter.
 */
import {BinaryFrame, StreamIndex, QueueIterator, AsyncFanout, SubstreamDuplex, toReadable, toWritable} from '../utilities/substreamDuplex.js';

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
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
async function throws(fn, label = 'expected throw')
{
	try { await fn(); }
	catch { return; }
	throw new Error(`${label}: did not throw`);
}
// Drains a QueueIterator (or fanout consumer / collator) via its real consume() method.
// Resolves with the collected values once `n` are seen or the source ends.
function consumeN(source, n, ms = 1000)
{
	return new Promise((resolve, reject) =>
	{
		const got = [];
		const timer = setTimeout(() => reject(`consume timed out at ${got.length}/${n}`), ms);
		const finish = () => { clearTimeout(timer); resolve(got); };
		const onData = value => { got.push(value); if (got.length >= n) finish(); };
		const onFail = error => { clearTimeout(timer); reject(error); };
		const pump = source.consume(onData, onFail, finish);
		pump();
	});
}

console.log('\n=== Substream Duplex Unit Tests ===\n');

// ═══════════════════════════════════════════════════════════════
// BinaryFrame
// ═══════════════════════════════════════════════════════════════

console.log('--- BinaryFrame ---\n');

await test('BF-constants: sentinel, frame types, and uid ceiling are stable', async () =>
{
	assert(BinaryFrame.sentinel === 0xFE, 'sentinel');
	assert(BinaryFrame.data === 0x01, 'data');
	assert(BinaryFrame.open === 0x02, 'open');
	assert(BinaryFrame.close === 0x03, 'close');
	assert(BinaryFrame.error === 0x04, 'error');
	assert(BinaryFrame.headerSize === 6, 'headerSize');
	assert(BinaryFrame.maxUID === 0xFFFFFFFF, 'maxUID matches the uint32 frame field');
});

await test('BF-build: header layout + string payload', async () =>
{
	const f = BinaryFrame.build(BinaryFrame.data, 42, 'hello');
	assert(f[0] === BinaryFrame.sentinel, 'sentinel byte');
	assert(f[1] === BinaryFrame.data, 'type byte');
	assert(f.readUInt32BE(2) === 42, 'uid bytes');
	assert(f.subarray(6).toString() === 'hello', 'payload bytes');
	assert(f.length === 6 + 5, 'total length');
});

await test('BF-build: null payload yields header-only 6-byte frame', async () =>
{
	const f = BinaryFrame.build(BinaryFrame.open, 7, null);
	assert(f.length === 6, 'header only');
	const parsed = BinaryFrame.parse(f);
	assert(parsed.payload.length === 0, 'empty payload parses');
});

await test('BF-build: object payload is JSON-encoded', async () =>
{
	const f = BinaryFrame.build(BinaryFrame.data, 1, {a: 1, b: 'x'});
	assert(BinaryFrame.parse(f).payload.toString() === '{"a":1,"b":"x"}', 'json payload');
});

await test('BF-build: extra arguments are ignored', async () =>
{
	const f = BinaryFrame.build(BinaryFrame.data, 5, 'ok', 'EXTRA', 99);
	const parsed = BinaryFrame.parse(f);
	assert(parsed.uid === 5 && parsed.payload.toString() === 'ok', 'extra args ignored');
});

await test('BF-build: uid boundaries 0 and 0xFFFFFFFF round-trip', async () =>
{
	for (const uid of [0, 1, 255, 65535, 0xFFFFFFFF])
	{
		const parsed = BinaryFrame.parse(BinaryFrame.build(BinaryFrame.data, uid, 'x'));
		assert(parsed.uid === uid, `uid ${uid} round-trips`);
	}
});

await test('BF-build: uid beyond uint32 throws (frame uid field is 32-bit)', async () =>
{
	// mintUID wraps at BinaryFrame.maxUID so it can never produce an out-of-range uid;
	// this guards hand-constructed frames against silent uint32 overflow.
	await throws(() => BinaryFrame.build(BinaryFrame.data, BinaryFrame.maxUID + 1, 'x'), 'uint32 overflow');
});

await test('BF-parse: rejects non-buffer, short, and wrong-sentinel inputs', async () =>
{
	assert(BinaryFrame.parse(null) === null, 'null');
	assert(BinaryFrame.parse(undefined) === null, 'undefined');
	assert(BinaryFrame.parse(123) === null, 'number');
	assert(BinaryFrame.parse('not a buffer') === null, 'string');
	assert(BinaryFrame.parse(Buffer.alloc(3)) === null, 'too short');
	assert(BinaryFrame.parse(Buffer.from([0x00, 1, 2, 3, 4, 5])) === null, 'wrong sentinel');
});

await test('BF-parse: exactly 6 bytes with sentinel yields empty payload', async () =>
{
	const buf = Buffer.alloc(6);
	buf[0] = BinaryFrame.sentinel;
	buf[1] = BinaryFrame.close;
	buf.writeUInt32BE(9, 2);
	const parsed = BinaryFrame.parse(buf);
	assert(parsed && parsed.frameType === BinaryFrame.close && parsed.uid === 9, 'header parsed');
	assert(parsed.payload.length === 0, 'empty payload');
});

await test('BF-parse: non-UTF8 binary payload is byte-exact', async () =>
{
	const raw = Buffer.from([0x00, 0x01, 0x7F, 0x80, 0xFE, 0xFF]);
	const parsed = BinaryFrame.parse(BinaryFrame.build(BinaryFrame.data, 3, raw));
	assert(Buffer.compare(parsed.payload, raw) === 0, 'bytes preserved');
});

await test('BF-toBuffer: falsy inputs (null/undefined/empty/0) produce empty buffer', async () =>
{
	for (const v of [null, undefined, '', 0, false])
		assert(BinaryFrame.toBuffer(v).length === 0, `falsy ${String(v)} → empty`);
});

await test('BF-toBuffer: buffer passes through, string encodes, {type:Buffer} reconstructs', async () =>
{
	const b = Buffer.from('xy');
	assert(BinaryFrame.toBuffer(b) === b, 'buffer identity');
	assert(BinaryFrame.toBuffer('hi').toString() === 'hi', 'string');
	assert(BinaryFrame.toBuffer({type: 'Buffer', data: [104, 105]}).toString() === 'hi', 'serialized buffer shape');
});

await test('BF-toBuffer: plain object and array are JSON-encoded', async () =>
{
	assert(BinaryFrame.toBuffer({k: 1}).toString() === '{"k":1}', 'object json');
	assert(BinaryFrame.toBuffer([1, 2, 3]).toString() === '[1,2,3]', 'array json');
});

await test('BF-mintUID: increments from next and advances counter', async () =>
{
	const idx = {next: 1, byUID: new Map()};
	assert(BinaryFrame.mintUID(idx) === 1, 'first uid');
	assert(idx.next === 2, 'counter advanced');
	assert(BinaryFrame.mintUID(idx) === 2, 'second uid');
});

await test('BF-mintUID: skips uids already present in byUID', async () =>
{
	const idx = {next: 1, byUID: new Map([[1, 'a']])};
	assert(BinaryFrame.mintUID(idx) === 2, 'skipped occupied 1');
});

await test('BF-mintUID: wraps to 1 at the uint32 ceiling (maxUID)', async () =>
{
	const idx = {next: BinaryFrame.maxUID, byUID: new Map()};
	assert(BinaryFrame.mintUID(idx) === BinaryFrame.maxUID, 'returns the ceiling uid');
	assert(idx.next === 1, 'wrapped to 1');
});

await test('BF-mintUID: a minted uid is always frame-encodable (mint and frame agree)', async () =>
{
	const idx = {next: BinaryFrame.maxUID, byUID: new Map()};
	const uid = BinaryFrame.mintUID(idx);
	assert(uid <= BinaryFrame.maxUID, 'within uint32 range');
	const parsed = BinaryFrame.parse(BinaryFrame.build(BinaryFrame.data, uid, 'x'));
	assert(parsed.uid === uid, 'ceiling uid round-trips through build/parse');
});

// ═══════════════════════════════════════════════════════════════
// StreamIndex
// ═══════════════════════════════════════════════════════════════

console.log('\n--- StreamIndex ---\n');

await test('SI-add: registers streamId with explicit uid and returns true', async () =>
{
	const si = new StreamIndex();
	assert(si.add('a', 5) === true, 'returns true');
	assert(si.has('a'), 'has streamId');
	assert(si.getUID('a') === 5, 'uid mapped');
	assert(si.getStreamId(5) === 'a', 'streamId mapped');
});

await test('SI-add: without uid mints one from the index counter', async () =>
{
	const si = new StreamIndex();
	si.add('a');
	assert(si.getUID('a') === 1, 'minted uid 1');
	si.add('b');
	assert(si.getUID('b') === 2, 'minted uid 2');
});

await test('SI-add: duplicate streamId returns false and preserves original uid', async () =>
{
	const si = new StreamIndex();
	si.add('a', 1);
	assert(si.add('a', 99) === false, 'returns false');
	assert(si.getUID('a') === 1, 'uid unchanged');
});

await test('SI-add: accepts an explicit stream object', async () =>
{
	const si = new StreamIndex();
	const stream = new SubstreamDuplex();
	si.add('a', 1, () => stream);
	assert(si.get('a') === stream, 'stored provided stream');
});

await test('SI-get/getUID/getStreamId/has: resolve by streamId OR uid', async () =>
{
	const si = new StreamIndex();
	si.add('a', 7);
	const stream = si.get('a');
	assert(si.get(7) === stream, 'get by uid');
	assert(si.getUID(7) === 7, 'getUID accepts a uid');
	assert(si.getStreamId('a') === 'a', 'getStreamId accepts a streamId');
	assert(si.has(7) && si.has('a'), 'has accepts either');
});

await test('SI-lookups: unknown keys return undefined/false safely', async () =>
{
	const si = new StreamIndex();
	assert(si.getUID('zzz') === undefined, 'getUID unknown');
	assert(si.getStreamId(999) === undefined, 'getStreamId unknown');
	assert(si.get('zzz') === undefined, 'get unknown');
	assert(si.get(undefined) === undefined, 'get undefined');
	assert(si.has('zzz') === false, 'has unknown');
	assert(si.has(undefined) === false, 'has undefined');
});

await test('SI-delete: removes all three mappings and fires onDelete', async () =>
{
	const si = new StreamIndex();
	si.add('a', 1);
	let deleted = null;
	const stream = si.get('a');
	si.delete('a', s => deleted = s);
	assert(deleted === stream, 'onDelete received stream');
	assert(!si.has('a') && si.getUID('a') === undefined && si.getStreamId(1) === undefined, 'all mappings gone');
});

await test('SI-delete: unknown streamId is a safe no-op', async () =>
{
	const si = new StreamIndex();
	let called = false;
	si.delete('nonexistent', () => called = true);
	assert(called === false, 'onDelete not called');
});

await test('SI-list: returns {streamId, uid} pairs for all streams', async () =>
{
	const si = new StreamIndex();
	si.add('a', 1);
	si.add('b', 2);
	assert(eq(si.list(), [{streamId: 'a', uid: 1}, {streamId: 'b', uid: 2}]), 'list shape');
});

await test('SI-keys/values/entries: iterate the streams map', async () =>
{
	const si = new StreamIndex();
	const sa = new SubstreamDuplex();
	si.add('a', 1, () => sa);
	assert(eq([...si.keys()], ['a']), 'keys');
	assert([...si.values()][0] === sa, 'values');
	assert([...si.entries()][0][0] === 'a', 'entries key');
});

await test('SI-intersect: filters entries by predicate', async () =>
{
	const si = new StreamIndex();
	si.add('a', 1);
	si.add('b', 2);
	const matched = si.intersect(streamId => streamId === 'b');
	assert(matched.length === 1 && matched[0][0] === 'b', 'intersect filter');
});

await test('SI-getActiveStreams: returns only subscribed (socketed) streams', async () =>
{
	const si = new StreamIndex();
	si.add('a', 1);
	si.add('b', 2);
	si.get('b').sockets.add({});
	assert(eq(si.getActiveStreams(), ['b']), 'only b is active');
});

await test('SI-subscribe: initial list fires onSubscribed + onChanged', async () =>
{
	const si = new StreamIndex();
	const sub = [], unsub = [], changed = [];
	si.subscribe(['a', 'b'], x => sub.push(x), x => unsub.push(x), l => changed.push(l));
	assert(eq(sub, ['a', 'b']), 'subscribed a,b');
	assert(unsub.length === 0, 'nothing unsubscribed');
	assert(changed.length === 1 && eq(changed[0], ['a', 'b']), 'onChanged once');
	assert(eq(si.subscriptions, ['a', 'b']), 'subscriptions stored');
});

await test('SI-subscribe: identical list does not fire onChanged', async () =>
{
	const si = new StreamIndex();
	si.subscribe(['a']);
	let changes = 0;
	si.subscribe(['a'], null, null, () => changes++);
	assert(changes === 0, 'no change emitted');
});

await test('SI-subscribe: diff fires add and remove deltas', async () =>
{
	const si = new StreamIndex();
	si.subscribe(['a', 'b']);
	const sub = [], unsub = [];
	si.subscribe(['b', 'c'], x => sub.push(x), x => unsub.push(x));
	assert(eq(sub, ['c']), 'added c');
	assert(eq(unsub, ['a']), 'removed a');
});

await test('SI-subscribe: omitted callbacks do not throw', async () =>
{
	const si = new StreamIndex();
	si.subscribe(['a']);
	si.subscribe([]);
	assert(eq(si.subscriptions, []), 'cleared');
});

await test('SI-reconcileStreams: opens new, keeps existing, closes removed', async () =>
{
	const si = new StreamIndex();
	si.add('a', 1);
	const opened = [], closed = [];
	const open = (id, uid) => { opened.push([id, uid]); si.add(id, uid); };
	const close = id => { closed.push(id); si.delete(id); };
	si.reconcileStreams([{streamId: 'a', uid: 1}, {streamId: 'b', uid: 2}], open, close);
	assert(eq(opened, [['b', 2]]), 'opened b only');
	assert(closed.length === 0, 'closed nothing');
	si.reconcileStreams([{streamId: 'a', uid: 1}], open, close);
	assert(eq(closed, ['b']), 'closed b on removal');
});

await test('SI-clear: deletes every stream and fires onDelete per stream', async () =>
{
	const si = new StreamIndex();
	si.add('a', 1);
	si.add('b', 2);
	const deleted = [];
	si.clear(() => deleted.push(1));
	assert([...si.keys()].length === 0, 'index emptied');
	assert(deleted.length === 2, 'onDelete per stream');
});

// ═══════════════════════════════════════════════════════════════
// QueueIterator
// ═══════════════════════════════════════════════════════════════

console.log('\n--- QueueIterator ---\n');

await test('QI-write/consume: yields written values in order', async () =>
{
	const q = new QueueIterator();
	q.write('a');
	q.write('b');
	q.end();
	assert(eq(await consumeN(q, 2), ['a', 'b']), 'ordered delivery');
});

await test('QI-depth: reflects queued items without a consumer', async () =>
{
	const q = new QueueIterator();
	assert(q.depth === 0, 'empty');
	q.write('a');
	q.write('b');
	assert(q.depth === 2, 'two queued');
});

await test('QI-falsy: delivers 0, "", false, null without treating them as done', async () =>
{
	const q = new QueueIterator();
	q.write(0);
	q.write('');
	q.write(false);
	q.write(null);
	const got = await consumeN(q, 4);
	assert(got.length === 4 && got[0] === 0 && got[1] === '' && got[2] === false && got[3] === null, 'falsy delivered');
});

await test('QI-backpressure: a pending next() resolves on the next write', async () =>
{
	const q = new QueueIterator();
	const pending = q.next();
	q.write('x');
	const packet = await pending;
	assert(packet.value === 'x' && packet.done === false, 'resolved with queued packet');
});

await test('QI-end: terminates iteration with a done packet', async () =>
{
	const q = new QueueIterator();
	q.end();
	const packet = await q.next();
	assert(packet.done === true, 'done after end');
});

await test('QI-write-after-end: is ignored', async () =>
{
	const q = new QueueIterator();
	q.end();
	q.write('x');
	const got = await consumeN(q, 5, 300);
	assert(got.length === 0, 'no data after end');
});

await test('QI-fail: sets error, emits fail, marks ended', async () =>
{
	const q = new QueueIterator();
	let reason = null;
	q.on('fail', e => reason = e);
	q.fail('boom');
	assert(reason === 'boom', 'fail emitted');
	assert(q.error === 'boom', 'error captured');
	assert(q.ended === true, 'ended');
});

await test('QI-next: rejects when error is set with an empty queue', async () =>
{
	const q = new QueueIterator();
	q.error = 'boom';
	await throws(() => q.next(), 'next rejects on error');
});

await test('QI-return: ends the queue and resolves a done packet', async () =>
{
	const q = new QueueIterator();
	const packet = await q.return();
	assert(packet.done === true, 'final packet');
	assert(q.ended === true, 'ended');
});

await test('QI-consume: pre-aborted signal returns null without consuming', async () =>
{
	const q = new QueueIterator();
	q.write('a');
	const ac = new AbortController();
	ac.abort();
	let calls = 0;
	const pump = q.consume(() => calls++, null, null, ac.signal);
	const result = await pump();
	assert(result === null, 'returns null');
	assert(calls === 0, 'onData never called');
});

await test('QI-consume: aborting mid-stream stops further delivery', async () =>
{
	const q = new QueueIterator();
	const ac = new AbortController();
	const got = [];
	const pump = q.consume(v => got.push(v), null, null, ac.signal);
	const done = pump();
	q.write('a');
	await new Promise(r => setTimeout(r, 20));
	ac.abort();
	q.write('b');
	await new Promise(r => setTimeout(r, 20));
	await done;
	assert(got.includes('a'), 'delivered before abort');
	assert(!got.includes('b'), 'not delivered after abort');
});

await test('QI-consume: onEnd fires when the source ends cleanly', async () =>
{
	const q = new QueueIterator();
	let ended = false;
	const pump = q.consume(() => {}, null, () => ended = true);
	const done = pump();
	q.end();
	await done;
	assert(ended === true, 'onEnd fired');
});

await test('QI-consume: an onData that throws is routed to onFail', async () =>
{
	const q = new QueueIterator();
	q.write('a');
	const failed = await new Promise(resolve =>
	{
		const pump = q.consume(() => { throw new Error('handler boom'); }, e => resolve(e), null);
		pump();
	});
	assert(failed && failed.message === 'handler boom', 'onFail received the thrown error');
});

await test('QI-close: delegates to end()', async () =>
{
	const q = new QueueIterator();
	q.close();
	assert(q.ended === true, 'ended via close()');
});

// ═══════════════════════════════════════════════════════════════
// AsyncFanout
// ═══════════════════════════════════════════════════════════════

console.log('\n--- AsyncFanout ---\n');

await test('AF-broadcast: every consumer receives every write', async () =>
{
	const f = new AsyncFanout();
	const a = f.consumer();
	const b = f.consumer();
	f.write('x');
	f.write('y');
	f.end();
	const [ga, gb] = await Promise.all([consumeN(a, 2), consumeN(b, 2)]);
	assert(eq(ga, ['x', 'y']) && eq(gb, ['x', 'y']), 'both consumers got all writes');
});

await test('AF-isolation: a consumer created after a write misses earlier writes', async () =>
{
	const f = new AsyncFanout();
	const early = f.consumer();
	f.write('first');
	const late = f.consumer();
	f.write('second');
	f.end();
	assert(eq(await consumeN(early, 2), ['first', 'second']), 'early sees both');
	assert(eq(await consumeN(late, 1), ['second']), 'late sees only second');
});

await test('AF-consumer-after-end: receives an immediate done packet', async () =>
{
	const f = new AsyncFanout();
	f.end();
	const late = f.consumer();
	const got = await consumeN(late, 5, 300);
	assert(got.length === 0, 'no data, ended');
});

await test('AF-consumer: throws when the fanout has already failed', async () =>
{
	const f = new AsyncFanout();
	f.fail('boom');
	await throws(() => f.consumer(), 'consumer throws after fail');
});

await test('AF-cleanup: consumers are removed from the set on end', async () =>
{
	const f = new AsyncFanout();
	f.consumer();
	assert(f.consumers.size === 1, 'one consumer registered');
	f.end();
	await new Promise(r => setTimeout(r, 20));
	assert(f.consumers.size === 0, 'consumer removed on end');
});

await test('AF-cleanup-on-fail: consumers are removed from the set on fail', async () =>
{
	const f = new AsyncFanout();
	f.consumer();
	assert(f.consumers.size === 1, 'one consumer registered');
	f.fail('boom');
	await new Promise(r => setTimeout(r, 20));
	assert(f.consumers.size === 0, 'consumer removed on fail');
});

await test('AF-asyncIterator: for-await over the fanout creates and drives a consumer', async () =>
{
	const f = new AsyncFanout();
	const got = [];
	const done = (async () => { for await (const v of f) { got.push(v); if (got.length >= 2) break; } })();
	f.write('p');
	f.write('q');
	await done;
	assert(eq(got, ['p', 'q']), 'fanout async-iterated');
});

// ═══════════════════════════════════════════════════════════════
// SubstreamDuplex
// ═══════════════════════════════════════════════════════════════

console.log('\n--- SubstreamDuplex ---\n');

await test('SD-write: fanout consumers receive written frames', async () =>
{
	const s = new SubstreamDuplex();
	const it = s[Symbol.asyncIterator]();
	s.write('a');
	s.write('b');
	assert(eq(await consumeN(it, 2), ['a', 'b']), 'fanout delivery');
});

await test('SD-process: collator receives processed frames', async () =>
{
	const s = new SubstreamDuplex();
	s.process('p1');
	s.process('p2');
	assert(eq(await consumeN(s.collator, 2), ['p1', 'p2']), 'collator delivery');
});

await test('SD-isSubscribed: reflects the sockets set', async () =>
{
	const s = new SubstreamDuplex();
	assert(s.isSubscribed === false, 'no sockets');
	const ws = {};
	s.sockets.add(ws);
	assert(s.isSubscribed === true, 'has a socket');
	s.sockets.delete(ws);
	assert(s.isSubscribed === false, 'socket removed');
});

await test('SD-end: idempotent, emits once, clears sockets', async () =>
{
	const s = new SubstreamDuplex();
	s.sockets.add({});
	let ends = 0;
	s.on('end', () => ends++);
	s.end();
	s.end();
	assert(ends === 1, 'end emitted once');
	assert(s.ended === true, 'marked ended');
	assert(s.sockets.size === 0, 'sockets cleared');
});

await test('SD-guards: process/write are no-ops after end', async () =>
{
	const s = new SubstreamDuplex();
	s.end();
	s.write('x');
	s.process('y');
	const got = await consumeN(s.collator, 5, 200);
	assert(got.length === 0, 'nothing delivered after end');
});

await test('SD-fail: marks ended, clears sockets, emits fail', async () =>
{
	const s = new SubstreamDuplex();
	s.sockets.add({});
	let reason = null;
	s.on('fail', e => reason = e);
	s.fail('boom');
	assert(reason === 'boom', 'fail emitted');
	assert(s.ended === true, 'ended');
	assert(s.sockets.size === 0, 'sockets cleared');
});

await test('SD-fail-after-end: is a no-op (no second teardown)', async () =>
{
	const s = new SubstreamDuplex();
	s.end();
	let failed = false;
	s.on('fail', () => failed = true);
	s.fail('boom');
	assert(failed === false, 'fail suppressed after end');
});

await test('SD-close: delegates to end()', async () =>
{
	const s = new SubstreamDuplex();
	s.close();
	assert(s.ended === true, 'ended via close()');
});

// ═══════════════════════════════════════════════════════════════
// resolveStream + stream adapters
// ═══════════════════════════════════════════════════════════════

console.log('\n--- resolveStream / adapters ---\n');

await test('RS-resolve: returns the stream for a known uid', async () =>
{
	const si = new StreamIndex();
	si.add('a', 1);
	assert(StreamIndex.resolveStream({uid: 1}, si) === si.get('a'), 'resolved by uid');
});

await test('RS-resolve: returns null for an unknown uid', async () =>
{
	assert(StreamIndex.resolveStream({uid: 999}, new StreamIndex()) === null, 'null for unknown');
});

await test('adapter-toWritable: forwards writes to the sink and ends it', async () =>
{
	const writes = [];
	let ended = false;
	const sink = {write: v => writes.push(v), end: () => ended = true};
	const w = toWritable(sink);
	await new Promise((resolve, reject) =>
	{
		w.on('finish', resolve);
		w.on('error', reject);
		w.write('a');
		w.write('b');
		w.end();
	});
	assert(eq(writes, ['a', 'b']), 'writes forwarded');
	assert(ended === true, 'sink ended on final');
});

await test('adapter-toWritable: sink failure surfaces as a destroy error', async () =>
{
	let failed = null;
	const sink = {write() { throw new Error('sink boom'); }, end() {}, fail: e => failed = e};
	const w = toWritable(sink);
	await new Promise(resolve =>
	{
		w.on('error', () => resolve());
		w.write('x');
	});
	assert(true, 'error surfaced without crashing');
});

await test('adapter-toReadable: streams an async iterable to completion', async () =>
{
	async function* gen() { yield '1'; yield '2'; yield '3'; }
	const got = [];
	for await (const chunk of toReadable(gen())) got.push(chunk);
	assert(eq(got, ['1', '2', '3']), 'readable yields all');
});

// ═══════════════════════════════════════════════════════════════

console.log(`\n${passed}/${total} tests passed`);
if (failures.length) { console.log('Failures:', failures); process.exit(1); }
process.exit(0);
