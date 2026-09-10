import WebSocket from 'ws';

/** Settle every handshake outcome and retire the transport on failure. */
export function waitForAsrSocketOpen(socket: WebSocket, timeoutMs = 10_000): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  if (socket.readyState !== WebSocket.CONNECTING) return Promise.reject(new Error('ASR connection already closed'));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off('open', opened);
      socket.off('error', failed);
      socket.off('close', closed);
      socket.off('unexpected-response', rejected);
      // terminate/close may emit a deferred error after this Promise settles.
      socket.on('error', () => {});
      if (error) {
        try { socket.terminate(); } catch { /* already retired */ }
        reject(error);
      } else resolve();
    };
    const opened = () => finish();
    const failed = (error: Error) => finish(error);
    const closed = () => finish(new Error('ASR connection closed during handshake'));
    const rejected: Parameters<WebSocket['on']>[1] = (_request: unknown, response: {statusCode?: number; resume: () => void}) => {
      response.resume();
      finish(new Error(`ASR server responded ${response.statusCode}`));
    };
    const timer = setTimeout(() => finish(new Error('ASR connect timeout')), timeoutMs);
    socket.once('open', opened);
    socket.once('error', failed);
    socket.once('close', closed);
    socket.once('unexpected-response', rejected);
  });
}
