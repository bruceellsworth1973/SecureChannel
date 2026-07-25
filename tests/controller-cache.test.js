const {Controller} = require('../index.js');
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
function assertEqual(actual, expected, message)
{
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a !== e) throw new Error(`${message || 'Not equal'}: expected ${e}, got ${a}`);
}
function createController()
{
	const controller = new Controller({}, null, 0);
	return controller;
}
(async () => {
	await test('cache(path) creates placeholder and returns empty object', () => {
		const controller = createController();
		const result = controller.cache(['domain', 'type']);
		assertEqual(result, {}, 'placeholder should be empty object');
	});
	await test('cache(path, value) sets value at path', () => {
		const controller = createController();
		controller.cache(['domain', 'type', 'node'], {name: 'test'});
		const result = controller.cache(['domain', 'type', 'node']);
		assertEqual(result, {name: 'test'});
	});
	await test('cache(path, value) merges by default', () => {
		const controller = createController();
		controller.cache(['domain', 'type', 'node'], {a: 1});
		controller.cache(['domain', 'type', 'node'], {b: 2});
		const result = controller.cache(['domain', 'type', 'node']);
		assertEqual(result, {a: 1, b: 2});
	});
	await test('cache(path, value, true) overwrites with overwrite flag', () => {
		const controller = createController();
		controller.cache(['domain', 'type', 'node'], {a: 1});
		controller.cache(['domain', 'type', 'node'], {b: 2}, true);
		const result = controller.cache(['domain', 'type', 'node']);
		assertEqual(result, {b: 2});
	});
	await test('cache(path, null) preserves an existing value and its siblings', () => {
		const controller = createController();
		controller.cache(['domain', 'type', 'node1'], {name: 'first'});
		controller.cache(['domain', 'type', 'node2'], {name: 'second'});
		controller.cache(['domain', 'type', 'node1'], null);
		const parent = controller.cache(['domain', 'type']);
		assertEqual(parent.node1, {name: 'first'}, 'node1 should be preserved');
		assertEqual(parent.node2, {name: 'second'}, 'node2 should remain');
	});
	await test('cache(path, null) leaves sibling paths intact', () => {
		const controller = createController();
		controller.cache(['domain', 'typeA', 'node'], {a: 1});
		controller.cache(['domain', 'typeB', 'node'], {b: 2});
		controller.cache(['domain', 'typeA', 'node'], null);
		const typeA = controller.cache(['domain', 'typeA']);
		const typeB = controller.cache(['domain', 'typeB']);
		assertEqual(typeA.node, {a: 1}, 'typeA node should be preserved');
		assertEqual(typeB.node, {b: 2}, 'typeB node should remain');
	});
	await test('cache(path, null) writes null at a previously absent leaf', () => {
		const controller = createController();
		controller.cache(['domain', 'type', 'node'], {name: 'test'});
		controller.cache(['domain', 'type', 'nonexistent'], null);
		const parent = controller.cache(['domain', 'type']);
		assertEqual(parent.node, {name: 'test'}, 'existing node should remain');
		assert(parent.nonexistent === null, 'absent leaf is created holding null');
	});
	await test('cache(path, null) creates the parent path with a null leaf', () => {
		const controller = createController();
		controller.cache(['nonexistent', 'path', 'node'], null);
		const root = controller.cache([]);
		assert('nonexistent' in root, 'parent path should be created');
		assert(root.nonexistent.path.node === null, 'leaf is created holding null');
	});
	await test('cache(path, null) does not clear an existing value on read-back', () => {
		const controller = createController();
		controller.cache(['domain', 'type', 'node'], {name: 'test'});
		controller.cache(['domain', 'type', 'node'], null);
		const result = controller.cache(['domain', 'type', 'node']);
		assertEqual(result, {name: 'test'}, 'null does not clear an existing value');
	});
	await test('cache with undefined value creates placeholder (getter mode)', () => {
		const controller = createController();
		const result = controller.cache(['new', 'path']);
		assertEqual(result, {});
		const parent = controller.cache(['new']);
		assert('path' in parent, 'path key should exist');
	});
	await test('cache(path, data) then cache(path, null) then cache(path, newData) works correctly', () => {
		const controller = createController();
		controller.cache(['domain', 'type', 'node'], {version: 1});
		controller.cache(['domain', 'type', 'node'], null);
		controller.cache(['domain', 'type', 'node'], {version: 2});
		const result = controller.cache(['domain', 'type', 'node']);
		assertEqual(result, {version: 2});
	});
	console.log(`\n${passed}/${total} tests passed`);
	if (failures.length) {console.log('Failures:', failures); process.exit(1);}
})();
