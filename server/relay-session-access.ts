import {requireRecruitmentSessionAccess,SessionAccessError} from '../src/lib/voice/session-access';
import {sessionAccessOps} from '../src/server/session-access';
import type {Context} from '../src/server/context';

export async function authorizeRelayContext<T extends {sessionId?:string;interviewId?:string;inviteToken?:string;title:string}>(
  db:Context['supabase']|null,context:T,
):Promise<T> {
  if(!context.sessionId) {
    if(/^数君招聘\s*·\s*/.test(context.title))throw new SessionAccessError(403,'招聘面试缺少有效场次');
    return context;
  }
  if(!db)throw new SessionAccessError(503,'Unable to verify voice session');
  const ops=sessionAccessOps(db);
  const session=await ops.loadSession(context.sessionId);
  await requireRecruitmentSessionAccess({...ops,loadSession:async()=>session},context.sessionId,{inviteToken:context.inviteToken});
  if(!session || context.interviewId!==session.interview.id)throw new SessionAccessError(403,'面试与邀请场次不匹配');
  const {data:state,error}=await db.from('sessions').select('status').eq('id',session.id).maybeSingle();
  if(error || !state)throw new SessionAccessError(503,'Unable to verify voice session state');
  if(['COMPLETED','ABANDONED'].includes(state.status))throw new SessionAccessError(403,'本场面试已结束，请联系 HR');
  const {inviteToken: _inviteToken,...withoutCredential}=context;
  const verified:Record<string,unknown>={...withoutCredential,title:session.interview.title};
  if(/^数君招聘\s*·\s*/.test(session.interview.title)) {
    const {data:interview,error:loadError}=await db.from('interviews').select('*, questions(*)').eq('id',session.interview.id).maybeSingle();
    if(loadError || !interview || !Array.isArray(interview.questions))throw new SessionAccessError(503,'Unable to load verified interview questions');
    verified.questions=interview.questions;
    verified.objective=interview.objective ?? null;
    for(const key of ['aiName','aiTone','language','followUpDepth'])if(typeof interview[key]==='string')verified[key]=interview[key];
  }
  return verified as T;
}
