import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import {readFileSync} from "node:fs";
import {randomUUID} from "node:crypto";
import {companyKnowledgeVersion,pinCompanyKnowledge} from "../src/lib/recruitment-company-knowledge";
import {recruitmentInteractionReply,recruitmentUtterance,rememberRecruitmentInteraction} from "../src/lib/voice/recruitment-quality";
import {parseRecruitmentDecision,recruitmentDecisionSpeech} from "../src/lib/voice/recruitment-decision";
import {hasRecruitmentAnswer,readPersistedRecruitmentFollowUpBudget,mergePersistedRecruitmentFollowUpBudget,summarizeRecruitmentResumeBudget} from "../server/voice-relay-helpers";

function setup(index:number,answer:string,metadata:Record<string,unknown>={},conflict=false,saveFailure=false) {
  const questions=Array.from({length:8},(_,i)=>({id:`q${i}`,text:`合成主问题${i+1}`}));
  const session={id:"synthetic",interviewId:"synthetic",currentQuestionId:`q${index}`,participantMetadata:metadata,updatedAt:"2026-09-10T01:00:00Z",status:"IN_PROGRESS"};
  const messages=answer?[{id:`user:${answer}`,role:"USER",questionId:`q${index}`,content:answer,timestamp:"2026-09-10T01:01:00Z"}]:[];
  const updates:Record<string,unknown>[]=[]; const replies:Record<string,unknown>[]=[];
  let calls=0;let tick=0;let navigationFailure=false;
  const db={from:()=>{
    let updating:Record<string,unknown>|undefined;let expected:string|undefined;
    const query={select:()=>query,eq:(key:string,value:string)=>{if(key==="updatedAt")expected=value;return query;},single:async()=>({data:JSON.parse(JSON.stringify(session)),error:null}),
      order:async()=>({data:messages,error:null}),update:(data:Record<string,unknown>)=>{updating=data;updates.push(data);return query;},
      upsert:async(data:Record<string,unknown>)=>{
        if(saveFailure)return{error:{code:"synthetic_failure"}};
        if(!replies.some(r=>r.id===data.id))replies.push(data);return{error:null};},
      then:(resolve:(value:unknown)=>unknown)=>{
        const delivered=(updating?.participantMetadata as {recruitmentTextReply?:{delivered:boolean}})?.recruitmentTextReply?.delivered;
        if(!updating||conflict||expected!==session.updatedAt||(navigationFailure&&delivered))return resolve({data:[],error:null});
        Object.assign(session,updating,{updatedAt:`database-clock-${++tick}`});
        return resolve({data:[{id:session.id,updatedAt:session.updatedAt}],error:null});
      }};
    return query;
  }};
  const source=ts.createSourceFile("recruitment-chat.ts",readFileSync(new URL("../src/lib/ai/recruitment-chat.ts",import.meta.url),"utf8"),ts.ScriptTarget.Latest,true);
  const functions=source.statements.filter(ts.isFunctionDeclaration).map(node=>node.getText(source).replace(/^export /,""));
  const sandbox=vm.createContext({supabaseAdmin:db,randomUUID,companyKnowledgeVersion,pinCompanyKnowledge,recruitmentInteractionReply,recruitmentUtterance,rememberRecruitmentInteraction,
    parseRecruitmentDecision,recruitmentDecisionSpeech,hasRecruitmentAnswer,readPersistedRecruitmentFollowUpBudget,
    mergePersistedRecruitmentFollowUpBudget,summarizeRecruitmentResumeBudget,buildInterviewerPrompt:()=>[],
    getProvider:()=>({generateResponse:async()=>{calls++;return{content:JSON.stringify({action:"probe",evidence_quotes:[messages.at(-1)?.content||answer],missing_evidence:"验证",speech:"你如何验证？"})};}}),
    interview:{id:"synthetic",title:"数君招聘 · 工程师",language:"zh",questions,llmProvider:"synthetic"},
  });
  vm.runInContext(ts.transpileModule(functions.join("\n"),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,sandbox);
  return {run:()=>vm.runInContext("respondToRecruitmentChat(interview,'synthetic')",sandbox),updates,replies,session,
    addAnswer:(content:string)=>messages.push({id:`user-${messages.length}`,role:"USER",questionId:session.currentQuestionId,content,timestamp:new Date(1789000000000+messages.length*1000).toISOString()}),
    setSaveFailure:(value:boolean)=>{saveFailure=value;},setNavigationFailure:(value:boolean)=>{navigationFailure=value;},calls:()=>calls};
}
test("text opening reads Q1 and Q1 answer advances without probing",async()=>{
  const opening=setup(0,"");assert.equal((await opening.run()).content,"合成主问题1");assert.equal(opening.calls(),0);
  const answer=setup(0,"我负责接口设计。");const result=await answer.run();
  assert.equal(result.questionAdvanced,true);assert.equal(answer.calls(),0);assert.match(result.content,/合成主问题2/);
});
test("text company reply stays on its durable question and does not call a model",async()=>{
  const check=setup(2,"你们公司是做什么的？");const result=await check.run();
  assert.equal(result.questionAdvanced,false);assert.equal(result.isComplete,false);assert.equal(check.calls(),0);
  assert.equal(check.replies[0].questionId,"q2");
});
test("text evidence probe is persisted and cannot exceed per-question budget",async()=>{
  const first=setup(2,"我修改了接口。");assert.equal((await first.run()).questionAdvanced,false);
  assert.equal(first.calls(),1);
  const metadata=first.session.participantMetadata as Record<string,unknown>;
  assert.equal((metadata.recruitmentTextProbes as Record<string,number>).q2,1);
  const second=setup(2,"我用集成测试验证。",metadata);assert.equal((await second.run()).questionAdvanced,true);assert.equal(second.calls(),0);
});
test("text cannot complete with fewer than eight stored answers",async()=>{
  const check=setup(7,"我说明了合作方式。",{oprunRecruitmentFollowUpBudget:{inlineFollowUpsUsed:2,finalFollowUpsUsed:1}});
  const result=await check.run();assert.equal(result.isComplete,false);assert.equal(result.questionAdvanced,false);
});
test("concurrent text progress conflict never returns an unpersisted probe",async()=>{
  const check=setup(2,"我修改了接口。",{},true);await assert.rejects(check.run(),/progress changed/);assert.equal(check.replies.length,0);
});
test("text reply storage failure cannot move the question forward",async()=>{
  const check=setup(0,"我负责接口设计。",{},false,true);
  await assert.rejects(check.run(),/reply storage failed/);
  assert.equal(check.updates.length,1);assert.equal(check.updates[0].currentQuestionId,"q0");
});
test("failed text probe resumes same saved reply without a new model call or probe",async()=>{
  const check=setup(2,"我修改了接口。",{},false,true);
  await assert.rejects(check.run(),/reply storage failed/);
  check.setSaveFailure(false);const first=await check.run();const again=await check.run();
  assert.equal(first.content,again.content);assert.equal(check.calls(),1);assert.equal(check.replies.length,1);
  assert.equal(check.session.currentQuestionId,"q2");
});
test("failed navigation resumes once without duplicating the stored reply",async()=>{
  const check=setup(0,"我负责接口设计。");check.setNavigationFailure(true);
  await assert.rejects(check.run(),/navigation storage failed/);
  assert.equal(check.session.currentQuestionId,"q0");assert.equal(check.replies.length,1);
  check.setNavigationFailure(false);assert.equal((await check.run()).questionAdvanced,true);
  assert.equal(check.session.currentQuestionId,"q1");assert.equal(check.replies.length,1);
});

for(const scenario of ["我负责企业接口设计。","我参与电商设计，目标岗位是企业软件。","我仅参与审核，没有负责上线。"]){
  test(`eight-question text journey preserves probes, FAQ and completion: ${scenario}`,async()=>{
    const check=setup(0,"");await check.run();let completed=false;
    for(let i=0;i<8;i++){
      assert.equal(check.session.currentQuestionId,`q${i}`);
      if(i===2){
        check.addAnswer("你们公司是做什么的？");
        const reply=await check.run();assert.equal(reply.questionAdvanced,false);
        assert.equal(check.session.currentQuestionId,"q2");
      }
      check.addAnswer(scenario);let reply=await check.run();
      if(!reply.questionAdvanced&&!reply.isComplete){
        check.addAnswer("我通过测试和业务复核验证交付。");reply=await check.run();
      }
      completed=reply.isComplete;
      if(i<7)assert.equal(reply.questionAdvanced,true);
    }
    assert.equal(completed,true);assert.equal(check.calls(),3);
    const meta=check.session.participantMetadata as Record<string,unknown>;
    assert.equal((meta.recruitmentCompanyReplies as unknown[]).length,1);
    assert.equal(Object.keys(meta.recruitmentTextProbes as object).length,3);
  });
}
