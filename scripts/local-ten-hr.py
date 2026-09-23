"""Isolated local official-entry acceptance; real HR routes and durable workers."""
import json, os, sys, threading, time, logging
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT/'output/local-sandbox/official-ten-20260915'
DATA.mkdir(parents=True, exist_ok=True)
MODE = sys.argv[1]
assert MODE in {'init', 'serve', 'worker', 'diagnostic', 'status', 'opening', 'pause', 'resume', 'bind-retake'}
member = json.loads(Path('C:/Users/wang/.zcode/v2/config.json').read_text(encoding='utf-8-sig'))['provider']['builtin:bigmodel-coding-plan']
assert member['enabled']
key = json.loads((ROOT/'output/local-sandbox/real-report/reconcile-key-private.json').read_text())['key']
keep = {k:v for k,v in os.environ.items() if k.upper() in {'PATH','SYSTEMROOT','WINDIR','TEMP','TMP','COMSPEC','PATHEXT','USERPROFILE'}}
os.environ.clear(); os.environ.update(keep)
os.environ.update(OPRUN_LOAD_DOTENV='false', OPRUN_HR_ENV_NAME='local',
    OPRUN_HR_DATA_ROOT=str(DATA), OPRUN_DATA_ROOT=str(DATA), OPRUN_LOG_DIR=str(DATA),
    DATABASE_URL='sqlite:///'+str(DATA/'hr.sqlite'), OPRUN_HR_AUTO_CREATE_SCHEMA='1',
    SECRET_KEY='local-ten-only', JWT_SECRET_KEY='local-ten-only-jwt',
    OPRUN_OUTBOUND_MODE='record_only', RECRUIT_GLM_ONLY='1',
    GLM_SHARED_CAPACITY_ENABLED='1', GLM_MAX_INFLIGHT='2', GLM_MIN_START_INTERVAL_SECONDS='1',
    REDIS_URL='redis://127.0.0.1:9/0', AURAL_API_KEY=key,
    AURAL_API_BASE='http://127.0.0.1:3300/api/v1', AURAL_PUBLIC_BASE='http://127.0.0.1:3300',
    AURAL_MAX_CONCURRENCY='10', HR_MODEL_CONTROL_SECRET='local-report-control',
    OPRUN_HR_PUBLIC_UPLOAD_ORIGINS='http://127.0.0.1:3308',
    ZHIPU_API_KEY=member['options']['apiKey'], ZHIPU_BASE_URL='https://open.bigmodel.cn/api/coding/paas/v4',
    OPRUN_HR_TASK_THREADS='2', OPRUN_HR_QUESTION_WORKERS='2')
sys.path.insert(0,'D:/GGGG/kiro/oprun-hr-quality-release/backend')
import requests
native = requests.sessions.Session.send
lock = threading.Lock()
ledger = DATA/'model-calls.jsonl'

def bounded_send(session, request, **kwargs):
    url = urlsplit(request.url)
    if url.hostname in ('127.0.0.1','::1'):
        assert url.scheme=='http' and url.port in (3300,3301,55321), 'local_port_boundary'
    else:
        assert MODE in ('worker','diagnostic'), 'model_work_not_allowed_in_api'
        assert request.url=='https://open.bigmodel.cn/api/coding/paas/v4/chat/completions' and request.method=='POST', 'membership_only_boundary'
        body=json.loads(request.body)
        assert body['model']=='glm-5.3', 'model_boundary'
        with lock:
            rows=ledger.read_text().splitlines() if ledger.exists() else []
            assert len(rows)<120, 'bounded_ten_request_budget_exhausted'
            with ledger.open('a',encoding='utf8') as f:
                f.write(json.dumps({'n':len(rows)+1,'at':time.time(),'model':body['model'],'thinking':body.get('thinking'),'maxTokens':body.get('max_tokens')})+'\n')
    kwargs['allow_redirects']=False
    kwargs['proxies']={}
    return native(session,request,**kwargs)
requests.sessions.Session.send=bounded_send
from app import app
from models import db
from models.recruit_position import RecruitPosition
from models.recruit_candidate import RecruitCandidate
from models.recruit_resume_processing_job import RecruitResumeProcessingJob
from models.recruit_interview_attempt import RecruitInterviewAttempt
from services.recruit_qa_test_data_service import issue_qa_run_token
logging.getLogger().setLevel(logging.WARNING)
with app.app_context():
    if MODE=='bind-retake':
        from services.recruit_interview_service import utcnow, record_interview_event
        from models.recruit_interview_attempt import RecruitInterviewQuestionRun
        receipt=json.loads((DATA/'retake-invites-private.json').read_text())
        assert len(receipt['results'])==10 and all(r['state']=='created' for r in receipt['results'])
        for row in receipt['results']:
            original=db.session.get(RecruitInterviewAttempt,row['id'])
            assert original.candidate_id==row['candidate_id'] and original.aural_interview_id==row['aural_interview_id']
            setup=original.setup_key+':local-voice-retest-2'
            newer=RecruitInterviewAttempt.query.filter_by(setup_key=setup).one_or_none()
            if newer is None:
                values={k:getattr(original,k) for k in ('candidate_id','application_no','position_id','position_name','position_source','position_confidence','position_snapshot','question_set_version','prompt_version')}
                newer=RecruitInterviewAttempt(**values,attempt_no=original.attempt_no+1,setup_key=setup,
                    correlation_id=setup,status='ready',stage='questions_ready',priority=5,
                    aural_interview_id=row['aural_interview_id'],aural_candidate_id=row['newAuralCandidateId'],
                    aural_invite_url='http://127.0.0.1:3300/i/invite/'+row['inviteToken'],question_count=8,
                    sync_status='waiting_for_session',next_sync_at=utcnow(),provider='zhipu',model='glm-5.3',
                    technical_metrics={'qa_voice_retest_of_attempt':original.id,'opening_generation_pending':False})
                db.session.add(newer);db.session.flush()
                questions=RecruitInterviewQuestionRun.query.filter_by(attempt_id=original.id).filter(RecruitInterviewQuestionRun.question_type!='follow_up').all()
                questions=[q for q in questions if q.question_type!='conversation' and 0<=q.question_index<8]
                assert len(questions)==8
                for q in questions:
                    fields={k:getattr(q,k) for k in ('question_id','question_index','question_type','question_text','normalized_hash','semantic_topic','coverage_tags')}
                    db.session.add(RecruitInterviewQuestionRun(attempt_id=newer.id,**fields))
                record_interview_event(newer,'local_qa_voice_retest_arranged',payload={'original_attempt_id':original.id,'new_resume_submission':False})
                db.session.commit()
            row['newHrAttemptId']=newer.id
        (DATA/'retake-bound-private.json').write_text(json.dumps(receipt),encoding='utf8')
        print(json.dumps({'boundRetakes':10,'newResumeSubmissions':0,'originalSessionsPreserved':True}))
    elif MODE in ('pause','resume'):
        from services.recruit_resume_processing_service import set_processing_paused
        print(json.dumps(set_processing_paused(paused=MODE=='pause',actor='local-acceptance',reason='Drain local worker before enabling shared GLM admission')))
    elif MODE=='init':
        assert RecruitCandidate.query.count()==0, 'existing_batch_cannot_be_reset'
        db.session.execute(db.text('PRAGMA journal_mode=WAL'))
        for name,skills in [('商务助理','订单核对、客户沟通、资料整理'),('运维工程师','系统维护、故障排查、监控与变更记录')]:
            if not RecruitPosition.query.filter_by(name=name).first():
                db.session.add(RecruitPosition(name=name,is_open=True,must_skills=skills,score_dims=skills,
                    overview='依据真实经历评估岗位匹配，所有面试回答为模拟测试，不代表简历持有人的实际能力。',
                    responsibilities=skills, requirements_must=skills,category='本地验收'))
        db.session.commit()
        token=issue_qa_run_token('local-acceptance','local-official-ten-20260915')
        (DATA/'qa-private.json').write_text(json.dumps(token),encoding='utf8')
        print(json.dumps({'initialized':True,'candidates':0,'positions':RecruitPosition.query.count(),'productionWrites':False}))
    elif MODE=='status':
        print(json.dumps({'candidates':RecruitCandidate.query.count(),
            'jobs':[{'id':j.id,'candidate':j.candidate_id,'status':j.status,'stage':j.stage,'error':j.error_code} for j in RecruitResumeProcessingJob.query.all()],
            'attempts':[{'id':a.id,'candidate':a.candidate_id,'status':a.status,'sync':a.sync_status,'session':a.aural_session_id} for a in RecruitInterviewAttempt.query.all()],
            'modelCalls':len(ledger.read_text().splitlines()) if ledger.exists() else 0}))
if MODE=='serve':
    from werkzeug.serving import make_server, WSGIRequestHandler
    class Quiet(WSGIRequestHandler):
        def log(self,*args,**kwargs): pass
    server=make_server('127.0.0.1',3301,app,threaded=True,request_handler=Quiet)
    print('LOCAL_TEN_HR_READY',flush=True)
    server.serve_forever()
elif MODE=='worker':
    import run_recruit_resume_worker
    sys.argv=['worker','--workers','1','--poll-seconds','2']
    raise SystemExit(run_recruit_resume_worker.main())
elif MODE=='opening':
    from run_recruit_resume_worker import run_interview_slot, stop_event
    timer=threading.Timer(20,stop_event.set)
    timer.start()
    try:
        run_interview_slot(app,slot=99,opening_only=True,once=False,poll_seconds=1)
    finally:
        timer.cancel()
