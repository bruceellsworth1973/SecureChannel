const {isString, bind} = require('helpers');
const {Dispatcher} = require('./dispatcher.js');
class SystemCommand extends Dispatcher
{
	progress = progress => this.emit('progress', progress)
	get output()
	{
		const whenFinished = (resolve, reject) => {
			const exit = () => {
				this.emit('ended');
				resolve('done');
			};
			const error = error => {
				this.emit('ended');
				reject(error);
			};
			bind({exit, error}).to(this._process);
		};
		const resetProgress = () => this.progress(null);
		return new Promise(whenFinished).finally(resetProgress);
	}
	abort() {this._process.kill();}
	// signal is a standard AbortSignal instance or undefined
	constructor(command, args, cwd, signal)
	{
		super();
		if (signal)
		{
			if (signal.aborted) {return this;}
			const abortConnection = () => this.abort();
			signal.addEventListener('abort', abortConnection, {once: true});
		}
		if (isString(args)) {args = args.split(' ');}
		const {spawn} = require('child_process');
		this._process = cwd ? spawn(command, args, {cwd}) : spawn(command, args);
		const data = data => this.emit('data', data);
		bind({data}).to(this._process.stdout);
	}
}
module.exports = {SystemCommand};
