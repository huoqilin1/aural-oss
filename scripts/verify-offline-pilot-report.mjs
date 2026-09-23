import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createClient} from '@supabase/supabase-js';
const root='output/local-sandbox/real-report/';
const fixture=JSON.parse(readFileSync(root+'offline-pilot-private.json'));
const cfg=JSON.parse(readFileSync('output/local-sandbox/supabase-status-private.json','utf8').replace(/^\uFEFF/,''));
assert.equal(cfg.API_URL,'http://127.0.0.1:55321');assert.equal(fixture.synthetic,true);
const db=createClient(cfg.API_URL,cfg.SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
const result=await db.from('sessions').select('id,status,summary,themes,sentiment,insights').eq('id',fixture.sessionId).single();
assert.ifError(result.error);
const messages=await db.from('messages').select('id,role,content,questionId').eq('sessionId',fixture.sessionId).order('timestamp');
assert.ifError(messages.error);
const answers=messages.data.filter(m=>m.role==='USER'&&m.content?.trim());
const receipt={status:result.data.status,answers:answers.length,answeredQuestions:new Set(answers.map(a=>a.questionId)).size,
  summaryCharacters:result.data.summary?.length||0,questionEvaluations:result.data.insights?.questionEvaluations?.length||0,
  scope:'local synthetic voice pilot; not official-site intake or ten-way acceptance'};
receipt.passed=receipt.status==='COMPLETED'&&receipt.answeredQuestions===8&&receipt.summaryCharacters>0&&receipt.questionEvaluations===8;
if(receipt.passed){
  const snapshot={session:result.data,answers};
  receipt.reportHash=createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  writeFileSync(root+'offline-pilot-persisted-report.json',JSON.stringify(snapshot));
}
writeFileSync(root+'offline-pilot-report-receipt.json',JSON.stringify(receipt,null,2));
console.log(JSON.stringify(receipt));
if(!receipt.passed)process.exitCode=2;
