/** Reuse the invitation already present in the route; no extra candidate step. */
export function invitationHeaders(pathname?:string):Record<string,string> {
  const path=pathname ?? (typeof window==='undefined' ? '' : window.location.pathname);
  const match=/^\/i\/invite\/([^/]+)(?:\/|$)/.exec(path);
  if(!match)return {};
  try {
    const token=decodeURIComponent(match[1]);
    return token && token.length<=512 && !/[\r\n]/.test(token) ? {'x-interview-invite':token} : {};
  } catch {return {};}
}
export const candidateFetch:typeof fetch=(input,init)=>{
  if(typeof window==='undefined')return fetch(input,init);
  const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,window.location.origin);
  if(url.origin!==window.location.origin || !url.pathname.startsWith('/api/'))return fetch(input,init);
  const headers=new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value,key)=>headers.set(key,value));
  for(const [key,value]of Object.entries(invitationHeaders()))headers.set(key,value);
  return fetch(input,{...init,headers});
};
