import {requireRecruitmentSessionAccess,SessionAccessError,type AccessSession,type SessionAccessOps} from '@/lib/voice/session-access';
import type {Context} from './context';

export function sessionAccessOps(db:Context['supabase']):SessionAccessOps {
  return {
    async loadSession(id) {
      const {data,error}=await db.from('sessions')
        .select('id, interview:interviews!inner(id,title,userId,projectId,project:projects(organizationId))').eq('id',id).maybeSingle();
      if(error)throw new SessionAccessError(503,'Unable to verify interview access');
      return data as AccessSession|null;
    },
    async matchesInvite(session,token) {
      const {data,error}=await db.from('candidates').select('id').eq('sessionId',session.id)
        .eq('interviewId',session.interview.id).eq('inviteToken',token).maybeSingle();
      if(error)throw new SessionAccessError(503,'Unable to verify invitation');
      return !!data;
    },
    async staffAccess(session,userId,write) {
      if(session.interview.userId===userId)return true;
      const organizationId=session.interview.project?.organizationId;
      if(!organizationId || !session.interview.projectId)return false;
      const memberResult=await db.from('organization_members').select('role')
        .eq('workspaceId',organizationId).eq('userId',userId).maybeSingle();
      if(memberResult.error)throw new SessionAccessError(503,'Unable to verify HR membership');
      const role=memberResult.data?.role;
      if(!['OWNER','ADMIN','MEMBER','VIEWER'].includes(role) || (write && role==='VIEWER'))return false;
      const projectResult=await db.from('project_members').select('id',{count:'exact',head:true}).eq('projectId',session.interview.projectId);
      if(projectResult.error || projectResult.count===null)throw new SessionAccessError(503,'Unable to verify project access');
      if(projectResult.count===0)return true;
      const access=await db.from('project_members').select('id').eq('projectId',session.interview.projectId).eq('userId',userId).maybeSingle();
      if(access.error)throw new SessionAccessError(503,'Unable to verify project membership');
      return !!access.data;
    },
  };
}

export async function assertSessionAccess(ctx:Context,sessionId:unknown,write=true,expectedInterviewId?:string):Promise<void> {
  await requireRecruitmentSessionAccess(sessionAccessOps(ctx.supabase),sessionId,
    {inviteToken:ctx.inviteToken,userId:ctx.user?.id},write,expectedInterviewId);
}
