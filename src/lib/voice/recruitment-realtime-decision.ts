import {recruitmentDecisionInstructions, parseRecruitmentDecision, recruitmentDecisionSpeech} from "./recruitment-decision";
import {PROMPTS} from "../../../server/voice-relay-prompts";

export function recruitmentRealtimeDecisionRequest(id:string, question:string, answer:string, isZh:boolean) {
  const prompts=PROMPTS.response.normal({aiName:"小君",title:"数君招聘",qNum:3,totalQs:8,
    qText:question,qType:"TEXT",choiceInstruction:"",history:`候选人：${answer}`,latestParticipantAnswer:answer,
    followUpInstruction:"本题尚未追问；只有当前目标关键缺口才使用一次。",nextToken:"[NEXT]",prevToken:"[PREV]",userTurns:1});
  return {conversation:"none",metadata:{topic:"recruitment_evidence",decisionId:id},
    output_modalities:["text"],tools:[],tool_choice:"none",max_output_tokens:1024,
    instructions:recruitmentDecisionInstructions(isZh),
    input:[{type:"message",role:"user",content:[{type:"input_text",text:isZh?prompts.zh:prompts.en}]}]};
}

export function readRecruitmentRealtimeDecision(response:unknown, answer:string, isZh:boolean) {
  const data=response as {status?:string;output?:{content?:{type?:string;text?:string}[]}[]};
  const raw=data?.status==="completed" && Array.isArray(data.output)
    ? data.output.flatMap(item=>Array.isArray(item.content)?item.content:[])
      .filter(item=>item.type==="output_text"&&typeof item.text==="string").map(item=>item.text).join("") : "";
  const decision=parseRecruitmentDecision(raw,answer);
  return {advance:decision?.action==="advance",speech:recruitmentDecisionSpeech(raw,answer,isZh).replace("[NEXT]","").trim()};
}

export function recruitmentRealtimeSpeechRequest(text:string) {
  return {input:[],output_modalities:["audio"],tools:[],tool_choice:"none",
    instructions:`Read exactly this approved utterance. Do not add, infer, answer, or call tools: ${JSON.stringify(text)}`};
}
