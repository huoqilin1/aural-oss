import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,readdir,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {UsageOutbox,type UsageEvent} from '../server/hr-model-usage-outbox';

test('lost acknowledgement survives a new outbox instance with the same identity',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'usage-outbox-test-'));
  const event:UsageEvent={id:randomUUID(),call_id:randomUUID(),provider:'zhipu',model:'glm-5.3',scene:'aural.turn',started_at:new Date().toISOString(),ended_at:new Date().toISOString(),status:'success',usage:{prompt_tokens:0,completion_tokens:3}};
  const delivered:string[]=[];
  try {
    const first=new UsageOutbox(directory,async row=>{delivered.push(row.id);throw new Error('lost acknowledgement');});
    await first.enqueue(event);await assert.rejects(first.flush());
    assert.equal((await readdir(directory)).length,1);
    const restored=new UsageOutbox(directory,async row=>{delivered.push(row.id);});
    await restored.flush();assert.deepEqual(delivered,[event.id,event.id]);
    assert.equal((await readdir(directory)).length,0);
    await restored.enqueue(event);
    await assert.rejects(restored.enqueue({...event,model:'kimi-k3'}));
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('usage-outbox-test-'));
    await rm(directory,{recursive:true,force:true});
  }
});

test('a failed record does not block later records in the same pass',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'usage-outbox-test-'));
  const sent:string[]=[];
  const first='00000000-0000-4000-8000-000000000001';
  const second='00000000-0000-4000-8000-000000000002';
  const outbox=new UsageOutbox<{id:string}>(directory,async row=>{
    if(row.id===first)throw new Error('synthetic unavailable');
    sent.push(row.id);
  });
  try{
    await outbox.enqueue({id:first});await outbox.enqueue({id:second});
    await assert.rejects(outbox.flush());
    assert.deepEqual(sent,[second]);
    assert.deepEqual(await readdir(directory),[first+'.json']);
  }finally{assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));await rm(directory,{recursive:true,force:true});}
});

test('a full page of retained failures cannot starve record 101',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'usage-outbox-test-'));
  const sent:number[]=[];
  const attempted:number[]=[];
  const outbox=new UsageOutbox<{id:string;index:number}>(directory,async row=>{
    attempted.push(row.index);
    if(row.index<=100)throw new Error('synthetic unavailable');
    sent.push(row.index);
  });
  try{
    for(let index=1;index<=102;index++)await outbox.enqueue({id:`00000000-0000-4000-8000-${String(index).padStart(12,'0')}`,index});
    await assert.rejects(outbox.flush());
    assert.equal(attempted.length,100);
    await assert.rejects(outbox.flush());
    assert.deepEqual(sent,[101,102]);
    assert.equal((await readdir(directory)).length,100);
  }finally{assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));await rm(directory,{recursive:true,force:true});}
});
