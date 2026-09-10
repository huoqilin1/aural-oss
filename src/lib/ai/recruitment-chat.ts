import { supabaseAdmin } from "@/lib/supabase/admin";
import type { Tables, Json } from "@/lib/supabase/types";
import { getProvider } from "./registry";
import { buildInterviewerPrompt } from "./prompts/interviewer";
import { randomUUID } from "node:crypto";
import { companyKnowledgeVersion, pinCompanyKnowledge } from "../recruitment-company-knowledge";
import { recruitmentInteractionReply, recruitmentUtterance, rememberRecruitmentInteraction } from "../voice/recruitment-quality";
import { parseRecruitmentDecision, recruitmentDecisionSpeech } from "../voice/recruitment-decision";
import { hasRecruitmentAnswer, readPersistedRecruitmentFollowUpBudget,
  mergePersistedRecruitmentFollowUpBudget, summarizeRecruitmentResumeBudget } from "../../../server/voice-relay-helpers";

type Interview = Tables<"interviews"> & {questions: Tables<"questions">[]};
type PreparedReply = {
  sourceId:string; messageId:string; questionId:string; nextQuestionId:string;
  content:string; questionAdvanced:boolean; isComplete:boolean; delivered:boolean;
}

async function finishPreparedReply(sessionId:string, updatedAt:string, metadata:Record<string,unknown>, reply:PreparedReply) {
  // The ID and payload were persisted before the first insert. Repeating an
  // uncertain insert is therefore an idempotent completion, not a new reply.
  const {error}=await supabaseAdmin.from("messages").upsert({id:reply.messageId,sessionId,role:"ASSISTANT",
    questionId:reply.questionId,content:reply.content,wordCount:reply.content.split(/\s+/).length},
    {onConflict:"id",ignoreDuplicates:true});
  if(error)throw new Error("Recruitment reply storage failed");
  const {data:moved,error:moveError}=await supabaseAdmin.from("sessions").update({
    currentQuestionId:reply.nextQuestionId, participantMetadata:{...metadata,recruitmentTextReply:{...reply,delivered:true}} as Json,
    updatedAt:new Date().toISOString(),
  }).eq("id",sessionId).eq("updatedAt",updatedAt).select("id");
  if(moveError||!moved?.length)throw new Error("Recruitment navigation storage failed");
  return {content:reply.content,questionAdvanced:reply.questionAdvanced,isComplete:reply.isComplete};
}
export function recruitmentChatProbeAllowed(index:number, total:number, final:number, perQuestion:number) {
  return perQuestion===0 && ((index>=1 && index<=6 && total<2) || (index===7 && final<1));
}

/** Text uses durable question identity and the same evidence/FAQ contract.
 * A compare-and-set prevents concurrent requests from resetting probe budgets.
 */
export async function respondToRecruitmentChat(interview:Interview, sessionId:string) {
  const {data:session,error:sessionError}=await supabaseAdmin.from("sessions")
    .select("id,interviewId,currentQuestionId,participantMetadata,updatedAt,status").eq("id",sessionId)
    .eq("interviewId",interview.id).single();
  if(sessionError||!session||session.status!=="IN_PROGRESS") throw new Error("Recruitment session unavailable");
  const {data:stored,error:messageError}=await supabaseAdmin.from("messages")
    .select("id,role,content,questionId,timestamp").eq("sessionId",sessionId).order("timestamp",{ascending:true});
  if(messageError) throw new Error("Recruitment evidence unavailable");
  const metadata=pinCompanyKnowledge(session.participantMetadata);
  const newestUser=[...(stored||[])].reverse().find(m=>m.role==="USER");
  const sourceId=newestUser?.id||`opening:${sessionId}`;
  const savedReply=metadata.recruitmentTextReply as unknown as PreparedReply|undefined;
  if(savedReply && !savedReply.delivered){
    // Finish an uncertain write even when another user message has arrived.
    // Replacing this reservation would lose the earlier reply and its linkage.
    return finishPreparedReply(sessionId,session.updatedAt,metadata,savedReply);
  }
  if(savedReply && savedReply.sourceId===sourceId)
    return {content:savedReply.content,questionAdvanced:savedReply.questionAdvanced,isComplete:savedReply.isComplete};
  const questions=interview.questions;
  const index=session.currentQuestionId ? questions.findIndex(q=>q.id===session.currentQuestionId) : 0;
  if(index<0||!questions[index]) throw new Error("Recruitment question unavailable");
  const current=questions[index];
  const messages=stored||[];
  const latest=[...messages].reverse().find(m=>m.role==="USER"&&m.questionId===current.id);
  const answer=latest?.content||"";
  const isZh=interview.language.startsWith("zh");
  const interaction=recruitmentInteractionReply(answer,interview.title,new Date(),companyKnowledgeVersion(metadata));
  const summary=summarizeRecruitmentResumeBudget(questions.map(q=>q.id),messages);
  const persisted=readPersistedRecruitmentFollowUpBudget(session.participantMetadata);
  let total=Math.max(summary.inlineFollowUpsUsed,persisted?.inlineFollowUpsUsed||0);
  let final=Math.max(summary.finalFollowUpsUsed,persisted?.finalFollowUpsUsed||0);
  const rawCounts=metadata.recruitmentTextProbes;
  const counts:Record<string,number>=rawCounts&&typeof rawCounts==="object"&&!Array.isArray(rawCounts)
    ? Object.fromEntries(Object.entries(rawCounts).filter(([,v])=>typeof v==="number"&&v>=0)) as Record<string,number> : {};
  const used=Math.max(counts[current.id]||0,new Map(summary.followUpsByQuestion).get(index)||0);
  const canProbe=recruitmentChatProbeAllowed(index,total,final,used);
  let content:string;
  let advance=false;
  let consumed=false;
  if(interaction) content=interaction.text;
  else if(!answer) content=current.text;
  else if(!hasRecruitmentAnswer(answer)||recruitmentUtterance(answer).kind==="correction") {
    content=isZh?"明白，请按你的实际情况继续。":"Understood; please continue with your actual experience.";
  } else if(index===0||!canProbe||index>=8) {
    content=isZh?"明白，谢谢。":"Understood, thank you.";
    advance=true;
  } else {
    const prompt=buildInterviewerPrompt({interview,currentQuestionIndex:index,
      conversationHistory:messages.filter(m=>m.role==="USER"||m.role==="ASSISTANT")
        .map(m=>({role:m.role==="USER"?"user" as const:"assistant" as const,content:m.content}))});
    const generated=await getProvider(interview.llmProvider).generateResponse({messages:prompt,
      model:interview.llmModel||undefined,temperature:0.7,maxTokens:1024});
    const decision=parseRecruitmentDecision(generated.content,answer);
    content=recruitmentDecisionSpeech(generated.content,answer,isZh).replace("[NEXT]","").trim();
    advance=decision?.action==="advance";
    consumed=decision?.action==="probe";
    if(consumed){counts[current.id]=1;if(index===7)final++;else total++;}
  }
  const allAnswered=Array.from({length:8},(_,i)=>i).every(i=>new Map(summary.answersByQuestion).has(i));
  const next=advance?questions[index+1]:undefined;
  const isComplete=advance&&!next&&allAnswered;
  if(advance&&!next&&!allAnswered){advance=false;content=isZh?"请继续完成当前问题。":"Please finish the current question.";}
  if(next)content+=` ${next.text}`;
  const prepared:PreparedReply={sourceId,messageId:randomUUID(),questionId:next?.id||current.id,
    nextQuestionId:next?.id||current.id,content,questionAdvanced:advance&&!!next,isComplete,delivered:false};
  const replyMetadata=interaction?rememberRecruitmentInteraction(metadata,current.id,interaction):metadata;
  const nextMetadata={...mergePersistedRecruitmentFollowUpBudget(replyMetadata,{inlineFollowUpsUsed:total,finalFollowUpsUsed:final}),
    recruitmentTextProbes:counts,recruitmentTextReply:prepared};
  // Claim progress before returning any new probe; a storage failure cannot
  // silently acknowledge delivery. Keep a consumed failed probe fail-closed.
  const claimedAt=new Date().toISOString();
  const {data:claimed,error:claimError}=await supabaseAdmin.from("sessions").update({
    participantMetadata:nextMetadata as Json,updatedAt:claimedAt,currentQuestionId:current.id,
  }).eq("id",sessionId).eq("updatedAt",session.updatedAt).select("id,updatedAt");
  if(claimError||!claimed?.length)throw new Error("Recruitment progress changed; response not delivered");
  return finishPreparedReply(sessionId,claimed[0].updatedAt,nextMetadata,prepared);
}
