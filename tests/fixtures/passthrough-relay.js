// Test fixture: a Passthrough subclass that connects to a remote WebSocket server
// and relays stream data between the parent Worker (IPC) and the remote server (WebSocket)
//
// The test server URL is passed via the RELAY_SERVER_PORT environment variable.
const {Passthrough} = require('../../index.js');
const {bind} = require('helpers');
const port = process.env.RELAY_SERVER_PORT || 19999;
const DEVICES = {
	'testnode': {
		uri: `ws://127.0.0.1:${port}`,
		enforceSSLVerification: false
	}
};
class PassthroughRelay extends Passthrough {
	constructor(devices) {
		super(devices);
		const {node, channel} = this;
		const connection = devices[node];
		const events = {
			ready: () => this.debug('relay connected'),
			connect: () => this.debug('relay connecting')
		};
		const sources = () => channel.connect(connection);
		bind(events).to(this).connect(sources);
	}
}
new PassthroughRelay(DEVICES);
