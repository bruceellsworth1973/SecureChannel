const {AsyncFanout} = require('../utilities/substreamDuplex.js');

function runTests()
{
	let passed = 0;
	let total = 0;
	const results = [];
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
			results.push(description);
		}
	}
	function assert(condition, message = 'Assertion failed')
	{
		if (!condition) throw new Error(message);
	}
	function assertDeepEqual(actual, expected, message)
	{
		const a = JSON.stringify(actual);
		const e = JSON.stringify(expected);
		assert(a === e, message || `Expected ${e}, got ${a}`);
	}
	async function collect(iterator)
	{
		const out = [];
		for await (const v of iterator) out.push(v);
		return out;
	}

	return (async () =>
	{
		console.log('\n=== AsyncFanout Tests ===\n');

		await test('single consumer receives all chunks', async () =>
		{
			const fanout = new AsyncFanout();
			const c = fanout.consumer();
			fanout.write(1); fanout.write(2); fanout.write(3);
			fanout.end();
			assertDeepEqual(await collect(c), [1, 2, 3]);
		});

		await test('multiple consumers receive identical sequences', async () =>
		{
			const fanout = new AsyncFanout();
			const c1 = fanout.consumer();
			const c2 = fanout.consumer();
			const c3 = fanout.consumer();
			fanout.write('a'); fanout.write('b'); fanout.write('c');
			fanout.end();
			const [r1, r2, r3] = await Promise.all([collect(c1), collect(c2), collect(c3)]);
			assertDeepEqual(r1, ['a', 'b', 'c']);
			assertDeepEqual(r2, ['a', 'b', 'c']);
			assertDeepEqual(r3, ['a', 'b', 'c']);
		});

		await test('end terminates all consumers', async () =>
		{
			const fanout = new AsyncFanout();
			const c1 = fanout.consumer();
			const c2 = fanout.consumer();
			fanout.write(10);
			fanout.end();
			const [r1, r2] = await Promise.all([collect(c1), collect(c2)]);
			assertDeepEqual(r1, [10]);
			assertDeepEqual(r2, [10]);
			const next1 = await c1.next();
			assert(next1.done === true, 'Consumer 1 should be done after end');
			const next2 = await c2.next();
			assert(next2.done === true, 'Consumer 2 should be done after end');
		});

		await test('late consumer receives only chunks from join point forward', async () =>
		{
			const fanout = new AsyncFanout();
			const early = fanout.consumer();
			fanout.write(1); fanout.write(2);
			const late = fanout.consumer();
			fanout.write(3);
			fanout.end();
			assertDeepEqual(await collect(early), [1, 2, 3]);
			assertDeepEqual(await collect(late), [3]);
		});

		await test('early-stop consumer does not affect other consumers', async () =>
		{
			const fanout = new AsyncFanout();
			const quitter = fanout.consumer();
			const stayer = fanout.consumer();
			const quitterResults = [];
			const quitterDone = (async () =>
			{
				for await (const v of quitter)
				{
					quitterResults.push(v);
					if (v === 2) break;
				}
			})();
			fanout.write(1); fanout.write(2); fanout.write(3); fanout.write(4); fanout.write(5);
			fanout.end();
			const stayerResults = await collect(stayer);
			await quitterDone;
			assertDeepEqual(quitterResults, [1, 2]);
			assertDeepEqual(stayerResults, [1, 2, 3, 4, 5]);
		});

		await test('works with Buffer chunks', async () =>
		{
			const fanout = new AsyncFanout();
			const c1 = fanout.consumer();
			const c2 = fanout.consumer();
			fanout.write(Buffer.from('hello'));
			fanout.write(Buffer.from('world'));
			fanout.end();
			const [r1, r2] = await Promise.all([collect(c1), collect(c2)]);
			assert(r1.length === 2, 'Consumer 1 should get 2 buffers');
			assert(r2.length === 2, 'Consumer 2 should get 2 buffers');
			assert(Buffer.isBuffer(r1[0]), 'Chunks should be Buffer instances');
			assert(r1[0].toString() === 'hello', 'First chunk should be "hello"');
			assert(r1[1].toString() === 'world', 'Second chunk should be "world"');
		});

		await test('empty fanout produces empty consumer', async () =>
		{
			const fanout = new AsyncFanout();
			const c = fanout.consumer();
			fanout.end();
			assertDeepEqual(await collect(c), []);
		});

		await test('fail propagates error to all consumers', async () =>
		{
			const fanout = new AsyncFanout();
			const c1 = fanout.consumer();
			const c2 = fanout.consumer();
			fanout.write(1);
			fanout.fail(new Error('source failed'));
			let err1 = null, err2 = null;
			try {await collect(c1);} catch (e) {err1 = e;}
			try {await collect(c2);} catch (e) {err2 = e;}
			assert(err1 !== null, 'Consumer 1 should receive the error');
			assert(err1.message === 'source failed', `Consumer 1 error: ${err1.message}`);
			assert(err2 !== null, 'Consumer 2 should receive the error');
			assert(err2.message === 'source failed', `Consumer 2 error: ${err2.message}`);
		});

		await test('writes after end are ignored', async () =>
		{
			const fanout = new AsyncFanout();
			const c = fanout.consumer();
			fanout.write(1);
			fanout.end();
			fanout.write(2);
			assertDeepEqual(await collect(c), [1]);
		});

		await test('consumer detach cleans up from consumers set', async () =>
		{
			const fanout = new AsyncFanout();
			const c = fanout.consumer();
			assert(fanout.consumers.size === 1, 'should have 1 consumer');
			await c.return();
			assert(fanout.consumers.size === 0, 'should have 0 consumers after return');
		});

		console.log(`\n${passed}/${total} tests passed`);
		if (results.length) {console.log('Failures:', results); process.exit(1);}
	})();
}
runTests();
