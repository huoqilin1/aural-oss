// Real recording hook and browser cameras; all uploads remain local mocks.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {chromium} from 'playwright';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const bundle=await build({absWorkingDir:root,bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"','process.env':'{}'},stdin:{resolveDir:root,loader:'tsx',contents:`
import {createRoot} from 'react-dom/client';import {useInterviewRecording} from './src/hooks/use-interview-recording';
function App(){const r=useInterviewRecording({sessionId:'local',enabled:true,screenshotIntervalMs:250});window.recording=r;return <button onClick={()=>r.start()}>Start</button>};createRoot(document.getElementById('root')).render(<App/>);`}});
const browser=await chromium.launch({headless:process.platform!=='win32',args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--autoplay-policy=no-user-gesture-required']});
try{
 const outcomes=await Promise.allSettled(Array.from({length:Number(process.env.CAMERA_TEST_COUNT||10)},async(_,index)=>{
  const context=await browser.newContext({permissions:['camera','microphone']});
  try{
   await context.addInitScript(index=>{
    const native=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);window.cameraAttempts=0;
    navigator.mediaDevices.getUserMedia=async c=>{if(c.video){window.cameraAttempts++;if(index===1&&window.cameraAttempts===1)throw new DOMException('Transient device startup failure','NotReadableError');}return native(c);};
    const play=HTMLMediaElement.prototype.play;let rejected=false;
    HTMLMediaElement.prototype.play=function(){if(index===2&&this.tagName==='VIDEO'&&!rejected){rejected=true;return Promise.reject(new DOMException('Transient playback interruption','AbortError'));}return play.call(this);};
   },index);
   const page=await context.newPage();let screenshots=0;
   await context.route('https://camera.invalid/**',route=>{
    const request=route.request();
    if(request.url().endsWith('/app.js'))return route.fulfill({contentType:'text/javascript',body:bundle.outputFiles[0].text});
    if(request.url().endsWith('/api/session/upload')){screenshots++;return route.fulfill({json:{url:'https://camera.invalid/private-image',path:'local/camera.jpg'}});}
    return route.fulfill({contentType:'text/html',body:'<div id="root"></div><script src="/app.js"></script>'});
   });
   await page.goto('https://camera.invalid/');await page.getByRole('button').click();
   await page.waitForFunction(()=>window.recording.isRecording);
   await page.waitForTimeout(1500);
   const before=screenshots;
   if(index===3)await page.evaluate(()=>window.recording.cameraStream?.getVideoTracks().forEach(t=>t.stop()));
   await page.waitForTimeout(6500);
   const camera=await page.evaluate(()=>({present:!!window.recording.cameraStream,tracks:window.recording.cameraStream?.getVideoTracks().map(t=>({state:t.readyState,enabled:t.enabled}))??[],videos:[...document.querySelectorAll('video')].map(v=>({width:v.videoWidth,state:v.readyState,paused:v.paused}))}));
   const live=camera.tracks.some(t=>t.state==='live');
   const attempts=await page.evaluate(()=>window.cameraAttempts);
   assert.ok(live&&screenshots>0&&(index!==3||screenshots>before),`route ${index}: ${JSON.stringify(camera)}, images=${screenshots}, attempts=${attempts}`);
   return {index,passed:true,screenshots,attempts};
  }finally{await context.close();}
 }));
 const result=outcomes.map((v,index)=>v.status==='fulfilled'?v.value:{index,passed:false,error:String(v.reason)});
 console.log(JSON.stringify({productionRequests:0,result}));
 assert.ok(result.every(r=>r.passed),'Camera capture/recovery failed');
}finally{await browser.close();}
