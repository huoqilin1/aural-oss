import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";

/** A server send/duration estimate is not evidence that the listener heard it. */
export function waitForBrowserPlayback(
  socket: WebSocket,
  questionIndex: number,
  signal: AbortSignal,
  timeoutMs = 180_000,
): Promise<"played" | "cancelled" | "timeout"> {
  if (signal.aborted || socket.readyState !== WebSocket.OPEN) return Promise.resolve("cancelled");
  return new Promise((resolve) => {
    const receiptId = randomUUID();
    const finish = (result: "played" | "cancelled" | "timeout") => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("close", onClose);
      signal.removeEventListener("abort", onClose);
      resolve(result);
    };
    const onClose = () => finish("cancelled");
    const onMessage = (data: { toString(): string }, binary: boolean) => {
      if (binary) return;
      try {
        const message = JSON.parse(data.toString());
        if (message.type === "playback_complete" && message.receiptId === receiptId
          && message.questionIndex === questionIndex) finish("played");
      } catch { /* Microphone frames and unrelated messages are not receipts. */ }
    };
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    socket.on("message", onMessage);
    socket.on("close", onClose);
    signal.addEventListener("abort", onClose, { once: true });
    socket.send(JSON.stringify({ type: "playback_receipt_request", receiptId, questionIndex }));
  });
}
