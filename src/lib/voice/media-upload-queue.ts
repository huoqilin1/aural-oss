import {SingleFlightSave} from './progress-save';
import {candidateFetch} from './candidate-fetch';

/** Page-memory queue: successful media is released; failed media stays retryable. */
export class MediaUploadQueue {
  private jobs = new Set<{save:()=>Promise<void>; pending:Promise<void>; failed:boolean}>();
  private flight = new SingleFlightSave<void>();
  add(save:()=>Promise<void>): void {
    const job={save,pending:Promise.resolve(),failed:false};
    this.jobs.add(job);
    this.start(job);
  }
  private start(job:{save:()=>Promise<void>; pending:Promise<void>; failed:boolean}) {
    job.failed=false;
    job.pending=Promise.resolve().then(job.save).then(()=>{this.jobs.delete(job);},error=>{job.failed=true;throw error;});
    void job.pending.catch(()=>{});
  }
  flush(): Promise<void> {
    return this.flight.run(async()=>{
      const visited=new Set<unknown>();
      while (true) {
        const batch=Array.from(this.jobs).filter(job=>!visited.has(job));
        if (!batch.length) break;
        for (const job of batch) {visited.add(job);if(job.failed)this.start(job);}
        await Promise.allSettled(batch.map(job=>job.pending));
      }
      if(this.jobs.size)throw Error('录音或截图尚未上传完成，请保留页面并重试');
    });
  }
}

export async function uploadInterviewMedia(
  input:{sessionId:string;blob:Blob;type:'recording'|'screenshot';filename:string},
  request:typeof fetch=candidateFetch,
):Promise<{url:string;path:string}> {
  if (!input.blob.size) throw Error('录音或截图内容为空，尚未保存');
  const form=new FormData();
  form.append('file',input.blob,input.filename);
  form.append('sessionId',input.sessionId);
  form.append('type',input.type);
  form.append('filename',input.filename);
  const response=await request('/api/session/upload',{method:'POST',body:form});
  if(!response.ok)throw Error(`录音或截图上传失败（${response.status}）`);
  const data=await response.json();
  if(typeof data?.url!=='string' || !data.url.trim() || typeof data?.path!=='string' || !data.path.startsWith(`${input.sessionId}/`) || data.bucket!==(input.type==='recording'?'recordings':'screenshots')) {
    throw Error('录音或截图没有收到本场存储确认');
  }
  return {url:data.url,path:data.path};
}
