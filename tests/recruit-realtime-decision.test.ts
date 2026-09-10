import assert from "node:assert/strict";
import test from "node:test";
import {recruitmentRealtimeDecisionRequest,readRecruitmentRealtimeDecision,recruitmentRealtimeSpeechRequest} from "../src/lib/voice/recruitment-realtime-decision";

test("backup decision is silent, isolated, and cannot call navigation tools",()=>{
  const request=recruitmentRealtimeDecisionRequest("check","你如何验证？","我使用测试验证。",true);
  assert.deepEqual(request.output_modalities,["text"]);
  assert.equal(request.conversation,"none");
  assert.deepEqual(request.tools,[]);
  assert.equal(request.tool_choice,"none");
  assert.match(request.instructions,/严格JSON/);
  assert.match(request.input[0].content[0].text,/最新完整发言: 我使用测试验证。/);
});

test("backup accepts evidence decision but rejects fabricated evidence and failed output",()=>{
  const decision={action:"advance",evidence_quotes:["使用测试"],missing_evidence:"",speech:"谢谢"};
  const response={status:"completed",output:[{content:[{type:"output_text",text:JSON.stringify(decision)}]}]};
  assert.equal(readRecruitmentRealtimeDecision(response,"我使用测试验证。",true).advance,true);
  const invalid=readRecruitmentRealtimeDecision(response,"我只做设计。",true);
  assert.equal(invalid.advance,false);
  assert.doesNotMatch(invalid.speech,/evidence_quotes|advance|NEXT/);
  assert.equal(readRecruitmentRealtimeDecision({...response,status:"failed"},"我使用测试验证。",true).advance,false);
});

test("validated voice reply has no candidate context or navigation tools",()=>{
  const request=recruitmentRealtimeSpeechRequest("你如何验证？");
  assert.deepEqual(request.input,[]);
  assert.deepEqual(request.tools,[]);
  assert.deepEqual(request.output_modalities,["audio"]);
  assert.match(request.instructions,/你如何验证/);
});
