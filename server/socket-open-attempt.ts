import type WebSocket from 'ws';

/** A pending provider connection must settle when its owning interview cancels. */
export function socketOpenAttempt(socket:WebSocket,timeoutMs=10_000) {
  let cancel=()=>{};
  const promise=new Promise<void>((resolve,reject)=>{
    let settled=false;
    const finish=(error?:Error)=>{
      if(settled)return;
      settled=true;clearTimeout(timer);
      socket.off('open',opened);socket.off('error',failed);socket.off('close',closed);socket.off('unexpected-response',unexpected);
      if(error) {
        // ws can emit an asynchronous error when a CONNECTING socket closes.
        socket.once('error',()=>{});
        try {socket.close();}catch{/* already closed */}
        reject(error);
      } else resolve();
    };
    const opened=()=>finish();
    const failed=(error:Error)=>finish(error);
    const closed=()=>finish(Error('ASR closed before ready'));
    const unexpected=(_request:unknown,response:{statusCode?:number;resume:()=>unknown})=>{
      response.resume();
      finish(Error(`ASR server responded ${response.statusCode ?? 'unknown'}`));
    };
    const timer=setTimeout(()=>finish(Error('ASR connect timeout')),timeoutMs);
    socket.once('open',opened);socket.once('error',failed);socket.once('close',closed);socket.once('unexpected-response',unexpected);
    cancel=()=>finish(Error('ASR connection cancelled'));
    if(socket.readyState===1)opened();
    else if(socket.readyState>=2)closed();
  });
  void promise.catch(()=>{});
  return {promise,cancel:()=>cancel()};
}
