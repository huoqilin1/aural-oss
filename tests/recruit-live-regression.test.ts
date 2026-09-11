import { OfflineAsrDrain } from '../server/offline-asr-drain';
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { evaluateTranscriptManualAdvance, hasRecruitmentAnswer, isUserEndRequest, isUserSkipRequest, mergeAsrSegments, restoreRecruitmentQuestionTranscript, summarizeRecruitmentResumeBudget } from "../server/voice-relay-helpers";
import { hasEightScoredAnswers, recruitmentQ1Transition, recruitmentSpeechIntent, recruitmentControlOnly } from "../src/lib/voice/recruitment-turn-policy";
import { shouldBlockRecruitmentCompletion } from "../src/lib/voice/completion-auto-close";
import { createAnswerCommitGate } from "../server/answer-commit-gate";
import { createAsrInitialConnectQueue } from "../server/asr-initial-connect-queue";
import { speakWithBackgroundSummary } from "../server/question-summary-transition";
import { shouldWaitForQuestionExpansion,mergeExpandedQuestionSet,LiveQuestionIdLookup,isProgressiveOpeningOnly } from "../src/lib/voice/dynamic-question-sync";
import { waitForBrowserPlayback } from "../server/browser-playback-receipt";
import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import { shouldSuppressRecentAsrFinal, shouldSuppressAnsweredAsrFinal } from "../server/voice-relay-helpers";
import { createAsrAudioReplayBuffer } from "../server/asr-audio-replay";
import { questionMemory } from "../server/question-memory";
import { recruitmentInteractionReply } from "../src/lib/voice/recruitment-quality";
import { companyKnowledgeVersion } from "../src/lib/recruitment-company-knowledge";
import { readRecruitmentRealtimeDecision, recruitmentRealtimeSpeechRequest } from "../src/lib/voice/recruitment-realtime-decision";

test("an identical pending ASR final remains a replay after the recent-history TTL expires", () => {
  const answer = "我负责核对数据和验收，不负责销售签约。";
  const sandbox = relayFunctions("voice-relay.ts", ["isDuplicateUserFinal", "normalizeUserUtteranceKey", "shouldSuppressRecentUserFinalReplay"], {
    recruitmentControlKey:()=>"", consumedRecruitmentControlKey:"",
    questionTranscript:[{role:"user",text:answer}],
    generatingResponse:true, suppressAsrResults:true, isTransitioning:false, ttsSpeaking:false,
    recentAcceptedUserFinals:[{text:answer,at:Date.now()-120_000,questionIndex:0}],
    currentQuestionIndex:0, ASR_RECENT_FINAL_REPLAY_TTL_MS:90_000,
    ASR_RECENT_FINAL_REPLAY_MIN_UNITS:8, shouldSuppressRecentAsrFinal,
    shouldSuppressAnsweredAsrFinal, lastAssistantMessageWallClockMs:100,
    lastListeningAudioActivityAt:200,
  });
  sandbox.incoming=answer;
  assert.equal(vm.runInContext("isDuplicateUserFinal(incoming)",sandbox),true,
    "model queue time must not turn the identical pending answer into another model request");
  sandbox.incoming=answer+"补充一下，我还负责了故障复盘。";
  assert.equal(vm.runInContext("isDuplicateUserFinal(incoming)",sandbox),false,
    "new evidence must remain available");
  sandbox.incoming="更正，我负责销售签约。";
  assert.equal(vm.runInContext("isDuplicateUserFinal(incoming)",sandbox),false);
  sandbox.questionTranscript.push({role:"assistant",text:"请确认你的职责。"});
  sandbox.generatingResponse=false;sandbox.suppressAsrResults=false;sandbox.incoming=answer;
  assert.equal(vm.runInContext("isDuplicateUserFinal(incoming)",sandbox),false,
    "a fresh answer after the interviewer speaks is a new turn");
  sandbox.questionTranscript=[{role:"assistant",text:"下一题"}];
  sandbox.generatingResponse=true;sandbox.suppressAsrResults=true;
  assert.equal(vm.runInContext("isDuplicateUserFinal(incoming)",sandbox),false);
});

test("actual recruitment question context bypasses the model but keeps its source answer", async () => {
  let calls = 0;
  const sandbox = relayFunctions("voice-relay.ts", ["summarizeQuestion"], {
    questionMemory,
    callRelayLLM: async () => { calls++; return "legacy summary"; },
    bt: (_zh: boolean, value: unknown) => value,
    PROMPTS: { summarize: () => "synthetic prompt" },
    log: { info() {}, error() {} },
  });
  const result = await vm.runInContext("summarizeQuestion('Q1', [{role:'user', text:'I owned review only.'}], true, undefined, 'session', 'interview', true)", sandbox);
  assert.equal(result, "Participant: I owned review only.");
  assert.equal(calls, 0);
  assert.equal(await vm.runInContext("summarizeQuestion('Q1', [{role:'user', text:'Source'}], true)", sandbox), "legacy summary");
  assert.equal(calls, 1);
});

test("ASR recovery retains unacknowledged PCM, separates questions and refuses truncated replay", () => {
  const buffer=createAsrAudioReplayBuffer(6);
  buffer.append(2,Buffer.from([1,2]));buffer.append(2,Buffer.from([3,4]));
  assert.deepEqual(Buffer.concat(buffer.snapshot(2)!),Buffer.from([1,2,3,4]));
  assert.equal(buffer.snapshot(2)!.length,2,"failed recovery must retain audio for the next bounded attempt");
  assert.deepEqual(buffer.snapshot(3),[]);
  buffer.acknowledge(2);assert.deepEqual(buffer.snapshot(2),[]);
  buffer.append(3,Buffer.alloc(7));assert.equal(buffer.snapshot(3),null);
  buffer.append(4,Buffer.from([8]));assert.deepEqual(Buffer.concat(buffer.snapshot(4)!),Buffer.from([8]));
});

test("protocol errors retire an OPEN recognizer once and bound recovery without candidate inactivity", () => {
  const events:string[]=[];
  const sandbox=relayFunctions("voice-relay.ts",["handleAsrProtocolError"],{
    currentQuestionIndex:6,ctxSessionId:"local-asr",asrProtocolFailureQuestion:-1,asrProtocolFailures:0,
    interviewDone:false,MAX_RECONNECT_ATTEMPTS:3,
    clearSilenceAutoSkip:()=>events.push("clear"),asrWs:{terminate:()=>events.push("retire")},
    browserWs:{close:()=>events.push("disconnect")},log:{warn:()=>{}},
  });
  vm.runInContext("handleAsrProtocolError(55000000);handleAsrProtocolError(45000081)",sandbox);
  assert.equal(sandbox.asrAlive,false);assert.equal(sandbox.asrProtocolFailures,1);
  assert.deepEqual(events,["clear","retire"]);
  for(let i=0;i<2;i++){sandbox.asrAlive=true;vm.runInContext("handleAsrProtocolError(55000000)",sandbox);}
  assert.equal(sandbox.interviewDone,true);assert.equal(sandbox.asrProtocolFailures,3);
  assert.equal(events.filter(e=>e==="disconnect").length,1);
});

test("recognizer unavailable pauses actual inactivity finalization", async () => {
  let held=0;
  const sandbox=relayFunctions("voice-relay.ts",["abandonForInactivity"],{
    interviewDone:false,endingInterview:false,asrAlive:false,
    armSilenceAutoSkip:()=>{held++;},ownsPersistedSession:()=>{throw new Error("must not finalize without recognizer");},
  });
  await vm.runInContext("abandonForInactivity()",sandbox);assert.equal(held,1);
});

test("actual ASR reconnect replays buffered speech before reopening input", async () => {
  const buffer=createAsrAudioReplayBuffer();buffer.append(6,Buffer.from([1,2]));
  const events:string[]=[];
  const sandbox=relayFunctions("voice-relay.ts",["autoReconnectAsr"],{
    currentQuestionIndex:6,interviewDone:false,asrAudioReplay:buffer,
    MAX_RECONNECT_ATTEMPTS:3,RECONNECT_DELAY_MS:1000,asrAudioSeq:1,keepAliveInterval:null,
    browserWs:{readyState:1,send:(data:string)=>events.push(JSON.parse(data).type)},WebSocket:{OPEN:1},
    connectAsr:async()=>{events.push("connect");buffer.append(6,Buffer.from([3,4]));},
    asrWs:{readyState:1,send:(data:string)=>events.push(data)},
    buildBigModelAudioRequest:(pcm:Buffer)=>`pcm:${pcm.toString('hex')}`,
    setTimeout:(callback:()=>void)=>{callback();return 0;},setInterval:()=>1,
    log:{info:()=>{},warn:()=>{}},
  });
  await vm.runInContext("autoReconnectAsr()",sandbox);
  assert.deepEqual(events,["session_reconnecting","connect","pcm:0102","pcm:0304","session_reconnected","input_ready"]);
  assert.equal(buffer.snapshot(6)!.length,2,"do not discard audio before recognition acknowledges it");
});

test("new-question microphone speech survives similar prior wording while delayed ASR replays remain suppressed", () => {
  const previous="我会先核对任务的目标和交付要求，再列出执行步骤，然后整理数据并检查结果，最后记录问题。";
  const incoming="我会先核对任务的目标和交付要求，再列出执行步骤，然后制作验收表，并请负责人确认完成标准。";
  assert.equal(shouldSuppressAnsweredAsrFinal(previous,incoming),true,"fixture must reproduce fuzzy cross-question suppression");
  const now=Date.now();
  const sandbox=relayFunctions("voice-relay.ts",["shouldSuppressRecentUserFinalReplay"],{
    questionTranscript:[],currentQuestionIndex:4,
    recentAcceptedUserFinals:[{text:previous,at:now-10_000,questionIndex:3}],
    lastAssistantMessageWallClockMs:now-5000,lastListeningAudioActivityAt:now-1000,
    shouldSuppressRecentAsrFinal,ASR_RECENT_FINAL_REPLAY_TTL_MS:90000,ASR_RECENT_FINAL_REPLAY_MIN_UNITS:8,
  });
  sandbox.incoming=incoming;
  assert.equal(vm.runInContext("shouldSuppressRecentUserFinalReplay(incoming)",sandbox),false);
  sandbox.lastListeningAudioActivityAt=now-6000;
  assert.equal(vm.runInContext("shouldSuppressRecentUserFinalReplay(incoming)",sandbox),true,"a delayed old final without new speech must remain blocked");
  sandbox.lastListeningAudioActivityAt=now-1000;
  sandbox.ttsSpeaking=true;
  assert.equal(vm.runInContext("shouldSuppressRecentUserFinalReplay(incoming)",sandbox),true);
  sandbox.ttsSpeaking=false;
  sandbox.recentAcceptedUserFinals[0].questionIndex=4;
  assert.equal(vm.runInContext("shouldSuppressRecentUserFinalReplay(incoming)",sandbox),true,"same-question rolling revisions remain guarded");
});

test("accepted finals with matching wording stay separate across question boundaries", () => {
  const sandbox=relayFunctions("voice-relay.ts",["rememberAcceptedUserFinal"],{
    currentQuestionIndex:3,recentAcceptedUserFinals:[],shouldSuppressAnsweredAsrFinal,mergeAsrSegments,
  });
  vm.runInContext("rememberAcceptedUserFinal('我会先核对任务目标和交付要求，再整理数据。')",sandbox);
  sandbox.currentQuestionIndex=4;
  vm.runInContext("rememberAcceptedUserFinal('我会先核对任务目标和交付要求，再整理数据。')",sandbox);
  assert.equal(sandbox.recentAcceptedUserFinals.length,2);
  assert.deepEqual(Array.from(sandbox.recentAcceptedUserFinals,(entry:any)=>entry.questionIndex),[3,4]);
});

test("real speech after a follow-up is not silently discarded for sharing the previous answer wording", () => {
  const previous="我会先核对任务的目标和交付要求，再列出执行步骤，然后整理数据并检查结果，最后记录问题。";
  const incoming="我会先核对任务的目标和交付要求，再列出执行步骤，然后制作验收表，并请负责人确认完成标准。";
  const now=Date.now();
  const sandbox=relayFunctions("voice-relay.ts",["isDuplicateUserFinal","normalizeUserUtteranceKey"],{
    incoming,questionTranscript:[{role:"user",text:previous},{role:"assistant",text:"请补充验收的具体步骤。"}],
    recruitmentControlKey:()=>"",consumedRecruitmentControlKey:"",shouldSuppressAnsweredAsrFinal,mergeAsrSegments,
    rememberAcceptedUserFinal:()=>{},shouldSuppressRecentUserFinalReplay:()=>false,
    lastAssistantMessageWallClockMs:now-5000,lastListeningAudioActivityAt:now-1000,
  });
  assert.equal(vm.runInContext("isDuplicateUserFinal(incoming)",sandbox),false);
  sandbox.lastListeningAudioActivityAt=now-6000;
  assert.equal(vm.runInContext("isDuplicateUserFinal(incoming)",sandbox),true);
});

test("playback receipt ignores stale/other-question packets and releases listeners on receipt, abort, close and timeout", async () => {
  for (const outcome of ["played", "abort", "close", "timeout"] as const) {
    const socket = Object.assign(new EventEmitter(), {readyState:1, send:(_data:string)=>{}});
    let request: any;
    socket.send = (data:string) => { request=JSON.parse(data); };
    const controller=new AbortController();
    let settled=false;
    const pending=waitForBrowserPlayback(socket as unknown as WebSocket,2,controller.signal,30).then(result=>{settled=true;return result;});
    socket.emit("message",Buffer.from(JSON.stringify({type:"playback_complete",receiptId:"stale",questionIndex:2})),false);
    socket.emit("message",Buffer.from(JSON.stringify({type:"playback_complete",receiptId:request.receiptId,questionIndex:1})),false);
    await Promise.resolve();
    assert.equal(settled,false);
    if(outcome==="played") socket.emit("message",Buffer.from(JSON.stringify({...request,type:"playback_complete"})),false);
    if(outcome==="abort") controller.abort();
    if(outcome==="close") socket.emit("close");
    assert.equal(await pending,outcome==="played"?"played":outcome==="timeout"?"timeout":"cancelled");
    assert.equal(socket.listenerCount("message"),0);
    assert.equal(socket.listenerCount("close"),0);
  }
});

test("actual TTS keeps inactivity paused until browser playback, and transport timeout never becomes candidate inactivity", async () => {
  for(const result of ["played","timeout","cancelled"]){
    let release:(result:string)=>void=()=>{};
    const events:any[]=[];
    const sandbox=relayFunctions("voice-relay.ts",["speakText"],{
      currentQuestionIndex:2,ctxSessionId:"local-playback",ctx:{language:"zh",clientPlaybackReceipt:true},
      cancelTts:()=>{},getTtsOptions:()=>({}),getTtsAuth:()=>({}),
      AbortController,WebSocket:{OPEN:1},interviewDone:false,
      browserWs:{readyState:1,send:(data:any)=>{if(typeof data==="string")events.push(JSON.parse(data));},close:()=>events.push({type:"closed"})},
      synthesizeSpeech:async function*(){yield {type:"audio",audio:Buffer.alloc(48)};yield {type:"done"};},
      setTimeout:(callback:()=>void)=>{callback();return 0;},clearTimeout:()=>{},
      waitForBrowserPlayback:()=>new Promise(resolve=>{release=resolve;}),
      log:{error:()=>{},warn:()=>{},info:()=>{}},
    });
    const pending=vm.runInContext("speakText('本地测试问题')",sandbox);
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(sandbox.ttsSpeaking,true,"server elapsed audio duration must not start silence while delivery is pending");
    assert.equal(events.some(e=>e.type==="tts_ended"),false);
    release(result);
    assert.equal(await pending,result==="played");
    assert.equal(events.some(e=>e.type==="tts_ended"),result==="played");
    assert.equal(sandbox.interviewDone,result==="timeout");
    assert.equal(events.some(e=>e.type==="closed"),result==="timeout");
  }
});

test("actual browser acknowledges only after both scheduled sources and jitter queue drain", () => {
  const source=ts.createSourceFile("voice",readFileSync(new URL("../src/hooks/use-voice.ts",import.meta.url),"utf8"),ts.ScriptTarget.Latest,true);
  let callback="";
  function visit(node:ts.Node){
    if(ts.isVariableDeclaration(node)&&node.name.getText(source)==="acknowledgePlayedAudio"&&node.initializer&&ts.isCallExpression(node.initializer))callback=node.initializer.arguments[0].getText(source);
    ts.forEachChild(node,visit);
  }
  visit(source);assert.ok(callback);
  const events:any[]=[];
  const sandbox=vm.createContext({pendingPlaybackReceiptRef:{current:{receiptId:"test",questionIndex:2}},audioSourcesRef:{current:[{}]},queuedAudioSamplesRef:{current:8},relayConnectorRef:{current:{sendJson:(event:any)=>events.push(event)}}});
  vm.runInContext(ts.transpileModule(`const acknowledge = ${callback}`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,sandbox);
  vm.runInContext("acknowledge()",sandbox);assert.equal(events.length,0);
  sandbox.audioSourcesRef.current=[];
  vm.runInContext("acknowledge()",sandbox);assert.equal(events.length,0);
  sandbox.queuedAudioSamplesRef.current=0;
  vm.runInContext("acknowledge();acknowledge()",sandbox);
  assert.equal(events.length,1);assert.equal(events[0].type,"playback_complete");
});

test("progressive Q2 takes the expansion path instead of the last-question silence timer", async () => {
  let transitions=0;
  const sandbox=relayFunctions("voice-relay.ts", ["speakAndHandle"], {
    speakText:async()=>true, interviewDone:false, currentQuestionIndex:1,
    questionTranscript:[], lastAssistantMessageWallClockMs:0,
    sortedQuestions:[{text:"Q1",description:"oprun_dimension:core_experience"},
      {text:"Q2",description:"oprun_dimension:project_ownership"}],
    shouldWaitForQuestionExpansion, log:{info:()=>{},error:()=>{}},
    handleTransition:async()=>{transitions++;},
    setTimeout:()=>{throw new Error("Q2 is not the last planned question");},
  });
  await vm.runInContext("speakAndHandle('谢谢',{pendingTransition:true})",sandbox);
  assert.equal(transitions,1);
});

test("microphone speech cancels end timers before ASR final, silence does not", () => {
  const cleared:unknown[]=[];
  const sandbox=relayFunctions("voice-relay.ts", ["noteIncomingAudioActivity"], {
    receivedMicrophoneFrames:0,receivedActiveMicrophoneFrames:0,lastUserAudioActivityAt:0,lastListeningAudioActivityAt:0,
    ASR_AUDIO_ACTIVITY_RMS_THRESHOLD:0.014,isOprunRecruitmentInterview:true,
    pendingLastQuestionTimeout:11,finalResponseTimeout:12,
    clearTimeout:(id:unknown)=>cleared.push(id), Buffer,
  });
  vm.runInContext("noteIncomingAudioActivity(Buffer.alloc(640))",sandbox);
  assert.equal(cleared.length,0);
  sandbox.ttsSpeaking=true;
  vm.runInContext("noteIncomingAudioActivity(Buffer.alloc(640,32))",sandbox);
  assert.equal(cleared.length,0);
  assert.equal(sandbox.lastListeningAudioActivityAt,0);
  sandbox.ttsSpeaking=false;
  vm.runInContext("noteIncomingAudioActivity(Buffer.alloc(640,32))",sandbox);
  assert.deepEqual(cleared,[11,12]);
  assert.equal(sandbox.pendingLastQuestionTimeout,null);
  assert.equal(sandbox.finalResponseTimeout,null);
});

test("automatic transition cannot cut active speech when expanded questions arrive", async () => {
  const sandbox=relayFunctions("voice-relay.ts", ["handleTransition"], {
    interviewDone:false,isOprunRecruitmentInterview:true,lastListeningAudioActivityAt:Date.now(),
    ASR_ACTIVE_SPEECH_HOLD_MS:5000,
    retainDeferredAnswerBeforeTransition:()=>{throw new Error("must defer before committing or switching");},
  });
  await vm.runInContext("handleTransition(true)",sandbox);
  assert.equal(sandbox.isTransitioning,false);
});

test("twenty first ASR handshakes use four bounded slots and failures release their slots", async () => {
  const schedule=createAsrInitialConnectQueue(4);
  const releases:Array<()=>void>=[];
  const started:number[]=[];
  let active=0,peak=0;
  const tasks=Array.from({length:20},(_,index)=>schedule(async()=>{
    started.push(index);active++;peak=Math.max(peak,active);
    await new Promise<void>(resolve=>releases.push(resolve));
    active--;
    if(index===3)throw new Error("injected handshake failure");
    return index;
  }));
  const all=Promise.allSettled(tasks);
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(started,[0,1,2,3]);
  for(let index=0;index<20;index++){
    assert.ok(releases[index],"a failed connection stranded the queue");
    releases[index]();
    await new Promise(resolve=>setImmediate(resolve));
  }
  const results=await all;
  assert.equal(peak,4);
  assert.deepEqual(started,Array.from({length:20},(_,i)=>i));
  assert.equal(results.filter(r=>r.status==="rejected").length,1);
  assert.equal(active,0);
});

test("actual ASR connection joins concurrent calls and retains throttling for later attempts", async () => {
  for(const provider of ["offline","volcengine"]) for(const failFirst of [false,true]){
    const events:string[]=[];let release:()=>void=()=>{};
    let calls=0;
    const sandbox=relayFunctions("voice-relay.ts",["connectAsr"],{
      asrConnectPending:null,asrConnectionAttempted:false,voiceRoute:{provider},
      scheduleInitialAsrConnect:(task:()=>Promise<void>)=>{events.push("initial");return task();},
      scheduleAsrConnect:(task:()=>Promise<void>)=>{events.push("replacement");return task();},
      connectAsrUngated:async()=>{calls++;if(calls===1){await new Promise<void>(resolve=>{release=resolve;});if(failFirst)throw new Error("injected first failure");}},
    });
    const first=vm.runInContext("connectAsr()",sandbox);
    const joined=vm.runInContext("connectAsr()",sandbox);
    const settled=Promise.allSettled([first,joined]);
    assert.equal(calls,1);release();await settled;
    assert.equal(sandbox.asrConnectPending,null);
    await vm.runInContext("connectAsr()",sandbox);
    assert.equal(calls,2);
    assert.deepEqual(events,["initial",provider === "offline" ? "initial" : "replacement"]);
  }
});

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

test("silence reminder restores actual ASR readiness before starting the next inactivity window", async () => {
  for (const outcome of ["played", "transitioned", "failed", "undelivered"] as const) {
    const events: string[] = [];
    let timer: (() => Promise<void>) | undefined;
    let finishSpeech!: () => void;
    const spoken = new Promise<void>((resolve) => { finishSpeech = resolve; });
    const sandbox = relayFunctions("voice-relay.ts", ["armSilenceAutoSkip", "reopenAsr"], {
      interviewDone:false, endingInterview:false, pendingProgressiveTransition:false,
      responseGenerationBlocked:false, asrAlive:true, isTransitioning:false,
      generatingResponse:false, ttsSpeaking:false, awaitingFinalResponse:false,
      silenceAskCount:0, MAX_SILENT_ASKS_PER_QUESTION:2, currentQuestionIndex:0,
      transitionGeneration:0, isOprunRecruitmentInterview:true, isZh:true,
      clearSilenceAutoSkip:()=>{}, silenceAutoSkipTimer:null, SILENCE_ASK_MS:100,
      setTimeout:(callback:()=>Promise<void>)=>{timer=callback;return 1;},
      recoverDeferredUserTurnBeforeInactivity:async()=>false,
      logVoiceInputProgress:()=>{}, log:{info(){},warn(){},error(){}},
      bt:(_zh:boolean,text:string)=>text, SPOKEN:{silenceAsk:()=>"Please continue"},
      speakText:async()=>{events.push("tts_text");await spoken;if(outcome==="failed")throw new Error("synthetic TTS failure");if(outcome==="undelivered")return false;events.push("tts_ended");return true;},
      armSilenceConfirm:()=>events.push("confirm_timer"),
      markResponseGenerationBlocked:()=>events.push("system_failure"),
      connectAsr:async()=>{events.push("asr_ready");},keepAliveInterval:1,
      pendingUserUtteranceWhileSuppressed:"", suppressAsrResults:false,
      browserWs:{readyState:1,send:(data:string)=>events.push(JSON.parse(data).type)},WebSocket:{OPEN:1},
    });
    vm.runInContext("armSilenceAutoSkip()",sandbox);
    const pending=timer!();
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(events,["tts_text"],"inactivity started while the reminder was still playing");
    if(outcome==="transitioned") sandbox.transitionGeneration=1;
    finishSpeech();await pending;
    assert.deepEqual(events,outcome==="played"
      ? ["tts_text","tts_ended","asr_ready","input_ready","confirm_timer"]
      : outcome==="failed" || outcome==="undelivered" ? ["tts_text","system_failure"] : ["tts_text","tts_ended"]);
  }
});

test("waiting for background questions cannot arm or finish an inactivity timeout", async () => {
  const timers: Array<()=>void> = [];
  const sandbox = relayFunctions("voice-relay.ts", ["armSilenceAutoSkip", "abandonForInactivity"], {
    pendingProgressiveTransition:true, interviewDone:false, endingInterview:false,
    clearSilenceAutoSkip:()=>{}, silenceAutoSkipTimer:null, SILENCE_ASK_MS:100,
    setTimeout:(callback:()=>void)=>{timers.push(callback);return timers.length;},
    ownsPersistedSession:()=>{throw new Error("background wait must not terminate a candidate");},
  });
  vm.runInContext("armSilenceAutoSkip()",sandbox);
  assert.equal(timers.length,0);
  await vm.runInContext("abandonForInactivity()",sandbox);
  sandbox.pendingProgressiveTransition=false;
  vm.runInContext("armSilenceAutoSkip()",sandbox);
  assert.equal(timers.length,1);
  sandbox.pendingProgressiveTransition=true;
  timers[0]();
  assert.equal(timers.length,1,"a stale timeout must not re-arm while questions are pending");
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

test("a failed system response cannot become candidate inactivity through a stale silence timer", async () => {
  const timers: Array<() => void> = [];
  const messages: Array<{type:string;message:string}> = [];
  const sandbox = relayFunctions("voice-relay.ts", ["markResponseGenerationBlocked", "armSilenceAutoSkip", "armSilenceConfirm", "abandonForInactivity"], {
    interviewDone:false, endingInterview:false, isOprunRecruitmentInterview:true,
    clearSilenceAutoSkip:()=>{}, silenceAutoSkipTimer:null, silenceConfirmPending:true,
    SILENCE_ASK_MS:100, SILENCE_CONFIRM_MS:100,
    setTimeout:(callback:()=>void)=>{timers.push(callback);return timers.length;},
    browserWs:{readyState:1,send:(text:string)=>messages.push(JSON.parse(text))}, WebSocket:{OPEN:1},
    ownsPersistedSession:()=>{throw new Error("a system failure must not abandon the candidate");},
  });
  vm.runInContext("armSilenceAutoSkip(); armSilenceConfirm(); markResponseGenerationBlocked()",sandbox);
  assert.equal(timers.length,2);
  assert.equal(sandbox.responseGenerationBlocked,true);
  assert.equal(sandbox.silenceConfirmPending,false);
  assert.equal(messages[0].type,"error");
  assert.doesNotMatch(messages[0].message,/409|HR_model|provider|重试次数/);
  for (const callback of timers) callback();
  vm.runInContext("armSilenceAutoSkip(); armSilenceConfirm()",sandbox);
  await vm.runInContext("abandonForInactivity()",sandbox);
  assert.equal(timers.length,2);
});

test("actual inactivity path processes a deferred answer or done command without abandoning", async () => {
  for (const buffer of ["pendingUserUtteranceWhileSuppressed", "pendingAsrFinalText", "queuedUserUtteranceWhileGenerating", "asrAccumulator", "heldBargeInInterimText"]) {
    for (const answer of ["我负责核对合同，异常交给负责人复核。", "答完了，没有了，请继续。", "我没有其他问题了，可以结束面试，谢谢。"]){
      const processed:string[]=[];
      const sent:Array<{type:string;text:string}>=[];
      const noop=()=>{};
      const sandbox=relayFunctions("voice-relay.ts", ["abandonForInactivity","recoverDeferredUserTurnBeforeInactivity"], {
        interviewDone:false,endingInterview:false,ownsPersistedSession:()=>true,
        isOprunRecruitmentInterview:true,currentQuestionIndex:1,ctxSessionId:"offline-inactivity",
        queuedUserUtteranceWhileGenerating:"",pendingUserUtteranceWhileSuppressed:"",pendingAsrFinalText:"",
        queuedUserUtteranceIsChat:false,lastUserAudioActivityAt:0,ASR_ACTIVE_SPEECH_HOLD_MS:1000,
        mergeAsrSegments,questionTranscript:[],looksLikeAssistantPlaybackEcho:()=>false,isDuplicateUserFinal:()=>false,
        clearPendingAsrFinal:()=>{sandbox.pendingAsrFinalText="";},
        armSilenceAutoSkip:noop,log:{info:noop,error:noop},
        browserWs:{readyState:1,send:(s:string)=>sent.push(JSON.parse(s))},WebSocket:{OPEN:1},
        handleUserUtterance:async(s:string)=>processed.push(s),
        persistSessionStatus:()=>{throw new Error("buffered speech must not be abandoned");},
      });
      sandbox[buffer]=answer;
      await vm.runInContext("abandonForInactivity()",sandbox);
      assert.deepEqual(processed,[answer]);
      assert.equal(sent[0].text,answer);
      assert.equal(sandbox.endingInterview,false);
      assert.equal(sandbox.pendingAsrFinalText,"");
      assert.equal(sandbox.pendingUserUtteranceWhileSuppressed,"");
      assert.equal(sandbox.queuedUserUtteranceWhileGenerating,"");
      assert.equal(sandbox.asrAccumulator,"");
    }
  }
});

test("deferred inactivity recovery preserves active speech and never replays an echo or duplicate", async () => {
  for (const mode of ["active", "echo", "duplicate"]) {
    let rearmed=0;
    const sandbox=relayFunctions("voice-relay.ts",["recoverDeferredUserTurnBeforeInactivity"],{
      isOprunRecruitmentInterview:true,queuedUserUtteranceWhileGenerating:"",pendingUserUtteranceWhileSuppressed:"当前回答",
      pendingAsrFinalText:"",mergeAsrSegments,questionTranscript:[],
      looksLikeAssistantPlaybackEcho:()=>mode==="echo",isDuplicateUserFinal:()=>mode==="duplicate",
      lastUserAudioActivityAt:mode==="active"?Date.now():0,ASR_ACTIVE_SPEECH_HOLD_MS:60000,
      armSilenceAutoSkip:()=>rearmed++,handleUserUtterance:()=>{throw new Error("must not replay");},
    });
    assert.equal(await vm.runInContext("recoverDeferredUserTurnBeforeInactivity()",sandbox),mode==="active");
    assert.equal(rearmed,mode==="active"?1:0);
    assert.equal(sandbox.pendingUserUtteranceWhileSuppressed,"当前回答");
  }
});

test("ongoing microphone speech without any ASR text cannot become candidate inactivity", async () => {
  let rearmed=0;
  const sandbox=relayFunctions("voice-relay.ts",["recoverDeferredUserTurnBeforeInactivity"],{
    isOprunRecruitmentInterview:true,queuedUserUtteranceWhileGenerating:"",pendingUserUtteranceWhileSuppressed:"",
    pendingAsrFinalText:"",asrAccumulator:"",heldBargeInInterimText:"",mergeAsrSegments,
    questionTranscript:[],looksLikeAssistantPlaybackEcho:()=>false,isDuplicateUserFinal:()=>false,
    lastUserAudioActivityAt:Date.now(),ASR_ACTIVE_SPEECH_HOLD_MS:60000,
    armSilenceAutoSkip:()=>rearmed++,handleUserUtterance:()=>{throw new Error("no words may be invented");},
  });
  assert.equal(await vm.runInContext("recoverDeferredUserTurnBeforeInactivity()",sandbox),true);
  assert.equal(rearmed,1);
  sandbox.lastUserAudioActivityAt=0;
  assert.equal(await vm.runInContext("recoverDeferredUserTurnBeforeInactivity()",sandbox),false);
});

test("optional closing silence sends a farewell only when all eight scored answers exist", async () => {
  for (const answered of [7,8]) {
    const events:string[]=[];
    const noop=()=>{};
    const sandbox=relayFunctions("voice-relay.ts",["abandonForInactivity"],{
      interviewDone:false,endingInterview:false,ownsPersistedSession:()=>true,
      isOprunRecruitmentInterview:true,currentQuestionIndex:8,lastUserAudioActivityAt:0,
      recruitmentAnsweredQuestions:new Set(Array.from({length:answered},(_,i)=>i)),hasEightScoredAnswers,
      queueFarewellAndEnd:()=>events.push("farewell"),
      clearSilenceAutoSkip:noop,cancelTts:noop,clearPendingAsrFinal:noop,
      answerCommitGate:{request:async()=>true},ctxSessionId:"local-closing",liveSessions:new Map(),
      persistSessionStatus:async(_sid:string,status:string)=>{events.push(status);return true;},
      browserWs:{readyState:1,send:noop},WebSocket:{OPEN:1},log:{info:noop,warn:noop,error:noop},
    });
    await vm.runInContext("abandonForInactivity()",sandbox);
    assert.deepEqual(events,answered===8?["farewell"]:["ABANDONED"]);
  }
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
  const sandbox=vm.createContext({voiceRoute:{provider:'volcengine'},offlineAsrDrain:new OfflineAsrDrain(), asrAlive:true, asrAudioReplay:{acknowledge:()=>{}}, transitionGeneration:0, pendingProgressiveTransition:false, responseGenerationBlocked:false, isTransitioning:false, generatingResponse:false, ttsSpeaking:false, awaitingFinalResponse:false, suppressAsrResults:false, asrAccumulator:"",heldBargeInInterimText:"",clearHeldBargeInInterim:()=>{}, logVoiceInputProgress:()=>{}, recoverDeferredUserTurnBeforeInactivity:async()=>false, retainDeferredAnswerBeforeTransition:()=>{}, ...context});
  vm.runInContext(ts.transpileModule(Array.from(found.values()).join("\n"), {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText, sandbox);
  return sandbox;
}

test("primary relay real response function never calls the model for answered Q1 or answer-done Q2", async () => {
  for (const index of [0,1]) {
    const sandbox=relayFunctions("voice-relay.ts", ["generateControlledResponse"], {
      interviewDone:false, currentQuestionIndex:index, sortedQuestions:[{text:"介绍"},{text:"经历"}],
      PROMPTS:{formatHistory:()=>""}, questionTranscript:[], isZh:true,
      getLatestAnsweredExchange:()=>({participant:"我负责项目交付。"}),
      recruitmentInteractionReply, companyKnowledgeVersion, recruitmentParticipantMetadataLoaded:false, ctx:{title:"数君招聘 · 工程师"},
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

test("primary actual transition preserves the answer until ACK and reopens input without waiting for summary", { timeout: 5000 }, async () => {
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
    refreshDynamicQuestions:async()=>{}, isZh:true, summarizeQuestion:()=>new Promise<string>(()=>{}), speakWithBackgroundSummary,
    speakAndHandle:async()=>{}, llmRoute:{}, ctx:{interviewId:"synthetic-interview"}, ctxSessionId:"synthetic-session", questionSummaries:[], runQueuedManualTransition:()=>false,
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
  assert.equal(sandbox.isTransitioning, false);
  assert.equal(sandbox.questionSummaries[1], "user: 我不会报未经核验的数据，我负责招聘台账。");
  assert.equal(events.filter((e)=>e.type==="question_change").length, 1);
  gate.close();
});

test("ten last-question transitions keep wrap-up playback on the browser's current question", async () => {
  await Promise.all(Array.from({length:10}, async (_, i) => {
    const count = i % 2 ? 9 : 8;
    let browserIndex = count - 1;
    const events: Record<string, unknown>[] = [];
    const noop = () => {};
    const peer = new EventEmitter() as EventEmitter & {readyState:number;send:(raw:string)=>void};
    peer.readyState = 1;
    peer.send = (raw) => {
      const event = JSON.parse(raw); events.push(event);
      if (event.type === "question_change") browserIndex = event.questionIndex;
      // The real browser correctly ignores stale or unknown question receipts.
      if (event.type === "playback_receipt_request" && event.questionIndex === browserIndex) {
        queueMicrotask(() => peer.emit("message", JSON.stringify({...event,type:"playback_complete"}), false));
      }
    };
    const sandbox = relayFunctions("voice-relay.ts", ["handleTransition"], {
      interviewDone:false, isTransitioning:false, isOprunRecruitmentInterview:true,
      currentQuestionIndex:count-1, questionTranscript:[{role:"user",text:"我负责检查和记录交付结果。"}],
      hasRecruitmentAnswer, silenceAskCount:0, silenceConfirmPending:false,
      answerCommitGate:{request:async()=>true}, recruitmentControlOnly,
      consumedRecruitmentControlKey:"", recentAcceptedUserFinals:[],
      browserWs:peer, WebSocket:{OPEN:1}, reopenAsr:async()=>{},
      log:{error:(...errors:unknown[])=>{throw errors.at(-1);},info:noop},
      shouldWaitForQuestionExpansion:()=>false,
      sortedQuestions:Array.from({length:count},(_,q)=>({text:`Synthetic question ${q+1}`})),
      clearPendingAsrFinal:noop, clearSilenceAutoSkip:noop, disconnectAsr:noop, cancelTts:noop,
      userTurnsOnCurrentQ:1, lastResponseWasCorrection:false, cachedWhiteboardDescription:"",
      whiteboardDirty:false, latestWhiteboardImage:null, recentAgentResponses:[], pendingLastQuestionTimeout:null,
      refreshDynamicQuestions:async()=>{}, isZh:true, summarizeQuestion:async()=>"Saved synthetic answer",
      buildWrapUpSayHello:()=>"还有补充吗？", llmRoute:{}, ctx:{interviewId:"local"}, ctxSessionId:"local",
      questionSummaries:[], runQueuedManualTransition:()=>false,
      speakAndHandle:async()=> {
        const receipt=await waitForBrowserPlayback(peer as unknown as WebSocket, sandbox.currentQuestionIndex,
          new AbortController().signal,100);
        assert.equal(receipt,"played","wrap-up must remain audible and acknowledged on the last valid question");
      },
    });
    await vm.runInContext("handleTransition()",sandbox);
    assert.equal(sandbox.currentQuestionIndex,count-1);
    assert.equal(sandbox.awaitingFinalResponse,true);
    assert.equal(sandbox.isTransitioning,false);
    assert.equal(events.filter(e=>e.type==="question_change").length,0);
    assert.equal(events.filter(e=>e.type==="playback_receipt_request").length,1);
  }));
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

test("backup socket validates silent decisions and drops cancelled or stale results",async()=>{
  for(const scenario of ["advance","invalid","stale","cancelled"]){
    const handlers=new Map<string,(data:Buffer)=>void>();
    const ws={on:(name:string,handler:(data:Buffer)=>void)=>handlers.set(name,handler)};
    const events:string[]=[];
    const answer="我用测试验证。";
    const sandbox=relayFunctions("openai-voice-relay.ts",["attachOaiHandlers"],{
      oaiWs:ws,lastOaiActivity:0,log:{debug:()=>{},error:(error:unknown)=>{throw error;}},
      recruitmentDecisions:new Map(scenario==="cancelled"?[]:[["decision",{questionIndex:2,answer}]]),
      currentQuestionIndex:scenario==="stale"?3:2,responseInFlight:true,
      takeQueuedAssistantResponse:()=>null,conversationHistory:[{role:"user",text:answer}],
      interviewDone:false,reconnecting:false,isZh:true,readRecruitmentRealtimeDecision,recruitmentRealtimeSpeechRequest,
      transitionToNextWhenReady:async()=>{events.push("advance");},
      requestAssistantResponse:(_reason:string,response:Record<string,unknown>)=>{events.push("speak");assert.doesNotMatch(String(response.instructions),/evidence_quotes/);},
    });
    sandbox.ws=ws;vm.runInContext("attachOaiHandlers(ws)",sandbox);
    const decision={action:"advance",evidence_quotes:[scenario==="invalid"?"编造的原话":answer],missing_evidence:"",speech:"谢谢"};
    handlers.get("message")!(Buffer.from(JSON.stringify({type:"response.done",response:{status:"completed",
      metadata:{topic:"recruitment_evidence",decisionId:"decision"},output:[{content:[{type:"output_text",text:JSON.stringify(decision)}]}]}})));
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(events,scenario==="advance"?["advance"]:scenario==="invalid"?["speak"]:[]);
    assert.equal(sandbox.recruitmentDecisions.size,0);
    if(scenario==="cancelled")assert.equal(sandbox.responseInFlight,true);
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


test("ten interrupted response cycles retain their model ownership and queue the next spoken final", async () => {
  for (let i=0;i<10;i++) {
    let cancelled=0; const messages:unknown[]=[];
    const sandbox=relayFunctions("voice-relay.ts",["interruptAssistantPlayback","handleUserUtterance"],{
      generatingResponse:true,suppressAsrResults:true,ttsSpeaking:true,
      cancelTts:()=>{cancelled++;},
      browserWs:{readyState:1,send:(value:string)=>messages.push(JSON.parse(value))},WebSocket:{OPEN:1},
      isTransitioning:false,interviewDone:false,isOprunRecruitmentInterview:true,
      isUserEndRequest:()=>false,isFastPrevRequest:()=>false,isUserPrevRequest:()=>false,
      isFastNextRequest:()=>false,isUserSkipRequest:()=>false,isSameAsPendingUserTurn:()=>false,
      isDuplicateUserFinal:()=>false,isReplayOfPendingUserTurn:()=>false,
      asrAudioReplay:{acknowledge:()=>{}},currentQuestionIndex:1,clearSilenceAutoSkip:()=>{},
      silenceAskCount:0,silenceConfirmPending:false,unansweredQuestionsStreak:0,
      queuedUserUtteranceWhileGenerating:"",queuedUserUtteranceIsChat:false,mergeAsrSegments,
      log:{info:()=>{}},
      generateControlledResponse:()=>{throw new Error("a second model request started before the old one settled");},
    });
    vm.runInContext("interruptAssistantPlayback()",sandbox);
    await vm.runInContext("handleUserUtterance('这是新的模拟补充回答。')",sandbox);
    assert.equal(cancelled,1);
    assert.equal(sandbox.generatingResponse,true);
    assert.equal(sandbox.suppressAsrResults,false);
    assert.equal(sandbox.queuedUserUtteranceWhileGenerating,'这是新的模拟补充回答。');
    assert.deepEqual(messages,[{type:"interrupt"}]);
  }
});

test('actual relay expansion carries immutable IDs to the original browser callback',()=>{
 const rows=Array.from({length:8},(_,order)=>({id:`q${order}`,order,text:`模拟问题${order}`,type:'OPEN_ENDED'}));
 const events:Array<{questionIds:unknown}>=[];
 const sandbox=relayFunctions('voice-relay.ts',['normalizeDynamicQuestions','applyDynamicQuestionSet'],{
  sortedQuestions:rows.slice(0,2),currentQuestionIndex:1,mergeExpandedQuestionSet,isProgressiveOpeningOnly,
  browserWs:{readyState:1,send:(s:string)=>events.push(JSON.parse(s))},WebSocket:{OPEN:1},log:{info:()=>{},warn:()=>{}}
 });
 sandbox.rows=rows;assert.equal(vm.runInContext("applyDynamicQuestionSet(rows,'database')",sandbox),true);
 const lookup=new LiveQuestionIdLookup(rows.slice(0,2));lookup.updateFromRelay(events[0].questionIds);
 lookup.update(rows.slice(0,2));
 assert.deepEqual(rows.map((_,i)=>lookup.idAt(i)),rows.map(r=>r.id));
});

test('actual offline relay retains ten sockets across eight question transitions',async()=>{
 for(let session=0;session<10;session++){
  let resets=0;
  const socket={readyState:1,send:()=>{}};
  const sandbox=relayFunctions('voice-relay.ts',['disconnectAsr','connectAsrUngated'],{
   voiceRoute:{provider:'offline'},asrWs:socket,WebSocket:{OPEN:1},interviewDone:false,
   browserWs:{readyState:1},asrIntentionalClose:false,asrAudioSeq:1,keepAliveInterval:null,
   asrSessionFirstSpeechAt:0,clearPendingAsrFinal:()=>{},clearHeldBargeInInterim:()=>{},
   buildBigModelAudioRequest:()=>Buffer.alloc(0),Buffer,log:{info:()=>{}},armSilenceAutoSkip:()=>{},
   closeAsrSocket:()=>{throw new Error('healthy offline connection was unnecessarily closed');},
   resetOfflineAsr:async(s:unknown)=>{assert.equal(s,socket);resets++;},
  });
  for(let turn=0;turn<8;turn++){
   vm.runInContext('disconnectAsr()',sandbox);assert.equal(sandbox.asrAlive,false);
   await vm.runInContext('connectAsrUngated()',sandbox);assert.equal(sandbox.asrAlive,true);
  }
  assert.equal(resets,8);
 }
});


test('actual relay waits for offline decoder receipts even after microphone silence',()=>{
 const drain=new OfflineAsrDrain();drain.sent(2,32000,true);drain.sent(3,32000,false);drain.acknowledge(2);
 const sandbox=relayFunctions('voice-relay.ts',['shouldHoldPendingAsrFinalForActiveSpeech'],{
  voiceRoute:{provider:'offline'},offlineAsrDrain:drain,ASR_ACTIVE_SPEECH_HOLD_MS:1000,
 });
 assert.equal(vm.runInContext("shouldHoldPendingAsrFinalForActiveSpeech('请问岗位薪资福利可以保证。')",sandbox),true);
});
