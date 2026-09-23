"""Current Aural module -> HTTP -> real HR route -> isolated SQLite. No provider calls."""
from pathlib import Path
import json
import os
import socket
import subprocess
import sys
import threading
import uuid

aural = Path(__file__).resolve().parents[1]
hr = Path(sys.argv[1]).resolve()
assert (hr / 'backend/app.py').is_file()
runtime = aural / 'output/local-sandbox' / ('bridge-' + uuid.uuid4().hex)
runtime.mkdir(parents=True)
# The subprocess cannot inherit application credentials or production endpoints.
platform_env = {key: value for key, value in os.environ.items() if key.upper() in {
    'PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT', 'USERPROFILE',
}}
os.environ.clear()
os.environ.update(platform_env)
os.environ.update({
    'OPRUN_LOAD_DOTENV': 'false', 'OPRUN_HR_ENV_NAME': 'local',
    'OPRUN_HR_DATA_ROOT': str(runtime), 'OPRUN_DATA_ROOT': str(runtime),
    'DATABASE_URL': 'sqlite:///:memory:', 'OPRUN_HR_AUTO_CREATE_SCHEMA': '1',
    'SECRET_KEY': 'local-bridge-hr', 'JWT_SECRET_KEY': 'local-bridge-jwt',
    'OPRUN_OUTBOUND_MODE': 'record_only', 'AURAL_API_KEY': '',
    'AURAL_API_BASE': 'http://127.0.0.1:9/api/v1', 'AURAL_PUBLIC_BASE': 'http://127.0.0.1:9',
    'REDIS_URL': 'redis://127.0.0.1:9/0', 'HR_MODEL_CONTROL_SECRET': 'local-bridge-control',
})
native_connect = socket.socket.connect
def local_connect(sock, address):
    if not isinstance(address, tuple) or address[0] not in ('127.0.0.1', '::1'):
        raise RuntimeError('Non-loopback network blocked in local bridge test')
    return native_connect(sock, address)
socket.socket.connect = local_connect
sys.path.insert(0, str(hr / 'backend'))
from app import app
from models import db
from models.recruit_candidate import RecruitCandidate
from models.recruit_interview_attempt import RecruitInterviewAttempt
from models.hr_model_execution import HrModelTask, HrModelFailure
from werkzeug.serving import make_server, WSGIRequestHandler

class QuietHandler(WSGIRequestHandler):
    def log(self, *args, **kwargs):
        pass

app.config.update(TESTING=True)
with app.app_context():
    db.create_all()
    candidate = RecruitCandidate(name='Local synthetic bridge', resume_text='synthetic test')
    db.session.add(candidate)
    db.session.flush()
    attempt = RecruitInterviewAttempt(candidate_id=candidate.id, setup_key='local-bridge',
        correlation_id='local-bridge', aural_interview_id='local-bridge-interview', status='ready')
    db.session.add(attempt)
    db.session.commit()
    with app.test_client() as client:
        rejected = client.post('/v1/recruit/internal/aural/model-task', json={'action': 'begin'})
        assert rejected.status_code in (401, 403), 'unsigned control must be rejected'

server = make_server('127.0.0.1', 0, app, request_handler=QuietHandler)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
script = r'''
const assert = require('node:assert/strict');
const {readdir} = require('node:fs/promises');
const {join} = require('node:path');
const {runHrModelTask,HrTaskHalted} = require('./server/hr-model-task.ts');
(async()=>{
 const identity={interview_id:'local-bridge-interview',stage:'voice_turn'};
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
 throw Error('Local outbox did not receive HR acknowledgement');
})().catch(error=>{console.error(error.message);process.exitCode=1;});
'''
try:
    node_env = {**platform_env, 'HR_MODEL_CONTROL_SECRET': 'local-bridge-control',
        'HR_MODEL_CONTROL_URL': f'http://127.0.0.1:{server.server_port}/v1/recruit/internal/aural/model-policy',
        'AURAL_RUNTIME_STATE_DIR': str(runtime / 'aural')}
    result = subprocess.run(['node', '--import', 'tsx', '-e', script], cwd=aural,
        env=node_env, capture_output=True, text=True, timeout=40)
    if result.returncode:
        raise AssertionError('Aural local bridge subprocess failed: ' + result.stderr[-1200:])
    with app.app_context():
        db.session.expire_all()
        assert HrModelTask.query.count() == 1
        assert HrModelTask.query.one().state == 'halted'
        assert HrModelFailure.query.count() == 1
    report = {'passed': True, 'checks': ['unsigned_rejected', 'signed_begin', 'success_ack',
        'failure_persisted', 'halt_blocks_retry', 'outbox_acknowledged'],
        'database': 'isolated in-memory SQLite', 'realProvidersCalled': False,
        'fullInterviewAcceptancePassed': False}
    (runtime / 'result.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps(report))
finally:
    server.shutdown()
    server.server_close()
    thread.join(timeout=5)
