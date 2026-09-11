import { requestAbortScope } from "./request-abort";
import type { SupabaseClient } from '@supabase/supabase-js';
import type { TtsChunkEvent } from './volcengine-tts';

export type VoiceProvider = 'volcengine' | 'offline';
export interface VoiceRoute { provider: VoiceProvider; test: boolean }

export function selectVoiceRoute(test: boolean, env: Record<string, string | undefined> = process.env): VoiceRoute {
  const provider = test ? 'offline' : (env.VOICE_PRODUCTION_PROVIDER?.trim() || 'volcengine');
  if (provider !== 'offline' && provider !== 'volcengine') throw new Error('Invalid voice provider');
  return { provider, test };
}

export function parseVoiceRoute(value: unknown): VoiceRoute {
  if (!value || typeof value !== 'object') throw new Error('Missing voice route');
  const route = value as VoiceRoute;
  if (!['offline', 'volcengine'].includes(route.provider) || typeof route.test !== 'boolean'
      || (route.test && route.provider !== 'offline')) throw new Error('Invalid voice route');
  return { provider: route.provider, test: route.test };
}

// Persisted at interview creation, so config changes never reroute an existing interview.
export async function loadVoiceRoute(client: SupabaseClient | null, interviewId?: string): Promise<VoiceRoute> {
  if (!client || !interviewId) throw new Error('Cannot verify voice route');
  const {data, error} = await client.from('interviews').select('customBranding').eq('id',interviewId).single();
  if (error || !data) throw new Error('Cannot verify voice route');
  const saved = data.customBranding?.oprunVoiceRoute;
  return saved === undefined ? {provider:'volcengine',test:false} : parseVoiceRoute(saved);
}

export function offlineVoiceEndpoint(kind: 'asr'|'tts'): string {
  const url = new URL(process.env.OFFLINE_VOICE_URL || 'http://127.0.0.1:5211');
  if (url.protocol !== 'http:' || !['127.0.0.1','[::1]'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Offline voice must use the local sidecar');
  }
  url.pathname = kind === 'asr' ? '/asr' : '/tts';
  if (kind === 'asr') url.protocol='ws:';
  return url.toString();
}

const spokenCharacter = new RegExp('[\\p{L}\\p{N}]', 'u');

export async function* synthesizeOffline(text: string, signal?: AbortSignal): AsyncGenerator<TtsChunkEvent> {
  const pieces = text.match(/[^。！？!?；;]+[。！？!?；;]?|[。！？!?；;]/g) || [text];
  for (const piece of pieces) {
    signal?.throwIfAborted();
    // Sentence splitting can leave punctuation-only fragments. SAPI emits no
    // samples for these; they are pauses, not failed speech payloads.
    if (!spokenCharacter.test(piece)) continue;
  const abortScope = requestAbortScope([AbortSignal.timeout(60_000), ...(signal ? [signal] : [])]);
  try {
    const response = await fetch(offlineVoiceEndpoint('tts'), {
      method:'POST',headers:{'Content-Type':'application/json'}, body:JSON.stringify({text:piece,format:'mp3'}),
      signal: abortScope.signal,
      redirect:'error',
    });
    if (!response.ok) throw new Error(`Offline TTS failed (${response.status})`);
    const audio=Buffer.from(await response.arrayBuffer());
    const wav = audio.length >= 44 && audio.toString('ascii',0,4)==='RIFF' && audio.toString('ascii',8,12)==='WAVE';
    const mp3 = audio.length >= 128 && response.headers.get('content-type')?.split(';')[0]==='audio/mpeg'
      && (audio.toString('ascii',0,3)==='ID3' || (audio[0]===0xff && (audio[1]&0xe0)===0xe0));
    if (!wav && !mp3) {
      throw new Error('Offline TTS returned invalid audio');
    }
    signal?.throwIfAborted();
    yield {type:'audio',audio};
  } finally { abortScope.dispose(); }
  }
  yield {type:'done'};
}
