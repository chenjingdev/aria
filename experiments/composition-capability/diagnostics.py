"""Secondary, descriptive musical diagnostics and deliberately degraded controls.
These are not an aesthetic pass/fail score or a claim of musical originality.
"""
import copy
import datetime
import json
import pathlib
import random
from evaluate import OUT, events, diagnose, to_render_song

def reprise(score):
    bars=score['voices'][0]['bars'];n=len(bars)
    if n<8:return None
    first=bars[:4]
    matches=[{'startBar':i+1,'equalBars':sum(a==b for a,b in zip(first,bars[i:i+4]))} for i in range(n//2,n-3)]
    return max(matches,key=lambda x:x['equalBars']) if matches else None

def alignment(score,shuffles=499):
    notes=events(score);melody=[n for n in notes if n['voice']==0];bass=[n for n in notes if n['voice']==1]
    if not melody or not bass:return None
    def active(note,t):
        start=(note['bar']-1)*4+note['beat']
        return start<=t+1e-7 and t<start+note['duration']-1e-7
    frames=[];crossed=0;both=0
    for bar in range(max(len(v['bars']) for v in score['voices'])):
        for beat in [0,2]:
            t=bar*4+beat
            ids=[i for i,n in enumerate(melody) if active(n,t)]
            low=[n['pitch'] for n in bass if active(n,t)]
            if len(ids)!=1 or not low:continue
            both+=1;crossed+=int(max(low)>=melody[ids[0]]['pitch'])
            if len(set(n%12 for n in low))>=2:frames.append((ids[0],set(n%12 for n in low)))
    if len(frames)<4:return {'eligibleChordFrames':len(frames),'note':'Too few simultaneous accompaniment chords; not scored','voiceCrossingFrames':crossed,'bothActiveFrames':both}
    pitches=[n['pitch'] for n in melody]
    ratio=lambda p:sum(p[i]%12 in chord for i,chord in frames)/len(frames)
    observed=ratio(pitches);null=[];rng=random.Random(9071)
    for _ in range(shuffles):
        shuffled=pitches.copy();rng.shuffle(shuffled);null.append(ratio(shuffled))
    return {'eligibleChordFrames':len(frames),'strongBeatChordMembership':observed,
            'shuffledMean':sum(null)/len(null),'shuffledPercentile':sum(x<observed for x in null)/len(null),
            'permutationTailFraction':(1+sum(x>=observed for x in null))/(len(null)+1),
            'voiceCrossingFrames':crossed,'bothActiveFrames':both,
            'note':'Non-chord tones and voice crossings can be intentional. This is a secondary descriptive comparison, not an aesthetic score.'}

def run():
    registration=OUT/'secondary-diagnostics-protocol.json'
    if not registration.exists():registration.write_text(json.dumps({
      'registeredAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
      'status':'Secondary exploratory diagnostics, designed after inspecting the first duet. Not part of primary formal-success criteria.',
      'alignment':'At quarter-beat positions 0 and 2, when one melody note and at least two accompaniment pitch classes sound, count melody membership in accompaniment pitch classes. Compare with 499 pitch-order shuffles preserving pitches, rhythm, and accompaniment.',
      'reprise':'Find exact first-four-melody-bar matches in the second half; a return can precede a coda.',
      'controls':'For the first complete duet, shuffle melody pitch order or loop its first bar. These intentionally altered controls are separate from model outputs.',
      'interpretation':'No aggregate music-quality score. Passing tones, harmonic tension, repetition, and voice crossing can be legitimate.'},indent=2))
    results=[];evaluation=json.loads((OUT/'evaluation.json').read_text())
    for row in evaluation:
        if row['kind']!='composition' or not row.get('parsed'):continue
        score=json.loads((OUT/'runs'/row['id']/'parsed-score.json').read_text())
        results.append({'id':row['id'],'reprise':reprise(score),'alignment':alignment(score)})
    (OUT/'musical-diagnostics.json').write_text(json.dumps(results,indent=2))
    secondary=[]
    for row in evaluation:
        if row['kind']!='reasoning_ablation' or not row.get('strictSuccess') or row.get('task')!='duet16':continue
        score=json.loads((OUT/'runs'/row['id']/'parsed-score.json').read_text())
        secondary.append({'id':row['id'],'kind':row['kind'],'reprise':reprise(score),'alignment':alignment(score)})
    for file in sorted((OUT/'normalizations').glob('*/evaluation.json')):
        row=json.loads(file.read_text())
        if not row.get('strictSuccess'):continue
        score=json.loads(file.with_name('parsed-score.json').read_text())
        secondary.append({'id':row['id'],'kind':'notation_normalization','reprise':reprise(score),'alignment':alignment(score)})
    if secondary:(OUT/'secondary-composition-diagnostics.json').write_text(json.dumps(secondary,indent=2))
    source=next((x for x in evaluation if x['id']=='duet16-json-101' and x.get('strictSuccess')),None)
    if source:
        original=json.loads((OUT/'runs'/source['id']/'parsed-score.json').read_text())
        controls=[]
        for kind in ['shuffled','loop']:
            score=copy.deepcopy(original);score['title']='Diagnostic control: '+kind
            if kind=='shuffled':
                melody=[e for b in score['voices'][0]['bars'] for e in b if e['pitches']]
                values=[e['pitches'] for e in melody];random.Random(9071).shuffle(values)
                for e,p in zip(melody,values):e['pitches']=p
            else:
                for v in score['voices']:v['bars']=[copy.deepcopy(v['bars'][0]) for _ in v['bars']]
            folder=OUT/'controls'/kind;folder.mkdir(parents=True,exist_ok=True)
            (folder/'parsed-score.json').write_text(json.dumps(score,indent=2))
            (folder/'render-song.json').write_text(json.dumps(to_render_song(score,'control-'+kind),indent=2))
            record={'id':'control-'+kind,'source':source['id'],'harnessAltered':True,**diagnose(score,{'bars':16,'voices':2}),'reprise':reprise(score),'alignment':alignment(score)}
            (folder/'evaluation.json').write_text(json.dumps(record,indent=2));controls.append(record)
        (OUT/'control-diagnostics.json').write_text(json.dumps(controls,indent=2))
    print(json.dumps(results,ensure_ascii=False,indent=2))

if __name__=='__main__':run()
