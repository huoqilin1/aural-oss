import json,re,sqlite3,difflib
from pathlib import Path
root=Path('output/local-sandbox/official-ten-20260915')
cases=json.loads(Path('D:/GGGG/kiro/oprun-hr-main-wt/.artifacts/acceptance-20260907/fixtures/cases.json').read_text(encoding='utf-8-sig'))
by_index={x['index']:x for x in cases}
rows=json.loads((root/'retake-bound-private.json').read_text(encoding='utf8'))['results']
c=sqlite3.connect(root/'hr.sqlite')
norm=lambda s: re.sub(r'[^\w\u4e00-\u9fff]','',s).lower()
results=[]
for row in rows:
    snapshot=json.loads((root/(str(row['fixture'])+'.retake-report-private.json')).read_text(encoding='utf8'))
    question_ids=dict(c.execute("select question_id,question_index from recruit_interview_question_runs where attempt_id=? and question_type not in ('follow_up','conversation') and question_index between 0 and 7",(row['newHrAttemptId'],)))
    case=by_index[row['fixture']]
    for qid,index in question_ids.items():
        expected=norm(case['answers'][index]);actuals=[norm(x['content']) for x in snapshot['answers'] if x['questionId']==qid]
        ratio=max((difflib.SequenceMatcher(None,expected,text,autojunk=False).ratio() for text in actuals),default=0)
        results.append({'fixture':row['fixture'],'question':index+1,'charSimilarity':round(ratio,4),'asrMessages':len(actuals)})
(root/'retake-asr-similarity.json').write_text(json.dumps({'scope':'Synthetic local TTS source versus real ASR transcript; diagnostic only, not a substitute for semantic review','results':results},indent=2),encoding='utf8')
print(json.dumps({'questions':len(results),'minimumSimilarity':min(x['charSimilarity'] for x in results),'below80Percent':[x for x in results if x['charSimilarity']<.8]}))
