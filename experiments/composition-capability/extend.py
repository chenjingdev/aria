"""Separately labelled Korean transfer and length extension after the primary suite."""
import datetime
import json
import time
from run import OUT, TASKS, JSON_FORMAT, run
from evaluate import evaluate_all

KOREAN='''눈 내린 크리스마스 마을의 따뜻하고 밝고 장난스러운 분위기로, 새로운 8마디 피아노 선율을 작곡해 줘.
4/4박자, C장조, 4분음표 기준 분당 100박으로 정확히 8마디를 써 줘. 흥얼거릴 수 있는 선율로 만들고 끝에는 분명한 마무리감을 줘.
단선율 한 성부만 쓰고 반주는 넣지 마. 기존 곡을 인용하지 마.
JSON 악보만 출력해. 필드는 title, bpm, meter, key, voices이고 bpm은 100, meter는 [4,4], key는 "C major"야.
voices는 name과 bars를 가진 객체들의 배열이야. 각 마디는 이벤트들의 배열이고, 이벤트는 [음높이, 4분음표 기준 박 수]야.
음높이는 "C4" 같은 음이름, 쉼표는 "R"이야. 4분음표는 1박, 8분음표는 0.5박이며 각 마디의 길이 합은 쉼표를 포함해 4박이야.
반복 기호 없이 모든 마디와 음을 직접 써 줘. 프로그램 코드나 악보를 만드는 방법은 출력하지 마.'''

registration={'registeredAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
 'status':'Conditional secondary tests; not pooled with the primary English suite',
 'language':'Run the matched Korean eight-bar JSON prompt at seeds 101/202/303 if at least 2/3 primary melody JSON scores pass formal checks.',
 'length':'Run one 32-bar two-voice JSON score at seed 101 if at least 2/3 primary 16-bar JSON scores pass. A length-capped response may be retried once at 16384 tokens as a separate result.',
 'toolsProvided':False}
file=OUT/'extensions-protocol.json'
if not file.exists():file.write_text(json.dumps(registration,ensure_ascii=False,indent=2))
primary=json.loads((OUT/'protocol.json').read_text())['jobs']
print('Waiting for primary suite to finish',flush=True)
while any(not (OUT/'runs'/j['id']/'result.json').exists() for j in primary):time.sleep(2)
evaluate_all()
evaluation=json.loads((OUT/'evaluation.json').read_text())
def passed(task):return sum(x.get('strictSuccess',False) for x in evaluation if x['kind']=='composition' and x['task']==task and x['format']=='json')
decisions={}
if passed('melody8')>=2:
    decisions['korean']='run'
    for seed in [101,202,303]:run(dict(id=f'korean-melody8-json-{seed}',kind='extension',task='korean-melody8',format='json',seed=seed,temperature=1,bars=8,voices=1,prompt=KOREAN))
else:decisions['korean']='skipped: fewer than 2/3 primary melody JSON passes'
if passed('duet16')>=2:
    decisions['length']='run'
    prompt=TASKS['duet16'].replace('sixteen-bar','thirty-two-bar').replace('16 bars','32 bars')+'\n\n'+JSON_FORMAT
    job=dict(id='long32-json-101',kind='extension',task='long32',format='json',seed=101,temperature=1,bars=32,voices=2,prompt=prompt)
    run(job)
    result=json.loads((OUT/'runs'/job['id']/'result.json').read_text())
    if result['metadata'].get('done_reason')=='length':
        run({**job,'id':'long32-json-101-budget16384','num_predict':16384,'timeout':900})
else:decisions['length']='skipped: fewer than 2/3 primary duet JSON passes'
(OUT/'extensions-decisions.json').write_text(json.dumps(decisions,indent=2))
evaluate_all()
