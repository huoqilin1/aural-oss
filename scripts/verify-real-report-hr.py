"""Invoke the actual HR polling worker against the real local Aural HTTP API."""
import json,runpy,re
from pathlib import Path
scope=runpy.run_path(str(Path(__file__).with_name('serve-real-report-control.py')),run_name='local_report_fixture')
app,fixture,runtime=scope['app'],scope['fixture'],scope['runtime']
offline_pilot = scope['fixture_name'] == 'offline-pilot-private.json'
prefix='offline-pilot-' if offline_pilot else ('live-' if scope['fixture_name'].startswith('live-') else '')
from models import db
from models.recruit_candidate import RecruitCandidate
from models.recruit_interview_attempt import RecruitInterviewAttempt,RecruitInterviewQuestionRun
from models.hr_model_usage import HrModelUsage
from models.hr_model_execution import HrModelTask
from services.recruit_interview_service import sync_interview_attempt_from_aural
with app.app_context():
    attempt=RecruitInterviewAttempt.query.filter_by(setup_key='local-report-'+fixture['sessionId']).one()
    attempt_id=attempt.id
    result=sync_interview_attempt_from_aural(attempt_id)
    db.session.expire_all()
    attempt=db.session.get(RecruitInterviewAttempt,attempt_id)
    candidate=db.session.get(RecruitCandidate,attempt.candidate_id)
    expected=json.loads((runtime/(prefix+'persisted-report.json')).read_text(encoding='utf-8'))
    from modules.flexwork.integrations import aural_client
    remote=aural_client.get_session(fixture['sessionId'])
    assert remote['summary']==expected['session']['summary'], 'Fresh Aural HTTP report mismatch'
    answers=RecruitInterviewQuestionRun.query.filter_by(attempt_id=attempt.id).all()
    answered=[row for row in answers if (row.answer_text or '').strip()]
    report_scene = 'interview.voice_report' if offline_pilot else 'interview.summary_report'
    usage=HrModelUsage.query.filter_by(scene=report_scene).all()
    log_path = 'output/offline-only-next-20260915.log' if offline_pilot else ('output/real-report-final-next-20260915.log' if prefix else 'output/real-report-next-auth-fixed-20260915.log')
    model_log=Path(log_path).read_text(encoding='utf8')
    current_tokens=re.findall(r'stage='+re.escape(report_scene)+r' .*model=(\S+) tokens_in=(\d+) tokens_out=(\d+)',model_log)[-1]
    current_usage_matches=any(row.status=='success' and row.model==current_tokens[0] and row.input_tokens==int(current_tokens[1]) and row.output_tokens==int(current_tokens[2]) for row in usage)
    task=db.session.get(HrModelTask,'aural:'+str(attempt.id))
    expected_by_question={}
    for row in expected['answers']:
        expected_by_question.setdefault(row['questionId'],[]).append(row['content'])
    receipt={'sync':result,'summaryMatches':candidate.ai_feedback==expected['session']['summary'],
        'reportFieldsMatch':all((candidate.ai_assessment or {}).get(key)==expected['session'].get(key) for key in ('summary','insights','themes','sentiment')),
        'answeredQuestions':len(answered),'answersMatch':sorted(row.answer_text for row in answered)==sorted('\n'.join(parts) for parts in expected_by_question.values()),
        'usage':[{'model':row.model,'status':row.status,'inputTokens':row.input_tokens,'outputTokens':row.output_tokens} for row in usage],
        'taskState':task.state if task else None,'reportPending':(attempt.technical_metrics or {}).get('report_pending'),
        'actualAuralHttp':True,'fullInterviewPageCompleted':bool(prefix),'currentReportUsageMatches':current_usage_matches}
    (runtime/(prefix+'hr-reconcile-receipt.json')).write_text(json.dumps(receipt,ensure_ascii=False,indent=2),encoding='utf8')
    print(json.dumps(receipt,ensure_ascii=False),flush=True)
    assert receipt['summaryMatches'] and receipt['reportFieldsMatch'], 'HR report mismatch'
    assert receipt['answeredQuestions']==8 and receipt['answersMatch'], 'HR answers mismatch'
    assert receipt['currentReportUsageMatches'], 'Missing current real model usage receipt'
    assert task and task.state=='active' and receipt['reportPending'] is False, 'HR task/report state mismatch'
