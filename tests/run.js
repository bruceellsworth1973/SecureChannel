const {readdirSync} = require('fs');
const {join} = require('path');
const {execSync} = require('child_process');
const dir = __dirname;
const tests = readdirSync(dir).filter(f => f.endsWith('.test.js') || f.endsWith('.test.mjs')).sort();
let failed = false;
for (const file of tests)
{
	try { execSync(`node ${join(dir, file)}`, {stdio: 'inherit'}); }
	catch(_) { failed = true; }
}
process.exit(failed ? 1 : 0);
