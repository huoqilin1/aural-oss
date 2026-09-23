import {readFileSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {createClient} from '@supabase/supabase-js';
import {buildInterviewerPrompt} from '../src/lib/ai/prompts/interviewer';
import {ZhipuProvider} from '../src/lib/ai/providers/zhipu';
import {parseRecruitmentDecision} from '../src/lib/voice/recruitment-decision';
async function main(){
 const cfg=JSON.parse(readFileSync('output/local-sandbox/supabase-status-private.json','utf8').replace(/^\uFEFF/,''));
 assert.equal(cfg.API_URL,'http://127.0.0.1:55321');
 const fixture=JSON.parse(readFileSync('output/local-sandbox/real-report/live-fixture-private.json','utf8'));
 const db=createClient(cfg.API_URL,cfg.SERVICE_ROLE_KEY,{auth:{persistSession:false}});
 const {data:interview,error}=await db.from('interviews').select('*,questions(*)').eq('id',fixture.interviewId).single();assert.ifError(error);
 interview.questions.sort((a:any,b:any)=>a.order-b.order);
 const {data:messages,error:me}=await db.from('messages').select('*').eq('sessionId',fixture.sessionId).order('timestamp');assert.ifError(me);
 const last=messages.findLastIndex((m:any)=>m.role==='USER');
 const history=messages.slice(0,last+1);
 const index=interview.questions.findIndex((q:any)=>q.id===messages[last].questionId);
 const prompt=buildInterviewerPrompt({interview,currentQuestionIndex:index,conversationHistory:history.filter((m:any)=>['USER','ASSISTANT'].includes(m.role)).map((m:any)=>({role:m.role.toLowerCase(),content:m.content}))});
 process.env.ZHIPU_API_KEY=JSON.parse(readFileSync('C:/Users/wang/.zcode/v2/config.json','utf8')).provider['builtin:bigmodel-coding-plan'].options.apiKey;
 process.env.ZHIPU_BASE_URL='https://open.bigmodel.cn/api/coding/paas/v4';
 const provider=new ZhipuProvider();const receipts=[];
 for(const disableThinking of [false,true]){
  const result=await provider.generateResponse({messages:prompt,model:'glm-5.3',temperature:0.7,maxTokens:1024,disableThinking});
  const receipt={diagnosticOnly:true,disableThinking,finishReason:result.finishReason,contentCharacters:result.content.length,usage:result.usage,decision:parseRecruitmentDecision(result.content,messages[last].content)};
  receipts.push(receipt);console.log(JSON.stringify(receipt));
 }
 writeFileSync('output/live-decision-diagnostic-20260915.json',JSON.stringify(receipts,null,2));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
