import type {DeliverableMessage} from '@/lib/voice/message-delivery';
import {orderedVoiceMessageTimestamp} from './logic';

export type StoredVoiceMessage = {
  id: string; sessionId: string; role: 'USER' | 'ASSISTANT'; content: string;
  contentType: 'TEXT'; questionId: string | null; wordCount: number;
  transcription: string | null; timestamp: string;
};
export type MessageStorage = {
  insertIfAbsent: (rows: StoredVoiceMessage[]) => Promise<void>;
  read: (sessionId: string, ids: string[]) => Promise<StoredVoiceMessage[]>;
};

/** A lost HTTP response must not insert duplicate answers on retry. */
export async function persistVoiceMessages(
  sessionId: string, messages: DeliverableMessage[], storage: MessageStorage,
  createId: () => string, now = Date.now(),
): Promise<void> {
  const rows: StoredVoiceMessage[] = messages.map((message, index) => ({
    id: message.messageId ?? createId(), sessionId,
    role: message.role === 'user' ? 'USER' : 'ASSISTANT', content: message.content,
    contentType: 'TEXT', questionId: message.questionId || null,
    wordCount: message.content.split(/\s+/).length,
    transcription: message.source === 'chat' ? 'chat' : null,
    timestamp: message.timestamp ?? orderedVoiceMessageTimestamp(now, index),
  }));
  // Repeated IDs inside a batch are ambiguous and must not be silently merged.
  if (new Set(rows.map(row => row.id)).size !== rows.length) throw new Error('Duplicate message identity');
  await storage.insertIfAbsent(rows);
  const retained = await storage.read(sessionId, rows.map(row => row.id));
  for (const expected of rows) {
    const actual = retained.find(row => row.id === expected.id);
    if (!actual || actual.sessionId !== sessionId || actual.role !== expected.role ||
      actual.content !== expected.content || actual.questionId !== expected.questionId ||
      actual.transcription !== expected.transcription ||
      Date.parse(actual.timestamp) !== Date.parse(expected.timestamp)) {
      throw new Error('Voice message identity conflict or missing acknowledgement');
    }
  }
}
