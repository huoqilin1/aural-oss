import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { evaluateTranscriptManualAdvance, hasRecruitmentAnswer, isUserEndRequest, isUserSkipRequest, restoreRecruitmentQuestionTranscript, summarizeRecruitmentResumeBudget } from "../server/voice-relay-helpers";
import { hasEightScoredAnswers, recruitmentQ1Transition, recruitmentSpeechIntent } from "../src/lib/voice/recruitment-turn-policy";
import { shouldBlockRecruitmentCompletion } from "../src/lib/voice/completion-auto-close";

test("recruitment answer-done is not an interview-end command, including appended ASR", () => {
  for (const phrase of ["我答完了。", "我做完了。", "我的交付是台账和完整的手续，没有依据的数字不补充。我答完了。", "That's all.", "I'm done."]) {
    assert.equal(isUserEndRequest(phrase, { isRecruitmentInterview: true }), false, phrase);
  }
});

test("answer-done commands advance one question and do not fabricate an answer", () => {
  for (const text of ["我答完了。", "我已经回答完了", "答完了", "我答完了，请进入下一题。", "I'm done.", "That's all.", "Next question."]) {
    assert.equal(recruitmentSpeechIntent(text), "answer_done", text);
    assert.equal(isUserSkipRequest(text, { isRecruitmentInterview: true }), true, text);
    assert.equal(hasRecruitmentAnswer(text), false, text);
  }
  for (const text of ["我负责入职台账，核对过两次数据。我答完了。", "我本人负责交付，请进入下一题。", "I led the project. I'm done."]) {
    assert.equal(hasRecruitmentAnswer(text), true, text);
    assert.equal(recruitmentSpeechIntent(text), "answer_done", text);
  }
});

test("explicit interview withdrawal is distinct from task descriptions and negations", () => {
  for (const text of ["结束面试", "我要结束整个面试。", "Please end the interview.", "I'm done with the interview."]) {
    assert.equal(recruitmentSpeechIntent(text), "end_interview", text);
  }
  for (const text of ["不要结束面试", "我不想结束面试", "我负责结束面试后的资料归档", "I finished the interview workflow for our project."]) {
    assert.equal(recruitmentSpeechIntent(text), null, text);
  }
});

test("Q1 always transitions after an actual answer but not greetings or repeat requests", () => {
  for (const control of ["你好", "请再说一遍", "能听到吗", "Can you hear me?"]) assert.equal(hasRecruitmentAnswer(control), false, control);
  assert.match(recruitmentQ1Transition({ recruitment:true, questionIndex:0, hasAnswer:true, controlOnly:false, isZh:true })!, /\[NEXT\]$/);
  for (const override of [{ hasAnswer:false }, { controlOnly:true }, { recruitment:false }, { questionIndex:1 }]) {
    assert.equal(recruitmentQ1Transition({ recruitment:true, questionIndex:0, hasAnswer:true, controlOnly:false, isZh:true, ...override }), null);
  }
});

test("completion requires eight distinct scored answers, not current index or closing", () => {
  for (let count=0; count<8; count++) assert.equal(hasEightScoredAnswers(Array.from({length:count}, (_, i)=>i)), false);
  assert.equal(hasEightScoredAnswers([0,1,2,3,4,5,6,6,8]), false);
  assert.equal(hasEightScoredAnswers([0,1,2,3,4,5,6,7]), true);
  assert.equal(hasEightScoredAnswers([0,1,2,3,4,5,6,7,8]), true);
});

test("reconnect rehydrates substantive answers but not answer-done control messages", () => {
  const ids=Array.from({length:8}, (_, i)=>`q${i}`);
  const messages=ids.map((questionId, i)=>({role:"USER", questionId, content:`我负责项目${i}的交付，我答完了。`, timestamp:`2026-09-06T10:00:0${i}Z`}));
  const summary=summarizeRecruitmentResumeBudget(ids, messages);
  assert.equal(hasEightScoredAnswers(summary.answersByQuestion.filter(([, n])=>n>0).map(([i])=>i)), true);
  messages[7].content="我答完了。";
  const incomplete=summarizeRecruitmentResumeBudget(ids, messages);
  assert.equal(hasEightScoredAnswers(incomplete.answersByQuestion.filter(([, n])=>n>0).map(([i])=>i)), false);
});

test("reconnect restores the current answer for manual next but does not bypass an unanswered follow-up", () => {
  const messages=[{role:"USER", questionId:"q1", content:"上一题回答"},
    {role:"USER", questionId:"q2", content:"我负责入职台账和交付。"},
    {role:"ASSISTANT", questionId:"q2", content:"谢谢你的分享。"}];
  const restored=restoreRecruitmentQuestionTranscript("q2", messages);
  assert.equal(restored.length, 2);
  assert.equal(restored.some((entry)=>hasRecruitmentAnswer(entry.text)), true);
  const decision=(latestQuestion:boolean)=>evaluateTranscriptManualAdvance({isTransitioning:false, assistantBusy:false,
    isRecruitmentInterview:true, hasCommittedUserTurn:restored.some((entry)=>entry.role === "user"),
    latestTranscriptRole:"assistant", latestAssistantLooksLikeQuestion:latestQuestion});
  assert.equal(decision(false).allowed, true);
  assert.equal(decision(true).allowed, false);
  assert.deepEqual(restoreRecruitmentQuestionTranscript(undefined, messages), []);
});

test("a premature relay complete signal cannot bypass the recruitment UI guard at Q2", () => {
  assert.equal(shouldBlockRecruitmentCompletion({isRecruitmentInterview:true, interviewComplete:true,
    totalQuestions:9, currentQuestionIndex:1, answeredCurrentQuestion:true, plannedMainQuestionCount:8}), true);
});

// Execute the actual nested relay functions with isolated I/O dependencies.
// These tests do not start a live relay or call any model, speech, or database service.
function relayFunctions(file: string, names: string[], context: Record<string, unknown>) {
  const source=ts.createSourceFile(file, readFileSync(new URL(`../server/${file}`, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  const found=new Map<string,string>();
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text)) found.set(node.name.text, node.getText(source));
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.equal(found.size, names.length);
  const sandbox=vm.createContext(context);
  vm.runInContext(ts.transpileModule(Array.from(found.values()).join("\n"), {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText, sandbox);
  return sandbox;
}

test("primary relay real response function never calls the model for answered Q1 or answer-done Q2", async () => {
  for (const index of [0,1]) {
    const sandbox=relayFunctions("voice-relay.ts", ["generateControlledResponse"], {
      currentQuestionIndex:index, sortedQuestions:[{text:"介绍"},{text:"经历"}],
      PROMPTS:{formatHistory:()=>""}, questionTranscript:[], isZh:true,
      getLatestAnsweredExchange:()=>({participant:"我负责项目交付。"}),
      isOprunRecruitmentInterview:true, isRecruitmentConversationControl:()=>false,
      recruitmentAnsweredQuestions:new Set([index]), recruitmentQ1Transition,
      buildAgentContext:()=>{throw new Error("Q1/explicit done must not invoke context/model generation");},
    });
    const response=await vm.runInContext(`generateControlledResponse({forceSkip:${index === 1}})`, sandbox);
    assert.match(response, /\[NEXT\]$/);
    assert.doesNotMatch(response, /[?？]|再见/);
  }
});

test("primary relay rejects all early end paths before farewell audio, status changes or completion events", async () => {
  for (const call of ["queueFarewellAndEnd('test')", "endInterview()", "speakAndHandle('再见', {pendingFarewell:true})"]) {
    const events: Array<{type:string}>=[];
    const sandbox=relayFunctions("voice-relay.ts", ["rejectIncompleteRecruitmentEnd","queueFarewellAndEnd","endInterview","speakAndHandle"], {
      interviewDone:false, endingInterview:false, awaitingFinalResponse:false,
      isOprunRecruitmentInterview:true, recruitmentAnsweredQuestions:new Set([0,1]),
      hasEightScoredAnswers, currentQuestionIndex:1, isZh:true, WebSocket:{OPEN:1},
      browserWs:{readyState:1, send:(data:string)=>events.push(JSON.parse(data))},
      speakText:()=>{throw new Error("Premature farewell must not be spoken");},
      ownsPersistedSession:()=>{throw new Error("Must reject before terminal lifecycle");},
    });
    await vm.runInContext(call, sandbox);
    assert.deepEqual(events.map((event)=>event.type), ["transition_rejected"]);
    assert.equal(sandbox.interviewDone, false);
    assert.equal(sandbox.endingInterview, false);
  }
});

test("backup relay real completion gate recovers incomplete state and permits eight answered questions", () => {
  for (const count of [2,8]) {
    const events: Array<{type:string}>=[];
    const sandbox=relayFunctions("openai-voice-relay.ts", ["recruitmentCanComplete","markInterviewComplete"], {
      isOprunRecruitmentInterview:true,
      recruitmentAnswersByQuestion:new Map(Array.from({length:count}, (_,i)=>[i,1])),
      hasEightScoredAnswers, pendingInterviewComplete:true, interviewCompleteTimer:null,
      interviewDone:true, send:(event:{type:string})=>events.push(event), log:{info:()=>{}},
    });
    vm.runInContext("markInterviewComplete('test')", sandbox);
    assert.deepEqual(events.map((event)=>event.type), [count===8 ? "interview_complete" : "transition_rejected"]);
    if(count===2) assert.equal(sandbox.interviewDone, false);
  }
});
