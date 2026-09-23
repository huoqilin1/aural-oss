import WebSocket from 'ws';
import {randomUUID} from 'node:crypto';
import {buildBigModelFullRequest,parseAsrResponse} from './volcengine-asr';

/** Reset a local recognizer in order, without a new TCP/SSH handshake per turn. */
export function resetOfflineAsr(socket:WebSocket, timeoutMs=10_000):Promise<void> {
  if(socket.readyState!==WebSocket.OPEN) return Promise.reject(new Error('Offline ASR is not connected'));
  return new Promise((resolve,reject)=>{
    const id=randomUUID();
    const finish=(error?:Error)=>{
      clearTimeout(timer);socket.off('message',message);socket.off('error',failed);socket.off('close',closed);
      if(error)reject(error);else resolve();
    };
    const message=(data:WebSocket.RawData)=>{
      const response=parseAsrResponse(Buffer.from(data as Buffer));
      if(response.reqid===id && response.code===0 && response.message==='offline_reset_ready')finish();
    };
    const failed=(error:Error)=>finish(error);
    const closed=()=>finish(new Error('Offline ASR closed during reset'));
    const timer=setTimeout(()=>finish(new Error('Offline ASR reset timeout')),timeoutMs);
    socket.on('message',message);socket.once('error',failed);socket.once('close',closed);
    try{socket.send(buildBigModelFullRequest({rate:16000,bits:16,channels:1},id));}catch(error){finish(error instanceof Error?error:new Error('Offline ASR reset failed'));}
  });
}
