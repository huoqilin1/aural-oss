// Direct route contract with real local Supabase; does not start/bypass Next.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID, randomBytes } from 'node:crypto';
import { build } from 'esbuild';
import { createClient } from '@supabase/supabase-js';

const root = resolve(import.meta.dirname, '..');
const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
assert.equal(config.API_URL, 'http://127.0.0.1:55321');
assert.ok(config.SERVICE_ROLE_KEY && config.ANON_KEY);
const output = resolve(root, 'output/local-sandbox', 'supabase-upload-' + randomUUID());
mkdirSync(output, {recursive:true});
const nativeFetch = globalThis.fetch;
const requests = [];
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  assert.equal(url.origin, config.API_URL, 'Only the owned local Supabase API is permitted');
  requests.push({method:init?.method || 'GET', path:url.pathname.split('/').slice(0,4).join('/')});
  return nativeFetch(input, init);
};
process.env.SUPABASE_URL = config.API_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY = config.SERVICE_ROLE_KEY;
const client = createClient(config.API_URL, config.SERVICE_ROLE_KEY, {auth:{persistSession:false,autoRefreshToken:false}});
const anon = createClient(config.API_URL, config.ANON_KEY, {auth:{persistSession:false,autoRefreshToken:false}});
const compiled = await build({absWorkingDir:root,entryPoints:['src/app/api/session/upload/route.ts'],bundle:true,
  write:false,platform:'node',format:'cjs',packages:'external'});
const routeFile = resolve(output,'upload-route.cjs');
writeFileSync(routeFile,compiled.outputFiles[0].contents);
const {POST} = createRequire(import.meta.url)(routeFile);
// Keep actual storage/session operations; explicitly isolate the report provider.
globalThis.__localSummaryCalls = 0;
const saveBuild = await build({absWorkingDir:root,entryPoints:['src/app/api/voice/save/route.ts'],bundle:true,
  write:false,platform:'node',format:'cjs',packages:'external',plugins:[{
    name:'explicit-local-summary-sink',setup(build) {
      build.onResolve({filter:/^@\/lib\/ai\/voice-summary$/},()=>({path:'summary-sink',namespace:'local-test'}));
      build.onLoad({filter:/.*/,namespace:'local-test'},()=>({contents:'export async function generateVoiceSummary(){globalThis.__localSummaryCalls++;}',loader:'js'}));
    }
  }]});
const saveFile = resolve(output,'voice-save-route.cjs');
writeFileSync(saveFile,saveBuild.outputFiles[0].contents);
const {POST:savePost} = createRequire(import.meta.url)(saveFile);
let userId, interviewId, sessionId;
const report = {passed:false,fullInterviewAcceptancePassed:false,checks:[],rawMedia:'synthetic bytes only',summaryProvider:'explicit test sink; model/report not verified'};
try {
  const created = await client.auth.admin.createUser({email:`local-${randomUUID()}@example.invalid`,
    password:randomBytes(24).toString('hex'),email_confirm:true});
  assert.ifError(created.error);userId=created.data.user.id;
  const interview = await client.from('interviews').insert({title:'数君招聘 · 本地合成验收',userId}).select('id').single();
  assert.ifError(interview.error);interviewId=interview.data.id;
  const session = await client.from('sessions').insert({interviewId,participantName:'Synthetic local test'}).select('id').single();
  assert.ifError(session.error);sessionId=session.data.id;
  const questionRows = Array.from({length:8},(_,index)=>({interviewId,order:index,text:`合成测试题 ${index+1}`,
    type:'OPEN_ENDED',description:'oprun_dimension:execution'}));
  const questions = await client.from('questions').insert(questionRows).select('id,order').order('order');
  assert.ifError(questions.error);
  async function save(payload) {
    return savePost(new Request('http://127.0.0.1:3219/api/voice/save',{method:'POST',
      headers:{'content-type':'application/json'},body:JSON.stringify({sessionId,...payload})}));
  }
  const answers = questions.data.map(q=>({role:'user',questionId:q.id,
    content:`本条为合成测试数据。我负责第${q.order+1}项资料核对，建立记录并由负责人确认结果。`}));
  assert.equal((await save({messages:answers.slice(0,6),currentQuestionIndex:5})).status,200);
  assert.equal((await save({complete:true})).status,409);
  let state = await client.from('sessions').select('status,currentQuestionId').eq('id',sessionId).single();
  assert.ifError(state.error);assert.equal(state.data.status,'IN_PROGRESS');
  assert.equal(state.data.currentQuestionId,questions.data[5].id);
  assert.equal(globalThis.__localSummaryCalls,0);
  report.checks.push('six_answers_cannot_complete_real_storage');
  assert.equal((await save({messages:answers.slice(6),currentQuestionIndex:7})).status,200);
  assert.equal((await save({validateOnly:true})).status,200);
  assert.equal((await save({complete:true})).status,409);
  assert.equal(globalThis.__localSummaryCalls,0);
  report.checks.push('eight_answers_without_recording_cannot_complete');
  const bytes = Buffer.from('Synthetic recording contract bytes; not a person recording.');
  async function upload(id=sessionId, duration='12') {
    const form = new FormData();
    form.append('sessionId',id);form.append('type','recording');form.append('audioDuration',duration);
    form.append('file',new Blob([bytes],{type:'audio/webm'}),'local.webm');
    return POST(new Request('http://127.0.0.1:3219/api/session/upload',{method:'POST',body:form}));
  }
  const first = await upload();assert.equal(first.status,200);
  const saved = await first.json();
  const row = await client.from('sessions').select('audioRecordingUrl,audioDuration').eq('id',sessionId).single();
  assert.ifError(row.error);assert.equal(row.data.audioRecordingUrl,saved.url);assert.equal(row.data.audioDuration,12);
  report.checks.push('upload_and_durable_session_link');
  const signed = await fetch(saved.url);assert.equal(signed.status,200);
  assert.ok(Buffer.from(await signed.arrayBuffer()).equals(bytes));
  report.checks.push('signed_download_exact_bytes');
  assert.equal((await save({complete:true})).status,200);
  state = await client.from('sessions').select('status,completedAt').eq('id',sessionId).single();
  assert.ifError(state.error);assert.equal(state.data.status,'COMPLETED');assert.ok(state.data.completedAt);
  assert.equal(globalThis.__localSummaryCalls,1);
  assert.equal((await save({complete:true})).status,200);
  assert.equal(globalThis.__localSummaryCalls,1);
  const persisted = await client.from('messages').select('questionId,content,timestamp').eq('sessionId',sessionId).order('timestamp');
  assert.ifError(persisted.error);assert.equal(persisted.data.length,8);
  assert.deepEqual(persisted.data.map(m=>m.content),answers.map(m=>m.content));
  assert.equal(new Set(persisted.data.map(m=>m.timestamp)).size,8);
  report.checks.push('eight_answers_and_recording_complete_once_with_exact_messages');
  const replay = await upload();assert.equal(replay.status,200);assert.equal((await replay.json()).path,saved.path);
  const listed = await client.storage.from('recordings').list(sessionId);assert.ifError(listed.error);
  assert.equal(listed.data.length,1);report.checks.push('identical_retry_single_object');
  const unauthorized = await anon.storage.from('recordings').download(saved.path);
  assert.ok(unauthorized.error);report.checks.push('anonymous_private_download_denied');
  assert.equal((await upload(randomUUID())).status,404);
  assert.equal((await upload(sessionId,'-1')).status,400);
  report.checks.push('missing_session_and_invalid_duration_rejected');
  // A corrupted collision must not be accepted merely because the path exists.
  const corrupt = await client.storage.from('recordings').update(saved.path,Buffer.from('different synthetic bytes'),{contentType:'audio/webm'});
  assert.ifError(corrupt.error);assert.equal((await upload()).status,500);
  report.checks.push('conflicting_content_rejected');
  const removed = await client.storage.from('recordings').remove([saved.path]);assert.ifError(removed.error);
  report.passed=true;
} catch(error) {
  report.error={name:error.name,code:error.code || null,message:String(error.message).replaceAll(config.SERVICE_ROLE_KEY,'[redacted]').replaceAll(config.ANON_KEY,'[redacted]').slice(0,350)};
} finally {
  try {
    if(sessionId) {
      const remaining = await client.storage.from('recordings').list(sessionId);assert.ifError(remaining.error);
      if(remaining.data.length) {
        const deleted = await client.storage.from('recordings').remove(remaining.data.map(item=>`${sessionId}/${item.name}`));
        assert.ifError(deleted.error);
      }
    }
    if(interviewId) {
      const deleted = await client.from('interviews').delete().eq('id',interviewId);assert.ifError(deleted.error);
      const leftover = await client.from('sessions').select('id').eq('interviewId',interviewId);assert.ifError(leftover.error);
      assert.equal(leftover.data.length,0);
    }
    if(userId) { const deleted = await client.auth.admin.deleteUser(userId);assert.ifError(deleted.error); }
    report.syntheticDataCleaned=true;
  } catch(error) {
    report.passed=false;report.syntheticDataCleaned=false;report.cleanupError={name:error.name,code:error.code || null};
  }
  report.requests=requests.length;
  writeFileSync(resolve(output,'result.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
}
process.exitCode=report.passed?0:1;
