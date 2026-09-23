import assert from 'node:assert/strict';
import test from 'node:test';
import {authorizeRelayContext} from '../server/relay-session-access';

function database(status='IN_PROGRESS',failState=false) {
  const reads:string[]=[];
  const db={from(table:string){
    let columns='';const filters:Record<string,unknown>={};
    const query:any={select(value:string){columns=value;return query;},eq(key:string,value:unknown){filters[key]=value;return query;},maybeSingle(){return query;},then(resolve:any,reject:any){
      reads.push(table+':'+columns);
      const data=table==='sessions' ? columns==='status' ? {status} : {id:'session-a',interview:{id:'job-a',title:'数君招聘 · 人力资源'}} :
        table==='candidates' ? filters.inviteToken==='invite-a' && filters.sessionId==='session-a' && filters.interviewId==='job-a' ? {id:'candidate'} : null :
        {questions:[{id:'verified-q1',text:'verified question',order:0}],objective:'verified objective',language:'zh-CN'};
      return Promise.resolve({data,error:columns==='status' && failState ? {code:'offline'} : null}).then(resolve,reject);
    }};return query;
  }};
  return {db:db as any,reads};
}
const context={sessionId:'session-a',interviewId:'job-a',inviteToken:'invite-a',title:'forged public title',questions:[{id:'forged-q'}],objective:'forged objective'};
test('relay checks the stored recruitment type and invitation before voice work',async()=>{
  const {db,reads}=database();
  await assert.rejects(authorizeRelayContext(db,{...context,inviteToken:'invite-b'}),/原邀请/);
  assert.equal(reads.some(read=>read.startsWith('interviews:')),false);
});
test('relay uses verified title questions and objective and removes invitation from runtime context',async()=>{
  const result=await authorizeRelayContext(database().db,context);
  assert.equal(result.title,'数君招聘 · 人力资源');
  assert.equal(result.objective,'verified objective');
  assert.equal(result.questions[0].id,'verified-q1');
  assert.equal('inviteToken' in result,false);
});
test('another interview id cannot be combined with a valid session invitation',async()=>{
  await assert.rejects(authorizeRelayContext(database().db,{...context,interviewId:'job-b'}),/不匹配/);
});
test('ended sessions and unavailable state are rejected on either relay',async()=>{
  for(const status of ['COMPLETED','ABANDONED'])await assert.rejects(authorizeRelayContext(database(status).db,context),/已结束/);
  await assert.rejects(authorizeRelayContext(database('IN_PROGRESS',true).db,context),/verify voice session state/);
  await assert.rejects(authorizeRelayContext(null,context),/verify voice session/);
});
test('recruitment cannot start without a session while unpersisted practice remains available',async()=>{
  await assert.rejects(authorizeRelayContext(null,{title:'数君招聘 · 总经理助理'}),/缺少有效场次/);
  assert.deepEqual(await authorizeRelayContext(null,{title:'Public practice'}),{title:'Public practice'});
});
