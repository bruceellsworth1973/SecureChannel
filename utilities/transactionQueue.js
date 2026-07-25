class Queue
{
	// allow reading of queue length
	get length() {return this._actions.length;}
	// add exports to top of queue
	first(...actions) {this._actions.unshift(...actions);}
	// add action to bottom of queue
	defer(...actions) {this._actions.push(...actions);}
	// execute next queued entry
	async next()
	{
		const action = this._actions.shift();
		// if action is a function, it will be executed
		if (action) {await action?.();}
		return this.length;
	}
	async drain() {while (await this.next());}
	// populate new queue with 0 or more exports
	constructor(...actions) {this._actions = [...actions];}
}
class Transaction
{
	response(returnPath)
	{
		return response => {
			// perform housekeeping
			clearTimeout(this._timeout);
			this._dispatcher
				.off(this._prefix + 'result')
				.off(this._prefix + 'error');
			// settle transaction
			returnPath(response);
		};
	}
	// the interfaced Dispatcher object must trigger events with names matching the success and failure paths trapped here
	transact(query, timeout = 0)
	{
		// transactions trap specific message types while allowing other events to stream through unimpeded
		// all transactions expect distinct message types ending in "result" and "error" with an optional global prefix
		const request = (success, failure) => {
			const fail = this.response(failure);
			const successResponse = this.response(success);
			// wrap low-level query in try/catch block in case there is a communication fault
			const sendRequest = () => {
				try {query();}
				catch(error) {fail(error);}
			};
			// fail if timeout fires before expected response
			const elapsed = () => fail('timeout');
			timeout && (this._timeout = setTimeout(elapsed, timeout * 1000));
			// capture success or failure path, whichever occurs first
			this._dispatcher
				.on(this._prefix + 'result', successResponse)
				.on(this._prefix + 'error', fail);
			// initiate query
			sendRequest();
		};
		return new Promise(request);
	}
	// prefix is optional and will be prepended to the trapped event names
	// this allows a single event stream to be multiplexed with other distinct transaction types
	constructor(dispatcher, prefix = '')
	{
		this._timeout = false;
		this._prefix = prefix;
		this._dispatcher = dispatcher;
	}
}
class TransactionQueue extends Queue
{
	async transact(query, prefix = '', timeout = 0)
	{
		if (this._busy)
		{
			// transaction already in progress, so push new transaction on the stack with its own closure
			const onReady = (resolve, reject) => {
				const futureQuery = () => this.transact(query, prefix, timeout).then(resolve, reject);
				this.defer(futureQuery);
			};
			return await new Promise(onReady);
		}
		// wrap transaction with a busy state to perform a blocking request
		this._busy = true;
		const response = await new Transaction(this._dispatcher, prefix).transact(query, timeout);
		this._busy = false;
		this.next();
		return response;
	}
	constructor(dispatcher)
	{
		super();
		this._busy = false;
		this._dispatcher = dispatcher;
	}
}
module.exports = {Queue, Transaction, TransactionQueue};
