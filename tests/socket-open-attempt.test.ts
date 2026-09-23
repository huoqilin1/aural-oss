import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:http';
import {once} from 'node:events';
import WebSocket,{WebSocketServer} from 'ws';
import {socketOpenAttempt} from '../server/socket-open-attempt';

test('cancelling a real pending websocket settles promptly without opening it later',async()=>{
  const server=createServer();
  server.on('upgrade',(_request,socket)=>{socket.on('error',()=>{});});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const port=(server.address() as {port:number}).port;
  const socket=new WebSocket(`ws://127.0.0.1:${port}`);
  const closed=once(socket,'close');
  const attempt=socketOpenAttempt(socket,1000);
  attempt.cancel();
  await assert.rejects(attempt.promise,/cancelled/);
  // events.once rejects on the expected ws cancellation error; the socket's
  // close still follows. Listen directly to avoid treating it as a test crash.
  await closed.catch(()=>{});
  socket.terminate();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));
});
test('a real connection opens and its completed attempt cannot close it',async()=>{
  const server=new WebSocketServer({host:'127.0.0.1',port:0});
  await once(server,'listening');
  const socket=new WebSocket(`ws://127.0.0.1:${(server.address() as {port:number}).port}`);
  const attempt=socketOpenAttempt(socket,1000);
  await attempt.promise;attempt.cancel();assert.equal(socket.readyState,WebSocket.OPEN);
  socket.terminate();server.clients.forEach(peer=>peer.terminate());
  await new Promise<void>(r=>server.close(()=>r()));
});
test('upstream rejection is reported without retaining the provider response body',async()=>{
  const server=createServer((_req,res)=>{res.writeHead(403);res.end('synthetic provider private payload');});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const socket=new WebSocket(`ws://127.0.0.1:${(server.address() as {port:number}).port}`);
  await assert.rejects(socketOpenAttempt(socket,1000).promise,error=>error instanceof Error && error.message==='ASR server responded 403');
  socket.terminate();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));
});
