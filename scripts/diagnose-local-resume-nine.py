"""One authorized retry of the malformed-JSON job; retain private failure bytes."""
import sys,runpy,json,hashlib,contextlib,io
from pathlib import Path
sys.argv=['local-ten-hr.py','diagnostic']
with contextlib.redirect_stdout(io.StringIO()):
    scope=runpy.run_path(str(Path(__file__).with_name('local-ten-hr.py')),run_name='diagnostic_fixture')
root=scope['DATA'];guard=root/'resume-nine-diagnostic-guard.json'
assert not guard.exists(),'Inspect existing diagnostic before any replay'
from models import db
from models.hr_model_execution import HrModelFailure
from models.recruit_resume_processing_job import RecruitResumeProcessingJob
from services.hr_model_failure_service import act_on_failure
from services.recruit_resume_processing_service import process_claimed_job,processing_paused
from agents import llm_provider
original=llm_provider._parse_llm_json_response
def capture(text,*args,**kwargs):
    result=original(text,*args,**kwargs)
    if result is None and isinstance(text,str):
        sha=hashlib.sha256(text.encode()).hexdigest()
        (root/('resume-nine-invalid-'+sha+'.private.txt')).write_text(text,encoding='utf8')
        print(json.dumps({'invalidResponseRetained':True,'sha256':sha,'characters':len(text)}),flush=True)
    return result
llm_provider._parse_llm_json_response=capture
with scope['app'].app_context():
    assert processing_paused(),'Original local worker must not concurrently claim this job'
    job=db.session.get(RecruitResumeProcessingJob,9)
    failure=db.session.get(HrModelFailure,'resume:9')
    assert job.status=='blocked_provider' and failure.state=='unconfirmed'
    assert len(failure.attempts)==1 and failure.attempts[0]['error']=='empty_or_invalid_response'
    assert failure.attempts[0].get('response_diagnostics',{}).get('json_parse_status')=='invalid_json_or_type'
    guard.write_text(json.dumps({'job':9,'scope':'Only malformed JSON stage; reuse successful extraction checkpoint','state':'starting'}),encoding='utf8')
    act_on_failure('resume:9','acknowledge','local-acceptance')
    act_on_failure('resume:9','retry','local-acceptance')
    db.session.expire_all();job=db.session.get(RecruitResumeProcessingJob,9)
    assert job.status in ('queued','retry_wait') and job.lease_owner is None
    job.lease_owner='local-resume-nine-diagnostic';db.session.commit()
    result=process_claimed_job(9)
    guard.write_text(json.dumps({'job':9,'state':'finished','result':result}),encoding='utf8')
    print(json.dumps(result),flush=True)
