"""Real scoring worker on a snapshot of the completed synthetic page interview."""
import json, os, sqlite3, sys, time, hashlib
from pathlib import Path
from datetime import datetime

root = Path(__file__).resolve().parents[1]
source = root / 'output/local-sandbox/real-report'
out = root / 'output' / ('offline-pilot-score-' + str(time.time_ns()))
out.mkdir(parents=True)
with sqlite3.connect(source/'control.sqlite') as src, sqlite3.connect(out/'score.sqlite') as dst:
    src.backup(dst)
fixture = json.loads((source/'offline-pilot-private.json').read_text())
assert fixture['sessionId'] == '622f60c0-75dd-4a66-89cb-88a7ab1d5de6'
config = json.loads(Path('C:/Users/wang/.zcode/v2/config.json').read_text(encoding='utf-8-sig'))
provider = config['provider']['builtin:bigmodel-coding-plan']
assert provider['enabled'] is True
keep = {k:v for k,v in os.environ.items() if k.upper() in {'PATH','SYSTEMROOT','WINDIR','TEMP','TMP','COMSPEC','PATHEXT','USERPROFILE'}}
os.environ.clear(); os.environ.update(keep)
os.environ.update(OPRUN_LOAD_DOTENV='false', OPRUN_HR_ENV_NAME='local',
    OPRUN_HR_DATA_ROOT=str(out), OPRUN_DATA_ROOT=str(out), OPRUN_LOG_DIR=str(out),
    DATABASE_URL='sqlite:///'+str(out/'score.sqlite'), OPRUN_HR_AUTO_CREATE_SCHEMA='1',
    SECRET_KEY='synthetic-score-local', JWT_SECRET_KEY='synthetic-score-local',
    OPRUN_OUTBOUND_MODE='record_only', RECRUIT_GLM_ONLY='1',
    RECRUIT_SCORE_RECOVERY_ENABLED='0', REDIS_URL='redis://127.0.0.1:9/0',
    AURAL_API_KEY='', AURAL_API_BASE='http://127.0.0.1:3300/api/v1',
    ZHIPU_API_KEY=provider['options']['apiKey'], ZHIPU_BASE_URL='https://open.bigmodel.cn/api/coding/paas/v4')
sys.path.insert(0,'D:/GGGG/kiro/oprun-hr-quality-release/backend')
import requests
native_send = requests.sessions.Session.send
calls = []
def bounded_send(session, request, **kwargs):
    assert request.url == 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions', 'unexpected_egress'
    assert request.method == 'POST' and len(calls) < 1, 'model_request_budget'
    body = json.loads(request.body)
    assert body['model'] == 'glm-5.3'
    calls.append({'model':body['model'], 'thinking':body.get('thinking')})
    kwargs['allow_redirects'] = False
    kwargs['proxies'] = {}
    return native_send(session, request, **kwargs)
requests.sessions.Session.send = bounded_send
from app import app
from models import db
from models.recruit_candidate import RecruitCandidate
from models.recruit_interview_attempt import RecruitInterviewAttempt, RecruitInterviewQuestionRun
from models.hr_model_execution import HrModelTask, HrModelFailure
from services.recruit_interview_service import score_due_completed_interviews, interview_completion_gate
from services.recruit_scoring_service import SELECTION_REPORT_DIMENSIONS
start = time.monotonic()
with app.app_context():
    attempt = RecruitInterviewAttempt.query.filter_by(aural_session_id=fixture['sessionId']).one()
    aid, cid = attempt.id, attempt.candidate_id
    assert attempt.sync_status == 'score_pending'
    assert interview_completion_gate(attempt, persist=False)['eligible']
    candidate = db.session.get(RecruitCandidate,cid)
    before_answers = json.dumps(candidate.aural_messages,sort_keys=True,ensure_ascii=False)
    # Only scheduling of unrelated synthetic fixtures is deferred in this disposable copy.
    RecruitInterviewAttempt.query.filter(RecruitInterviewAttempt.id != aid).update(
        {RecruitInterviewAttempt.next_sync_at:datetime(2099,1,1)},synchronize_session=False)
    db.session.commit()
    result = score_due_completed_interviews(limit=1)
    db.session.remove()
    attempt = db.session.get(RecruitInterviewAttempt,aid)
    candidate = db.session.get(RecruitCandidate,cid)
    score = (candidate.ai_assessment or {}).get('score_v2_1') or {}
    dims = score.get('selection_dimensions') or {}
    dimensions_valid = set(dims)==set(SELECTION_REPORT_DIMENSIONS) and all(
        isinstance(dims[k].get('score'),(int,float)) and 0 <= dims[k]['score'] <= maximum
        and bool(dims[k].get('evidence')) and bool(dims[k].get('supporting_question_numbers'))
        and all(type(n) is int and 1<=n<=8 for n in dims[k]['supporting_question_numbers'])
        for k,maximum in SELECTION_REPORT_DIMENSIONS.items())
    receipt = {'worker':result,'sessionId':fixture['sessionId'],'attemptId':aid,
        'syncStatus':attempt.sync_status,'dimensionsValid':dimensions_valid,
        'dimensionNames':list(dims),'selectionReportStatus':(candidate.ai_assessment or {}).get('selection_report_status'),
        'answersUnchanged':before_answers==json.dumps(candidate.aural_messages,sort_keys=True,ensure_ascii=False),
        'leaseReleased':attempt.lease_owner is None and attempt.lease_expires_at is None,
        'requests':calls,'elapsedSeconds':round(time.monotonic()-start,2),
        'failureCount':HrModelFailure.query.count(),
        'isolatedDatabase':True,'sourcePageEvidenceReused':True,'productionWrites':False,
        'output':str(out)}
    (out/'receipt.json').write_text(json.dumps(receipt,ensure_ascii=False,indent=2),encoding='utf8')
    (out/'score.json').write_text(json.dumps(score,ensure_ascii=False,indent=2),encoding='utf8')
    print(json.dumps(receipt,ensure_ascii=False),flush=True)
    assert result['scored']==1 and attempt.sync_status=='synced'
    assert dimensions_valid and receipt['answersUnchanged'] and receipt['leaseReleased']

