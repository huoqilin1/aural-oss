import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
const root = 'output/local-sandbox/real-report/';
const output = root + 'offline-pilot-private.json';
assert.ok(!existsSync(output), 'Pilot already dispatched; inspect and resume existing IDs');
const cfg = JSON.parse(readFileSync('output/local-sandbox/supabase-status-private.json', 'utf8').replace(/^\uFEFF/, ''));
assert.equal(cfg.API_URL, 'http://127.0.0.1:55321');
const prior = JSON.parse(readFileSync(root + 'live-fixture-private.json', 'utf8'));
const key = JSON.parse(readFileSync(root + 'reconcile-key-private.json', 'utf8')).key;
const db = createClient(cfg.API_URL, cfg.SERVICE_ROLE_KEY, {auth:{persistSession:false, autoRefreshToken:false}});
const questions = await db.from('questions').select('order,text,type,description').eq('interviewId', prior.interviewId).order('order');
assert.ifError(questions.error); assert.equal(questions.data.length, 8);
const receipt = {synthetic:true, stage:'dispatch', scope:'local voice pilot; not website intake or ten-way acceptance'};
writeFileSync(output, JSON.stringify(receipt));
const headers = {'Content-Type':'application/json', Authorization:'Bearer ' + key};
const create = await fetch('http://127.0.0.1:3300/api/v1/interviews', {method:'POST', headers, redirect:'error', body:JSON.stringify({
  title:'数君招聘 · 离线语音本地虚构验收', description:'仅虚构订单核对岗位，所有回答均为测试数据。',
  objective:'验证页面、真实离线语音、GLM与报告保存；不得评价真实人员。',
  language:'zh-CN', voiceTest:true, voiceEnabled:true, videoEnabled:true,
  relayLlmRoute:{primary:'zhipu', fallbacks:[]},
})});
assert.equal(create.status, 200);
const interview = (await create.json()).data;
receipt.interviewId = interview.id; receipt.stage = 'interview-created';
writeFileSync(output, JSON.stringify(receipt));
assert.ifError((await db.from('questions').insert(questions.data.map(q => ({...q, interviewId:interview.id})))).error);
const invite = await fetch('http://127.0.0.1:3300/api/v1/interviews/' + interview.id + '/candidates', {method:'POST', headers, redirect:'error', body:JSON.stringify({name:'虚构离线语音验收', email:'offline-pilot@example.invalid', notes:'仅本地模拟，不通知真人'})});
assert.equal(invite.status, 200);
const candidate = (await invite.json()).data[0];
receipt.candidateId = candidate.id; receipt.inviteToken = candidate.inviteToken; receipt.stage = 'ready';
writeFileSync(output, JSON.stringify(receipt));
console.log(JSON.stringify({ready:true, questions:8, voice:true, video:true, offline:true, modelCalls:0}));
