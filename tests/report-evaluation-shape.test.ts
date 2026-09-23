import assert from 'node:assert/strict';
import test from 'node:test';
import {validateReport} from '../src/lib/ai/validate-report';
import {buildSummaryPrompt} from '../src/lib/ai/prompts/summary';
const entries = () => Array.from({length:8}, (_,i)=>({question:`Q${i+1}`,score:3,evaluation:'Evidence remains self-reported.'}));
test('wrapped GLM evaluations retain entries and qualification without another model call',()=>{
 const items=entries(); const report={summary:'Report',questionEvaluations:{note:'Synthetic answers only.',items}};
 validateReport(report,8);
 assert.equal(report.questionEvaluations,items);
 assert.equal((report as unknown as Record<string,unknown>).questionEvaluationsNote,'Synthetic answers only.');
 validateReport(report,8);
});
test('eight scored questions reject missing, duplicate, optional ninth and malformed evaluations',()=>{
 for(const list of [[],entries().slice(1),[...entries(),{question:'optional',score:1,evaluation:'not scored'}],entries().map(()=>entries()[0])]) {
  assert.throws(()=>validateReport({summary:'Report',questionEvaluations:list},8),/report_question_coverage_incomplete/);
 }
 for(const bad of [null,'3',0,11,NaN]) {
  const list=entries(); list[0].score=bad as number;
  assert.throws(()=>validateReport({summary:'Report',questionEvaluations:list},8),/report_question_evaluation_invalid/);
 }
});
test('unrecognized wrappers are not flattened with possible evidence loss',()=>{
 assert.throws(()=>validateReport({summary:'Report',questionEvaluations:{items:entries(),other:'unrecognized'}}),/report_evaluations_invalid/);
});
test('recruiting report requests eight ordered scored questions and excludes optional closing',()=>{
 const questions=Array.from({length:9},(_,i)=>({text:`QuestionMarker${i}`,order:i})).reverse();
 const prompt=String(buildSummaryPrompt('数君招聘 · QA',[],null,null,questions,'zh')[0].content);
 assert.match(prompt,/exactly 8 entries/);
 assert.doesNotMatch(prompt,/QuestionMarker8/);
 assert.ok(prompt.indexOf('QuestionMarker0')<prompt.indexOf('QuestionMarker7'));
 assert.equal(questions[0].order,8);
});
