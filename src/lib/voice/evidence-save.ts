import {candidateFetch} from './candidate-fetch';
/** A HTTP response alone is not proof that a whiteboard/code record exists. */
export async function saveInterviewEvidence(
  url: string,
  payload: Record<string, unknown>,
  request: typeof fetch = candidateFetch,
): Promise<void> {
  const response = await request(url, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({json:payload}),
  });
  if (!response.ok) throw new Error(`面试补充材料保存失败（${response.status}），请重试`);
  const body = await response.json();
  const data = body?.result?.data?.json ?? body?.result?.data;
  if (body?.error || !data?.message?.id) throw new Error('面试补充材料尚未确认保存，请重试');
}

/** Metadata acknowledgment is separate from proof that the media object exists. */
export async function saveRecordingMetadata(
  payload: Record<string, unknown> & {sessionId: string},
  request: typeof fetch = candidateFetch,
): Promise<void> {
  const response = await request('/api/trpc/session.saveRecording', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({json:payload}),
  });
  if (!response.ok) throw new Error(`录音资料保存失败（${response.status}），请保留页面并重试`);
  const body = await response.json();
  const data = body?.result?.data?.json ?? body?.result?.data;
  if (body?.error || data?.success !== true || data?.sessionId !== payload.sessionId) {
    throw new Error('录音资料尚未确认保存到本场面试，请保留页面并重试');
  }
}
