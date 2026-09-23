import {readFileSync,writeFileSync} from 'node:fs';
import {createClient} from '@supabase/supabase-js';
const root='output/local-sandbox/official-ten-20260915/';
const a=JSON.parse(readFileSync(root+'attempts-private.json','utf8'));
const cfg=JSON.parse(readFileSync('output/local-sandbox/supabase-status-private.json','utf8').replace(/^\uFEFF/,''));
if(cfg.API_URL!=='http://127.0.0.1:55321')throw Error('local only');
const db=createClient(cfg.API_URL,cfg.SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
const s=await db.from('sessions').select('id,status,interviewId,summary,insights').in('interviewId',a.map(x=>x.aural_interview_id));
if(s.error)throw s.error;
const m=await db.from('messages').select('sessionId,role,content,questionId').in('sessionId',s.data.map(x=>x.id));
if(m.error)throw m.error;
const results=s.data.map(x=>{const msgs=m.data.filter(v=>v.sessionId===x.id),answers=msgs.filter(v=>v.role==='USER'&&v.content?.trim());
return {id:x.id,hrAttempt:a.find(v=>v.aural_interview_id===x.interviewId)?.id,
  hrMapped:a.some(v=>v.aural_session_id===x.id),status:x.status,answers:answers.length,
  answeredQuestions:new Set(answers.map(v=>v.questionId)).size,answerChars:answers.map(v=>v.content.length),
  summaryChars:x.summary?.length||0,evaluations:x.insights?.questionEvaluations?.length||0};});
writeFileSync(root+'sessions-receipt.json',JSON.stringify(results,null,2));
console.log(JSON.stringify(results));
