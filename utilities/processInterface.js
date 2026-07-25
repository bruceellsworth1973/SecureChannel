const {EventEmitter} = require('events');
const {PassThrough} = require('stream');
// in-process emulation of the fork() IPC contract: a driver written against the
// Node/Passthrough process interface runs inside the parent process, exchanging
// frames with its peer over paired emitters instead of a serialized IPC channel
class ProcessInterface extends EventEmitter
{
	connected = true;
	exit() {this.peer.emit('close');}
	send(frame) {this.peer.emit('message', frame);}
	constructor(child, driver, argv)
	{
		super();
		this.argv = argv;
		this.stdin = child.stdin;
		this.stdout = child.stdout;
		this.stderr = child.stderr;
		this.peer = child;
		child.peer = this;
		child.connected = true;
		setImmediate(() => new driver(this));
	}
}
class ChildInterface
{
	static fork(driver, args = [])
	{
		class Child extends EventEmitter
		{
			peer = null;
			connected = false;
			stdin = new PassThrough();
			stdout = new PassThrough();
			stderr = new PassThrough();
			send(frame) {this.peer.emit('message', frame);}
		}
		const child = new Child();
		const argv = [process.argv[0], driver.name, ...args];
		new ProcessInterface(child, driver, argv);
		return child;
	}
}
module.exports = {ProcessInterface, ChildInterface};
