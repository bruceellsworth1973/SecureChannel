const {SERVER_ADDRESS} = require('./config.js');
const timestamp = () => new Date().toISOString();
class Logger
{
	constructor(types = ['info', 'warn', 'telemetry', 'debug', 'verbose', 'error'])
	{
		return (type, message, meta = {}) => {
			const { source, address, ...rest } = meta;
			types.includes(type) && console.log(`[${type.toUpperCase()}]`, timestamp(), `${address || SERVER_ADDRESS}:${source} | ${message} |`, rest);
		}
	}
}
module.exports = {Logger};
