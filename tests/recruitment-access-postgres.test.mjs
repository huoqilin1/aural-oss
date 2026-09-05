import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';

test('PostgreSQL: recruitment cannot bypass server authorization through permissive RLS or RPC',
  {skip:!process.env.VOICE_TEST_DATABASE_URL},async t=>{
    const url=new URL(process.env.VOICE_TEST_DATABASE_URL);
    assert.ok(['127.0.0.1','localhost'].includes(url.hostname));assert.equal(url.pathname,'/codex_recruit_test');
    const client=new pg.Client({connectionString:url.href});await client.connect();
    const suffix=randomUUID().replaceAll('-','');
    const schema=`access_${suffix}`,anon=`anon_${suffix}`,authenticated=`auth_${suffix}`,service=`svc_${suffix}`;
    const table=name=>`"${schema}".${name}`;
    const roles=[anon,authenticated,service];
    const recruit=randomUUID(),practice=randomUUID(),recruitSession=randomUUID(),practiceSession=randomUUID();
    try {
      await client.query(`CREATE SCHEMA "${schema}";
        CREATE ROLE "${anon}" NOLOGIN NOBYPASSRLS;
        CREATE ROLE "${authenticated}" NOLOGIN NOBYPASSRLS;
        CREATE ROLE "${service}" NOLOGIN BYPASSRLS;
        CREATE TYPE ${table('"InterviewMode"')} AS ENUM ('CHAT','VOICE');
        CREATE TABLE ${table('interviews')} (id uuid PRIMARY KEY,title text);
        CREATE TABLE ${table('questions')} (id uuid PRIMARY KEY,"interviewId" uuid,description text);
        CREATE TABLE ${table('sessions')} (id uuid PRIMARY KEY,"interviewId" uuid,status text DEFAULT 'IN_PROGRESS');
        CREATE TABLE ${table('candidates')} (id uuid PRIMARY KEY,"interviewId" uuid,"inviteToken" text);
        CREATE TABLE ${table('messages')} (id uuid PRIMARY KEY,"sessionId" uuid REFERENCES ${table('sessions')}(id) ON DELETE CASCADE,content text,"questionId" uuid,role text DEFAULT 'USER');
        CREATE TABLE ${table('objects')} (id uuid PRIMARY KEY,bucket_id text,name text);
        CREATE FUNCTION ${table('create_interview_session')}(uuid,text,text,${table('"InterviewMode"')},uuid) RETURNS json LANGUAGE sql SECURITY DEFINER AS 'SELECT ''{}''::json';
        CREATE FUNCTION ${table('create_invite_session')}(text,${table('"InterviewMode"')},uuid) RETURNS json LANGUAGE sql SECURITY DEFINER AS 'SELECT ''{}''::json';`);
      for(const name of ['interviews','questions','sessions','candidates','messages','objects']) {
        await client.query(`ALTER TABLE ${table(name)} ENABLE ROW LEVEL SECURITY;
          CREATE POLICY legacy_permissive ON ${table(name)} FOR ALL USING(true) WITH CHECK(true);`);
      }
      for(const role of roles)await client.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"; GRANT ALL ON ALL TABLES IN SCHEMA "${schema}" TO "${role}";`);
      for(const bucket of ['recordings','screenshots','whiteboards','support-attachments'])await client.query(`INSERT INTO ${table('objects')} VALUES ($1,$2,'synthetic object')`,[randomUUID(),bucket]);
      await client.query(`INSERT INTO ${table('interviews')} VALUES ($1,'数君招聘 · 人力资源'),($2,'Public practice');`,[recruit,practice]);
      await client.query(`INSERT INTO ${table('sessions')} (id,"interviewId") VALUES ($1,$2),($3,$4)`,[recruitSession,recruit,practiceSession,practice]);
      for(const [interview,session]of [[recruit,recruitSession],[practice,practiceSession]]) {
        await client.query(`INSERT INTO ${table('questions')} (id,"interviewId") VALUES ($1,$2)`,[randomUUID(),interview]);
        await client.query(`INSERT INTO ${table('candidates')} VALUES ($1,$2,'synthetic invitation')`,[randomUUID(),interview]);
        await client.query(`INSERT INTO ${table('messages')} (id,"sessionId",content) VALUES ($1,$2,'synthetic answer')`,[randomUUID(),session]);
      }
      await client.query(`SET ROLE "${anon}"`);
      assert.equal((await client.query(`SELECT * FROM ${table('candidates')}`)).rowCount,2,'reproduce permissive pre-migration read');
      await client.query('RESET ROLE');
      const completionMigration=(await readFile(new URL('./fixtures/pending-completion-guard.sql',import.meta.url),'utf8'))
        .replaceAll('public.',`"${schema}".`).replaceAll('search_path = public',`search_path = "${schema}"`);
      let migration=await readFile(new URL('../supabase/migrations/008_recruitment_access_boundary.sql',import.meta.url),'utf8');
      migration=migration.replaceAll('public.',`"${schema}".`).replaceAll('storage.',`"${schema}".`).replace(/\banon\b/g,`"${anon}"`).replace(/\bauthenticated\b/g,`"${authenticated}"`).replace(/\bservice_role\b/g,`"${service}"`);
      await client.query(migration);await client.query(migration);
      for(const role of [anon,authenticated])await t.test(`untrusted role ${role===anon?'anonymous':'logged in'} cannot enumerate or alter recruitment`,async()=>{
        await client.query(`SET ROLE "${role}"`);
        try {
          for(const name of ['interviews','questions','sessions','candidates','messages'])assert.equal((await client.query(`SELECT * FROM ${table(name)}`)).rowCount,1,`${name} exposes only the practice row`);
          assert.deepEqual((await client.query(`SELECT bucket_id FROM ${table('objects')}`)).rows,[{bucket_id:'support-attachments'}]);
          await assert.rejects(client.query(`INSERT INTO ${table('objects')} VALUES ($1,'recordings','forged')`,[randomUUID()]),{code:'42501'});
          assert.equal((await client.query(`UPDATE ${table('candidates')} SET "inviteToken"='changed' WHERE "interviewId"=$1`,[recruit])).rowCount,0);
          await assert.rejects(client.query(`INSERT INTO ${table('messages')} (id,"sessionId",content) VALUES ($1,$2,'forged')`,[randomUUID(),recruitSession]),{code:'42501'});
          await assert.rejects(client.query(`SELECT ${table('create_interview_session')}($1,NULL,NULL,'CHAT',NULL)`,[recruit]),{code:'42501'});
          await assert.rejects(client.query(`SELECT ${table('create_invite_session')}('synthetic invitation','CHAT',NULL)`),{code:'42501'});
        } finally {await client.query('RESET ROLE');}
      });
      await t.test('service role retains mediated reads and RPC execution',async()=>{
        await client.query(`SET ROLE "${service}"`);
        try {
          assert.equal((await client.query(`SELECT * FROM ${table('candidates')}`)).rowCount,2);
          assert.equal((await client.query(`SELECT * FROM ${table('objects')}`)).rowCount,4);
          assert.equal((await client.query(`SELECT ${table('create_invite_session')}('synthetic invitation','CHAT',NULL)`)).rowCount,1);
        } finally {await client.query('RESET ROLE');}
      });
      await t.test('access migration and completion version migration work together',async()=>{
        // Prove 008 independently above; only now add the pending 007 migration.
        await client.query(completionMigration);
        await client.query(migration);
        const interview=randomUUID(),session=randomUUID();
        await client.query(`SET ROLE "${service}"`);
        try {
          await client.query(`INSERT INTO ${table('interviews')} VALUES ($1,'数君招聘 · 总经理助理')`,[interview]);
          await client.query(`INSERT INTO ${table('sessions')} (id,"interviewId") VALUES ($1,$2)`,[session,interview]);
          for(let i=0;i<8;i++) {
            const question=randomUUID();
            await client.query(`INSERT INTO ${table('questions')} VALUES ($1,$2,$3)`,[question,interview,`oprun_dimension:q${i+1}`]);
            await client.query(`INSERT INTO ${table('messages')} (id,"sessionId","questionId",content) VALUES ($1,$2,$3,'synthetic evidence')`,[randomUUID(),session,question]);
          }
          await client.query(`UPDATE ${table('sessions')} SET status='COMPLETED',"completedVoiceRevision"=8 WHERE id=$1`,[session]);
          const result=await client.query(`SELECT status,"voiceRevision","completedVoiceRevision" FROM ${table('sessions')} WHERE id=$1`,[session]);
          assert.equal(result.rows[0].status,'COMPLETED');assert.equal(result.rows[0].voiceRevision,'8');
        } finally {await client.query('RESET ROLE');}
      });
    } finally {
      await client.query('ROLLBACK');await client.query('RESET ROLE');
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      for(const role of roles)await client.query(`DROP ROLE IF EXISTS "${role}"`);
      await client.end();
    }
  });
