const {isObject, iterable} = require('helpers');
class CachedData
{
	collector(type, overwrite, dedup, publishStatus, publishPayload, nodeInData, onData)
	{
		const formPath = node => [type, node];
		const ingestData = (driver, path, payload, socket) => {
			const [type, node] = path;
			driver.cache(path, payload, overwrite);
			publishStatus && socket.data('status', {[node]:type});
			publishPayload && socket.data(type, {[node]:payload});
			// uses local onData method  from subclass or falls back to passed onData to allow seamless observation
			const callback = this.onData || onData;
			callback && callback?.call(driver, payload, node, socket);
		};
		const dedupType = diff => {
			if (nodeInData)
			{
				// ignores passed node name in favor of dynamic node from data source
				return function(data, node, socket)
				{
					let changed = false;
					if (isObject(data))
					{
						const nodes = iterable(data);
						for (const [node, payload] of nodes)
						{
							const path = formPath(node);
							if (diff(this.cache(path), payload))
							{
								ingestData(this, path, payload, socket);
								// suppress publishDataStream if publishPayload is true
								changed = !publishPayload;
							}
						}
					}
					return changed;
				}
			}
			else
			{
				return function(data, node, socket)
				{
					const path = formPath(node);
					if (diff(this.cache(path), data))
					{
						ingestData(this, path, data, socket);
						// suppress publishDataStream if publishPayload is true
						return !publishPayload;
					}
					return false;
				}
			}
		};
		const passType = () => {
			if (nodeInData)
			{
				return function(data, node, socket)
				{
					if (isObject(data))
					{
						const nodes = iterable(data);
						for (const [node, payload] of nodes)
						{
							const path = formPath(node);
							ingestData(this, path, payload, socket);
						}
						// suppress publishDataStream if publishPayload is true
						return !publishPayload;
					}
					return false;
				}
			}
			else
			{
				return function(data, node, socket)
				{
					const path = formPath(node);
					ingestData(this, path, data, socket);
					// suppress publishDataStream if publishPayload is true
					return !publishPayload;
				}
			}
		};
		return dedup ? dedupType(require('deep-diff')) : passType();
	}
	emitter(type, nodeInData, publishDataType)
	{
		if (nodeInData)
		{
			if (publishDataType)
			{
				// this algorithm emits state for all nodes of the same type when any node receives an update
				return function(_, socket)
				{
					const {controller, domain} = this;
					const path = [domain, type];
					const data = controller.cache(path);
					// publish one or more incoming source types under a fixed output type, and embed the source type in the published data
					socket.data(publishDataType, {[type]:data});
				}
			}
			else
			{
				// this algorithm emits state for all nodes of the same type when any node receives an update
				return function(_, socket)
				{
					const {controller, domain} = this;
					const path = [domain, type];
					const data = controller.cache(path);
					socket.data(type, data);
				}
			}
		}
		else
		{
			// this algorithm only emits state for a singular node when each receives an update
			return function(data, socket) {socket.data(type, data);}
		}
	}
	constructor(type, {overwrite = false, dedup = false, publishStatus = false, publishPayload = false, publishDataStream = false, nodeInData = false, onData = false, publishDatatype = false})
	{
		const source = {};
		const sink = {};
		source[type] = this.collector(type, overwrite, dedup, publishStatus, publishPayload, nodeInData, onData);
		if (publishDataStream) {sink[type] = this.emitter(type, nodeInData, publishDatatype);}
		return {source, sink};
	}
}
module.exports = {CachedData};
