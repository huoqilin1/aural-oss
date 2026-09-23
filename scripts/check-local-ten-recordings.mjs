import {readFileSync,writeFileSync} from 'node:fs';
import {createClient} from '@supabase/supabase-js';
const root='output/local-sandbox/official-ten-20260915/';
const rows=JSON.parse(readFileSync(root+'retake-bound-private.json','utf8')).results;
const cfg=JSON.parse(readFileSync('output/local-sandbox/supabase-status-private.json','utf8').replace(/^\uFEFF/,''));
if(cfg.API_URL!=='http://127.0.0.1:55321')throw Error('Local only');
const db=createClient(cfg.API_URL,cfg.SERVICE_ROLE_KEY,{auth:{persistSession:false}});
const results=[];
for(const row of rows){
 const {data,error}=await db.from('sessions').select('audioRecordingUrl').eq('id',row.newSessionId).single();
 if(error)throw error;
 const listed=await db.storage.from('recordings').list(row.newSessionId);
 if(listed.error)throw listed.error;
 results.push({fixture:row.fixture,linked:!!data.audioRecordingUrl,files:listed.data.length,bytes:listed.data.reduce((n,f)=>n+(f.metadata?.size||0),0)});
}
writeFileSync(root+'retake-recording-receipt.json',JSON.stringify({results},null,2));console.log(JSON.stringify({results}));
