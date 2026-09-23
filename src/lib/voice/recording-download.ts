/** Restrict the proxy to signed recording objects in explicitly configured storage. */
export function allowedRecordingUrl(value: string, storageUrls: Array<string | undefined>): URL | null {
  try {
    const url = new URL(value);
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.hash) return null;
    const origins = storageUrls.flatMap(value => {
      try {return value ? [new URL(value).origin] : [];} catch {return [];}
    });
    if (!origins.includes(url.origin)) return null;
    if (!/^\/storage\/v1\/object\/sign\/recordings\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9._-]+$/.test(url.pathname)) return null;
    if (!url.searchParams.get('token')) return null;
    return url;
  } catch {return null;}
}

export async function fetchRecordingDownload(
  value:string,storageUrls:Array<string|undefined>,request:typeof fetch=fetch,
):Promise<Response> {
  const url=allowedRecordingUrl(value,storageUrls);
  if (!url) return Response.json({error:'Invalid recording download address'},{status:400});
  const response=await request(url,{redirect:'manual'});
  if (response.status>=300 && response.status<400) {
    await response.body?.cancel();
    return Response.json({error:'Recording redirects are not allowed'},{status:502});
  }
  return response;
}
