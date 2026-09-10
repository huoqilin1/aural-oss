/** Explicit, bounded local synthetic prompt check. No production sessions/DB.
 * Usage: RECRUIT_QUALITY_MODEL_CHECK=1 node --import tsx scripts/check-recruit-quality-model.ts
 * Raw synthetic responses are review evidence; automatic flags are NOT human acceptance.
 */
import OpenAI from "openai";
import { mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { QUALITY_CASES } from "../tests/fixtures/recruit-quality-cases";
import { PROMPTS } from "../server/voice-relay-prompts";
import { recruitmentInteractionReply, RECRUIT_QUALITY_VERSION } from "../src/lib/voice/recruitment-quality";
import { recruitmentDecisionSpeech, parseRecruitmentDecision } from "../src/lib/voice/recruitment-decision";
import { recruitmentRealtimeDecisionRequest } from "../src/lib/voice/recruitment-realtime-decision";

async function main() {
  if (process.env.RECRUIT_QUALITY_MODEL_CHECK !== "1") throw new Error("Explicit local model check flag required");
  if (!process.env.DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY unavailable");
  const output = join(process.cwd(), "test-results", `quality-${Date.now()}`);
  mkdirSync(output,{recursive:true});
  const model = process.env.DEEPSEEK_MODEL || "deepseek-chat";
  const backupPrompt=process.env.RECRUIT_QUALITY_PROMPT_PATH==="backup";
  const client = new OpenAI({apiKey:process.env.DEEPSEEK_API_KEY,
    baseURL:process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com", maxRetries:0, timeout:45000});
  writeFileSync(join(output,"manifest.json"),JSON.stringify({version:RECRUIT_QUALITY_VERSION,model,
    sampleCount:60,runs:3,synthetic:true,scope:`${backupPrompt?"backup":"primary"} prompt + deterministic FAQ via DeepSeek; not live primary/backup voice`,humanReview:"pending"},null,2));
  console.log(`Evidence directory: ${output}`);
  for(let run=1;run<=3;run++) {
    let flagged=0;
    for(const item of QUALITY_CASES) {
      const started=Date.now();
      let response:string; let sourceId:string|undefined; let rawDecision:string|undefined;
      if(item.kind.endsWith("faq")) {
        const reply=recruitmentInteractionReply(item.answer,item.title||"数君招聘 · 工程师",new Date("2026-09-10T10:00:00Z"));
        response=reply?.text||""; sourceId=reply?.sourceId;
      } else {
        const prompt=PROMPTS.response.normal({aiName:"小君",title:"数君招聘 · 工程师",qNum:item.questionIndex+1,totalQs:8,
          qText:`请说明${item.goal}。`,qType:"TEXT",choiceInstruction:"",history:`候选人：${item.answer}`,
          latestParticipantAnswer:item.answer,followUpInstruction:"本题尚未追问；就地追问剩余2次。只有目标关键缺口才使用一次。",
          nextToken:"[NEXT]",prevToken:"[PREV]",userTurns:1}).zh;
        try {
          const backup=recruitmentRealtimeDecisionRequest(item.id,`请说明${item.goal}。`,item.answer,true);
          const result=await client.chat.completions.create({model,messages:backupPrompt?
            [{role:"system",content:backup.instructions},{role:"user",content:backup.input[0].content[0].text}]:[{role:"user",content:prompt}],temperature:0.7,max_tokens:300});
          rawDecision=result.choices[0]?.message?.content||"";
          response=recruitmentDecisionSpeech(rawDecision,item.answer);
        } catch(error) {
          appendFileSync(join(output,"results.jsonl"),JSON.stringify({run,id:item.id,error:error instanceof OpenAI.APIError?{status:error.status,code:error.code}:"request_failed"})+"\n");
          throw new Error(`Model check stopped at ${item.id}; inspect sanitized evidence`);
        }
      }
      const machineFlag=item.kind.endsWith("faq") ? sourceId!==item.expected
        : !parseRecruitmentDecision(rawDecision||"",item.answer) || (item.kind==="sufficient" ? !response.includes("[NEXT]") : !/[?？]/.test(response)||response.includes("[NEXT]"));
      if(machineFlag)flagged++;
      appendFileSync(join(output,"results.jsonl"),JSON.stringify({run,...item,response,rawDecision,sourceId,machineFlag,elapsedMs:Date.now()-started,humanReview:"pending"})+"\n");
      if(item.id==="P1"||item.id==="S10"||item.id==="U10")console.log(`Run ${run}: ${item.id}; flags so far ${flagged}`);
    }
    console.log(`Run ${run}: 60 outputs retained; machine flags ${flagged}; human review pending`);
  }
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
