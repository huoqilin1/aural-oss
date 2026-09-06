import {createHmac,randomUUID} from 'node:crypto';
import {mkdir,readFile,readdir,unlink,writeFile,link} from 'node:fs/promises';
import path from 'node:path';

export type UsageEvent={id:string;call_id:string;provider:string;model:string;scene:string;started_at:string;ended_at:string;
  status:'success'|'failed'|'empty'|'timeout';usage:null|{prompt_tokens?:number;completion_tokens?:number;prompt_cache_hit_tokens?:number}};

export class UsageOutbox<Event extends {id:string} = UsageEvent> {
  private running:Promise<void>|null=null;
  private generation=0;
  constructor(private directory:string,private send:(event:Event)=>Promise<void>){}
  async ready(){await mkdir(this.directory,{recursive:true,mode:0o700});}
  async enqueue(event:Event){
    if(!/^[0-9a-f-]{36}$/.test(event.id))throw new Error('Invalid usage event id');
    await this.ready();const file=path.join(this.directory,event.id+'.json');
    const body=JSON.stringify(event);
    const temporary=path.join(this.directory,randomUUID()+'.tmp');
    await writeFile(temporary,body,{flag:'wx',mode:0o600});
    try {
      try {await link(temporary,file);}
      catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST' || await readFile(file,'utf8')!==body)throw error;}
    } finally {await unlink(temporary);}
    this.generation++;
  }
  flush(){
    if(this.running)return this.running;
    this.running=(async()=>{
      let observed:number;
      do { observed=this.generation; await this.drain(); } while(observed!==this.generation);
    })().finally(()=>{this.running=null;});return this.running;
  }
  private async drain(){
    await this.ready();
    const files=(await readdir(this.directory)).filter(f=>/^[0-9a-f-]{36}\.json$/.test(f)).sort().slice(0,100);
    for(const file of files){
      const event=JSON.parse(await readFile(path.join(this.directory,file),'utf8')) as Event;
      await this.send(event);
      await unlink(path.join(this.directory,file));
    }
  }
}

let instance:UsageOutbox|null=null;
let instanceKey='';
let timer:ReturnType<typeof setInterval>|null=null;
function current(){
  const directory=process.env.HR_MODEL_USAGE_OUTBOX?.trim();
  const policyUrl=process.env.HR_MODEL_CONTROL_URL?.trim();
  const secret=process.env.HR_MODEL_CONTROL_SECRET?.trim();
  if(!directory || !path.isAbsolute(directory) || !policyUrl || !secret)throw new Error('HR model usage outbox configuration incomplete');
  const url=new URL(policyUrl);
  if(url.username || url.password || url.search || url.hash ||
    (url.protocol!=='https:' && !(url.protocol==='http:' && ['localhost','127.0.0.1'].includes(url.hostname))))throw new Error('Invalid HR model control URL');
  url.pathname=url.pathname.replace(/model-policy$/,'model-usage');
  if(url.pathname===new URL(policyUrl).pathname)throw new Error('Invalid HR model control path');
  const key=directory+'|'+url.href+'|'+secret;
  if(!instance || key!==instanceKey){
    instanceKey=key;
    instance=new UsageOutbox(directory,async event=>{
      const body=JSON.stringify(event);const timestamp=String(Math.floor(Date.now()/1000));
      const signature=createHmac('sha256',secret).update(`${timestamp}\nPOST\n${url.pathname}\n${body}`).digest('hex');
      const response=await fetch(url,{method:'POST',body,headers:{'Content-Type':'application/json','X-HR-Model-Timestamp':timestamp,'X-HR-Model-Signature':signature},redirect:'error',signal:AbortSignal.timeout(5000)});
      if(!response.ok)throw new Error(`Usage acknowledgement failed (${response.status})`);
      const result=await response.json();
      if(!result.success || result.id!==event.id)throw new Error('Usage acknowledgement identity mismatch');
    });
    if(timer)clearInterval(timer);
    timer=setInterval(()=>{void instance?.flush().catch(()=>{});},15000);timer.unref();
  }
  return instance;
}
export async function ensureHrUsageReady(){await current().ready();}
export async function flushHrUsage(){await current().flush();}
export async function queueHrUsage(event:Omit<UsageEvent,'id'|'ended_at'>){
  const outbox=current();await outbox.enqueue({...event,id:randomUUID(),ended_at:new Date().toISOString()});
  void outbox.flush().catch(()=>{}); // Retained on disk; timer / next request retries.
}
