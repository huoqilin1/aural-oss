import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { closeAsrSocket } from '../server/close-asr-socket';

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
