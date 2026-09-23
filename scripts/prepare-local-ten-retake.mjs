// Re-test only the voice segment with the ten previously generated question sets.
// Original abandoned sessions and all source/score evidence are retained.
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
const root='output/local-sandbox/official-ten-20260915/';
const target=root+'retake-invites-private.json';
if(existsSync(target))throw Error('Already reserved: inspect receipt, never replay candidate writes');
const inputs=JSON.parse(readFileSync(root+'retake-sources-private.json','utf8'));
if(inputs.length!==10||new Set(inputs.map(x=>x.fixture)).size!==10)throw Error('Exactly ten sources required');
const key=JSON.parse(readFileSync('output/local-sandbox/real-report/reconcile-key-private.json','utf8')).key;
const receipt={scope:'local voice-segment retest after genuine official-site intake; not uninterrupted full acceptance',reservedAt:Date.now(),results:[]};
writeFileSync(target,JSON.stringify(receipt));
for(const item of inputs){
 const row={...item,state:'dispatching'};receipt.results.push(row);writeFileSync(target,JSON.stringify(receipt));
 const response=await fetch('http://127.0.0.1:3300/api/v1/interviews/'+item.aural_interview_id+'/candidates',{
  method:'POST',redirect:'error',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},
  body:JSON.stringify({name:'本地模拟复测'+item.fixture,notes:'仅本地语音段复测，不联系真人；保留此前未完成场次。'})});
 if(!response.ok)throw Error('local_invitation_http_'+response.status);
 const candidate=(await response.json()).data?.[0];
 if(!candidate?.id||!candidate?.inviteToken)throw Error('Invalid local candidate receipt');
 Object.assign(row,{state:'created',newAuralCandidateId:candidate.id,inviteToken:candidate.inviteToken});
 writeFileSync(target,JSON.stringify(receipt));
}
console.log(JSON.stringify({newVoiceInvites:10,newResumeSubmissions:0,modelRequests:0,oldSessionsPreserved:true}));
