import assert from 'node:assert/strict';
import {test} from 'node:test';
import {answeredAsrRevision} from '../server/voice-relay-helpers';
import {answerRevisionMessage} from '../src/lib/voice/answer-revision';

test('longer evidence is retained even when the original answer was already accepted', () => {
  const original = '我负责招聘项目的数据记录，整体效率提高15%。';
  const revised = original + '补充纠正：实际是5%，不是15%。';
  const text = answeredAsrRevision(original, revised);
  assert.equal(text, revised);
  const saved = answerRevisionMessage({text, questionId:'q4', questionIndex:3}, i => `q${i+1}`);
  assert.equal(saved?.questionId, 'q4');
  assert.ok(saved?.content.includes('实际是5%'));
});

test('shorter rolling correction is retained, not selected by length', () => {
  const text = answeredAsrRevision('我负责招聘项目的数据记录，整体效率提高15%。', '我负责招聘项目的数据记录，整体效率提高5%。');
  assert.ok(text?.includes('提高5%'));
});

test('exact replay and old prefix are not new revisions', () => {
  assert.equal(answeredAsrRevision('我负责招聘项目的数据记录。', '我负责招聘项目的数据记录。'), null);
  assert.equal(answeredAsrRevision('我负责招聘项目的数据记录。', '我负责招聘项目'), null);
});

test('late revision keeps original question and rejects invalid mapping', () => {
  const event = {text:'这是补充', questionId:'q2', questionIndex:1};
  assert.equal(answerRevisionMessage(event, i => `q${i+1}`)?.questionId, 'q2');
  assert.equal(answerRevisionMessage({...event, questionId:'another-session'}, i => `q${i+1}`), null);
  assert.equal(answerRevisionMessage({...event, questionIndex:-1}, () => 'q2'), null);
});
test('relay and browser retain identical revision identity and timestamp', () => {
  const event={questionIndex:0,questionId:'q1',text:'更正为5%',
    messageId:'00000000-0000-4000-8000-000000000001',timestamp:'2026-09-05T01:00:00Z'};
  const message=answerRevisionMessage(event,()=> 'q1');
  assert.equal(message?.messageId,event.messageId);
  assert.equal(message?.timestamp,event.timestamp);
});
