// Real useVoice hook, real browser audio, local WebSocket peer; no production requests.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "playwright";
import { resolve } from "node:path";
import {writeFileSync,readFileSync} from "node:fs";
import {createServer} from "node:http";
import {makeSignal,verifyAudioContent} from "./helpers/audio-content.mjs";
const failures=[];
function check(value,message){if(!value){failures.push(message);if(!process.env.AURAL_AUDIO_DIAGNOSTIC_CONTINUE)assert.fail(message);}}
const root = resolve(import.meta.dirname, "..");
const bundle = await build({ absWorkingDir: root, bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" },
  stdin: { resolveDir: root, loader: "tsx", contents: `
    import {createRoot} from 'react-dom/client'; import {useVoice} from './src/hooks/use-voice'; import {useInterviewRecording} from './src/hooks/use-interview-recording';import {setStoredCameraStream} from './src/lib/media-stream-store';
    const interviewContext={title:'Local audio regression',aiName:'AI',aiTone:'professional',language:'zh',followUpDepth:'low',questions:[{id:'q1',text:'Local Q1',type:'open',order:1}]};
    function App(){const recording=useInterviewRecording({sessionId:'local',enabled:true,screenshotIntervalMs:999999});const voice=useVoice({interviewId:'local',sessionId:'local',interviewContext,onTtsChunk:recording.addTtsChunk,onInterrupt:recording.cancelTts});window.voice=voice;window.recording=recording;
    return <><video autoPlay muted playsInline ref={el=>{if(el&&recording.cameraStream&&el.srcObject!==recording.cameraStream){el.srcObject=recording.cameraStream;el.play().catch(()=>{});}}}/><button onClick={async()=>{window.camera=await navigator.mediaDevices.getUserMedia({video:true});setStoredCameraStream(window.camera);await voice.connect();await voice.startListening();await recording.start(voice.mediaStreamRef.current);}}>Start</button></>}
    createRoot(document.getElementById('root')).render(<App/>);` } });
// Worklet module fetches do not pass through Playwright's page routing.
// Serve the exact public module over loopback, like the deployed same-origin URL.
const server=createServer((req,res)=>{
  if(req.url==='/audio/microphone-capture.worklet.js'){
    res.setHeader('Content-Type','text/javascript');res.end(readFileSync(resolve(root,'public/audio/microphone-capture.worklet.js')));
  }else if(req.url==='/app.js'){
    res.setHeader('Content-Type','text/javascript');res.end(bundle.outputFiles[0].text);
  }else{res.setHeader('Content-Type','text/html');res.end('<div id="root"></div><script src="/app.js"></script>');}
});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
server.unref();
const base=`http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: process.platform !== "win32", args: [...(process.env.AURAL_AUDIO_BROWSER_DIAGNOSTICS ? ["--enable-logging=stderr", "--vmodule=video_capture*=2,fake_video_capture_device*=2"] : []),"--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
try {
  const context = await browser.newContext({ permissions: ["camera", "microphone"] });
  await context.addInitScript(() => {
    const Native = AudioContext; window.contexts = [];
    window.AudioContext = class extends Native { constructor(options) { super(options); window.contexts.push(this); } };
    let sourceContext, destination;
    navigator.mediaDevices.getUserMedia = async constraints => {
      if (!constraints.audio) {
        // Isolate audio reliability from the unstable Windows fake-camera device.
        // The camera lifecycle assertion still checks a real, recording video track.
        const canvas=document.createElement('canvas');canvas.width=640;canvas.height=480;
        const paint=canvas.getContext('2d');let frame=0;
        const draw=()=>{paint.fillStyle='#17304e';paint.fillRect(0,0,640,480);paint.fillStyle='#f8cf70';paint.fillRect((frame++*7)%560,170,80,80);};
        draw();const stream=canvas.captureStream(5),track=stream.getVideoTracks()[0];
        const timer=setInterval(()=>{if(track.readyState==='ended')clearInterval(timer);else draw();},200);
        const stop=track.stop.bind(track);track.stop=()=>{window.cameraStopStack=new Error().stack;stop();};
        return stream;
      }
      if (!sourceContext) { sourceContext = new Native(); destination = sourceContext.createMediaStreamDestination(); }
      await sourceContext.resume();
      return new MediaStream(destination.stream.getAudioTracks().map(track => track.clone()));
    };
    window.sourceClock=()=>({time:sourceContext.currentTime,rate:sourceContext.sampleRate});
    window.speak = async samples => {
      const buffer=sourceContext.createBuffer(1,samples.length,16000);buffer.copyToChannel(new Float32Array(samples),0);
      await new Promise(resolve=>{const source=sourceContext.createBufferSource();source.buffer=buffer;source.connect(destination);source.onended=resolve;source.start();
        if(window.stallNext){window.stallNext=false;setTimeout(()=>{const end=performance.now()+5000;while(performance.now()<end){}},50);}
      });
    };
  });
  await context.addInitScript(`window.makeSignal = ${makeSignal.toString()};`);
  const page = await context.newPage();
  let socket, chunks=[];
  await page.routeWebSocket("**/ws/**", ws => {socket=ws;ws.onMessage(raw=>{const message=JSON.parse(String(raw));
    if(message.type==='init') ws.send(JSON.stringify({type:'ready',sessionId:'local'}));
    if(message.type==='audio') chunks.push(Buffer.from(message.data,'hex'));
  });});
  await page.goto(base);await page.getByRole("button").click();
  await page.waitForFunction(()=>window.voice?.isListening);
  const opening=Buffer.alloc(24000*22*2);for(let i=0;i<opening.length/2;i++)opening.writeInt16LE(Math.round(30*Math.sin(2*Math.PI*300*i/24000)),i*2);
  socket.send(opening);socket.send(JSON.stringify({type:'tts_ended'}));await page.waitForTimeout(23500);
  for(let q=1;q<=8;q++){
    if(q===5){await page.evaluate(()=>window.voice.stopListening());
      assert.equal(await page.evaluate(()=>window.contexts[0].state),'running','stopping capture must retain playback clock');
      await page.evaluate(async()=>{await window.voice.startListening();window.recording.attachMicStream(window.voice.mediaStreamRef.current);});}
    socket.send(JSON.stringify({type:'input_ready'}));await page.waitForTimeout(300);
    const samples=makeSignal(q);
    if(q===2)await page.evaluate(()=>{window.stallNext=true;});
    chunks=[];await page.evaluate(q=>window.speak(window.makeSignal(q)),q);await page.waitForTimeout(400);
    const bytes=Buffer.concat(chunks);const actual=Array.from({length:bytes.length/2},(_,i)=>bytes.readInt16LE(i*2)/32768);
    if(process.env.AURAL_AUDIO_EVIDENCE_DIR){writeFileSync(resolve(process.env.AURAL_AUDIO_EVIDENCE_DIR,`q${q}.pcm`),bytes);writeFileSync(resolve(process.env.AURAL_AUDIO_EVIDENCE_DIR,`q${q}.expected.f32`),Buffer.from(new Float32Array(samples).buffer));console.log(JSON.stringify({q,expected:samples.length/16000,actual:actual.length/16000,contexts:await page.evaluate(()=>window.contexts.map(c=>({time:c.currentTime,rate:c.sampleRate,state:c.state})))}));}
    const durationPassed=actual.length>=samples.length-8192;check(durationPassed,`Q${q}: capture duration truncated`);
    const content=verifyAudioContent(samples,actual);
    check(content.passed,`Q${q}: missing, repeated or shifted audio ${JSON.stringify(content)}`);
    assert.equal(await page.evaluate(()=>window.contexts.filter(c=>c.state!=='closed').length),3,'exactly playback, capture and recording contexts remain active');
    const cameraLive=await page.evaluate(()=>window.recording.cameraStream?.getVideoTracks()[0].readyState==='live');check(cameraLive,`Q${q}: camera ended`);
    console.log(JSON.stringify({question:q,expectedSeconds:samples.length/16000,sentSeconds:actual.length/16000,content,cameraLive,simulatedCamera:true,passed:durationPassed&&content.passed&&cameraLive,productionRequests:0}));
  }
  assert.deepEqual(failures,[]);
} finally { await browser.close(); await new Promise(resolve=>server.close(resolve)); }
