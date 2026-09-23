import type WebSocket from 'ws';

/** Detach retired sessions without leaving ws's asynchronous close error unhandled. */
export function closeAsrSocket(socket: WebSocket | null | undefined): void {
  if (!socket) return;
  // During a handshake, error listeners own its pending Promise. Removing
  // them would strand a cancelled connection until its timeout, blocking the
  // reconnect queue. There are no established-session message handlers yet.
  if (socket.readyState !== 0) socket.removeAllListeners();
  // close() during CONNECTING emits error on the next tick, outside try/catch.
  // Keep this listener on the retired socket until it can be garbage collected.
  socket.on('error', () => {});
  try { socket.close(); } catch {
    try { socket.terminate(); } catch { /* already disposed */ }
  }
}
