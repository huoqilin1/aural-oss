export class SessionAccessError extends Error {
  constructor(readonly status:400|403|404|503,message:string) {super(message);}
}
export interface AccessSession {
  id:string;
  interview:{id:string;title:string;userId?:string;projectId?:string;project?:{organizationId:string}|null};
}
export interface SessionAccessOps {
  loadSession(id:string):Promise<AccessSession|null>;
  matchesInvite(session:AccessSession,token:string):Promise<boolean>;
  staffAccess(session:AccessSession,userId:string,write:boolean):Promise<boolean>;
}
export async function requireRecruitmentSessionAccess(
  ops:SessionAccessOps,sessionId:unknown,credentials:{inviteToken?:string|null;userId?:string|null},write=true,expectedInterviewId?:string,
):Promise<void> {
  if(typeof sessionId!=='string' || !sessionId || sessionId.length>200) throw new SessionAccessError(400,'Invalid session');
  const session=await ops.loadSession(sessionId);
  if(!session)throw new SessionAccessError(404,'Interview session not found');
  if(!session.interview || typeof session.interview.title!=='string')throw new SessionAccessError(503,'Unable to verify interview access');
  if(expectedInterviewId!==undefined && session.interview.id!==expectedInterviewId)throw new SessionAccessError(403,'Interview does not match this session');
  // Preserve existing public practice behavior; recruitment requires its invitation.
  if(!/^数君招聘\s*·\s*/.test(session.interview.title))return;
  if(credentials.inviteToken && credentials.inviteToken.length<=512 && await ops.matchesInvite(session,credentials.inviteToken))return;
  if(credentials.userId && await ops.staffAccess(session,credentials.userId,write))return;
  throw new SessionAccessError(403,'请使用本场面试的原邀请链接，或由有权限的 HR 访问');
}
