import {createHmac} from 'node:crypto';
import {parseRelayLlmRoute,type RelayLlmRoute,type RelayLlmProviderId} from '../src/lib/relay-llm-route';

export type HrTextPolicy={route:RelayLlmRoute;models:Record<RelayLlmProviderId,string>};

export async function resolveHrModelChain(legacyChain:string[]):Promise<string[]> {
  const policy=await getHrTextPolicy();
  return policy ? [policy.route.primary,...policy.route.fallbacks].map(provider=>policy.models[provider]) : legacyChain;
}

/** Read every time: a cached old policy must never restore a disabled provider. */
export async function getHrTextPolicy(request:typeof fetch=fetch):Promise<HrTextPolicy|null> {
  const base=process.env.HR_MODEL_CONTROL_URL?.trim();
  const secret=process.env.HR_MODEL_CONTROL_SECRET?.trim();
  if(!base && !secret)return null; // Existing installations until bridge is configured.
  if(!base || !secret)throw new Error('HR model control configuration incomplete');
  const url=new URL(base);
  if(url.username || url.password || url.search || url.hash ||
     (url.protocol!=='https:' && !(url.protocol==='http:' && ['127.0.0.1','localhost'].includes(url.hostname))))
    throw new Error('HR model control requires HTTPS');
  const timestamp=String(Math.floor(Date.now()/1000));
  const signature=createHmac('sha256',secret).update(`${timestamp}\nGET\n${url.pathname}\n`).digest('hex');
  const response=await request(url,{headers:{'X-HR-Model-Timestamp':timestamp,'X-HR-Model-Signature':signature},
    redirect:'error',cache:'no-store',signal:AbortSignal.timeout(5000)});
  if(!response.ok)throw new Error(`HR model control unavailable (${response.status})`);
  const data=await response.json();
  if (data.schema_version !== undefined && data.schema_version !== 1) throw new Error("HR_model_contract_version_unsupported");
  const route=parseRelayLlmRoute(data.route);
  if(!data.success || !route || !data.models)throw new Error('HR model control returned an invalid policy');
  for(const provider of [route.primary,...route.fallbacks]) {
    if(typeof data.models[provider]!=='string' || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(data.models[provider]))
      throw new Error('HR model control returned an invalid model');
  }
  return {route,models:data.models};
}
