import {readFileSync} from 'node:fs';
import {createClient} from '@supabase/supabase-js';
const cfg=JSON.parse(readFileSync('output/local-sandbox/supabase-status-private.json','utf8').replace(/^\uFEFF/,''));
if(cfg.API_URL!=='http://127.0.0.1:55321')throw Error('Local only');
const db=createClient(cfg.API_URL,cfg.SERVICE_ROLE_KEY,{auth:{persistSession:false}});
const rows=JSON.parse(readFileSync('output/local-sandbox/official-ten-20260915/retake-bound-private.json','utf8')).results;
for(const row of rows){
 const {data,error}=await db.from('sessions').select('id,summary,insights,interview:interviews!inner(title,objective,language,questions(id,text,order,type,description))').eq('id',row.newSessionId).single();
 if(error)throw error;
 const ev=data.insights?.questionEvaluations; const entries=Array.isArray(ev)?ev:ev?.items;
 if(entries)console.log(JSON.stringify({fixture:row.fixture,entries:entries.map(e=>({keys:Object.keys(e),matchedOrder:data.interview.questions.find(q=>q.text===e.question)?.order,scoreType:typeof e.score,score:e.score}))}));
 console.log(JSON.stringify({fixture:row.fixture,questionCount:data.interview.questions.length,questionOrders:data.interview.questions.map(q=>q.order),insightKeys:Object.keys(data.insights||{}),evaluationType:typeof data.insights?.questionEvaluations,evaluationKeys:Object.keys(data.insights?.questionEvaluations||{}),evaluationEntryKeys:Object.values(data.insights?.questionEvaluations||{}).map(v=>v&&typeof v==='object'?Object.keys(v):typeof v),summaryLength:data.summary?.length,objectiveLength:data.interview.objective?.length,language:data.interview.language}));
}
