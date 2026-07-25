const getClientAddress = ({headers, socket}) => {
	const forwarded = headers['x-forwarded-for'];
	if (forwarded)
	{
		// grab first address from forwarded header
		const [address] = forwarded.split(/\s*,\s*/);
		// strip ephemeral port added by some proxies
		return address.split(':')[0];
	}
	// not forwarded, so use remote address
	return socket.remoteAddress;
};
module.exports = {getClientAddress};
