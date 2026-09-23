import assert from 'node:assert/strict';
import {test} from 'node:test';
import {prepareDelivery, removeAcknowledged} from '../src/lib/voice/message-delivery';
import {requeueFailedProgressMessages} from '../src/lib/voice/progress-save';
import {persistVoiceMessages, type StoredVoiceMessage} from '../src/app/api/voice/save/message-storage';

const first = () => ({role:'user',content:'本人只负责数据记录。',questionId:'q1'});
const uuid = '00000000-0000-4000-8000-000000000001';
const time = '2026-09-05T01:00:00Z';

function storage() {
  const rows=new Map<string,StoredVoiceMessage>();
  return {rows, adapter:{
    async insertIfAbsent(values:StoredVoiceMessage[]) {
      for(const row of values) if(!rows.has(row.id)) rows.set(row.id,{...row});
    },
    async read(sessionId:string, ids:string[]) {
      return Array.from(rows.values()).filter(row => row.sessionId===sessionId && ids.includes(row.id));
    },
  }};
}

test('retry preserves the first message identity and capture time', () => {
  const pending=[first()];
  const sent=prepareDelivery(pending,()=>uuid,()=>time);
  const retry=prepareDelivery(pending,()=>{throw Error('must not replace identity')},()=>{throw Error('must not replace time')});
  assert.deepEqual(retry,sent);
  pending[0].content='之后的修改';
  assert.equal(sent[0].content,'本人只负责数据记录。');
});

test('commit followed by response loss can be retried without a duplicate row', async () => {
  const {rows,adapter}=storage();
  const batch=prepareDelivery([first()],()=>uuid,()=>time);
  await assert.rejects(persistVoiceMessages('s1',batch,{
    ...adapter, async read(){throw Error('lost response after commit')},
  },()=>uuid));
  assert.equal(rows.size,1);
  await persistVoiceMessages('s1',batch,adapter,()=>uuid);
  assert.equal(rows.size,1);
});

test('parallel identical retries retain one answer', async () => {
  const {rows,adapter}=storage();
  const batch=prepareDelivery([first()],()=>uuid,()=>time);
  await Promise.all([persistVoiceMessages('s1',batch,adapter,()=>uuid),persistVoiceMessages('s1',batch,adapter,()=>uuid)]);
  assert.equal(rows.size,1);
});

test('same identity cannot overwrite content or move to another session', async () => {
  const {rows,adapter}=storage();
  const batch=prepareDelivery([first()],()=>uuid,()=>time);
  await persistVoiceMessages('s1',batch,adapter,()=>uuid);
  await assert.rejects(persistVoiceMessages('s1',[{...batch[0],content:'伪造的新内容'}],adapter,()=>uuid));
  await assert.rejects(persistVoiceMessages('s2',batch,adapter,()=>uuid));
  assert.equal(rows.get(uuid)?.content,first().content);
  assert.equal(rows.get(uuid)?.sessionId,'s1');
});

test('acknowledgement removes only sent messages and preserves a late answer', () => {
  const sent=prepareDelivery([first()],()=>uuid,()=>time);
  const late=prepareDelivery([{...first(),content:'晚到补充'}],()=>uuid.replace(/1$/,'2'),()=>time);
  assert.deepEqual(removeAcknowledged([...sent,...late],sent),late);
  assert.deepEqual(requeueFailedProgressMessages(sent,[...sent,...late]),[...sent,...late]);
});
