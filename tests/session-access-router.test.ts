import assert from 'node:assert/strict';
import test from 'node:test';
import {sessionRouter} from '../src/server/routers/session';
import {sessionAccessOps} from '../src/server/session-access';

function client(inviteToken?:string) {
  let writes=0;
  const interview={id:'job-a',title:'数君招聘 · 总经理助理',userId:'owner-a'};
  const db={from(table:string){
    const eqs:Record<string,unknown>={};let update=false;
    const query:any={
      select(){return query;},eq(key:string,value:unknown){eqs[key]=value;return query;},
      maybeSingle(){return query;},single(){return query;},order(){return query;},
      update(){writes++;update=true;return query;},insert(){writes++;return query;},
      then(resolve:any,reject:any){
        const data=table==='sessions' ? (eqs.id==='a' ? update ? {id:'a'} : {id:'a',interview} : null) :
          table==='candidates' ? (eqs.sessionId==='a' && eqs.interviewId==='job-a' && eqs.inviteToken==='invite-a' ? {id:'candidate-a'} : null) : interview;
        return Promise.resolve({data,error:null}).then(resolve,reject);
      },
    };return query;
  }};
  return {caller:sessionRouter.createCaller({supabase:db,user:null,inviteToken} as any),writes:()=>writes};
}
test('recruitment data read and material write are blocked for another invitation',async()=>{
  for(const token of [undefined,'invite-b']) {
    const subject=client(token);
    await assert.rejects(subject.caller.getById({id:'a'}),/原邀请/);
    await assert.rejects(subject.caller.saveRecording({sessionId:'a',audioRecordingUrl:'/synthetic'}),/原邀请/);
    await assert.rejects(subject.caller.complete({id:'a'}),/原邀请/);
    assert.equal(subject.writes(),0);
  }
});
test('the matching invitation can read and save its own session',async()=>{
  const subject=client('invite-a');
  assert.equal((await subject.caller.getById({id:'a'})).id,'a');
  assert.deepEqual(await subject.caller.saveRecording({sessionId:'a',audioRecordingUrl:'/synthetic'}),{success:true,sessionId:'a'});
  assert.equal(subject.writes(),1);
  await assert.rejects(subject.caller.getById({id:'b'}));
});
test('knowing the recruitment slug and email cannot create an unverified session',async()=>{
  const subject=client();
  await assert.rejects(subject.caller.create({interviewSlug:'synthetic',participantEmail:'synthetic@example.invalid'}),/原邀请/);
  assert.equal(subject.writes(),0);
});
test('project permission query failure must not mean an unrestricted project',async()=>{
  let reads=0;
  const db={from(){
    const result=reads++===0 ? {data:{role:'MEMBER'},error:null} : {data:null,count:null,error:{code:'offline'}};
    const query:any={select(){return query;},eq(){return query;},maybeSingle(){return query;},then(resolve:any,reject:any){return Promise.resolve(result).then(resolve,reject);}};
    return query;
  }};
  await assert.rejects(sessionAccessOps(db as any).staffAccess({id:'a',interview:{id:'job',title:'数君招聘 · 人力资源',projectId:'project-a',project:{organizationId:'org-a'}}},'hr-a',true),/Unable to verify project/);
});
