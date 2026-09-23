import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createClient} from '@supabase/supabase-js';
const root='output/local-sandbox/official-ten-20260915/';
const rows=JSON.parse(readFileSync(root+'retake-bound-private.json','utf8')).results;
if(rows.length!==10||new Set(rows.map(x=>x.newSessionId)).size!==10)throw Error('Exact ten session boundary');
const cfg=JSON.parse(readFileSync('output/local-sandbox/supabase-status-private.json','utf8').replace(/^\uFEFF/,''));
if(cfg.API_URL!=='http://127.0.0.1:55321')throw Error('Local only');
const db=createClient(cfg.API_URL,cfg.SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
const sessions=await db.from('sessions').select('id,status,summary,themes,sentiment,insights').in('id',rows.map(x=>x.newSessionId));
const messages=await db.from('messages').select('id,sessionId,role,content,questionId').in('sessionId',rows.map(x=>x.newSessionId)).order('timestamp');
const questions=await db.from('questions').select('id,interviewId,order').in('interviewId',rows.map(x=>x.aural_interview_id));
for(const r of [sessions,messages,questions])if(r.error)throw r.error;
const results=rows.map(row=>{
 const session=sessions.data.find(x=>x.id===row.newSessionId);
 const core=questions.data.filter(x=>x.interviewId===row.aural_interview_id&&x.order<8).map(x=>x.id);
 const answers=messages.data.filter(x=>x.sessionId===row.newSessionId&&x.role==='USER'&&x.content?.trim()&&core.includes(x.questionId));
 const result={fixture:row.fixture,attemptId:row.newHrAttemptId,sessionId:row.newSessionId,status:session?.status,
  coreQuestions:core.length,answeredQuestions:new Set(answers.map(x=>x.questionId)).size,
  answerMessages:answers.length,summaryChars:session?.summary?.length||0,evaluations:session?.insights?.questionEvaluations?.length||0};
 result.passed=result.status==='COMPLETED'&&result.coreQuestions===8&&result.answeredQuestions===8&&result.summaryChars>0&&result.evaluations===8;
 if(result.summaryChars>0){
  const snapshot={session,answers};result.reportHash=createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  writeFileSync(root+row.fixture+'.retake-report-private.json',JSON.stringify(snapshot));
 }
 return result;
});
const receipt={scope:'local voice retest after official intake; original failures retained',passed:results.every(x=>x.passed),results};
writeFileSync(root+'retake-reports-receipt.json',JSON.stringify(receipt,null,2));
console.log(JSON.stringify(receipt));
