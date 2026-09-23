"""Cache eighty distinct existing synthetic answers using only local offline TTS."""
import json, hashlib, time
from pathlib import Path
import requests
root=Path(__file__).resolve().parents[1]
out=root/'output/local-sandbox/official-ten-20260915/audio'
out.mkdir(exist_ok=True)
fixtures=json.loads(Path('D:/GGGG/kiro/oprun-hr-main-wt/.artifacts/acceptance-20260907/fixtures/cases.json').read_text(encoding='utf8'))
fixtures=[x for x in fixtures if 131<=x['index']<=140]
assert len(fixtures)==10 and all(x['synthetic'] and len(x['answers'])==8 for x in fixtures)
for q in range(8):
    for f in fixtures:
        name=f"{f['index']}-{q+1}"
        text='以下是模拟测试回答。'+f['answers'][q]
        digest=hashlib.sha256(text.encode()).hexdigest()
        wav=out/(name+'.wav'); meta=out/(name+'.json')
        if wav.exists() and meta.exists():
            assert json.loads(meta.read_text())['textSha256']==digest
            continue
        r=requests.post('http://127.0.0.1:5211/tts',json={'text':text},timeout=180)
        r.raise_for_status()
        assert r.content[:4]==b'RIFF'
        wav.write_bytes(r.content)
        meta.write_text(json.dumps({'index':f['index'],'question':q+1,'textSha256':digest,'bytes':len(r.content),'paidRequests':0}))
    print(json.dumps({'question':q+1,'cached':10,'paidRequests':0}),flush=True)
