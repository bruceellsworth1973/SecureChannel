#!/usr/bin/node
import {AsyncSemaphore, isEmpty, bind, reject, parse, unchain, iterable, KEYS} from 'helpers';
import securechannel from '../index.js';
import {createInterface} from 'readline';
import supportsColor from 'supports-color';
const {URI} = process.env;
const {SecureChannel, Node} = securechannel;
const nsresolution = 1000 * 1000 * 1000;
const escape = '\x1b'
const reset = `${escape}[0m`;
const red = `${escape}[31m`;
const green = `${escape}[32m`
const yellow = `${escape}[33m`;
const blue = `${escape}[34m`;
const colorLog = {
	log: (...messages) => console.log(...messages),
	error: (...messages) => console.error(red, ...messages, reset),
	verbose: (...messages) => console.log(blue, ...messages, reset),
	warn: (...messages) => console.error(yellow, ...messages, reset),
	info: (...messages) => console.info(green, ...messages, reset)
};
const useColor = supportsColor.stdout;
const output = useColor ? colorLog : console;
class ClientConnection extends Node
{
	cache = {}
	_channelEvents = {
		heartbeat:heartbeat => this.cache.heartbeat = heartbeat,
		error:() => this.isReady = this.isReady ? false : reject('connection failed'),
		up:({SessionID}) => this.SessionID || (this.SessionID = SessionID),
		down:() => {
			this.closeChannel();
			this.promptUser();
		},
		message:({type, message}) => {
			//output.verbose('<<', {[type]:message});
			switch (type)
			{
				case 'checkin': return this.onCheckin(message);
				case 'import': return this.onImport(message);
				case 'ready': return this.isReady = true;
				case 'error': return this.onError(message);
				case 'response': return this.response(message);
				case 'data': return this.onData(message);
				//default: return output.verbose(type, iterable(message, KEYS));
			}
		}
	}
	get key()
	{
		const [s, ns] = process.hrtime();
		return s * nsresolution + ns;
	}
	get prompt()
	{
		const arrow = '> ';
		const disconnected = '[disconnected]';
		if (useColor)
		{
			const prompt = this.isConnected ? `${green}${this.remote}@${this.uri}${reset}/${blue}${this.SessionID}${reset}` : `${red}${disconnected}${reset}`;
			return prompt + arrow;
		}
		else
		{
			const prompt = this.isConnected ? `${this.remote}@${this.uri}/${this.SessionID}` : disconnected;
			return prompt + arrow;
		}
	}
	set prompt(_) {this.setPrompt();}
	get isReady() {return this._ready_semaphpore.isOpen;}
	set isReady(ready) {this._ready_semaphpore.status = ready;}
	get onReady() {return this._ready_semaphpore.status;}
	get isConnected() {return this.channel?.isClient;}
	get SessionID() {return this._session_id || '';}
	set SessionID(SessionID)
	{
		this._session_id = SessionID;
		// value doesn't matter here
		// just triggers refresh
		this.prompt = SessionID;
		// inform server of new session token
		this.message('sessionid', {SessionID});
	}
	get uri() {return this._uri || '';}
	set uri(uri)
	{
		this._uri = uri;
		if (uri) {this.prompt = uri;}
		else
		{
			this.cache = {};
			this.SessionID = null;
			this.isReady = false;
		}
	}
	get commands() {return this.cache.commands || [];}
	get types() {return iterable(this.cache, KEYS);}
	get exportsLoaded() {return !isEmpty(this.commands);}
	// overridden by request method
	response = () => {}
	// derive connection values
	parseURI(uri)
	{
		const defaultPort = 443;
		let parts = [];
		let delimiter = ':';
		uri = uri.toLowerCase().replace('wss://', '').replace('ws://', '');
		if (uri.includes(delimiter))
		{
			// uri includes port
			const [address, remainder] = uri.split(delimiter);
			delimiter = '/';
			if (remainder.includes(delimiter))
			{
				// uri includes path
				const [port, path] = remainder.split(delimiter);
				parts = [address, +port, '/' + path];
			}
			else
			{
				// remainder is port
				parts = [address, remainder];
			};
		}
		else
		{
			delimiter = '/';
			if (uri.includes(delimiter))
			{
				// uri includes path
				const [address, path] = uri.split(delimiter);
				parts = [address, defaultPort, '/' + path];
			}
			else
			{
				// uri does not include port or path
				parts = [uri, defaultPort];
			};
		}
		return parts;
	}
	// intercept outbound message
	message(type, message)
	{
		//output.verbose('>>', {[type]:message});
		this.isConnected && this.channel.message(type, message);
	}
	showHelp()
	{
		const help = useColor ?
`${blue}Help:${reset}
${reset}?                        ${reset}- ${yellow}show help${reset}
${reset}open ${blue}<endpoint> <token>  ${reset}- ${yellow}Open connection to endpoint,${reset}
                           ${yellow}where ${blue}<endpoint>${yellow} is in the form of ${reset}wss://${blue}<host>${reset}:${blue}<port>${reset}/${blue}<path>${yellow},${reset}
                           ${blue}<token> ${yellow}is an optional session id,${reset}
                           ${yellow}and both ${blue}<port>${yellow} and ${blue}<path>${yellow} are optional${reset}
                           ${yellow}(port 443 is used by default)${reset}
${reset}close                    ${reset}- ${yellow}Close current connection${reset}
${reset}exit                     ${reset}- ${yellow}Exit program${reset}
${reset}types                    ${reset}- ${yellow}Display published data types${reset}
${reset}show ${blue}<type>              ${reset}- ${yellow}Display state of data ${blue}<type>${reset}
${reset}newsession ${blue}<token>       ${reset}- ${yellow}change session token${reset}
${reset}request ${blue}<command> <args> ${reset}- ${yellow}execute remote command${reset}
                           ${yellow}with optional args in JSON notation${reset}` :
`Help:
?                        - show help
open <endpoint> <token>  - open connection to endpoint,
                           where <endpoint> is in the form of wss://<host>:<port>/<path>,
                           <token> is an optional session id,
                           and both <port> and <path> are optional
	                       (port 443 is used by default)
close                    - close current connection
exit                     - exit program
types                    - display published data types
show <type>              - display state of data <type>
newsession <token>       - change session token
request <command> <args> - execute remote command
                           with optional args in JSON notation`;
		output.log(help);
	}
	showTypes()
	{
		try
		{
			if (isEmpty(this.types)) {throw 'no published data types to display';}
			output.info(this.types);
		}
		catch(error) {output.error(error);}
	}
	showData(type)
	{
		try
		{
			if (!type) {throw 'no data type specifiec';}
			const data = this.cache[type];
			if (!data) {throw 'no data to display';}
			output.info(data);
		}
		catch(error) {output.error(error);}
	}
	request(command, args = {})
	{
		// prepare query
		const {key} = this;
		const request = {command, ...args};
		const captureResult = resolve => this.response = resolve;
		const query = unchain(new Promise(captureResult));
		// commit request
		this.message('request', {key, request});
		return query;
	}
	onImport({exports})
	{
		this.cache.commands = exports;
		this.message('checkin');
		output.verbose('received commands');
	}
	onCheckin({nodes:data})
	{
		try
		{
			if (data)
			{
				const [[remote, nodes]] = iterable(data);
				this.remote = remote;
				this.cache.nodes = nodes;
				this.exportsLoaded ? this.message('checkin') : this.message('exports');
				output.verbose('received nodes');
			}
		}
		catch (error) {output.error(error);}
	}
	onError({error}) {if (!this.isEnding) output.debug(error);}
	onData(data)
	{
		const {type, message} = data;
		this.cache[type] = message;
		output.verbose('received', type);
		if (this.hasPrompt) this.promptUser();
	}
	async openChannel(uri, SessionID)
	{
		if (this.isConnected) {throw 'already connected';}
		const [address, port, path] = this.parseURI(uri);
		this.channel = new SecureChannel(this._channelEvents, SessionID).connect({address, port, path, uri});
		try
		{
			await this.onReady;
			this.uri = uri;
		}
		catch(_) {throw 'connection failed';}
	}
	closeChannel()
	{
		this.channel?.disconnect();
		this.uri = false;
	}
	async handleInput(userInput)
	{
		try
		{
			const parts = userInput.split(' ');
			const command = parts.shift();
			switch (command)
			{
				case '': {return;}
				case '?': return this.showHelp();
				case 'open':
				{
					const uri = parts.shift();
					if (!uri) {throw 'no URI specified';}
					// close existing connection if already open
					if (this.isConnected) {this.closeChannel();}
					const sessionid = parts.shift();
					// attempt connection
					await this.openChannel(uri, sessionid);
					return;
				}
				case 'close':
				{
					if (!this.isConnected) {throw 'not connected';}
					return this.closeChannel();
				}
				case 'exit': {return this.end();}
				case 'types':
				{
					if (!this.isReady) {throw 'not ready';}
					return this.showTypes();
				}
				case 'show':
				{
					if (!this.isReady) {throw 'not ready';}
					const type = parts.shift();
					return this.showData(type);
				}
				case 'newsession':
				{
					if (!this.isReady) {throw 'not ready';}
					const token = parts.shift();
					return this.SessionID = token;
				}
				case 'request':
				{
					if (!this.isReady) {throw 'not ready';}
					const command = parts.shift();
					if (!command) {throw 'no command specified';}
					// combine remainder of line
					let args = parts.join(' ') || '{}';
					try {args = parse(args);}
					catch(_) {throw 'arguments must be supplied in JSON format';}
					const result = await this.request(command, args);
					return output.log(result);
				}
				default: {throw `unknown command "${command}": use ? for help`;}
			}
		}
		catch(error) {output.error(error);}
	}
	showHints = line => {
		if (line.endsWith(' ')) {line = line + escape;}
		const parts = line.split(' ');
		const startsWith = (completions, partial) => completions.filter(completion => completion.startsWith(partial));
		switch (parts.length)
		{
			case 1:
			{
				const commands = this.isReady
					? ['open', 'close', 'newsession', 'types', 'show', 'request', 'exit']
					: ['open'];
				const partial = parts.shift().replace(escape, '');
				const hits = startsWith(commands, partial);
				const hints = hits.length ? hits : commands;
				return [hints, partial];
			}
			case 2:
			{
				const command = parts.shift();
				const partial = parts.shift().replace(escape, '');
				switch (command)
				{
					case 'show':
					{
						if (this.isReady)
						{
							const types = this.types;
							const hits = startsWith(types, partial);
							const hints = hits.length ? hits : types;
							return [hints, partial];
						}
						break;
					}
					case 'request':
					{
						if (this.isReady)
						{
							const commands = this.commands;
							const hits = startsWith(commands, partial);
							const hints = hits.length ? hits : commands;
							return [hints, partial];
						}
						break;
					}
					case 'open':
					{
						// no hints for port
						if (partial.includes(':')) {break;}
						// common hints for address
						else
						{
							const addresses = isEmpty(partial)
								? ['127.0.0.1']
								: ['127.0.0.1', 'localhost'];
							const hits = startsWith(addresses, partial);
							const hints = hits.length ? hits : addresses;
							return [hints, partial];
						}
					}
				}
			}
		}
		return [];
	}
	startMainLoop()
	{
		this.endMainLoop = () => {
			UI.close();
			process.stdin.unref();
		};
		const line = async userInput => {
			//UI.pause();
			this.hasPrompt = false;
			await this.handleInput(userInput);
			this.promptUser();
			this.hasPrompt = true;
			//UI.resume();
		};
		const SIGINT = () => this.destroy('^C');
		const {stdin, stdout} = process;
		const options = {
			input:stdin,
			output:stdout,
			prompt:this.prompt,
			completer:this.showHints
		};
		const UI = bind({line, SIGINT}).to(createInterface(options));
		output.verbose('? = help');
		this.setPrompt = () => UI.setPrompt(this.prompt);
		this.promptUser = () => UI.prompt();
		this.promptUser();
	}
	async initializeConnection(uri)
	{
		try {await this.openChannel(uri);}
		catch(error) {output.error(error);}
		this.startMainLoop();
	}
	end()
	{
		this.isEnding = true;
		this.endMainLoop();
		this.closeChannel();
	}
	destroy(message)
	{
		message && output.warn(message || '');
		this.end();
		process.exit();
	}
	constructor(uri)
	{
		super();
		this._ready_semaphpore = new AsyncSemaphore(false);
		// open connection immediately if uri is defined in the environment
		if (uri) {this.initializeConnection(uri);}
		// else just start the main loop
		else {this.startMainLoop();}
	}
}
new ClientConnection(URI);
