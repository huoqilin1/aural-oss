import type {DeliverableMessage} from './message-delivery';

type OutboxStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const keyFor = (sessionId: string) => `aural:pending-voice:v1:${encodeURIComponent(sessionId)}`;

/** Tab-scoped storage survives refresh; acknowledged content is removed. */
export function writeDeliveryOutbox(storage: OutboxStorage, sessionId: string, messages: readonly DeliverableMessage[]): void {
  const key=keyFor(sessionId);
  if (!messages.length) { storage.removeItem(key); return; }
  storage.setItem(key, JSON.stringify({version:1, sessionId, messages}));
}

export function readDeliveryOutbox(storage: OutboxStorage, sessionId: string): DeliverableMessage[] {
  const raw=storage.getItem(keyFor(sessionId));
  if (!raw) return [];
  const value=JSON.parse(raw);
  if (value?.version !== 1 || value.sessionId !== sessionId || !Array.isArray(value.messages) ||
      value.messages.some((message: DeliverableMessage) => !message ||
        !['user','assistant'].includes(message.role) || typeof message.content !== 'string' ||
        (message.questionId !== undefined && typeof message.questionId !== 'string') ||
        (message.messageId !== undefined && typeof message.messageId !== 'string') ||
        (message.timestamp !== undefined && (typeof message.timestamp !== 'string' || !Number.isFinite(Date.parse(message.timestamp)))))) {
    throw new Error('Invalid saved interview outbox');
  }
  return value.messages;
}
