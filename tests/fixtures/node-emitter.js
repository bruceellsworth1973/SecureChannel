// Test fixture: a Node driver booted in-process by the emulator (ChildInterface.fork).
// The emulator injects a ProcessInterface as the child's process; the Node talks to the
// parent only across that interface, exactly as a forked child would over real IPC.
const {Node} = require('securechannel');
const devices = {'testnode': {}};
class NodeEmitter extends Node {
	constructor(devices, iface) {
		super(devices, undefined, iface);
		this.connect(() => {
			this.on('startStream', ({streamId, chunks, close}) => {
				const stream = this.openStream(streamId);
				for (const chunk of (chunks || [])) stream.write(chunk);
				if (close) this.closeStream(streamId);
			});
			this.on('echoStream', ({streamId}) => {
				const stream = this.openStream(streamId);
				const echo = async () => { for await (const chunk of stream.collator) stream.write(chunk); };
				echo();
			});
			this.ready();
		});
	}
}
// Boot-function export for the in-process emulator (ChildInterface.fork passes a ProcessInterface).
module.exports = iface => new NodeEmitter(devices, iface);
// Self-instantiate when launched as a real forked child process (Worker.start), where process is the IPC interface.
if (require.main === module) new NodeEmitter(devices);
