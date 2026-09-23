// Explicit hardware test. Keeps raw microphone/camera data in browser memory only.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
assert.equal(process.env.AURAL_REAL_DEVICE_ACCEPTANCE, '1', 'Explicit hardware opt-in required');
const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'output/real-device-local',new Date().toISOString().replace(/[:.]/g,'-'));
mkdirSync(output, {recursive:true});
const bundle = await build({absWorkingDir:root,bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',
  define:{'process.env.NODE_ENV':'"production"','process.env':'{}'},
  stdin:{resolveDir:root,loader:'tsx',contents:`
    import {RecruitmentMediaAccess} from './src/lib/voice/recruitment-media-access';
    import {useInterviewRecording} from './src/hooks/use-interview-recording';
    import {createRoot} from 'react-dom/client';
    window.Entry=RecruitmentMediaAccess;
    function App(){window.recording=useInterviewRecording({sessionId:'local-hardware',enabled:true,screenshotIntervalMs:1000});return null;}
    const root=createRoot(document.getElementById('root'));root.render(<App/>);window.unmount=()=>root.unmount();`}});
const headless = process.env.AURAL_REAL_DEVICE_HEADED !== '1';
const browser = await chromium.launch({headless}); // No fake media devices or source substitution.
let result;
try {
  const ctx = await browser.newContext({permissions:['camera','microphone']});
  const unexpected=[];
  await ctx.route('**/*', route => {
    const url=new URL(route.request().url());
    if(url.origin!=='https://local-hardware.invalid'){unexpected.push(url.origin);return route.abort();}
    if(url.pathname==='/app.js')return route.fulfill({contentType:'text/javascript',body:bundle.outputFiles[0].text});
    return route.fulfill({contentType:'text/html',body:'<div id="root"></div><button id="start">Start local capture</button><video muted autoplay playsinline></video><script src="/app.js"></script>'});
  });
  const page=await ctx.newPage();
  await page.goto('https://local-hardware.invalid/');
  await page.waitForFunction(()=>!!window.recording);
  await page.evaluate(worklet => {
    const access=new window.Entry(true);
    window.runFinished=false;
    document.querySelector('#start').onclick=async()=>{
      let audio,stream,clone,recorder,asset;
      const result={passed:false,realHardware:true,rawMediaPersisted:false,audioBlocks:0,audioSamples:0,recordedBytes:0,uploads:[]};
      try {
        // In-browser upload sink: raw camera/audio never leaves browser memory.
        window.fetch=async(url,options)=>{
          if(String(url)!=='/api/session/upload')throw new Error('Unexpected network target');
          const form=options.body,file=form.get('file'),kind=form.get('type');
          result.uploads.push({kind,bytes:file.size,mime:file.type});
          const failed=kind==='recording'&&result.uploads.filter(x=>x.kind==='recording').length===1;
          return new Response(JSON.stringify(failed?{}:{url:'https://local-hardware.invalid/saved',path:'local/saved'}),{status:failed?500:200,headers:{'Content-Type':'application/json'}});
        };
        result.devices=(await navigator.mediaDevices.enumerateDevices()).map(d=>({kind:d.kind,hasLabel:!!d.label}));
        const native=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia=async constraints=>{
          try{return await native(constraints);}
          catch(error){result.nativeError={name:error.name,message:error.message};throw error;}
        };
        stream=await access.request();
        result.trackKinds=stream.getTracks().map(t=>t.kind).sort();
        const video=document.querySelector('video');video.srcObject=stream;await video.play();
        audio=new AudioContext();await audio.resume();
        asset=URL.createObjectURL(new Blob([worklet],{type:'text/javascript'}));
        await audio.audioWorklet.addModule(asset);
        const processor=new AudioWorkletNode(audio,'oprun-microphone-capture');
        processor.port.onmessage=event=>{result.audioBlocks++;result.audioSamples+=event.data.length;};
        const sink=audio.createGain();sink.gain.value=0;
        audio.createMediaStreamSource(stream).connect(processor);processor.connect(sink);sink.connect(audio.destination);
        clone=stream.clone();recorder=new MediaRecorder(clone);
        await window.recording.start(stream,access.cameraStream());
        recorder.ondataavailable=event=>{result.recordedBytes+=event.data.size;};
        recorder.start(250);
        await new Promise(resolve=>setTimeout(resolve,3500));
        result.videoWidth=video.videoWidth;result.videoHeight=video.videoHeight;
        result.videoTime=video.currentTime;result.sampleRate=audio.sampleRate;
        await new Promise(resolve=>{recorder.onstop=resolve;recorder.stop();});
        try{await window.recording.stop();result.firstSaveRejected=false;}
        catch{result.firstSaveRejected=true;}
        const saved=await window.recording.stop();
        result.saved={confirmed:!!saved.audioUrl,duration:saved.audioDuration,screenshots:saved.screenshots.length};
        result.hardwarePassed=result.videoWidth>2&&result.videoHeight>2&&result.videoTime>1&&result.audioBlocks>0&&result.recordedBytes>0;
      } catch(error){result.error={name:error.name,message:error.message};}
      finally {
        if(recorder?.state==='recording')recorder.stop();
        clone?.getTracks().forEach(t=>t.stop());access.dispose();
        if(audio)await audio.close();if(asset)URL.revokeObjectURL(asset);
        result.allTracksStopped=[...(stream?.getTracks()||[]),...(clone?.getTracks()||[])].every(t=>t.readyState==='ended');
        document.querySelector('video').srcObject=null;
        window.unmount();
        window.result=result;window.runFinished=true;
      }
    };
  },readFileSync(resolve(root,'public/audio/microphone-capture.worklet.js'),'utf8'));
  await page.getByRole('button',{name:'Start local capture'}).click();
  await page.waitForFunction(()=>window.runFinished,undefined,{timeout:25000});
  result=await page.evaluate(()=>window.result);
  result.unexpectedRequests=unexpected;result.browser=browser.version();result.headless=headless;
  const uploads=result.uploads.filter(x=>x.kind==='recording');
  result.passed=!!(result.hardwarePassed&&result.allTracksStopped&&result.firstSaveRejected&&result.saved?.confirmed
    &&result.saved.duration>=3&&result.saved.screenshots>0&&uploads.length===2&&uploads[0].bytes>0
    &&uploads[0].bytes===uploads[1].bytes&&unexpected.length===0);
  writeFileSync(resolve(output,'result.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
  assert.equal(result.passed,true,'Real hardware acquisition failed');
  assert.equal(result.allTracksStopped,true);
  assert.equal(result.firstSaveRejected,true,'First failed audio save must not be reported successful');
  assert.equal(result.saved.confirmed,true);
  assert.ok(result.saved.duration>=3);
  assert.ok(result.saved.screenshots>0);
  assert.equal(uploads.length,2);
  assert.ok(uploads[0].bytes>0);
  assert.equal(uploads[0].bytes,uploads[1].bytes,'Retry must retain the captured recording');
  assert.deepEqual(unexpected,[]);
} finally {await browser.close();}
