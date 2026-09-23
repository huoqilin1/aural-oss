"""Read/sync only. Real HR and local Aural receipts; no model regeneration."""
import contextlib,io,json,runpy,sys
from pathlib import Path
sys.argv=['local-ten-hr.py','status']
with contextlib.redirect_stdout(io.StringIO()):
    scope=runpy.run_path(str(Path(__file__).with_name('local-ten-hr.py')),run_name='local_ten_verifier')
app,root=scope['app'],scope['DATA']
from models import db
from models.recruit_candidate import RecruitCandidate
from models.recruit_interview_attempt import RecruitInterviewAttempt,RecruitInterviewQuestionRun
from services.recruit_interview_service import sync_interview_attempt_from_aural
rows=json.loads((root/'retake-bound-private.json').read_text(encoding='utf8'))['results']
results=[]
with app.app_context():
 for row in rows:
    attempt=db.session.get(RecruitInterviewAttempt,row['newHrAttemptId'])
    snapshot=root/(str(row['fixture'])+'.retake-report-private.json')
    if snapshot.exists():
        sync_interview_attempt_from_aural(attempt.id, refresh_completed=True)
        db.session.expire_all()
        attempt=db.session.get(RecruitInterviewAttempt,row['newHrAttemptId'])
    candidate=db.session.get(RecruitCandidate,attempt.candidate_id)
    questions=RecruitInterviewQuestionRun.query.filter_by(attempt_id=attempt.id).all()
    core=[q for q in questions if q.question_type not in ('follow_up','conversation') and 0<=q.question_index<8]
    assessment=candidate.ai_assessment or {}
    score=assessment.get('score_v2_1') or {}
    raw=candidate.aural_messages or []
    result={'fixture':row['fixture'],'attemptId':attempt.id,'status':attempt.status,'sync':attempt.sync_status,
       'coreQuestions':len(core),'answeredQuestions':sum(bool((q.answer_text or '').strip()) for q in core),
       'scoreKeys':list(score),'selectionDimensions':score.get('selection_dimensions'),
       'reportPending':(attempt.technical_metrics or {}).get('report_pending'),
       'leaseReleased':attempt.lease_owner is None,'rawMessageCount':len(raw)}
    # Store only technical score shape/counts, not evidence or personal text.
    dims=result.pop('selectionDimensions')
    result['dimensionsType']=type(dims).__name__
    result['dimensionsCount']=len(dims) if isinstance(dims,(list,dict)) else 0
    result['selectionComplete']=assessment.get('selection_report_status')=='complete'
    result['dimensionsValid']=isinstance(dims,dict) and set(dims)=={'position_fit','proven_ability','evidence_credibility','motivation_stability'} and all(
        isinstance(v,dict) and isinstance(v.get('score'),(int,float)) and 0<=v['score']<=v.get('max',-1)
        and bool(v.get('evidence')) and bool(v.get('supporting_question_numbers'))
        and all(isinstance(n,int) and 1<=n<=8 for n in v['supporting_question_numbers']) for v in dims.values())
    result['rawMessageKeys']=list(raw[0]) if isinstance(raw,list) and raw else []
    if snapshot.exists():
        expected=json.loads(snapshot.read_text(encoding='utf8'))
        result['summaryMatches']=candidate.ai_feedback==expected['session']['summary']
        result['reportFieldsMatch']=all(assessment.get(k)==expected['session'].get(k) for k in ('summary','insights','themes','sentiment'))
        by_id={m.get('id'):m for m in raw} if isinstance(raw,list) else {}
        result['rawAnswersMatch']=all(a['id'] in by_id and by_id[a['id']].get('content')==a['content'] for a in expected['answers'])
    results.append(result)
receipt={'scope':'local ten original-source voice retest HR reconciliation','results':results}
(root/'retake-hr-reconcile-receipt.json').write_text(json.dumps(receipt,ensure_ascii=False,indent=2),encoding='utf8')
print(json.dumps(receipt,ensure_ascii=False))
