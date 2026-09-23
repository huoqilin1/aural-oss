// One real GLM Coding membership request with the application's report prompt.
// Provider-layer evidence only: no browser, database or HR control substitution.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
const root=resolve(import.meta.dirname,'..');
const output=resolve(root,'output','real-report-provider-'+Date.now());
mkdirSync(output,{recursive:true});
const compiled=await build({stdin:{contents:'export {buildSummaryPrompt} from "./src/lib/ai/prompts/summary"; export {extractJson} from "./src/lib/ai/extract-json"; export {validateReport} from "./src/lib/ai/validate-report";',resolveDir:root},absWorkingDir:root,bundle:true,write:false,platform:'node',format:'cjs'});
const modulePath=resolve(output,'report-contract.cjs');writeFileSync(modulePath,compiled.outputFiles[0].contents);
const {buildSummaryPrompt,extractJson,validateReport}=createRequire(import.meta.url)(modulePath);
const questions=['请自我介绍并说明相关经历。','如何核对订单并处理差错？','如何协调需求变更？','如何判断任务优先级？','如何核实交付结果？','一次失误如何复盘？','如何使用 AI 并核验输出？','入职后如何安排第一个月？'].map((text,order)=>({text,order,type:'OPEN_ENDED'}));
const answers=['以下全部是虚构测试数据。我在虚构商贸团队负责订单台账，核对客户需求和交付记录。','我逐条比对订单号、数量和承诺日期，差错先在台账标记，再请负责人确认，不自行改价格。','我记录变更内容、影响和提出时间，让销售与交付负责人共同确认后更新版本。','先检查截止日期和对其他任务的影响，有冲突就列出两个方案交负责人决定。','我对照签收记录与订单逐项核验，缺少证明的项目标记待确认，不填造成功结果。','曾漏填一次变更日期，我补查原记录并增加必填检查；没有保存统计数据，不能声称提升了具体百分比。','我用 AI 草拟核对清单，再用原始资料逐项验证；不向模型提供客户敏感信息，不直接使用未经核验的数字。','第一周学习流程，第二周跟随同事核对，第三周独立处理小批量，第四周请负责人抽检；这些是计划，不是已经完成的业绩。'];
const messages=questions.flatMap((q,i)=>[{role:'assistant',content:q.text},{role:'user',content:answers[i]}]);
const prompt=buildSummaryPrompt('数君招聘 · 合成订单运营验收',messages,'评估岗位相关证据，所有材料均为虚构测试，不生成真实人员结论。',[{name:'执行与核验',description:'依据回答中的具体行动与可验证结果评分'}],questions,'zh-CN');
const receipt={provider:'GLM Coding membership',requests:0,model:'glm-5.3',passed:false,fullPageToReportPassed:false,databasePersisted:false,syntheticInput:true,output};
const started=Date.now();
try {
 const config=JSON.parse(readFileSync('C:/Users/wang/.zcode/v2/config.json','utf8').replace(/^\uFEFF/,''));
 const provider=config.provider['builtin:bigmodel-coding-plan'];assert.equal(provider.enabled,true);
 const key=provider.options.apiKey;assert.ok(typeof key==='string'&&key.trim());
 const endpoint='https://open.bigmodel.cn/api/coding/paas/v4/chat/completions';
 receipt.requests=1;
 const response=await fetch(endpoint,{method:'POST',redirect:'error',signal:AbortSignal.timeout(240000),headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},body:JSON.stringify({model:'glm-5.3',messages:prompt,max_tokens:32768,temperature:0.3,thinking:{type:'enabled'},stream:false})});
 receipt.httpStatus=response.status;assert.ok(response.ok,'provider_http_failure');
 const body=await response.json();const content=body.choices?.[0]?.message?.content;
 assert.ok(typeof content==='string'&&content.trim(),'provider_content_missing');
 const report=extractJson(content);validateReport(report);
 receipt.reportHash=createHash('sha256').update(JSON.stringify(report)).digest('hex');
 receipt.summaryCharacters=report.summary.length;receipt.usage=body.usage;receipt.finishReason=body.choices?.[0]?.finish_reason;
 writeFileSync(resolve(output,'synthetic-report.json'),JSON.stringify(report,null,2));receipt.passed=true;
} catch(error) {receipt.errorType=error.name;receipt.error=String(error.message).slice(0,180);process.exitCode=1;}
finally {receipt.elapsedMs=Date.now()-started;writeFileSync(resolve(output,'receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));}
