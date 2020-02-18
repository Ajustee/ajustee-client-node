const WebSocket = require('ws');
 
const ws = new WebSocket('ws://www.host.com/path');
 
ws.on('open', function open() {
  	ws.send('something');
});
 
ws.on('message', function incoming(data: any) {
  	console.log(data);
});

ws.send('something');