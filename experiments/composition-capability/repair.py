"""One secondary notation-only repair, preserving the first-pass failure."""
import datetime
import json
import time
from run import OUT,run
from evaluate import evaluate_all

protocol={'registeredAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
          'status':'Adaptive secondary test after observing R4 in a pitch field; not pooled with primary success rate',
          'question':'Can precise notation feedback repair the score without composing or changing sounding notes?',
          'toolsProvided':False,'source':'melody8-json-303'}
file=OUT/'repair-protocol.json'
if not file.exists():file.write_text(json.dumps(protocol,indent=2))
while not (OUT/'extensions-decisions.json').exists():time.sleep(2)
source=json.loads((OUT/'runs'/protocol['source']/'result.json').read_text())
feedback='Your score uses "R4" in a pitch field, but the requested notation uses "R" for a rest. Correct only this notation error. Preserve every sounding pitch, duration, bar, voice, tempo and all other score contents. Return the corrected JSON score only.'
job={'id':'repair-rest-json-303','kind':'repair','task':'notation-repair','format':'json','seed':303,'temperature':0,'bars':8,'voices':1,
     'prompt':feedback,'messages':[{'role':'user','content':source['job']['prompt']},{'role':'assistant','content':source['content']},{'role':'user','content':feedback}]}
run(job);evaluate_all()
fixed=json.loads((OUT/'runs'/job['id']/'result.json').read_text())
try:
    expected=json.loads(source['content'])
    replacements=0
    for voice in expected['voices']:
        for bar in voice['bars']:
            for event in bar:
                if event[0]=='R4':event[0]='R';replacements+=1
    actual=json.loads(fixed['content'])
    result={'restTokensCorrected':replacements,'allOtherScoreContentPreserved':expected==actual}
except Exception as e:result={'error':str(e)}
(OUT/'repair-result.json').write_text(json.dumps(result,indent=2))
print(result,flush=True)
