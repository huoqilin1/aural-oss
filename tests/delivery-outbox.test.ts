import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readDeliveryOutbox,writeDeliveryOutbox} from '../src/lib/voice/delivery-outbox';
import {prepareDelivery} from '../src/lib/voice/message-delivery';

function storage() {
  const data=new Map<string,string>();
  return {data,getItem:(key:string)=>data.get(key)??null,
    setItem:(key:string,value:string)=>{data.set(key,value);},removeItem:(key:string)=>{data.delete(key);}};
}
test('outbox recovers an unacknowledged batch after reload with its original ids',()=>{
  const store=storage();
  const batch=prepareDelivery([{role:'user',content:'合成回答',questionId:'q1'}],()=> '00000000-0000-4000-8000-000000000001');
  writeDeliveryOutbox(store,'session-a',batch);
  assert.deepEqual(readDeliveryOutbox(store,'session-a'),batch);
  assert.deepEqual(readDeliveryOutbox(store,'session-b'),[]);
  writeDeliveryOutbox(store,'session-a',[]);
  assert.equal(store.data.size,0);
});
test('outbox does not silently treat corrupt stored records as delivered',()=>{
  const store=storage();
  writeDeliveryOutbox(store,'session-a',[{role:'user',content:'合成回答'}]);
  const key=Array.from(store.data.keys())[0];
  store.data.set(key,'broken-json');
  assert.throws(()=>readDeliveryOutbox(store,'session-a'));
  assert.equal(store.data.get(key),'broken-json');
});
