import assert from 'node:assert/strict';
import test from 'node:test';
import {requireRecruitmentSessionAccess,SessionAccessError,type SessionAccessOps} from '../src/lib/voice/session-access';
import {invitationHeaders,candidateFetch} from '../src/lib/voice/candidate-fetch';

const session={id:'a',interview:{id:'job-a',title:'数君招聘 · 人力资源'}};
function ops():SessionAccessOps {return {
  async loadSession(id){return id===session.id?session:null;},
  async matchesInvite(s,token){return s.id==='a' && token==='invite-a';},
  async staffAccess(_s,user,write){return user==='hr-a' || (user==='viewer-a' && !write);},
};}
test('candidate access requires the invitation for this session',async()=>{
  await requireRecruitmentSessionAccess(ops(),'a',{inviteToken:'invite-a'});
  for(const credentials of [{},{inviteToken:'invite-b'},{userId:'unrelated-hr'},{inviteToken:'x'.repeat(513)}]) {
    await assert.rejects(requireRecruitmentSessionAccess(ops(),'a',credentials),error=>error instanceof SessionAccessError && error.status===403);
  }
});
test('HR project permissions distinguish reading from writing',async()=>{
  await requireRecruitmentSessionAccess(ops(),'a',{userId:'hr-a'});
  await requireRecruitmentSessionAccess(ops(),'a',{userId:'viewer-a'},false);
  await assert.rejects(requireRecruitmentSessionAccess(ops(),'a',{userId:'viewer-a'}),/原邀请/);
});
test('lookup failure and missing interview metadata never turn into public access',async()=>{
  const missing=ops();missing.loadSession=async()=>({id:'a',interview:null} as any);
  await assert.rejects(requireRecruitmentSessionAccess(missing,'a',{}),error=>error instanceof SessionAccessError && error.status===503);
  const failed=ops();failed.loadSession=async()=>{throw Error('storage unavailable');};
  await assert.rejects(requireRecruitmentSessionAccess(failed,'a',{}),/storage unavailable/);
  await assert.rejects(requireRecruitmentSessionAccess(ops(),'missing',{}),error=>error instanceof SessionAccessError && error.status===404);
});
test('existing public practice is preserved while invalid identifiers are rejected',async()=>{
  const publicOps=ops();publicOps.loadSession=async()=>({id:'a',interview:{id:'public',title:'Practice'}});
  await requireRecruitmentSessionAccess(publicOps,'a',{});
  for(const id of [null,{},'',12])await assert.rejects(requireRecruitmentSessionAccess(publicOps,id,{}));
});
test('invitation headers come only from the invitation route and reject malformed values',()=>{
  assert.deepEqual(invitationHeaders('/i/invite/invite-a/session'),{'x-interview-invite':'invite-a'});
  assert.deepEqual(invitationHeaders('/i/invite/invite-a'),{'x-interview-invite':'invite-a'});
  for(const path of ['/interviews/a','/i/invite/','/i/invite/%0d%0aevil/session','/i/invite/%XX/session'])assert.deepEqual(invitationHeaders(path),{});
});

test('browser requests attach invitation only to same-origin API requests',async()=>{
  const previousWindow=(globalThis as any).window;
  const previousFetch=globalThis.fetch;
  const sent:RequestInit[]=[];
  (globalThis as any).window={location:{origin:'https://synthetic.example',pathname:'/i/invite/invite-a/session'}};
  globalThis.fetch=async(_url,options)=>{sent.push(options ?? {});return new Response('ok');};
  try {
    await candidateFetch('/api/voice/save',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    await candidateFetch('https://external.example/api/upload',{method:'POST'});
    await candidateFetch('/ordinary-page');
    assert.equal(new Headers(sent[0].headers).get('x-interview-invite'),'invite-a');
    assert.equal(new Headers(sent[0].headers).get('Content-Type'),'application/json');
    assert.equal(new Headers(sent[1].headers).has('x-interview-invite'),false);
    assert.equal(new Headers(sent[2].headers).has('x-interview-invite'),false);
  } finally {
    globalThis.fetch=previousFetch;
    if(previousWindow===undefined)delete (globalThis as any).window;else (globalThis as any).window=previousWindow;
  }
});
