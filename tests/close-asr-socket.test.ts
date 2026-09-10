import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { closeAsrSocket } from '../server/close-asr-socket';
import { waitForAsrSocketOpen } from '../server/asr-socket-open';

test('retiring ten CONNECTING ASR sockets handles deferred errors without process failure', async () => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as {port:number};
  try {
    const sockets = Array.from({length:10},()=>new WebSocket(`ws://127.0.0.1:${address.port}`));
    for (const socket of sockets) closeAsrSocket(socket);
    await Promise.all(sockets.map(socket => new Promise<void>(resolve => socket.once('close',()=>resolve()))));
    assert.ok(sockets.every(socket=>socket.readyState===WebSocket.CLOSED));
  } finally { server.close(); }
});

test('retiring an open socket detaches stale callbacks and is repeatable after close', async () => {
  const server = new WebSocketServer({host:'127.0.0.1',port:0});
  await once(server,'listening');
  const address = server.address() as {port:number};
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
  await once(socket,'open');
  let staleCalled=false;
  socket.on('close',()=>{staleCalled=true;});
  closeAsrSocket(socket);
  await new Promise<void>(resolve=>socket.once('close',()=>resolve()));
  assert.equal(staleCalled,false);
  closeAsrSocket(socket);
  closeAsrSocket(null);
  server.close();
});


test('cancelling a pending handshake settles its waiter without waiting for timeout', async () => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as {port:number};
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
  const waiter = new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  try {
    const rejected = assert.rejects(waiter, /closed before the connection was established/);
    closeAsrSocket(socket);
    await rejected;
    assert.equal(socket.readyState, WebSocket.CLOSED);
  } finally { socket.terminate(); server.close(); }
});


test('ten timed-out handshakes close their sockets and a fresh ten can connect', async () => {
  const stalled = createServer();
  const accepted = new WebSocketServer({host:'127.0.0.1',port:0});
  const connections = new Set<import('node:net').Socket>();
  stalled.on('connection', socket => { connections.add(socket);socket.on('close',()=>connections.delete(socket)); });
  stalled.on('upgrade',(_request,socket)=>{socket.on('end',()=>socket.destroy());socket.resume();});
  stalled.listen(0,'127.0.0.1');
  await Promise.all([once(stalled,'listening'),once(accepted,'listening')]);
  const sockets = Array.from({length:10},()=>new WebSocket(`ws://127.0.0.1:${(stalled.address() as {port:number}).port}`));
  try {
    const outcomes = await Promise.allSettled(sockets.map(socket=>waitForAsrSocketOpen(socket,100)));
    assert.equal(outcomes.filter(x=>x.status==='rejected').length,10);
    await new Promise(resolve=>setTimeout(resolve,50));
    assert.ok(sockets.every(s=>s.readyState===WebSocket.CLOSED));
    assert.equal(connections.size,0);
    const next = Array.from({length:10},()=>new WebSocket(`ws://127.0.0.1:${(accepted.address() as {port:number}).port}`));
    await Promise.all(next.map(s=>waitForAsrSocketOpen(s,1000)));
    assert.ok(next.every(s=>s.readyState===WebSocket.OPEN));
    for(const s of next)s.close();
  } finally { for(const s of sockets)s.terminate();for(const s of Array.from(connections))s.destroy();stalled.close();accepted.close(); }
});

test('HTTP refusal and intentional cancellation settle without a phantom timeout', async () => {
  const server=createServer((_req,res)=>{res.writeHead(503);res.end('private provider body');});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const url=`ws://127.0.0.1:${(server.address() as {port:number}).port}`;
  try {
    await assert.rejects(waitForAsrSocketOpen(new WebSocket(url)),/^Error: ASR server responded 503$/);
    const socket=new WebSocket(url);
    const pending=waitForAsrSocketOpen(socket);
    closeAsrSocket(socket);
    await assert.rejects(pending,/closed before the connection was established/);
  } finally { server.close(); }
});
