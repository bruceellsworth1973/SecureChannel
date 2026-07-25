const {SecureChannel} = require('../index.js');
const {BinaryFrame} = require('../utilities/substreamDuplex.js');
const WebSocket = require('ws');

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

function createJsonPair()
{
	return new Promise(resolve =>
	{
		const serverChannel = new SecureChannel();
		let serverWs;
		const wss = new WebSocket.Server({port: 0}, () =>
		{
			const {port} = wss.address();
			wss.on('connection', ws =>
			{
				serverWs = ws;
				const methods = serverChannel._socketMethods;
				Object.assign(serverWs, {
					isActive() { return this.readyState === WebSocket.OPEN; },
					onMessage: methods.onMessage,
					message: (type, message) => serverChannel.message(type, message, serverWs),
					data: (type, message) => serverWs.message('data', {type, message})
				});
				serverWs.on('message', message =>
				{
					methods.onMessage.call(serverWs, message, '127.0.0.1');
				});
				if (clientWs && clientWs.readyState === WebSocket.OPEN) resolve({serverChannel, serverWs, clientWs, wss});
			});
			const clientWs = new WebSocket(`ws://127.0.0.1:${port}`);
			clientWs.on('open', () =>
			{
				if (serverWs) resolve({serverChannel, serverWs, clientWs, wss});
			});
		});
	});
}

async function cleanup(pair)
{
	pair.clientWs.close();
	pair.wss.close();
	await new Promise(r => setTimeout(r, 50));
}

(async () =>
{
	console.log('\n=== SC3 JSON Regression Tests ===\n');

	await test('SecureChannel constructor initializes correctly', async () =>
	{
		const ch = new SecureChannel();
		assert(ch.streamIndex.streams instanceof Map, 'streamIndex.streams is a Map');
		assert(typeof ch.on === 'function', 'on method');
		assert(typeof ch.off === 'function', 'off method');
		assert(typeof ch.send === 'function', 'send method');
		assert(typeof ch.message === 'function', 'message method');
		assert(typeof ch.sendBinary === 'function', 'sendBinary method');
		assert(typeof ch.registerStream === 'function', 'registerStream method');
		assert(typeof ch.unregisterStream === 'function', 'unregisterStream method');
	});

	await test('SecureChannel constructor with routes registers handlers', async () =>
	{
		let received = false;
		const ch = new SecureChannel({testevent: () => { received = true; }});
		ch.emit('testevent', {});
		assert(received, 'route handler fired');
	});

	await test('SecureChannel.send transmits JSON over ws', async () =>
	{
		const pair = await createJsonPair();
		const received = new Promise(resolve =>
		{
			pair.clientWs.on('message', data =>
			{
				const parsed = JSON.parse(data.toString());
				resolve(parsed);
			});
		});
		pair.serverChannel.send({type: 'hello', message: {value: 42}}, pair.serverWs);
		const result = await Promise.race([received, new Promise((_, rej) => setTimeout(() => rej('timeout'), 2000))]);
		assert(result.type === 'hello', 'type preserved');
		assert(result.message.value === 42, 'message preserved');
		await cleanup(pair);
	});

	await test('SecureChannel.message wraps in type/message envelope', async () =>
	{
		const pair = await createJsonPair();
		const received = new Promise(resolve =>
		{
			pair.clientWs.on('message', data =>
			{
				const parsed = JSON.parse(data.toString());
				resolve(parsed);
			});
		});
		pair.serverChannel.message('testtype', {key: 'val'}, pair.serverWs);
		const result = await Promise.race([received, new Promise((_, rej) => setTimeout(() => rej('timeout'), 2000))]);
		assert(result.type === 'testtype', 'type is testtype');
		assert(result.message.key === 'val', 'message.key preserved');
		await cleanup(pair);
	});

	await test('dispatcher routes events to registered handlers', async () =>
	{
		let eventData = null;
		const ch = new SecureChannel();
		ch.on('myevent', data => { eventData = data; });
		ch.emit('myevent', {foo: 'bar'});
		assert(eventData !== null, 'handler fired');
		assert(eventData.foo === 'bar', 'data passed through');
	});

	await test('dispatcher.off removes handler', async () =>
	{
		let callCount = 0;
		const ch = new SecureChannel();
		ch.on('counted', () => { callCount++; });
		ch.emit('counted', {});
		assert(callCount === 1, 'fired once');
		ch.off('counted');
		ch.emit('counted', {});
		assert(callCount === 1, 'not fired after off');
	});

	await test('JSON onMessage parses and dispatches to channel events', async () =>
	{
		const pair = await createJsonPair();
		let dispatched = null;
		pair.serverChannel.on('customtype', data => { dispatched = data; });
		pair.clientWs.send(JSON.stringify({type: 'customtype', message: {payload: 'test'}}));
		await new Promise(r => setTimeout(r, 200));
		assert(dispatched !== null, 'event dispatched');
		assert(dispatched.payload === 'test', 'payload intact');
		await cleanup(pair);
	});

	await test('JSON traffic works alongside open stream', async () =>
	{
		const pair = await createJsonPair();
		pair.serverChannel.registerStream(1);
		assert(pair.serverChannel.streamIndex.has(1), 'stream registered');
		let jsonReceived = null;
		pair.serverChannel.on('jsontest', data => { jsonReceived = data; });
		pair.clientWs.send(JSON.stringify({type: 'jsontest', message: {x: 99}}));
		await new Promise(r => setTimeout(r, 200));
		assert(jsonReceived !== null, 'JSON still dispatched with stream present');
		assert(jsonReceived.x === 99, 'JSON data intact');
		await cleanup(pair);
	});

	await test('send with no ws target does not throw when ws is inactive', async () =>
	{
		const ch = new SecureChannel();
		let threw = false;
		try { ch.send({type: 'test', message: {}}); }
		catch(_) { threw = true; }
		assert(!threw, 'no throw when ws is undefined/inactive');
	});

	await test('clientName is stored and accessible', async () =>
	{
		const ch = new SecureChannel({}, 'myClient');
		assert(ch.clientName === 'myClient', 'clientName set');
	});

	await test('multiple SecureChannel instances are independent', async () =>
	{
		const ch1 = new SecureChannel();
		const ch2 = new SecureChannel();
		ch1.registerStream('alpha');
		ch2.registerStream('beta');
		assert(!ch1.streamIndex.has('beta'), 'ch1 does not have ch2 stream');
		assert(!ch2.streamIndex.has('alpha'), 'ch2 does not have ch1 stream');
	});

	await test('frame constants accessible alongside JSON channel operations', async () =>
	{
		const pair = await createJsonPair();
		assert(BinaryFrame.sentinel === 0xFE, 'sentinel constant');
		assert(BinaryFrame.data === 0x01, 'data constant');
		assert(BinaryFrame.close === 0x03, 'close constant');
		pair.serverChannel.registerStream(BinaryFrame.data);
		assert(pair.serverChannel.streamIndex.has(BinaryFrame.data), 'stream registered using frame constant as streamId');
		let jsonOk = false;
		pair.serverChannel.on('ping', () => { jsonOk = true; });
		pair.clientWs.send(JSON.stringify({type: 'ping', message: {}}));
		await new Promise(r => setTimeout(r, 200));
		assert(jsonOk, 'JSON dispatch still works with stream registered via frame constant');
		await cleanup(pair);
	});

	console.log(`\n${passed}/${total} tests passed`);
	if (failures.length) { console.log('Failures:', failures); process.exit(1); }
	process.exit(0);
})();
