# SecureChannel

## Node Peer to Peer Communication
Clone this project to your projects folder.  This should create a SecureChannel folder in the current folder.  Assuming you want to use this module from another project that is in its own folder, use the following steps from a command shell to install SecureChannel in your project:
```sh
cd <project>
npm install -S ../SecureChannel
```
You also need to edit the package.json file in your project folder and ensure that it contains something like the following:
```json
{
    "dependencies": {
        "securechannel": "file:../SecureChannel"
    }
}
```
After following the steps above, you can require('securechannel') in your source code just like any module, using the client and server examples below as a template.  You need to serve a certificate chain on the server side, which I place in the ../ssl folder in the included examples.

This assumes your folder structure is something like the following:

> Projects  
> └── SecureChannel  
>  │   │   package.json  
>  │   │   readme.md  
>  │   │   index.js  
>  │   │  
> └── <project>  
>  │   │   package.json  
>  │   │   server.js  
>  │   │   ...  
> └── ssl  
>  │   │   server.crt  
>  │   │   server.key  
>  │   │   lsa-ca.crt  

You can use a different folder structure, but the path specified in the npm install command and in your package.json file must reference the correct path to securechannel.
### Example client.js
```javascript
const LOGGING = true;
const ADDRESS = 'localhost';
const PORT = 8080;
// KEEPALIVE value of client and server needs to agree
const KEEPALIVE = 30; // in seconds
const {SecureChannel, Response} = require('securechannel')

function log(...messages)
{
        LOGGING && console.log(...messages);
}
function response(message)
{
        log(time(), '>', 'response', message);
        return {timestamp:time(), message};
}
function request(query)
{
        log(time(), '<', 'request', query);
        return queue.process(() => this.message('request', {query})).then(result => response(result), error => response(error));
}
const routes = {
        up(event)
        {
                log(event.timestamp, this.SessionID, 'connection up');
                if ('test3' === this.SessionID)
                {
                        request.call(this, 'something');
                        request.call(this, 'something else');
                }
        },
        down(event) {log(event.timestamp, this.SessionID, 'connection down');},
        error(event) {log(event.timestamp, event.reason);},
        heartbeat(event) {log(event.timestamp, this.SessionID, 'heartbeat received');}
};
const connection = {address:ADDRESS, port:PORT, keepalive:KEEPALIVE, enforceSSLVerification:false};
new SecureChannel(routes, 'test1').connect(Object.assign({}, connection, {keepalive:0}));
new SecureChannel(routes, 'test2').connect(connection);
// the server will only allow one socket connection for each named session
// purposely send a prior session id to test disconnection of the old socket on the server side
const channel = new SecureChannel(routes, 'test3').connect(connection);
const queue = new Response(channel);
const time = () => channel.time().toSQL();
```
### Example server.js
```javascript
const KEY = '../../ssl/server.key';
const CERT = '../../ssl/server.crt';
const CA = '../../ssl/lsa-ca.crt';
const ADDRESS = 'localhost';
const PORT = 8080;
// KEEPALIVE value of client and server needs to agree
const KEEPALIVE = 30; // in seconds
const LOGGING = true;
const {readFileSync} = require('fs');
const {SecureChannel} = require('securechannel');

const log = (...messages) => LOGGING && console.log(...messages);
const connected = [];
function list()
{
        connected.push(this.SessionID);
}
function clients()
{
        connected.length = 0;
        channel.sockets(list);
        log({clients:connected});
}
const routes = {
        listening(data) {log(data.address+':'+data.port, 'server listening');},
        open(data)
        {
                log(data.address, 'connection opened');
                clients();
        },
        close(data)
        {
                log(data.address, 'connection closed:', data.reason);
                clients();
        },
        heartbeat(data) {log(data.address, this.SessionID, 'heartbeat received', 'latency:', data.latency);},
        request(data)
        {
                const query = data.query;
                log(data.address, '> request', data.query);
                // replace below with your own processing code
                if ('something' === query)
                {
                        log(data.address, '< result', query);
                        // test success path
                        this.message('result', {result:query});
                }
                else {
                        log(data.address, '< error', query)
                        // test failure path
                        this.message('error', {error:query});
                }
        }
};
const channel = new SecureChannel(routes).listen({address:ADDRESS, port:PORT, keepalive:KEEPALIVE, cert:readFileSync(CERT), key:readFileSync(KEY), ca:readFileSync(CA)});
```
## Node Server to Browser Client Communication
This has been developed and tested for compatibility with Chrome, but it may also work with other browsers without modification.
Use the sample files located under the Browser Client folder to see a fully working example.  The sampleserver.js runs under Node and is installed on a test platform in a fashion identical to the Node Peer to Peer use case, so you can use the same steps to set it up.  You can connect to the sample server by loading sampleclient.htm in a browser (Chrome has been fully tested).
Sampleserver.js listens to a custom TCP port.  Normal operation dictates that you use a reverse proxy to translate requests on port 443 to point to the custom port that the server is listening to.  This effectively translates a request like wss://video:443/archive/websocket to wss://video:3002/websocket.  In this example, "/websocket" would be the value of the path variable, "/archive" would be the virtual path mapped to the custom port through the web proxy, and 3002 would be the custom port the server is listening to.  In practice, you can use any values you want for these variables as long as the proxy and the node server are configured to use the same port number and as long as the client and server are both configured to use the same websocket path string.
