const {isEqual, toLowerCase, assign, initKey, inject, iterable, KEYS} = require('helpers');
class ExpressMiddleware
{
	static secureChannel({url}, {headersSent}, next)
	{
		if (url.includes('securechannel') || headersSent) {return;}
		next();
	}
	static injectToken(req, _, next)
	{
		const {headers} = req;
		const {getClientAddress} = require('./clientAddress.js');
		const address = getClientAddress(req);
		// check for authorization header
		const authHeader = headers['authorization'];
		const [type, value] = authHeader ? authHeader.trim().split(' ') : [];
		// check for bearer token
		const token = isEqual(toLowerCase(type), 'bearer') ? value + '@' + address : '@' + address;
		const timestamp = new Date().toISOString();
		assign({token, telemetry:{address, timestamp}}).to(req);
		next();
	}
	static noRoute = ({url}, res) => {
		const status = 404;
		const message = {error:'resource not found'};
		if (!url.includes('securechannel') && !res.headersSent) {res.status(status).json(message);}
	}
	static getStatus = (controller, getUserSessions) => async (_, res) => {
		const {state, channels} = controller;
		const response = {...state};
		try
		{
			// the inner function is run against each websocket context by the channel.sockets method
			const captureMetadata = sessions => function() {
				const {SessionID, Address, Latency} = this;
				sessions.push({SessionID, Address, Latency});
			};
			const getChanneldata = server => resolve => {
				const sessions = [];
				server.sockets(captureMetadata(sessions));
				resolve(sessions);
			};
			const getServerConnection = (acc, id) => {
				const {connection} = controller.channels[id];
				const {port, address, path, keepalive} = connection;
				const url = `${address}:${port || ''}${path || ''}`;
				return {...acc, [id]:{url, keepalive}};
			};
			response.channels = iterable(channels, KEYS).reduce(getServerConnection, {});
			response.sessions = {};
			for (const [id, server] of iterable(channels))
			{
				for (const {SessionID, Address, Latency} of await new Promise(getChanneldata(server)))
				{
					const socket = inject(response.sessions, SessionID, {address:Address, user:null, accessed:null});
					initKey(socket[SessionID], 'latency');
					socket[SessionID].latency[id] = Latency || null;
				}
			}
			if (getUserSessions)
			{
				const userSessions = await getUserSessions?.call(controller);
				for (const {sessionid, user, accessed} of userSessions)
				{
					const session = response.sessions[sessionid];
					if (session) {assign({user, accessed}).to(session);}
				}
			}
			res.json(response);
		}
		catch(error) {res.status(503).json({error});}
	}
}
module.exports = {ExpressMiddleware};
