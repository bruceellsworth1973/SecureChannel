const KEY = '../../ssl/server.key';
const CERT = '../../ssl/server.crt';
const CA = '../../ssl/lsa-ca.crt';
const ADDRESS = 'localhost';
const PORT = 3002;
// KEEPALIVE value must be 0 for compatibility with browser client implementation
const KEEPALIVE = 0; // in seconds
const LOGGING = true;
const {readFileSync} = require('fs');
const {SecureChannel} = require('securechannel');

const log = (...messages) => LOGGING && console.log(...messages);
const routes = {
	listening(event) {log(event.address+':'+event.port, 'server listening')},
	connect(event) {log(event.address, 'connection opened')},
	down(event) {log(event.address, 'connection closed:', event.reason)},
	request(event)
	{
		const query = event.query;
		log(event.address, '> request', event.query);
		// replace below with your own processing code
		if ('something' === query)
		{
			log(event.address, '< result', query);
			// test success path
			this.message('result', {result:query});
		}
		else {
			log(event.address, '< error', query)
			// test failure path
			this.message('error', {error:query});
		}
	}
};
new SecureChannel(routes).listen({address:ADDRESS, port:PORT, path:'/websocket', keepalive:KEEPALIVE, cert:readFileSync(CERT), key:readFileSync(KEY), ca:readFileSync(CA)});
