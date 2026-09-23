import {createHash} from 'node:crypto';

export interface MediaObjectStore {
  upload(path: string, bytes: Buffer, options: {contentType: string; upsert: false}): PromiseLike<{error: unknown}>;
  download(path: string): PromiseLike<{data: Blob | null; error: unknown}>;
  createSignedUrl(path: string, expiresIn: number): PromiseLike<{data: {signedUrl: string} | null; error: unknown}>;
}

/** Content-addressed paths make a lost acknowledgment retryable without overwrites. */
export async function storeMediaObject(
  store: MediaObjectStore,
  input: {sessionId: string; bytes: Buffer; contentType: string; extension: 'jpg' | 'webm' | 'm4a'},
): Promise<{url: string; path: string; sha256: string}> {
  if (!/^[a-zA-Z0-9_-]+$/.test(input.sessionId) || !input.bytes.length) {
    throw new Error('Invalid media session or empty media object');
  }
  const sha256 = createHash('sha256').update(input.bytes).digest('hex');
  const path = `${input.sessionId}/${sha256}.${input.extension}`;
  // A network error can occur after storage accepted the object. Inspect the
  // immutable destination on either a returned error or a rejected request.
  let uploadError: unknown;
  try {
    const result = await store.upload(path,input.bytes,{contentType:input.contentType,upsert:false});
    uploadError = result.error;
  } catch (error) { uploadError = error; }
  if (uploadError) {
    const existing = await store.download(path);
    if (existing.error || !existing.data) throw new Error('Media object upload was not confirmed');
    const bytes = Buffer.from(await existing.data.arrayBuffer());
    if (!bytes.equals(input.bytes)) throw new Error('Stored media does not match this upload');
  }
  const signed = await store.createSignedUrl(path,60*60*24*365);
  if (signed.error || !signed.data?.signedUrl) throw new Error('Media URL creation failed; retry the same media');
  return {url:signed.data.signedUrl,path,sha256};
}
