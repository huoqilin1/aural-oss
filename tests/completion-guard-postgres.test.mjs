import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';

const connectionString = process.env.VOICE_TEST_DATABASE_URL;
test('PostgreSQL: completion and transcript writes share an atomic boundary',
  {skip: !connectionString}, async t => {
    const url = new URL(connectionString);
    assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
    assert.equal(url.pathname, '/codex_recruit_test');
    const pool = new pg.Pool({connectionString, max: 4});
    const schema = `completion_test_${randomUUID().replaceAll('-', '')}`;
    const table = name => `"${schema}".${name}`;
    try {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      await pool.query(`CREATE TABLE ${table('interviews')} (id uuid PRIMARY KEY, title text);
        CREATE TABLE ${table('sessions')} (id uuid PRIMARY KEY, "interviewId" uuid, status text DEFAULT 'IN_PROGRESS');
        CREATE TABLE ${table('questions')} (id uuid PRIMARY KEY, "interviewId" uuid, description text);
        CREATE TABLE ${table('messages')} (id uuid PRIMARY KEY, "sessionId" uuid REFERENCES ${table('sessions')}(id) ON DELETE CASCADE, "questionId" uuid, role text, content text);`);
      // Execute the actual migration in a unique local schema, never public.
      const migration = (await readFile(new URL('../supabase/migrations/007_recruit_voice_completion_guard.sql', import.meta.url), 'utf8'))
        .replaceAll('public.', `"${schema}".`).replaceAll('search_path = public', `search_path = "${schema}"`);
      await pool.query(migration);
      await pool.query(migration); // Safe rerun of the migration itself.
      const seed = async (count = 8, title = '数君招聘 · 人力资源') => {
        const interview = randomUUID(), session = randomUUID();
        await pool.query(`INSERT INTO ${table('interviews')} VALUES ($1,$2)`, [interview,title]);
        await pool.query(`INSERT INTO ${table('sessions')} (id,"interviewId") VALUES ($1,$2)`, [session,interview]);
        const messages = [];
        for (let i=0;i<count;i++) {
          const question=randomUUID(), id=randomUUID();
          await pool.query(`INSERT INTO ${table('questions')} VALUES ($1,$2,$3)`, [question,interview,`oprun_dimension:q${i+1}`]);
          await pool.query(`INSERT INTO ${table('messages')} VALUES ($1,$2,$3,'USER','本人负责核对数据')`, [id,session,question]);
          messages.push({id,question});
        }
        return {session,interview,messages};
      };
      const finish = (query, session, version) => query(
        `UPDATE ${table('sessions')} SET status='COMPLETED', "completedVoiceRevision"=$2 WHERE id=$1`, [session,version]);
      const state = async session => (await pool.query(`SELECT * FROM ${table('sessions')} WHERE id=$1`, [session])).rows[0];
      await t.test('eight answers close at the stored version; new late evidence is explicitly rejected', async () => {
        const row=await seed();
        assert.equal(Number((await state(row.session)).voiceRevision),8);
        await finish(pool.query.bind(pool),row.session,8);
        await assert.rejects(pool.query(`INSERT INTO ${table('messages')} VALUES ($1,$2,$3,'USER','更正：是3万元')`,
          [randomUUID(),row.session,row.messages[7].question]), {code:'PVR02'});
        assert.equal(Number((await state(row.session)).completedVoiceRevision),8);
        // The same acknowledged identity can be retried without another version.
        await pool.query(`INSERT INTO ${table('messages')} VALUES ($1,$2,$3,'USER','本人负责核对数据') ON CONFLICT(id) DO NOTHING`,
          [row.messages[0].id,row.session,row.messages[0].question]);
        assert.equal(Number((await state(row.session)).voiceRevision),8);
      });
      await t.test('missing or stale version cannot close a session', async () => {
        const row=await seed();
        for (const version of [null,7]) await assert.rejects(finish(pool.query.bind(pool),row.session,version), {code:'PVR01'});
        assert.equal((await state(row.session)).status,'IN_PROGRESS');
      });
      await t.test('seven stored answers cannot bypass the application guard', async () => {
        const row=await seed(7);
        await assert.rejects(finish(pool.query.bind(pool),row.session,7), {code:'PVR03'});
      });
      await t.test('concurrent new revision commits before a waiting completion, which must retry', async () => {
        const row=await seed();
        const writer=await pool.connect(), closer=await pool.connect();
        try {
          await writer.query('BEGIN');
          await writer.query(`INSERT INTO ${table('messages')} VALUES ($1,$2,$3,'USER','更正：是3万元')`,
            [randomUUID(),row.session,row.messages[7].question]);
          const closing=finish(closer.query.bind(closer),row.session,8);
          // Attach the rejection handler before releasing the competing lock.
          const rejected=assert.rejects(closing,{code:'PVR01'});
          await writer.query('COMMIT');
          await rejected;
          assert.equal((await state(row.session)).status,'IN_PROGRESS');
          await finish(pool.query.bind(pool),row.session,9);
          assert.equal(Number((await state(row.session)).completedVoiceRevision),9);
        } finally { await writer.query('ROLLBACK'); writer.release(); closer.release(); }
      });
      await t.test('a completion holding the lock rejects a subsequent new insert', async () => {
        const row=await seed();
        const closer=await pool.connect(), writer=await pool.connect();
        try {
          await closer.query('BEGIN');
          await finish(closer.query.bind(closer),row.session,8);
          const rejected=assert.rejects(writer.query(`INSERT INTO ${table('messages')} VALUES ($1,$2,$3,'USER','迟到补充')`,
            [randomUUID(),row.session,row.messages[7].question]),{code:'PVR02'});
          await closer.query('COMMIT');
          await rejected;
        } finally { await closer.query('ROLLBACK'); closer.release(); writer.release(); }
      });
      await t.test('non-recruitment interviews retain their existing completion behavior', async () => {
        const row=await seed(0,'产品访谈');
        await finish(pool.query.bind(pool),row.session,null);
        await pool.query(`INSERT INTO ${table('messages')} VALUES ($1,$2,NULL,'USER','访谈补充')`,[randomUUID(),row.session]);
        assert.equal((await state(row.session)).status,'COMPLETED');
      });
      await t.test('in-place edits invalidate an old completion version; closed evidence cannot be edited or deleted', async () => {
        const row=await seed();
        await pool.query(`UPDATE ${table('messages')} SET content='更正：3万元' WHERE id=$1`,[row.messages[7].id]);
        await assert.rejects(finish(pool.query.bind(pool),row.session,8),{code:'PVR01'});
        await finish(pool.query.bind(pool),row.session,9);
        await assert.rejects(pool.query(`UPDATE ${table('messages')} SET content='旧版本' WHERE id=$1`,[row.messages[7].id]),{code:'PVR02'});
        await assert.rejects(pool.query(`DELETE FROM ${table('messages')} WHERE id=$1`,[row.messages[7].id]),{code:'PVR02'});
        // Whole-session removal still honors the existing FK cleanup policy.
        await pool.query(`DELETE FROM ${table('sessions')} WHERE id=$1`,[row.session]);
        assert.equal((await pool.query(`SELECT count(*)::int n FROM ${table('messages')} WHERE "sessionId"=$1`,[row.session])).rows[0].n,0);
      });
      await t.test('an answer cannot be reassigned into a different recruitment session', async () => {
        const source=await seed(), target=await seed();
        await assert.rejects(pool.query(`UPDATE ${table('messages')} SET "sessionId"=$2 WHERE id=$1`,[source.messages[0].id,target.session]),{code:'PVR04'});
      });
      await t.test('a question from a different interview or a nonexistent question cannot receive this answer', async () => {
        const source=await seed(), target=await seed();
        for (const question of [target.messages[0].question,randomUUID()]) {
          await assert.rejects(pool.query(`INSERT INTO ${table('messages')} VALUES ($1,$2,$3,'USER','错题内容')`,
            [randomUUID(),source.session,question]),{code:'PVR04'});
          await assert.rejects(pool.query(`UPDATE ${table('messages')} SET "questionId"=$2 WHERE id=$1`,
            [source.messages[0].id,question]),{code:'PVR04'});
        }
        assert.equal(Number((await state(source.session)).voiceRevision),8);
      });
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
  });
