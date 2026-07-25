const {QueueIterator, SubstreamDuplex, AsyncFanout, BinaryFrame} = require('../utilities/substreamDuplex.js');

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
function race(promise, ms = 2000, label = 'operation')
{
	return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(`${label} timed out after ${ms}ms`), ms))]);
}
async function collect(iterator)
{
	const out = [];
	for await (const v of iterator) out.push(v);
	return out;
}

(async () =>
{
	// ═══════════════════════════════════════════════════════════════
	// QueueIterator Tests
	// ═══════════════════════════════════════════════════════════════

	console.log('\n=== QueueIterator Tests ===\n');

	await test('COL-1: single writer, single reader', async () =>
	{
		const col = new QueueIterator();
		const reader = race(collect(col), 2000, 'collect');
		col.write('a');
		col.write('b');
		col.write('c');
		col.end();
		const result = await reader;
		assert(result.length === 3, `expected 3, got ${result.length}`);
		assert(result[0] === 'a' && result[1] === 'b' && result[2] === 'c', 'data order preserved');
	});

	await test('COL-2: writes before reader starts (queued)', async () =>
	{
		const col = new QueueIterator();
		col.write('x');
		col.write('y');
		col.end();
		const result = await race(collect(col), 2000, 'collect');
		assert(result.length === 2, `expected 2, got ${result.length}`);
		assert(result[0] === 'x' && result[1] === 'y', 'queued data delivered');
	});

	await test('COL-3: reader waits for writes (suspended coroutine)', async () =>
	{
		const col = new QueueIterator();
		const result = [];
		const reader = (async () => { for await (const v of col) result.push(v); })();
		await new Promise(r => setTimeout(r, 50));
		assert(result.length === 0, 'reader suspended — no data yet');
		col.write('delayed');
		await new Promise(r => setTimeout(r, 50));
		assert(result.length === 1, 'reader resumed after write');
		col.end();
		await race(reader, 2000, 'reader');
		assert(result[0] === 'delayed', 'data correct');
	});

	await test('COL-4: multiple writers collated into one reader', async () =>
	{
		const col = new QueueIterator();
		const result = [];
		const reader = (async () => { for await (const v of col) result.push(v); })();
		col.write('w1-a');
		col.write('w2-a');
		col.write('w1-b');
		col.write('w3-a');
		col.write('w2-b');
		col.end();
		await race(reader, 2000, 'reader');
		assert(result.length === 5, `expected 5, got ${result.length}`);
		assert(result[0] === 'w1-a' && result[4] === 'w2-b', 'interleaved writes in push order');
	});

	await test('COL-5: end() terminates reader', async () =>
	{
		const col = new QueueIterator();
		const result = [];
		const reader = (async () => { for await (const v of col) result.push(v); })();
		col.write('before');
		col.end();
		await race(reader, 2000, 'reader');
		assert(result.length === 1, 'reader received data before end');
	});

	await test('COL-6: writes after end() are dropped', async () =>
	{
		const col = new QueueIterator();
		col.write('before');
		col.end();
		col.write('after');
		const result = await race(collect(col), 2000, 'collect');
		assert(result.length === 1, `expected 1, got ${result.length}`);
		assert(result[0] === 'before', 'only pre-end data');
	});

	await test('COL-7: fail() propagates error to reader', async () =>
	{
		const col = new QueueIterator();
		let caught = null;
		const reader = (async () => {
			try { for await (const v of col) v; }
			catch(e) { caught = e; }
		})();
		col.write('ok');
		col.fail(new Error('broken'));
		await race(reader, 2000, 'reader');
		assert(caught !== null, 'error propagated');
		assert(caught.message === 'broken', `error message: ${caught.message}`);
	});

	await test('COL-8: empty collator (end immediately)', async () =>
	{
		const col = new QueueIterator();
		col.end();
		const result = await race(collect(col), 2000, 'collect');
		assert(result.length === 0, 'empty');
	});

	await test('COL-9: object payloads preserved', async () =>
	{
		const col = new QueueIterator();
		col.write({id: 1, data: Buffer.from([0xFF]).toJSON()});
		col.write({id: 2, data: 'text'});
		col.end();
		const result = await race(collect(col), 2000, 'collect');
		assert(result.length === 2, 'both received');
		assert(result[0].id === 1, 'object preserved');
		assert(Buffer.from(result[0].data)[0] === 0xFF, 'buffer data preserved');
	});

	// ═══════════════════════════════════════════════════════════════
	// AsyncFanout Tests
	// ═══════════════════════════════════════════════════════════════

	console.log('\n=== AsyncFanout Tests ===\n');

	await test('FAN-1: single consumer receives all writes', async () =>
	{
		const fan = new AsyncFanout();
		const consumer = fan.consumer();
		fan.write('a');
		fan.write('b');
		fan.end();
		const result = await race(collect(consumer), 2000, 'collect');
		assert(result.length === 2, `expected 2, got ${result.length}`);
		assert(result[0] === 'a' && result[1] === 'b', 'data correct');
	});

	await test('FAN-2: multiple consumers each receive all writes', async () =>
	{
		const fan = new AsyncFanout();
		const c1 = fan.consumer();
		const c2 = fan.consumer();
		fan.write('x');
		fan.write('y');
		fan.end();
		const [r1, r2] = await race(Promise.all([collect(c1), collect(c2)]), 2000, 'collect');
		assert(r1.length === 2 && r2.length === 2, 'both got 2');
		assert(r1[0] === 'x' && r2[0] === 'x', 'same data');
	});

	await test('FAN-3: consumer created after writes receives nothing', async () =>
	{
		const fan = new AsyncFanout();
		fan.write('early');
		const consumer = fan.consumer();
		fan.write('late');
		fan.end();
		const result = await race(collect(consumer), 2000, 'collect');
		assert(result.length === 1, `expected 1, got ${result.length}`);
		assert(result[0] === 'late', 'only post-creation data');
	});

	await test('FAN-4: consumer detach does not affect other consumers', async () =>
	{
		const fan = new AsyncFanout();
		const c1 = fan.consumer();
		const c2 = fan.consumer();
		const r1 = [];
		const p1 = (async () => { for await (const v of c1) { r1.push(v); if (r1.length === 2) break; } })();
		const r2 = [];
		const p2 = (async () => { for await (const v of c2) r2.push(v); })();
		fan.write('a');
		fan.write('b');
		fan.write('c');
		fan.write('d');
		fan.end();
		await race(Promise.all([p1, p2]), 3000, 'consumers');
		assert(r1.length === 2, `c1 early exit: ${r1.length}`);
		assert(r2.length === 4, `c2 full: ${r2.length}`);
	});

	// ═══════════════════════════════════════════════════════════════
	// SubstreamDuplex Tests
	// ═══════════════════════════════════════════════════════════════

	console.log('\n=== SubstreamDuplex Tests ===\n');

	await test('SD-1: write() delivers to fanout consumers', async () =>
	{
		const sd = new SubstreamDuplex();
		const c1 = sd.fanout.consumer();
		const c2 = sd.fanout.consumer();
		sd.write('a');
		sd.write('b');
		sd.write('c');
		sd.close();
		const [r1, r2] = await race(Promise.all([collect(c1), collect(c2)]), 2000, 'drain');
		assert(r1.length === 3 && r2.length === 3, 'both consumers got 3');
		assert(r1[0] === 'a' && r1[2] === 'c', 'consumer 1 data');
		assert(r2[0] === 'a' && r2[2] === 'c', 'consumer 2 data');
	});

	await test('SD-2: process() writes to collator', async () =>
	{
		const sd = new SubstreamDuplex();
		const result = [];
		const reader = (async () => { for await (const v of sd.collator) result.push(v); })();
		sd.process('from-c1');
		sd.process('from-c2');
		sd.process('from-c1-again');
		sd.close();
		await race(reader, 2000, 'collator reader');
		assert(result.length === 3, `expected 3, got ${result.length}`);
		assert(result[0] === 'from-c1', 'first write');
		assert(result[1] === 'from-c2', 'second write');
		assert(result[2] === 'from-c1-again', 'third write');
	});

	await test('SD-3: simultaneous fanout + collator', async () =>
	{
		const sd = new SubstreamDuplex();
		const outbound = [];
		const inbound = [];
		const consumer = sd.fanout.consumer();
		const outReader = (async () => { for await (const v of consumer) outbound.push(v); })();
		const inReader = (async () => { for await (const v of sd.collator) inbound.push(v); })();
		sd.write('out1');
		sd.write('out2');
		sd.process('in1');
		sd.process('in2');
		sd.close();
		await race(Promise.all([outReader, inReader]), 2000, 'both');
		assert(outbound.length === 2, `outbound: ${outbound.length}`);
		assert(outbound[0] === 'out1' && outbound[1] === 'out2', 'outbound data');
		assert(inbound.length === 2, `inbound: ${inbound.length}`);
		assert(inbound[0] === 'in1' && inbound[1] === 'in2', 'inbound data');
	});

	await test('SD-4: async iterator creates fanout consumer', async () =>
	{
		const sd = new SubstreamDuplex();
		const result = [];
		const reader = (async () => { for await (const v of sd) result.push(v); })();
		sd.write('x');
		sd.write('y');
		sd.close();
		await race(reader, 2000, 'reader');
		assert(result.length === 2, `expected 2, got ${result.length}`);
		assert(result[0] === 'x' && result[1] === 'y', 'data correct');
	});

	await test('SD-5: close() terminates both collator and fanout', async () =>
	{
		const sd = new SubstreamDuplex();
		const inbound = [];
		const reader = (async () => { for await (const v of sd.collator) inbound.push(v); })();
		sd.process('data');
		sd.close();
		await race(reader, 2000, 'collator');
		assert(inbound.length === 1, 'received before close');
		assert(sd.ended === true, 'ended flag set');
	});

	await test('SD-6: fail() propagates to collator reader', async () =>
	{
		const sd = new SubstreamDuplex();
		let caught = null;
		const reader = (async () => {
			try { for await (const v of sd.collator) v; }
			catch(e) { caught = e; }
		})();
		sd.process('ok');
		sd.fail('stream broke');
		await race(reader, 2000, 'reader');
		assert(caught !== null, 'error propagated');
		assert(caught === 'stream broke', `error value: ${caught}`);
	});

	await test('SD-7: fail() propagates to fanout consumer', async () =>
	{
		const sd = new SubstreamDuplex();
		let caught = null;
		const consumer = sd.fanout.consumer();
		const reader = (async () => {
			try { for await (const v of consumer) v; }
			catch(e) { caught = e; }
		})();
		sd.write('ok');
		sd.fail('fanout broke');
		await race(reader, 2000, 'reader');
		assert(caught !== null, 'error propagated');
		assert(caught === 'fanout broke', `error value: ${caught}`);
	});

	await test('SD-8: writes after close() are dropped', async () =>
	{
		const sd = new SubstreamDuplex();
		sd.write('before');
		sd.close();
		sd.write('after');
		sd.process('also-after');
		assert(sd.ended === true, 'ended');
	});

	await test('SD-9: isSubscribed reflects sockets set', async () =>
	{
		const sd = new SubstreamDuplex();
		assert(sd.isSubscribed === false, 'initially unsubscribed');
		const ws = {};
		sd.sockets.add(ws);
		assert(sd.isSubscribed === true, 'subscribed after add');
		sd.sockets.delete(ws);
		assert(sd.isSubscribed === false, 'unsubscribed after remove');
	});

	await test('SD-10: event emitter on/off/emit', async () =>
	{
		const sd = new SubstreamDuplex();
		const received = [];
		const listener = data => received.push(data);
		sd.on('write', listener);
		sd.write('a');
		sd.write('b');
		sd.off('write', listener);
		sd.write('c');
		sd.close();
		assert(received.length === 2, `expected 2 events, got ${received.length}`);
		assert(received[0] === 'a' && received[1] === 'b', 'event data');
	});

	await test('SD-11: close() clears sockets', async () =>
	{
		const sd = new SubstreamDuplex();
		sd.sockets.add({});
		sd.sockets.add({});
		assert(sd.sockets.size === 2, 'two sockets');
		sd.close();
		assert(sd.sockets.size === 0, 'sockets cleared on close');
	});

	// ═══════════════════════════════════════════════════════════════

	console.log(`\n${passed}/${total} tests passed`);
	if (failures.length) { console.log('Failures:', failures); process.exit(1); }
	process.exit(0);
})();
