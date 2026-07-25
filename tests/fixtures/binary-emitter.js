// Test fixture: a minimal script that emits and receives stream data via IPC
// Spawned as a Worker child process by the binary-relay test suite
//
// Uses the streamData/streamEnd/streamError IPC message types
// which dispatch through the Worker's _NodeEvents pipeline.

// Handshake
process.send({type: 'checkin', message: {nodes: {}}});

const received = [];

process.on('message', event => {
	if (!event || typeof event !== 'object') return;
	const {type, message} = event;
	if (type === 'streamData')
	{
		received.push(message);
		process.send({type: 'streamData', message: {
			streamId: message.streamId,
			data: {echo: message.data, received: received.length}
		}});
		return;
	}
	if (type === 'start')
	{
		const {streamId, chunks} = message;
		process.send({type: 'stream', message: {action: 'open', streamId, metadata: {}}});
		for (const chunk of (chunks || []))
		{
			process.send({type: 'streamData', message: {streamId, data: chunk}});
		}
		process.send({type: 'streamEnd', message: {streamId}});
		return;
	}
	if (type === 'query')
	{
		process.send({type: '__query_result__', message: {count: received.length, items: received}});
		return;
	}
	if (type === 'startNoClose')
	{
		const {streamId, chunks} = message;
		process.send({type: 'stream', message: {action: 'open', streamId, metadata: {}}});
		for (const chunk of (chunks || []))
		{
			process.send({type: 'streamData', message: {streamId, data: chunk}});
		}
		return;
	}
	if (type === 'exit') process.exit(0);
});

process.send({type: 'ready', message: {}});
