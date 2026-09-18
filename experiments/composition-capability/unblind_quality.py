"""Verify committed anonymous reviews, then disclose models and control checks."""
import hashlib
import json
from pathlib import Path
import statistics

ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'output/music-quality-grid-2026-09-06'
CRITERIA=['melody','harmony','form','rhythm']
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()

def run():
    commitment=json.loads((OUT/'rating-commitment.json').read_text())
    assert commitment['ratingsSha256']==sha(OUT/'anonymous-ratings.json')
    blind=json.loads((OUT/'blinding-record.json').read_text())
    assert blind['mappingSha256']==sha(OUT/'private/mapping.json')
    for name,value in blind['packetSha256'].items():assert sha(OUT/'review-packets'/name)==value
    ratings=json.loads((OUT/'anonymous-ratings.json').read_text());by_id={r['id']:r for r in ratings}
    assert len(by_id)==len(ratings)==blind['anonymousScores']
    for row in ratings:
        assert all(isinstance(row[k],int) and 0<=row[k]<=5 for k in CRITERIA)
        row['total']=sum(row[k] for k in CRITERIA)
    mapping=json.loads((OUT/'private/mapping.json').read_text())
    assert set(by_id)=={m['id'] for m in mapping}
    generation={r['key']:r for r in json.loads((OUT/'generation.json').read_text())}
    originals=[];source_ids={}
    for item in mapping:
        if item['kind']!='original':continue
        source=generation[item['source']]
        originals.append({**by_id[item['id']],'model':source['model'],'brief':source['brief'],'seed':source['seed'],'source':source['key']})
        source_ids[item['source']]=item['id']
    checks=[]
    for item in mapping:
        if item['kind']=='original':continue
        row=by_id[item['id']];reference=by_id[source_ids[item['source']]]
        result={'id':item['id'],'kind':item['kind'],'sourceId':reference['id'],'total':row['total'],'sourceTotal':reference['total']}
        if item['kind']=='loop':
            result['informative']=reference['form']>=2
            result['passed']=reference['form']-row['form']>=2 and row['total']<reference['total'] if result['informative'] else None
        elif item['kind']=='shuffle':result['passed']=reference['melody']+reference['harmony']-row['melody']-row['harmony']>=2 and row['total']<reference['total']
        else:result['passed']=abs(row['total']-reference['total'])<=2 and all(abs(row[k]-reference[k])<=1 for k in CRITERIA)
        checks.append(result)
    models=sorted({r['model'] for r in originals});means={}
    for model in models:
        rows=[r for r in originals if r['model']==model]
        means[model]={'n':len(rows),**{k:statistics.mean(r[k] for r in rows) for k in CRITERIA+['total']}}
    pairs=[]
    for brief in ['lanterns','snowfall','toyshop']:
        for seed in [701,907]:
            rows=[r for r in originals if r['brief']==brief and r['seed']==seed]
            if len(rows)!=2:continue
            rows.sort(key=lambda r:r['model'])
            winner='tie' if rows[0]['total']==rows[1]['total'] else max(rows,key=lambda r:r['total'])['model']
            pairs.append({'brief':brief,'seed':seed,'rows':rows,'winner':winner})
    result={'assessor':'One model-label-blind AI score reader; not a human listening panel','ratingsCommitmentVerified':True,
            'means':means,'pairs':pairs,'controls':checks,'originals':originals,
            'allControlChecksPassed':all(c.get('passed') is True for c in checks),
            'humanListeningVotes':len(list((OUT/'listener-ratings').glob('*.json')))}
    (OUT/'unblinded-results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
    print(json.dumps({'means':means,'pairedWinners':[p['winner'] for p in pairs],'controls':checks},ensure_ascii=False,indent=2))

if __name__=='__main__':run()
