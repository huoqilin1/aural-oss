import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { evaluateTranscriptManualAdvance, hasRecruitmentAnswer, isUserEndRequest, isUserSkipRequest, mergeAsrSegments, restoreRecruitmentQuestionTranscript, summarizeRecruitmentResumeBudget } from "../server/voice-relay-helpers";
import { hasEightScoredAnswers, recruitmentQ1Transition, recruitmentSpeechIntent, recruitmentControlOnly } from "../src/lib/voice/recruitment-turn-policy";
import { shouldBlockRecruitmentCompletion } from "../src/lib/voice/completion-auto-close";
import { createAnswerCommitGate } from "../server/answer-commit-gate";

test("completion preflight retains late messages and serializes subsequent saves", async () => {
  const source = ts.createSourceFile("use-voice.ts", readFileSync(new URL("../src/hooks/use-voice.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  let callback = "";
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "saveAndComplete"
      && node.initializer && ts.isCallExpression(node.initializer)) callback = node.initializer.arguments[0].getText(source);
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(callback);
  for (const [ok, concurrent] of [[true, false], [false, false], [true, true], [false, true]]) {
    const trackedMessagesRef = { current: [{ role: "user", content: "最初回答", questionId: "q8" }] };
    const bodies: Array<{ messages: Array<{ content: string }> }> = [];
    let release: (value: unknown) => void = () => {};
    const sandbox = vm.createContext({
      trackedMessagesRef, progressSaveChainRef: { current: Promise.resolve() },
      asrBufferRef: { current: "" }, chatBufferRef: { current: "" }, currentQuestionIndexRef: { current: 7 },
      questionIdAt: () => "q8", sessionId: "local-preflight", AbortController, setTimeout, clearTimeout,
      log: { info: () => {} }, requeueFailedProgressMessages: (a: unknown[], b: unknown[]) => [...a, ...b],
      fetch: async (_url: string, options: { body: string }) => {
        bodies.push(JSON.parse(options.body));
        if (bodies.length === 1) return await new Promise(resolve => { release = resolve; });
        return { ok: true };
      },
    });
    vm.runInContext(ts.transpileModule(`const saveAndComplete = ${callback}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, sandbox);
    const first = vm.runInContext("saveAndComplete(true)", sandbox);
    const firstResult = Promise.resolve(first).then(() => true, () => false);
    await new Promise(resolve => setImmediate(resolve));
    trackedMessagesRef.current.push({ role: "user", content: "补充证据", questionId: "q8" });
    const queued = concurrent ? vm.runInContext("saveAndComplete(true)", sandbox) : null;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(bodies.length, 1, "second save raced past the first ACK");
    release({ ok, status: 503, json: async () => ({ error: "local failure" }) });
    assert.equal(await firstResult, ok);
    if (!concurrent) assert.ok(trackedMessagesRef.current.some(m => m.content === "补充证据"), "late message was erased by preflight ACK");
    await (queued ?? vm.runInContext("saveAndComplete(true)", sandbox));
    assert.deepEqual(bodies[1].messages.map(m => m.content), ok ? ["补充证据"] : ["最初回答", "补充证据"]);
  }
});

test("actual inactivity termination persists the current answer before publishing a terminal state", async () => {
  const order: string[] = [];
  const noop = () => {};
  const sandbox = relayFunctions("voice-relay.ts", ["abandonForInactivity"], {
    interviewDone:false, endingInterview:false, ownsPersistedSession:()=>true,
    clearSilenceAutoSkip:noop, clearPendingAsrFinal:noop, cancelTts:noop,
    ctxSessionId:"local-abandon-test", liveSessions:new Map(),
    isOprunRecruitmentInterview:true, currentQuestionIndex:5, lastUserAudioActivityAt:0,
    questionTranscript:[{role:"user",text:"我已经回答本题，追问暂时没有继续回复。"}],
    retainDeferredAnswerBeforeTransition:()=>order.push("retain"),
    answerCommitGate:{request:async()=>{order.push("save");return true;}},
    persistSessionStatus:async()=>{order.push("terminal");return true;},
    browserWs:{readyState:1,send:()=>order.push("notify")},WebSocket:{OPEN:1},
    log:{info:noop,warn:noop,error:noop},
  });
  await vm.runInContext("abandonForInactivity()",sandbox);
  assert.ok(order.includes("save"), "current answer was never committed");
  assert.ok(order.indexOf("save") < order.indexOf("terminal"), "terminal preceded answer persistence");
  assert.ok(order.indexOf("terminal") < order.indexOf("notify"));
});

test("recruitment answer-done is not an interview-end command, including appended ASR", () => {
  for (const phrase of ["我答完了。", "我做完了。", "我的交付是台账和完整的手续，没有依据的数字不补充。我答完了。", "That's all.", "I'm done."]) {
    assert.equal(isUserEndRequest(phrase, { isRecruitmentInterview: true }), false, phrase);
  }
});

test("inactivity save failure, resumed speech and failed status write do not publish a terminal", async () => {
  for (const failure of ["answer", "resumed", "status", "answer-throw", "status-throw"]) {
    const events:string[] = [];
    const noop = () => {};
    const sandbox = relayFunctions("voice-relay.ts", ["abandonForInactivity"], {
      interviewDone:false, endingInterview:false, ownsPersistedSession:()=>true,
      clearSilenceAutoSkip:noop, clearPendingAsrFinal:noop, cancelTts:noop,
      ctxSessionId:"local-failure", liveSessions:new Map(),
      isOprunRecruitmentInterview:true, currentQuestionIndex:5,lastUserAudioActivityAt:0,
      retainDeferredAnswerBeforeTransition:noop,
      persistSessionStatus:async()=>{
        if (failure === "status-throw") throw new Error("local storage unavailable");
        return false;
      },
      armSilenceAutoSkip:()=>events.push("retry"),
      browserWs:{readyState:1,send:()=>events.push("terminal")},WebSocket:{OPEN:1},
      log:{info:noop,warn:noop,error:noop},
    });
    sandbox.answerCommitGate = {request:async()=>{
      if (failure === "answer-throw") throw new Error("local transport unavailable");
      if (failure === "resumed") sandbox.lastUserAudioActivityAt = 1;
      return failure !== "answer";
    }};
    await vm.runInContext("abandonForInactivity()", sandbox);
    assert.equal(sandbox.interviewDone, false);
    assert.equal(sandbox.endingInterview, false);
    assert.deepEqual(events,["retry"]);
  }
});

test("production Q2 negations, missing experience and quoted controls remain real answers", () => {
  for (const text of [
    "我负责资料核对和入职引导，合同特殊条款由负责人审核，我不会自行承诺。",
    "没有经过复核的数据我不会报一个精确百分比，但可以提供流程版本和问题记录。",
    "我不会使用这个工具，目前没有相关经验。", "我不会", "没有相关经验",
    "我没有放弃了这个项目的想法。", "我负责设计下一题", "不要下一题", "我还没有答完了",
    "候选人对我说我答完了", "他告诉我“下一题”。", "I cannot use that tool yet.",
    "Our workflow tells the user to skip this question when it is irrelevant.",
  ]) {
    assert.equal(isUserSkipRequest(text, { isRecruitmentInterview: true }), false, text);
    assert.equal(hasRecruitmentAnswer(text), true, text);
  }
  for (const text of ["我不会报虚假数据。我答完了。", "我写过“下一题”这个提示。现在我答完了。", "我本人负责交付，请进入下一题。"]) {
    assert.equal(hasRecruitmentAnswer(text), true, text);
    assert.equal(recruitmentSpeechIntent(text), "answer_done", text);
  }
});

test("answer write gate waits for the matching successful acknowledgement, not a different question", async () => {
  const events: Record<string, unknown>[] = [];
  const gate = createAnswerCommitGate((e) => events.push(e), 500);
  let settled = false;
  const pending = gate.request(1).then((ok) => { settled = true; return ok; });
  const event = events[0];
  gate.acknowledge({ ...event, questionIndex: 2, ok: true });
  await Promise.resolve();
  assert.equal(settled, false);
  gate.acknowledge({ ...event, ok: true });
  assert.equal(await pending, true);
  gate.close();
});

test("failed or timed out saves never acknowledge advancement; fresh retry can succeed", async () => {
  const events: Record<string, unknown>[] = [];
  const gate = createAnswerCommitGate((e) => events.push(e), 15);
  const failed = gate.request(1);
  gate.acknowledge({ ...events[0], ok: false });
  assert.equal(await failed, false);
  assert.equal(await gate.request(1), false);
  const retry = gate.request(1);
  gate.acknowledge({ ...events[1], ok: true }); // expired ACK cannot satisfy new request
  gate.acknowledge({ ...events[2], ok: true });
  assert.equal(await retry, true);
  const disconnected = gate.request(2);
  gate.close();
  assert.equal(await disconnected, false);
});

test("actual primary turn handler retains negated answers and appended done before requesting next", async () => {
  for (const text of ["我不会报未经复核的数据，我负责入职审核。", "我负责入职审核，我不会自行承诺。我答完了。"] ) {
    const transcript: Array<{role:string;text:string}> = [];
    const order: string[] = [];
    const noop = () => {};
    const sandbox = relayFunctions("voice-relay.ts", ["handleUserUtterance"], {
      isTransitioning:false, interviewDone:false, isOprunRecruitmentInterview:true,
      isUserEndRequest, isUserSkipRequest, hasRecruitmentAnswer,
      isFastPrevRequest:()=>false, isUserPrevRequest:()=>false, isFastNextRequest:()=>true,
      isSameAsPendingUserTurn:()=>false, isDuplicateUserFinal:()=>false,
      clearSilenceAutoSkip:noop, silenceAskCount:0, silenceConfirmPending:false, unansweredQuestionsStreak:0,
      generatingResponse:false, browserWs:{readyState:1,send:noop}, WebSocket:{OPEN:1},
      ttsSpeaking:false, updateUserLanguage:noop, rememberAcceptedUserFinal:noop, questionTranscript:transcript,
      userTurnsOnCurrentQ:0, recruitmentAnsweredQuestions:new Set(), currentQuestionIndex:1,
      lastResponseWasCorrection:false, pendingLastQuestionTimeout:null, awaitingFinalResponse:false,
      suppressAsrResults:false, cancelTts:noop, log:{info:noop,error:noop},
      generateControlledResponse:async ({forceSkip}:{forceSkip:boolean})=>{
        assert.equal(transcript[0].text, text);
        order.push("answer-retained");
        return forceSkip ? "[NEXT]" : "";
      }, NEXT_TOKEN:"[NEXT]", PREV_TOKEN:"[PREV]", sortedQuestions:[{}, {type:"OPEN"}],
      pendingWhiteboardVision:false, handleTransition:async()=>{order.push("next");},
      reopenAsr:async()=>{}, queuedUserUtteranceWhileGenerating:"", queuedUserUtteranceIsChat:false,
    });
    sandbox.text = text;
    await vm.runInContext("handleUserUtterance(text)", sandbox);
    assert.equal(transcript.length, 1);
    assert.equal(sandbox.userTurnsOnCurrentQ, 1);
    assert.deepEqual(order, recruitmentSpeechIntent(text) === "answer_done" ? ["answer-retained","next"] : ["answer-retained"]);
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
  for (const text of ["结束面试", "我要结束整个面试。", "没有其他问题了，可以结束面试，谢谢。", "可以结束面试，谢谢。", "Please end the interview.", "I'm done with the interview."]) {
    assert.equal(recruitmentSpeechIntent(text), "end_interview", text);
  }
  for (const text of ["不要结束面试", "我不想结束面试", "我负责结束面试后的资料归档", "I finished the interview workflow for our project."]) {
    assert.equal(recruitmentSpeechIntent(text), null, text);
  }
});

test("late primary response after a fast next neither speaks nor releases the new turn lock", async () => {
  let release: (text: string) => void = () => {};
  const pending = new Promise<string>((resolve) => { release = resolve; });
  const noop = () => {};
  const sandbox = relayFunctions("voice-relay.ts", ["handleUserUtterance"], {
    isTransitioning:false, interviewDone:false, isOprunRecruitmentInterview:true,
    isUserEndRequest, isUserSkipRequest, hasRecruitmentAnswer,
    isFastPrevRequest:()=>false, isUserPrevRequest:()=>false, isFastNextRequest:()=>false,
    isSameAsPendingUserTurn:()=>false, isDuplicateUserFinal:()=>false,
    clearSilenceAutoSkip:noop, silenceAskCount:0, silenceConfirmPending:false, unansweredQuestionsStreak:0,
    generatingResponse:false, browserWs:{readyState:1,send:noop}, WebSocket:{OPEN:1},
    ttsSpeaking:false, updateUserLanguage:noop, rememberAcceptedUserFinal:noop, questionTranscript:[],
    userTurnsOnCurrentQ:0, recruitmentAnsweredQuestions:new Set(), currentQuestionIndex:2,
    lastResponseWasCorrection:false, pendingLastQuestionTimeout:null, awaitingFinalResponse:false,
    suppressAsrResults:false, cancelTts:noop, log:{info:noop,error:noop},
    generateControlledResponse:()=>pending,
    speakAndHandle:()=>{throw new Error("stale follow-up spoken on Q4");},
    reopenAsr:()=>{throw new Error("stale cycle reset Q4 input");},
  });
  const work = vm.runInContext("handleUserUtterance('我负责招聘交付与资料核对。')", sandbox);
  sandbox.transitionGeneration = 1;
  sandbox.currentQuestionIndex = 3;
  sandbox.generatingResponse = true;
  release("请补充你在上一题中的个人贡献？");
  await work;
  assert.equal(sandbox.generatingResponse, true);
  assert.equal(sandbox.currentQuestionIndex, 3);
});

test("late TTS completion cannot add the old follow-up to the new question transcript", async () => {
  let finish: (ok: boolean) => void = () => {};
  const transcript: unknown[] = [];
  const sandbox = relayFunctions("voice-relay.ts", ["speakAndHandle"], {
    interviewDone:false, questionTranscript:transcript,
    speakText:()=>new Promise<boolean>((resolve)=>{finish=resolve;}),
  });
  const work = vm.runInContext("speakAndHandle('请补充具体职责？')", sandbox);
  sandbox.transitionGeneration = 1;
  finish(true);
  await work;
  assert.equal(transcript.length, 0);
});

test("fast next retains all deferred final segments on the old question before save", () => {
  const transcript: Array<{text:string}> = [];
  const events: Array<{text:string;questionIndex:number}> = [];
  const noop=()=>{};
  const sandbox = relayFunctions("voice-relay.ts", ["retainDeferredAnswerBeforeTransition"], {
    queuedUserUtteranceWhileGenerating:"我负责资料审核。", queuedUserUtteranceIsChat:false,
    pendingUserUtteranceWhileSuppressed:"然后登记台账并提交复核。", pendingAsrFinalText:"最后回访确认。",
    mergeAsrSegments, hasRecruitmentAnswer, clearPendingAsrFinal:noop,
    looksLikeAssistantPlaybackEcho:()=>false, isDuplicateUserFinal:()=>false,
    rememberAcceptedUserFinal:noop, questionTranscript:transcript, userTurnsOnCurrentQ:1,
    recruitmentAnsweredQuestions:new Set([2]), currentQuestionIndex:2, WebSocket:{OPEN:1},
    browserWs:{readyState:1,send:(s:string)=>events.push(JSON.parse(s))},
  });
  vm.runInContext("retainDeferredAnswerBeforeTransition()",sandbox);
  assert.equal(transcript.length,1);
  for(const part of ["资料审核","提交复核","回访确认"]) assert.ok(transcript[0].text.includes(part));
  assert.equal(events[0].questionIndex,2);
  assert.equal(sandbox.pendingUserUtteranceWhileSuppressed,"");
  assert.equal(sandbox.queuedUserUtteranceWhileGenerating,"");
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
  const sandbox=vm.createContext({transitionGeneration:0, retainDeferredAnswerBeforeTransition:()=>{}, ...context});
  vm.runInContext(ts.transpileModule(Array.from(found.values()).join("\n"), {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText, sandbox);
  return sandbox;
}

test("primary relay real response function never calls the model for answered Q1 or answer-done Q2", async () => {
  for (const index of [0,1]) {
    const sandbox=relayFunctions("voice-relay.ts", ["generateControlledResponse"], {
      interviewDone:false, currentQuestionIndex:index, sortedQuestions:[{text:"介绍"},{text:"经历"}],
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

test("primary actual transition preserves the answer until ACK and allows retry after save failure", async () => {
  const events: Record<string, unknown>[] = [];
  const gate = createAnswerCommitGate((e) => events.push(e), 1000);
  const noop = () => {};
  const transcript = [{role:"user",text:"我不会报未经核验的数据，我负责招聘台账。"}];
  const sandbox = relayFunctions("voice-relay.ts", ["handleTransition"], {
    interviewDone:false, isTransitioning:false, questionTranscript:transcript,
    isOprunRecruitmentInterview:true, currentQuestionIndex:1, hasRecruitmentAnswer,
    silenceAskCount:0, silenceConfirmPending:false, transitionGeneration:0,
    pendingProgressiveTransition:false, answerCommitGate:gate, recruitmentControlOnly,
    consumedRecruitmentControlKey:"old-control", recentAcceptedUserFinals:[{text:"我答完了",at:1}],
    browserWs:{readyState:1,send:(s:string)=>events.push(JSON.parse(s))}, WebSocket:{OPEN:1},
    reopenAsr:async()=>{}, log:{error:(err:unknown)=>{throw err;}, info:noop},
    shouldWaitForQuestionExpansion:()=>false, sortedQuestions:[{text:"介绍"},{text:"经历"},{text:"协作"}],
    clearPendingAsrFinal:noop, clearSilenceAutoSkip:noop, suppressAsrResults:false,
    disconnectAsr:noop, cancelTts:noop, generatingResponse:false, asrAccumulator:"",
    userTurnsOnCurrentQ:1, lastResponseWasCorrection:false, cachedWhiteboardDescription:"",
    whiteboardDirty:false, latestWhiteboardImage:null, recentAgentResponses:[], pendingLastQuestionTimeout:null,
    refreshDynamicQuestions:async()=>{}, isZh:true, summarizeQuestion:async()=>"summary",
    speakAndHandle:async()=>{}, llmRoute:{}, ctxSessionId:"synthetic-session", questionSummaries:[], runQueuedManualTransition:()=>false,
  });
  const failed = vm.runInContext("handleTransition()", sandbox);
  assert.equal(sandbox.currentQuestionIndex, 1);
  assert.equal(sandbox.questionTranscript, transcript);
  gate.acknowledge({...events[0],ok:false});
  await failed;
  assert.equal(sandbox.currentQuestionIndex, 1);
  assert.equal(sandbox.questionTranscript, transcript);
  assert.equal(sandbox.consumedRecruitmentControlKey, "");
  assert.equal(sandbox.recentAcceptedUserFinals.length, 0);
  assert.equal(events.at(-1)?.reason, "answer_save_failed");
  const retry = vm.runInContext("handleTransition()", sandbox);
  assert.equal(sandbox.currentQuestionIndex, 1);
  gate.acknowledge({...events.at(-1),ok:true});
  await retry;
  assert.equal(sandbox.currentQuestionIndex, 2);
  assert.equal(events.filter((e)=>e.type==="question_change").length, 1);
  gate.close();
});

test("backup actual socket handler holds response.done behind delayed save and emits the tool result", async () => {
  for (const saveOk of [false,true]) {
    const events:Record<string,unknown>[] = [];
    const upstream:Record<string,unknown>[] = [];
    const handlers = new Map<string, (...args:any[])=>void>();
    const ws = {on:(name:string,fn:(...args:any[])=>void)=>handlers.set(name,fn),
      send:(s:string)=>upstream.push(JSON.parse(s))};
    const gate = createAnswerCommitGate((e)=>events.push(e),1000);
    const noop = () => {};
    const sandbox = relayFunctions("openai-voice-relay.ts", ["attachOaiHandlers"], {
      oaiWs:ws, lastOaiActivity:0, log:{error:(...args:unknown[])=>{throw args.at(-1);},info:noop,warn:noop,debug:noop},
      isTransitioning:false, currentQuestionIndex:1, sortedQuestions:[{},{text:"经历"},{text:"协作"}],
      ctx:{}, pendingFunctionCalls:[], questionEnteredAt:0, lastUserInput:1,
      MIN_QUESTION_DWELL_MS:0, MIN_WORDS_BEFORE_TRANSITION:0, userCommittedWordsThisQuestion:20,
      recruitmentCanComplete:()=>false, isOprunRecruitmentInterview:true, answerCommitGate:gate,
      interviewDone:false, browserWs:{readyState:1}, WebSocket:{OPEN:1}, send:(e:Record<string,unknown>)=>events.push(e),
      clearPendingTransition:noop, disableTools:noop, pushHistory:noop,
      activeResponseQuestionIndex:1, responseInFlight:true, takeQueuedAssistantResponse:()=>null,
      pendingAsrUpdate:null, outputTranscriptBuffer:"", modelIsSpeaking:false, pendingInterviewComplete:false,
      responseTtsBytes:0, isProgressiveOpeningOnly:()=>false, inputTranscriptBuffer:"",
      responseAudioStarted:false, responseAudioStartedAt:0, queuedAssistantResponse:null,
      requestAssistantResponse:()=>events.push({type:"followup"}), reconnecting:false,
    });
    sandbox.ws=ws;
    vm.runInContext("attachOaiHandlers(ws)",sandbox);
    handlers.get("message")!(Buffer.from(JSON.stringify({type:"response.function_call_arguments.done",
      name:"signal_question_change",call_id:"tool-1",arguments:JSON.stringify({questionIndex:2})})));
    handlers.get("message")!(Buffer.from(JSON.stringify({type:"response.done",response:{status:"completed",output:[{}]}})));
    await new Promise((resolve)=>setImmediate(resolve));
    assert.equal(sandbox.currentQuestionIndex,1);
    assert.equal(sandbox.responseInFlight,true);
    assert.equal(upstream.length,0);
    gate.acknowledge({...events[0],ok:saveOk});
    await new Promise((resolve)=>setImmediate(resolve));
    assert.equal(sandbox.currentQuestionIndex,saveOk?2:1);
    assert.equal(sandbox.responseInFlight,false);
    assert.equal(upstream.length,1);
    assert.equal((upstream[0].item as any).call_id,"tool-1");
    assert.equal(events.filter((e)=>e.type==="followup").length,1);
    gate.close();
  }
});

test("actual browser save queue carries an earlier failed answer into the later acknowledged write", async () => {
  const source = ts.createSourceFile("use-voice.ts", readFileSync(new URL("../src/hooks/use-voice.ts",import.meta.url),"utf8"),ts.ScriptTarget.Latest,true);
  let callback = "";
  function visit(node:ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source)==="saveProgress"
      && node.initializer && ts.isCallExpression(node.initializer)) callback=node.initializer.arguments[0].getText(source);
    ts.forEachChild(node,visit);
  }
  visit(source);
  assert.ok(callback);
  const bodies:Array<{messages:Array<{content:string}>}> = [];
  let rejectFirst:(response:{ok:boolean;status:number})=>void = () => {};
  const trackedMessagesRef = {current:[{role:"user",content:"我不会编造数据，我维护招聘台账。",questionId:"q2"}]};
  const sandbox = vm.createContext({trackedMessagesRef, asrBufferRef:{current:""},
    progressSaveChainRef:{current:Promise.resolve()}, questionIdAt:()=>"q2",sessionId:"local-test",
    AbortSignal,log:{info:()=>{},error:()=>{}},
    requeueFailedProgressMessages:(failed:unknown[],pending:unknown[])=>[...failed,...pending],
    fetch:async (_url:string,options:{body:string})=>{
      bodies.push(JSON.parse(options.body));
      if(bodies.length===1) return await new Promise((resolve)=>{rejectFirst=resolve;});
      return {ok:true,status:200};
    },
  });
  vm.runInContext(ts.transpileModule(`const saveProgress = ${callback}`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,sandbox);
  const first = vm.runInContext("saveProgress(1,1)",sandbox);
  await Promise.resolve();
  const queued = vm.runInContext("saveProgress(1,1)",sandbox);
  rejectFirst({ok:false,status:503});
  assert.equal(await first,false);
  assert.equal(await queued,true);
  assert.equal(bodies.length,2);
  assert.deepEqual(bodies[1].messages,bodies[0].messages);
  assert.equal(trackedMessagesRef.current.length,0);
});
