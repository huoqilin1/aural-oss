import {readFileSync,writeFileSync} from 'node:fs';
const policy=readFileSync(new URL('./local-ten-driver-policy.mjs',import.meta.url),'utf8').replace('export function','function');
const source=`async(page)=>{
 ${policy}
 const results=[];
 for(const c of page.context().browser().contexts())for(const p of c.pages()){
  const state=await p.evaluate(()=>{
   const t=document.body.innerText,v=window.__qaVoice||{},q=Number(t.match(/第\\s*(\\d+)\\s*\\/\\s*8\\s*题/)?.[1])||0;
   return {index:window.__qaIndex,run:window.__qaRun,q,ready:v.ready&&v.connected,terminal:v.terminal||false,error:v.error||false,playing:window.__qaPlaybackState?.status==='playing',
    seq:v.seq||0,prompt:v.prompt||'',lastHandledSeq:window.__qaLastHandledSeq||0,mainSent:(window.__qaMainSent||[]).includes(q),supplements:(window.__qaSupplementCount||{})[q]||0,
    done:t.includes('测试已完成'),asrEnds:v.asrEnds||0,camera:[...document.querySelectorAll('video')].some(x=>x.videoWidth>0&&x.readyState>=2)};
  });
  if(!(state.index>=131&&state.index<=140)||state.run!==2)continue;
  const selected=chooseSpeech(state);
  let sent=false;
  if(selected){
   const r=await p.request.get('http://127.0.0.1:3308/__qa-audio/'+selected.file+'.wav');if(!r.ok())throw Error('Offline fixture missing');
   const base64=(await r.body()).toString('base64');
   sent=await p.evaluate(({state,selected,base64})=>{
    const v=window.__qaVoice;if(!v.ready||!v.connected||v.terminal||v.error||v.seq!==state.seq)return false;
    window.__qaLastHandledSeq=state.seq;window.__qaMainSent||=[];window.__qaSupplementCount||={};
    if(selected.kind==='main')window.__qaMainSent.push(state.q);
    if(selected.kind==='supplement'||selected.kind==='no-more')window.__qaSupplementCount[state.q]=(window.__qaSupplementCount[state.q]||0)+1;
    window.__qaPlaybackState={q:state.q,kind:selected.kind,status:'playing'};
    window.__qaSpeak(base64).then(()=>{window.__qaPlaybackState={q:state.q,kind:selected.kind,status:'ended',at:Date.now()};},()=>{window.__qaPlaybackState={status:'failed'};});
    return true;
   },{state,selected,base64});
  }
  results.push({index:state.index,q:state.q,ready:state.ready,done:state.done,terminal:state.terminal,error:state.error,camera:state.camera,asrEnds:state.asrEnds,sent,kind:sent?selected.kind:null});
 }
 return results;
}`;
writeFileSync('output/local-ten-retake-step.js',source);
console.log('Built WS-aware bounded ten-way speech driver');
