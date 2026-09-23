"""Aural save reconciliation against an owned, isolated PostgreSQL cluster.

This is a database contract layer, not a Next/provider/browser E2E test.
"""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import traceback
import threading
import uuid

aural = Path(__file__).resolve().parents[1]
hr = Path(sys.argv[1]).resolve(strict=True)
runtime = aural / 'output/local-sandbox' / ('postgres-contract-' + uuid.uuid4().hex)
runtime.mkdir(parents=True)
helper = '/mnt/' + aural.drive[0].lower() + str(aural)[2:].replace('\\', '/') + '/scripts/local-pg-fixture.py'
platform_env = {k: v for k, v in os.environ.items() if k.upper() in {
    'PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT', 'USERPROFILE'}}
fixture = None
redis_fixture = None
server = None
thread = None
redis_helper = helper.replace('local-pg-fixture.py', 'local-redis-fixture.py')
report = {'passed': False, 'checks': [], 'database': 'isolated PostgreSQL',
          'realProvidersCalled': False, 'fullInterviewAcceptancePassed': False}
try:
    setup = subprocess.run(['wsl', '-d', 'Ubuntu', '--', 'python3', helper, 'start'],
        capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=100)
    if setup.returncode:
        raise RuntimeError('PostgreSQL fixture setup failed: ' + setup.stderr[-1500:])
    fixture = json.loads(setup.stdout)
    redis_setup = subprocess.run(['wsl', '-d', 'Ubuntu', '--', 'python3', redis_helper, 'start'],
        capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=30)
    assert redis_setup.returncode == 0, 'Owned Redis fixture failed'
    redis_fixture = json.loads(redis_setup.stdout)
    os.environ.clear()
    os.environ.update(platform_env)
    os.environ.update({
        'OPRUN_LOAD_DOTENV': 'false', 'OPRUN_HR_ENV_NAME': 'local',
        'OPRUN_HR_DATA_ROOT': str(runtime), 'OPRUN_DATA_ROOT': str(runtime),
        'DATABASE_URL': f"postgresql://{fixture['user']}:{fixture['password']}@127.0.0.1:{fixture['port']}/postgres",
        'OPRUN_HR_AUTO_CREATE_SCHEMA': '1', 'SECRET_KEY': 'local-contract-only',
        'JWT_SECRET_KEY': 'local-contract-jwt', 'OPRUN_OUTBOUND_MODE': 'record_only',
        'AURAL_API_KEY': '', 'AURAL_API_BASE': 'http://127.0.0.1:9/api/v1',
        'AURAL_PUBLIC_BASE': 'http://127.0.0.1:9',
        'REDIS_URL': f"redis://:{redis_fixture['password']}@127.0.0.1:{redis_fixture['port']}/0",
        'HR_MODEL_CONTROL_SECRET': 'local-contract-control',
    })
    native_connect = socket.socket.connect
    def connect(sock, address):
        if not isinstance(address, tuple) or address[0] not in ('127.0.0.1', '::1'):
            raise RuntimeError('Non-loopback I/O blocked')
        return native_connect(sock, address)
    socket.socket.connect = connect
    sys.path[:0] = [str(hr / 'backend'), str(hr / 'backend/tests')]
    from app import app
    from models import db
    from models.recruit_interview_attempt import RecruitInterviewQuestionRun as Run
    from services import recruit_interview_service as service
    from test_recruit_interview_live_sync import _candidate_and_attempt, _seed_complete_answers
    from core.auth_middleware import _nonce_store, _token_blacklist
    from models.hr_model_execution import HrModelTask, HrModelFailure
    from werkzeug.serving import make_server, WSGIRequestHandler
    assert _nonce_store._redis is not None and _token_blacklist._redis is not None
    app.config.update(TESTING=True)
    with app.app_context():
        assert db.engine.dialect.name == 'postgresql'
        db.create_all()
        for count in (6, 8):
            _, attempt = _candidate_and_attempt(db)
            _seed_complete_answers(db, attempt)
            rows = Run.query.filter_by(attempt_id=attempt.id).order_by(Run.question_index).all()
            questions = []
            for row in rows:
                row.answer_text = None
                row.live_state = 'pending'
                questions.append({'id': row.question_id, 'text': row.question_text,
                    'order': row.question_index, 'description': 'oprun_dimension:' + row.coverage_tags[-1]})
            db.session.commit()
            child = subprocess.run(['node', '--import', 'tsx', str(aural / 'scripts/local-recruitment-save-replay.ts')],
                cwd=aural, env=platform_env, input=json.dumps({'questions': questions, 'answeredCount': count}),
                capture_output=True, text=True, encoding='utf-8', timeout=40)
            assert child.returncode == 0, 'Aural replay failed'
            output = json.loads(child.stdout)
            assert output['completionWrites'] == (1 if count == 8 else 0)
            for repetition in range(3):
                service._reconcile_aural_messages(attempt, output['messages'])
                db.session.commit()
                db.session.expire_all()
                for row in rows[:count]:
                    assert row.answer_text == output['expected'][row.question_id]
                assert all(not row.answer_text for row in rows[count:])
                followups = Run.query.filter_by(attempt_id=attempt.id, question_type='follow_up').all()
                assert len(followups) == 1
                assert followups[0].parent_question_id == rows[1].question_id
                assert service.interview_completion_gate(attempt, persist=False)['eligible'] == (count == 8)
            report['checks'].append({'answered': count, 'reconciliations': 3, 'completionEligible': count == 8,
                'answersExact': True, 'followupCount': 1})
        interview_id = attempt.aural_interview_id
        with app.test_client() as client:
            assert client.post('/v1/recruit/internal/aural/model-task', json={'action': 'begin'}).status_code in (401, 403)
        class QuietHandler(WSGIRequestHandler):
            def log(self, *args, **kwargs):
                pass
        server = make_server('127.0.0.1', 0, app, request_handler=QuietHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        script = r'''
const assert = require('node:assert/strict');
const {readdir} = require('node:fs/promises');
const {join} = require('node:path');
const {runHrModelTask,HrTaskHalted} = require('./server/hr-model-task.ts');
(async()=>{
 const identity={interview_id:process.env.LOCAL_INTERVIEW_ID,stage:'voice_turn'};
 assert.equal(await runHrModelTask(identity,async route=>{
   assert.equal(typeof route.primary,'string');return 'synthetic-ok';
 }), 'synthetic-ok');
 await assert.rejects(runHrModelTask(identity,async route=>{
   throw Object.assign(new Error('all_models_failed'),{attempts:[route.primary,...route.fallbacks]
     .map(provider=>({provider,model:'synthetic',state:'failed',error:'http_429'}))});
 }));
 await assert.rejects(runHrModelTask(identity,async()=>{throw Error('must not run');}),HrTaskHalted);
 for(let count=0;count<100;count++){
   const pending=await readdir(join(process.env.AURAL_RUNTIME_STATE_DIR,'model-task-events'));
   if(!pending.some(name=>name.endsWith('.json')))return;
   await new Promise(resolve=>setTimeout(resolve,100));
 }
 throw Error('Outbox acknowledgement missing');
})().catch(()=>{process.exitCode=1;});
'''
        node_env = {**platform_env, 'HR_MODEL_CONTROL_SECRET': 'local-contract-control',
            'HR_MODEL_CONTROL_URL': f'http://127.0.0.1:{server.server_port}/v1/recruit/internal/aural/model-policy',
            'AURAL_RUNTIME_STATE_DIR': str(runtime / 'aural'), 'LOCAL_INTERVIEW_ID': interview_id}
        control = subprocess.run(['node', '--import', 'tsx', '-e', script], cwd=aural,
            env=node_env, capture_output=True, text=True, timeout=40)
        assert control.returncode == 0, 'Signed Aural HTTP control failed'
        db.session.expire_all()
        assert HrModelTask.query.count() == 1 and HrModelTask.query.one().state == 'halted'
        assert HrModelFailure.query.count() == 1
        report['signedHttpChecks'] = ['unsigned_rejected', 'signed_begin', 'success_ack',
            'failure_persisted', 'halt_blocks_retry', 'outbox_acknowledged']
        report['realRedisUsed'] = True
        db.session.remove()
        db.engine.dispose()
    if '--concurrency' in sys.argv:
        # The repository fixtures may drop tables only in this owned cluster.
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
        server = None
        import pytest
        class Outcomes:
            def __init__(self):
                self.passed = self.skipped = self.failed = 0
            def pytest_runtest_logreport(self, report):
                if report.skipped:
                    self.skipped += 1
                if report.failed:
                    self.failed += 1
                if report.when == 'call' and report.passed:
                    self.passed += 1
        outcomes = Outcomes()
        result = pytest.main([str(hr / 'backend/tests/test_recruit_postgres_concurrency.py'), '-q'], plugins=[outcomes])
        report['postgresConcurrency'] = vars(outcomes)
        assert result == 0 and outcomes.passed == 2 and outcomes.skipped == 0 and outcomes.failed == 0
    report['passed'] = True
except Exception as error:
    # SQL/DSN exception text may contain credentials or payload; do not emit it.
    report['errorType'] = type(error).__name__
    report['errorFrames'] = [{'file': Path(f.filename).name, 'line': f.lineno, 'function': f.name}
                             for f in traceback.extract_tb(error.__traceback__)[-5:]]
finally:
    if server:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
    if redis_fixture:
        stopped_redis = subprocess.run(['wsl', '-d', 'Ubuntu', '--', 'python3', redis_helper, 'stop', redis_fixture['runtime']],
            capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=30)
        report['redisStopped'] = stopped_redis.returncode == 0
        if stopped_redis.returncode:
            report['passed'] = False
    if fixture:
        stopped = subprocess.run(['wsl', '-d', 'Ubuntu', '--', 'python3', helper, 'stop', fixture['runtime']],
            capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=60)
        report['fixtureStopped'] = stopped.returncode == 0
        report['fixtureRuntime'] = fixture['runtime']
        if stopped.returncode:
            report['passed'] = False
    (runtime / 'result.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps(report))
sys.exit(0 if report['passed'] else 1)
