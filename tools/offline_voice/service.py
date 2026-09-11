"""Loopback-only offline speech sidecar. No outbound inference or provider fallback.

ASR uses the existing relay binary transport, retaining browser/save contracts.
Models must be downloaded ahead of time; startup fails if any are missing.
"""
import asyncio
import gzip
import io
import json
import os
from pathlib import Path
import struct
from collections import OrderedDict
from hashlib import sha256
from concurrent.futures import ThreadPoolExecutor

from aiohttp import web, WSMsgType
import numpy as np
import sherpa_onnx as so
import soundfile as sf

ROOT = Path(os.environ['OFFLINE_VOICE_MODEL_DIR']).resolve()
ASR = ROOT / 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17'
TTS = ROOT / 'vits-melo-tts-zh_en'
TTS_ENGINE=os.environ.get('OFFLINE_VOICE_TTS_ENGINE','melo')
if TTS_ENGINE not in ('windows','melo') or (TTS_ENGINE=='windows' and os.name!='nt'):
    raise RuntimeError('Unsupported offline TTS engine')
recognizer = so.OfflineRecognizer.from_sense_voice(model=str(ASR/'model.int8.onnx'),
    tokens=str(ASR/'tokens.txt'), num_threads=2, use_itn=True, language='auto')
tts = None if TTS_ENGINE=='windows' else so.OfflineTts(so.OfflineTtsConfig(model=so.OfflineTtsModelConfig(
    vits=so.OfflineTtsVitsModelConfig(model=str(TTS/'model.onnx'),
        lexicon=str(TTS/'lexicon.txt'), tokens=str(TTS/'tokens.txt'), dict_dir=str(TTS/'dict')),
    num_threads=2, provider='cpu')))
asr_pool = ThreadPoolExecutor(max_workers=2)
# Windows SAPI objects are thread-local. Keep neural engines serialized, but
# synthesize independent Windows utterances concurrently for live interviews.
tts_pool = ThreadPoolExecutor(max_workers=4 if TTS_ENGINE == 'windows' else 1)
slots = asyncio.Semaphore(10)
audio_cache = OrderedDict()
cache_bytes = 0
inflight = {}

async def cached_synthesis(text, audio_format='wav'):
    global cache_bytes
    key=sha256((audio_format+'\0'+text).encode()).digest()
    if key in audio_cache:
        audio_cache.move_to_end(key)
        return audio_cache[key]
    if key in inflight:
        return await asyncio.shield(inflight[key])
    async def work():
        global cache_bytes
        async with slots:
            audio=await asyncio.get_running_loop().run_in_executor(tts_pool,synthesize,text,audio_format)
        if len(audio)<=32*1024*1024:
            while audio_cache and cache_bytes+len(audio)>32*1024*1024:
                _,old=audio_cache.popitem(last=False)
                cache_bytes-=len(old)
            audio_cache[key]=audio
            cache_bytes+=len(audio)
        return audio
    task=asyncio.create_task(work())
    inflight[key]=task
    task.add_done_callback(lambda _: inflight.pop(key,None))
    return await asyncio.shield(task)

def recognize(samples):
    stream = recognizer.create_stream()
    stream.accept_waveform(16000, samples)
    recognizer.decode_stream(stream)
    return stream.result.text

def synthesize(text, audio_format='wav'):
    if TTS_ENGINE=='windows':
        from windows_tts import synthesize_windows
        raw=synthesize_windows(text)
        if audio_format=='wav':
            return raw
        samples,rate=sf.read(io.BytesIO(raw),dtype='float32')
    else:
        audio=tts.generate(text, sid=0, speed=1.0)
        samples,rate=audio.samples,audio.sample_rate
    output=io.BytesIO()
    if audio_format=='mp3':
        sf.write(output,samples,rate,format='MP3',subtype='MPEG_LAYER_III',
                 bitrate_mode='VARIABLE',compression_level=0.4)
    else:
        sf.write(output,samples,rate,format='WAV',subtype='PCM_16')
    return output.getvalue()

async def speech(request):
    data=await request.json()
    text=data.get('text')
    audio_format=data.get('format','wav')
    if not isinstance(text,str) or not text.strip() or len(text)>2000:
        raise web.HTTPBadRequest()
    if audio_format not in ('wav','mp3'):
        raise web.HTTPBadRequest()
    audio=await cached_synthesis(text,audio_format)
    return web.Response(body=audio,content_type='audio/mpeg' if audio_format=='mp3' else 'audio/wav')

def response_packet(text):
    payload=json.dumps({'result':{'utterances':[{'text':text,'definite':True}]}},ensure_ascii=False).encode()
    return bytes([0x11,0x90,0x10,0])+struct.pack('>I',len(payload))+payload

async def recognition(request):
    ws=web.WebSocketResponse(max_msg_size=1024*1024,heartbeat=20)
    await ws.prepare(request)
    cfg=so.VadModelConfig()
    cfg.silero_vad.model=str(ROOT/'silero_vad.onnx')
    cfg.silero_vad.min_silence_duration=0.7
    cfg.silero_vad.max_speech_duration=15
    cfg.sample_rate=16000
    cfg.num_threads=1
    vad=so.VoiceActivityDetector(cfg,buffer_size_in_seconds=30)
    pending=np.empty(0,dtype=np.float32)
    initialized=False
    try:
        async for message in ws:
            if message.type != WSMsgType.BINARY:
                continue
            packet=message.data
            if len(packet)<12 or packet[0]!=0x11:
                raise ValueError('invalid_audio_packet')
            kind=packet[1]>>4
            offset=4+(4 if packet[1]&1 else 0)
            size=struct.unpack('>I',packet[offset:offset+4])[0]
            payload=packet[offset+4:]
            if size!=len(payload) or len(payload)>1024*1024:
                raise ValueError('invalid_audio_size')
            if packet[2]&15==1:
                with gzip.GzipFile(fileobj=io.BytesIO(payload)) as zipped:
                    payload=zipped.read(1024*1024+1)
                if len(payload)>1024*1024:
                    raise ValueError('audio_packet_too_large')
            if kind==1:
                config=json.loads(payload)
                audio=config['audio']
                if any(audio.get(k)!=v for k,v in [('rate',16000),('bits',16),('channels',1)]):
                    raise ValueError('unsupported_audio_format')
                # Ordered processing ensures prior inference has settled before
                # acknowledging reset. Reuse the VAD and transport across turns.
                vad.reset()
                pending=np.empty(0,dtype=np.float32)
                initialized=True
                ack=json.dumps({'reqid':config.get('user',{}).get('uid'),
                    'code':0,'message':'offline_reset_ready'}).encode()
                await ws.send_bytes(bytes([0x11,0x90,0x10,0])+struct.pack('>I',len(ack))+ack)
                continue
            if kind!=2 or not initialized or len(payload)%2:
                raise ValueError('invalid_audio_sequence')
            pending=np.concatenate((pending,np.frombuffer(payload,dtype='<i2').astype(np.float32)/32768))
            while len(pending)>=512:
                vad.accept_waveform(pending[:512])
                pending=pending[512:]
            if packet[1]&2:
                if len(pending):
                    vad.accept_waveform(np.pad(pending,(0,512-len(pending))))
                    pending=np.empty(0,dtype=np.float32)
                vad.flush()
            while not vad.empty():
                samples=np.array(vad.front.samples,dtype=np.float32,copy=True)
                vad.pop()
                async with slots:
                    text=await asyncio.get_running_loop().run_in_executor(asr_pool,recognize,samples)
                if text.strip():
                    await ws.send_bytes(response_packet(text))
            # Confirm only after VAD and every resulting decode have finished.
            # A first segment is not proof that the rest of the spoken turn was
            # processed, especially when ten connections share inference.
            sequence=abs(struct.unpack('>i',packet[4:8])[0]) if packet[1]&1 else 0
            ack=json.dumps({'code':0,'message':'offline_audio_processed',
                'audio_sequence':sequence}).encode()
            await ws.send_bytes(bytes([0x11,0x90,0x10,0])+struct.pack('>I',len(ack))+ack)
    except Exception:
        # Never log audio, transcripts, or model payloads.
        await ws.close(code=1011,message=b'offline_asr_failed')
    return ws

async def health(request):
    return web.json_response({'status':'ok','provider':'offline','engine':so.__version__,'tts_engine':TTS_ENGINE})

app=web.Application(client_max_size=16384)
app.router.add_get('/health',health)
app.router.add_post('/tts',speech)
app.router.add_get('/asr',recognition)
if __name__=='__main__':
    web.run_app(app,host='127.0.0.1',port=int(os.environ.get('OFFLINE_VOICE_PORT','5211')),access_log=None)
