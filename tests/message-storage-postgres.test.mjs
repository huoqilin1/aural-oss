import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import pg from 'pg';
const {persistVoiceMessages} = createRequire(import.meta.url)('../src/app/api/voice/save/message-storage.ts');
const {answerRevisionMessage} = createRequire(import.meta.url)('../src/lib/voice/answer-revision.ts');

const connectionString = process.env.VOICE_TEST_DATABASE_URL;

test('PostgreSQL: concurrent retries, lost acknowledgement and immutable answer identity',
  {skip: !connectionString}, async () => {
    const url = new URL(connectionString);
    assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname), 'Local test database only');
    assert.match(url.pathname, /^\/codex_recruit_test$/);
    const pool = new pg.Pool({connectionString, max: 20});
    const schema = `voice_test_${randomUUID().replaceAll('-', '')}`;
    const table = `"${schema}".messages`;
    try {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      await pool.query(`CREATE TABLE ${table} (
        id uuid PRIMARY KEY, "sessionId" uuid NOT NULL, role text NOT NULL,
        content text NOT NULL, "contentType" text NOT NULL, "questionId" uuid,
        "wordCount" integer, transcription text, timestamp timestamptz NOT NULL)`);
      const adapter = {
        async insertIfAbsent(rows) {
          const values = rows.flatMap(row => [row.id,row.sessionId,row.role,row.content,
            row.contentType,row.questionId,row.wordCount,row.transcription,row.timestamp]);
          const placeholders = rows.map((_, i) => `(${Array.from({length:9},(_,j)=>`$${i*9+j+1}`).join(',')})`).join(',');
          await pool.query(`INSERT INTO ${table} VALUES ${placeholders} ON CONFLICT (id) DO NOTHING`, values);
        },
        async read(sessionId, ids) {
          const result = await pool.query(`SELECT * FROM ${table} WHERE "sessionId"=$1 AND id=ANY($2::uuid[])`, [sessionId,ids]);
          return result.rows.map(row=>({...row,timestamp:row.timestamp.toISOString()}));
        },
      };
      const sessionId=randomUUID();
      const messages=Array.from({length:8},(_,i)=>({messageId:randomUUID(),role:'user',
        content:`第${i+1}题合成回答：本人负责核对数据。`,questionId:randomUUID(),timestamp:`2026-09-05T09:0${i}:00+08:00`}));
      await assert.rejects(persistVoiceMessages(sessionId,messages,{
        ...adapter,async read(){throw Error('Response lost after successful commit');},
      },randomUUID));
      await Promise.all(Array.from({length:20},()=>persistVoiceMessages(sessionId,messages,adapter,randomUUID)));
      assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count,8);
      const retained=await adapter.read(sessionId,messages.map(row=>row.messageId));
      for (const message of messages) {
        const row=retained.find(row=>row.id===message.messageId);
        assert.equal(row.content,message.content);
        assert.equal(row.questionId,message.questionId);
        assert.equal(Date.parse(row.timestamp),Date.parse(message.timestamp));
      }
      await assert.rejects(persistVoiceMessages(sessionId,[{...messages[0],content:'不可覆盖的伪造回答'}],adapter,randomUUID));
      await assert.rejects(persistVoiceMessages(randomUUID(),[messages[0]],adapter,randomUUID));
      assert.equal((await adapter.read(sessionId,[messages[0].messageId]))[0].content,messages[0].content);
      // Relay direct persistence and browser retry share the same identity.
      const event={questionIndex:0,questionId:messages[0].questionId,
        messageId:randomUUID(),timestamp:'2026-09-05T01:08:00Z',text:'更正：效率是5%，不是15%。'};
      const revision=answerRevisionMessage(event,index=>messages[index]?.questionId);
      assert.ok(revision);
      await Promise.all([
        persistVoiceMessages(sessionId,[revision],adapter,randomUUID),
        persistVoiceMessages(sessionId,[answerRevisionMessage(event,index=>messages[index]?.questionId)],adapter,randomUUID),
      ]);
      assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count,9);
      assert.equal((await adapter.read(sessionId,[event.messageId]))[0].content,revision.content);
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
  });
