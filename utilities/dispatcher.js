const {isFunction, isFalse, iterable} = require('helpers');
const {Transaction} = require('./transactionQueue.js');
class Dispatcher
{
	_parsers = []
	_callbacks = {}
	log(type, message) {this.context?.logger?.(type, message);}
	// default parser
	sink = source => {
		// propagate unprocessed messages using generic data event
		source && this.emit('data', source);
		return false;
	}
	// specify custom message parser
	// parser priority is the inverse of the order in which it is added to the chain
	// therefore, the highest priority parser should be added last
	use(parser)
	{
		if (isFunction(parser)) {this._parsers.unshift(parser);}
		return this;
	}
	reduce(message)
	{
		// custom reduce function that aborts processing on conditional match
		for (const parser of this._parsers)
		{
			if (isFalse(message)) {break;}
			message = parser(message);
		}
		return this;
	}
	transact(query, prefix = '', timeout = 0) {return new Transaction(this, prefix).transact(query, timeout);}
	// execute event listener, if present
	trigger = (type, message, socket) => {
		// can trigger on a specific context when provided or fallback to the default context
		const context = socket || this.context;
		try
		{
			if (type)
			{
				const callback = this._callbacks[type];
				if (isFunction(callback))
				{
					callback.call(context, message);
					return true;
				}
				throw `no listener for ${type} event`;
			}
			throw 'unknown type for payload: ' + message;
		}
		catch(error)
		{
			this.log('debug', error);
			return false;
		}
	}
	// alias for the trigger method to closely match the standard EventEmitter API
	emit = this.trigger
	// untrap event type
	off = (type) => {
		if (type in this._callbacks) delete this._callbacks[type];
		return this;
	}
	// trap event type
	on = (type, callback) => {
		this._callbacks[type] = callback;
		return this;
	}
	// trap all events defined in events object properties
	// this deviates from the standard "bind" helper method
	// since it does not bind the listener context to the dispatcher object
	// instead it calls each listener using the context provided in the constructor
	bind(events)
	{
		for (const [type, listener] of iterable(events)) {this.on(type, listener);}
		return this;
	}
	constructor(events = {}, context)
	{
		this.context = context || null;
		this.use(this.sink);
		this.bind(events);
	}
}
module.exports = {Dispatcher};
