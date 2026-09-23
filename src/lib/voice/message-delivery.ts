export type DeliverableMessage = {
  messageId?: string;
  role: string;
  content: string;
  questionId?: string;
  source?: string;
  timestamp?: string;
};

/** Assign identity once, before the first network request, then freeze the batch. */
export function prepareDelivery<T extends DeliverableMessage>(
  messages: readonly T[], createId: () => string = () => crypto.randomUUID(),
  now: () => string = () => new Date().toISOString(),
): T[] {
  return messages.map(message => {
    message.messageId ??= createId();
    message.timestamp ??= now();
    return {...message};
  });
}

export function removeAcknowledged<T extends DeliverableMessage>(pending: readonly T[], acknowledged: readonly T[]): T[] {
  const ids = new Set(acknowledged.map(message => message.messageId).filter(Boolean));
  return pending.filter(message => !message.messageId || !ids.has(message.messageId));
}
