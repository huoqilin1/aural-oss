"""Actual HR model control HTTP routes, dedicated SQLite and no remote network."""
import json,os,sys,socket
from pathlib import Path
root=Path(__file__).resolve().parents[1]
runtime=root/'output/local-sandbox/real-report'
fixture_name=os.environ.get('LOCAL_REPORT_FIXTURE_NAME','fixture-private.json')
if fixture_name not in ('fixture-private.json','live-fixture-private.json','offline-pilot-private.json'): raise RuntimeError('invalid_local_fixture_name')
fixture=json.loads((runtime/fixture_name).read_text())
keep={k:v for k,v in os.environ.items() if k.upper() in {'PATH','SYSTEMROOT','WINDIR','TEMP','TMP','COMSPEC','PATHEXT','USERPROFILE'}}
os.environ.clear();os.environ.update(keep)
os.environ.update(OPRUN_LOAD_DOTENV='false',OPRUN_HR_ENV_NAME='local',OPRUN_HR_DATA_ROOT=str(runtime),OPRUN_DATA_ROOT=str(runtime),DATABASE_URL='sqlite:///'+str(runtime/'control.sqlite'),OPRUN_HR_AUTO_CREATE_SCHEMA='1',SECRET_KEY='local-report-hr',JWT_SECRET_KEY='local-report-jwt',OPRUN_OUTBOUND_MODE='record_only',AURAL_API_KEY='',AURAL_API_BASE='http://127.0.0.1:3300/api/v1',AURAL_PUBLIC_BASE='http://127.0.0.1:3300',REDIS_URL='redis://127.0.0.1:9/0',HR_MODEL_CONTROL_SECRET='local-report-control',RECRUIT_GLM_ONLY='1')
local_api_key=runtime/'reconcile-key-private.json'
if local_api_key.exists():
    os.environ['AURAL_API_KEY']=json.loads(local_api_key.read_text())['key']
os.environ['AURAL_MAX_CONCURRENCY']='10'
native=socket.socket.connect
def local_connect(sock,address):
    if not isinstance(address,tuple) or address[0] not in ('127.0.0.1','::1'): raise RuntimeError('non_loopback_blocked')
    return native(sock,address)
socket.socket.connect=local_connect
sys.path.insert(0,'D:/GGGG/kiro/oprun-hr-quality-release/backend')
from app import app
from models import db
from models.recruit_candidate import RecruitCandidate
from models.recruit_interview_attempt import RecruitInterviewAttempt
from werkzeug.serving import make_server,WSGIRequestHandler
class Quiet(WSGIRequestHandler):
    def log(self,*args,**kwargs):pass
with app.app_context():
    db.create_all()
    setup_key='local-report-'+fixture['sessionId']
    attempt=RecruitInterviewAttempt.query.filter_by(setup_key=setup_key).one_or_none()
    if attempt is None:
        candidate=RecruitCandidate(name='Synthetic local report',resume_text='Synthetic acceptance only')
        db.session.add(candidate);db.session.flush()
        attempt=RecruitInterviewAttempt(candidate_id=candidate.id,setup_key=setup_key,correlation_id=fixture['sessionId'],aural_interview_id=fixture['interviewId'],aural_session_id=fixture['sessionId'],status='completed')
        db.session.add(attempt);db.session.commit()
    elif (attempt.aural_session_id != fixture['sessionId'] or
          attempt.aural_interview_id != fixture['interviewId']):
        raise RuntimeError('existing_local_fixture_identity_mismatch')
if __name__ == '__main__':
    server=make_server('127.0.0.1',3301,app,request_handler=Quiet)
    print(json.dumps({'ready':True,'port':3301,'actualHrRoutes':True,'productionWrites':False}),flush=True)
    try:server.serve_forever()
    finally:server.server_close()
