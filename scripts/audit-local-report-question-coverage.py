import json,re,sqlite3,difflib
from pathlib import Path
root=Path('output/local-sandbox/official-ten-20260915');c=sqlite3.connect(root/'hr.sqlite')
rows=json.loads((root/'retake-bound-private.json').read_text(encoding='utf8'))['results']
results=[]
norm=lambda s:re.sub(r'[^\w\u4e00-\u9fff]','',s).lower()
for row in rows:
    report=json.loads((root/(str(row['fixture'])+'.retake-report-private.json')).read_text(encoding='utf8'))
    raw=report['session']['insights']['questionEvaluations'];evaluations=raw if isinstance(raw,list) else raw['items']
    questions=list(c.execute("select question_index,question_text from recruit_interview_question_runs where attempt_id=? and question_type not in ('follow_up','conversation') order by question_index",(row['newHrAttemptId'],)))
    mappings=[]
    for entry in evaluations:
        text=entry['question'];explicit=re.match(r'^\s*(?:[Qq]\s*([1-9])|第\s*([1-9一二三四五六七八九])\s*题)',text)
        if explicit:
            v=explicit.group(1) or explicit.group(2);number=int(v) if v.isdigit() else '一二三四五六七八九'.index(v)+1
            mappings.append({'questionNumber':number,'method':'explicit_number'})
        else:
            comparisons=[(difflib.SequenceMatcher(None,norm(text),norm(q),autojunk=False).ratio(),i) for i,q in questions]
            ratio,index=max(comparisons)
            mappings.append({'questionNumber':index+1,'similarity':round(ratio,3),'method':'text_comparison'})
    results.append({'fixture':row['fixture'],'mappedNumbers':[x['questionNumber'] for x in mappings],'mappings':mappings})
(root/'report-question-coverage-audit.json').write_text(json.dumps({'scope':'Report question identity diagnostic, not semantic score accuracy','results':results},indent=2),encoding='utf8')
print(json.dumps({'results':results}))
