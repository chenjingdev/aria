"""Secondary compatibility probe: group explicit pitch/duration pairs only.
No missing note, beat or bar is invented. Primary scores remain unchanged.
"""
import copy
import hashlib
import json
from evaluate import OUT, midi, parse_json, diagnose, to_render_song, write_json

def number(x):return isinstance(x,(int,float)) and not isinstance(x,bool) and x>0
def pitch(x):
    if x=='R':return True
    try:
        if isinstance(x,list):return bool(x) and all(isinstance(n,str) and midi(n)>=0 for n in x)
        return isinstance(x,str) and midi(x)>=0
    except ValueError:return False
def event(x):return isinstance(x,list) and len(x)==2 and pitch(x[0]) and number(x[1])
def leaves(x):
    if isinstance(x,list):return [v for item in x for v in leaves(item)]
    return [x]

evaluation=json.loads((OUT/'evaluation.json').read_text());results=[]
for row in evaluation:
    if row['kind'] not in ['composition','extension','runtime_retry','reasoning_ablation'] or row['format']!='json' or row.get('parsed'):continue
    source=OUT/'runs'/row['id']/'result.json';result=json.loads(source.read_text())
    if result.get('error') or result.get('metadata',{}).get('done_reason')!='stop':continue
    record={'source':row['id'],'sourceSha256':hashlib.sha256(result['content'].encode()).hexdigest(),'primaryResultUnchanged':True,'rule':'Group alternating pitch/duration values within already declared bars; accept a single event as a one-event bar; no scalar values, bar boundaries or other fields changed.'}
    try:
        raw=json.loads(result['content']);normalized=copy.deepcopy(raw);changes=[]
        for vi,voice in enumerate(normalized['voices']):
            for bi,bar in enumerate(voice['bars']):
                if isinstance(bar,list) and all(event(e) for e in bar):continue
                if not isinstance(bar,list) or len(bar)%2:raise ValueError('Cannot unambiguously pair this bar')
                paired=[bar[i:i+2] for i in range(0,len(bar),2)]
                if not all(event(e) for e in paired):raise ValueError('Not a valid alternating pitch/duration list')
                assert leaves(bar)==leaves(paired)
                voice['bars'][bi]=paired;changes.append({'voice':vi+1,'bar':bi+1,'events':len(paired)})
        if not changes:raise ValueError('No applicable container normalization')
        for before,after in zip(raw['voices'],normalized['voices']):
            assert {k:v for k,v in before.items() if k!='bars'}=={k:v for k,v in after.items() if k!='bars'}
            assert len(before['bars'])==len(after['bars'])
            assert all(leaves(a)==leaves(b) for a,b in zip(before['bars'],after['bars']))
        assert {k:v for k,v in raw.items() if k!='voices'}=={k:v for k,v in normalized.items() if k!='voices'}
        score=parse_json(json.dumps(normalized));verdict=diagnose(score,result['job'])
        record.update({'changes':changes,'scalarContentPreserved':True,'verdict':verdict})
        folder=OUT/'normalizations'/row['id'];folder.mkdir(parents=True,exist_ok=True)
        write_json(folder/'score.json',normalized);write_json(folder/'audit.json',record)
        if verdict['strictSuccess']:
            identifier=row['id']+'-normalized'
            write_json(folder/'parsed-score.json',score);write_json(folder/'render-song.json',to_render_song(score,identifier))
            write_json(folder/'evaluation.json',{'id':identifier,'kind':'notation_normalization','folder':str(folder),'renderBars':max(verdict['voiceBars']),**verdict})
    except Exception as e:record['error']=str(e)
    results.append(record)
write_json(OUT/'notation-normalizations.json',results)
print(json.dumps([{k:r.get(k) for k in ['source','error','scalarContentPreserved']}|{'success':r.get('verdict',{}).get('strictSuccess'),'bars':r.get('verdict',{}).get('voiceBars')} for r in results],ensure_ascii=False))
