import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createClient} from '@supabase/supabase-js';
import reportValidation from '../src/lib/ai/validate-report.ts';
const {validateReport}=reportValidation;
const root='output/local-sandbox/official-ten-20260915/';
const rows=JSON.parse(readFileSync(root+'retake-bound-private.json','utf8')).results;
if(rows.length!==10||new Set(rows.map(r=>r.newSessionId)).size!==10)throw Error('Exact ten boundary');
const cfg=JSON.parse(readFileSync('output/local-sandbox/supabase-status-private.json','utf8').replace(/^\uFEFF/,''));
if(cfg.API_URL!=='http://127.0.0.1:55321')throw Error('Local only');
const db=createClient(cfg.API_URL,cfg.SERVICE_ROLE_KEY,{auth:{persistSession:false}});
const key=JSON.parse(readFileSync('output/local-sandbox/real-report/reconcile-key-private.json','utf8')).key;
const guard=root+'report-repair-guard.json';
if(existsSync(guard))throw Error('Existing repair run; inspect receipts and server state before resuming');
const receipts=[];const save=()=>writeFileSync(guard,JSON.stringify(receipts,null,2));save();
for(const row of rows){
 const {data,error}=await db.from('sessions').select('id,status,summary,insights,themes,sentiment').eq('id',row.newSessionId).single();
 if(error||data.status!=='COMPLETED')throw Error('Completed local session required');
 writeFileSync(root+row.fixture+'.before-report-repair-private.json',JSON.stringify(data));
 let valid=false,canonical=false;
 const report={...structuredClone(data.insights||{}),summary:data.summary};
 try{validateReport(report,8);valid=true;canonical=Array.isArray(data.insights?.questionEvaluations);}catch{}
 const receipt={fixture:row.fixture,sessionId:data.id,action:valid?(canonical?'reuse':'normalize_without_model'):'repair_report_only',state:canonical&&valid?'reused':'dispatching'};
 receipts.push(receipt);save();
 if(receipt.state==='reused'){console.log(JSON.stringify(receipt));continue;}
 try{
  const response=await fetch('http://127.0.0.1:3300/api/v1/sessions/'+data.id+'/report',{method:'POST',headers:{Authorization:'Bearer '+key},redirect:'error',signal:AbortSignal.timeout(900000)});
  receipt.httpStatus=response.status;receipt.state=response.ok?'saved':'failed';
 }catch(e){receipt.state='unknown';receipt.errorType=e.name;}
 save();console.log(JSON.stringify(receipt));
}
