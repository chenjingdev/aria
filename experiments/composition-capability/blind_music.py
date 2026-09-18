"""Create anonymous canonical scores/audio; keep identities sealed until review."""
import copy
import datetime
import hashlib
import json
import os
from pathlib import Path
import random
import secrets

from evaluate import diagnose, note_name, to_render_song, write_json

ROOT=Path(__file__).resolve().parents[2]
OUT=Path(os.environ.get('MUSIC_QUALITY_OUT',str(ROOT/'output/music-quality-2026-09-06')))

def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()

def canonical(score,identifier,brief):
    lines=[f'## {identifier}',f'Brief: {brief}','C major; 4/4; quarter = 100. Durations below are quarter-note beats.',
           'bar | melody | accompaniment']
    def cell(events):
        return ' '.join(('R' if not e['pitches'] else '+'.join(note_name(p) for p in e['pitches']))+':'+str(e['duration']).removesuffix('.0') for e in events)
    for i in range(16):lines.append(f'{i+1:02d} | '+cell(score['voices'][0]['bars'][i])+' | '+cell(score['voices'][1]['bars'][i]))
    return '\n'.join(lines)

def canonical_grid(score,identifier,brief):
    from evaluate import midi
    voices=[]
    for voice in ['melody','accompaniment']:
        active='R';bars=[]
        for bar in score[voice]:
            segments=[]
            for step,slot in enumerate(bar):
                if slot=='_':
                    if step==0:segments.append(['~'+active if active!='R' else 'R',.5])
                    else:segments[-1][1]+=.5
                else:
                    active=slot if isinstance(slot,str) else '+'.join(sorted(slot,key=midi))
                    segments.append([active,.5])
            bars.append(' '.join(p+':'+str(d).removesuffix('.0') for p,d in segments))
        voices.append(bars)
    lines=[f'## {identifier}',f'Brief: {brief}','C major; 4/4; quarter = 100. Durations in quarter-note beats. ~ means a note held across the preceding bar line, not a new onset. R is silence.','bar | melody | accompaniment']
    for i in range(16):lines.append(f'{i+1:02d} | {voices[0][i]} | {voices[1][i]}')
    return '\n'.join(lines)

def build():
    if (OUT/'blinding-record.json').exists():print('Anonymous materials already committed');return
    protocol=json.loads((OUT/'protocol.json').read_text())
    grid='representation' in protocol
    if grid:
        from grid_quality import to_song,validate
    score_filename='grid-score.json' if grid else 'parsed-score.json'
    generation=json.loads((OUT/'generation.json').read_text())
    complete=sorted([r for r in generation if r['chosen']],key=lambda r:r['key'])
    if not complete:raise RuntimeError('No complete scores to assess')
    seed=secrets.randbits(128);rng=random.Random(seed)
    control_sources=complete.copy();rng.shuffle(control_sources)
    items=[]
    for record in complete:
        score=json.loads((Path(record['chosen'])/score_filename).read_text())
        items.append({'kind':'original','source':record['key'],'brief':record['brief'],'score':score})
    # Random source order is sealed with the assignment seed. No aesthetic selection.
    for kind,index in [('loop',0),('shuffle',len(complete)-1),('duplicate',len(complete)//2)]:
        record=control_sources[index];score=json.loads((Path(record['chosen'])/score_filename).read_text());score=copy.deepcopy(score)
        if kind=='loop':
            if grid:
                for voice in ['melody','accompaniment']:score[voice]=[copy.deepcopy(score[voice][0]) for _ in range(16)]
            else:
                for voice in score['voices']:voice['bars']=[copy.deepcopy(voice['bars'][0]) for _ in range(16)]
        elif kind=='shuffle':
            if grid:
                indices=[(bi,si) for bi,b in enumerate(score['melody']) for si,e in enumerate(b) if e not in ['R','_']]
                values=[score['melody'][bi][si] for bi,si in indices];random.Random(4290).shuffle(values)
                for (bi,si),value in zip(indices,values):score['melody'][bi][si]=value
            else:
                events=[e for b in score['voices'][0]['bars'] for e in b if e['pitches']]
                values=[e['pitches'] for e in events];random.Random(4290).shuffle(values)
                for event,value in zip(events,values):event['pitches']=value
        items.append({'kind':kind,'source':record['key'],'brief':record['brief'],'score':score})
    rng.shuffle(items)
    private=OUT/'private';private.mkdir(exist_ok=True)
    public=OUT/'public';public.mkdir(exist_ok=True)
    mapping=[];evaluations=[];packets=[];original_ids={}
    for i,item in enumerate(items,1):
        identifier=f'S{i:02d}';score=item['score']
        if not grid:
            score['title']=identifier
            for j,voice in enumerate(score['voices']):voice['name']=['melody','accompaniment'][j]
        folder=OUT/'anonymous'/identifier;folder.mkdir(parents=True,exist_ok=True)
        write_json(folder/score_filename,score)
        song=to_song(score,identifier) if grid else to_render_song(score,identifier);song['tracks'][1]['volume']=.45
        write_json(folder/'render-song.json',song)
        if grid:
            validate(score)
            verdict={'parsed':True,'strictSuccess':True,'voiceBars':[16,16],'notes':sum(len(t['notes']) for t in song['tracks'])}
        else:verdict=diagnose(score,{'bars':16,'voices':2});assert verdict['strictSuccess']
        evaluations.append({'id':identifier,'kind':'anonymous_score','folder':str(folder),'renderBars':16,**verdict})
        packets.append((canonical_grid if grid else canonical)(score,identifier,protocol['briefs'][item['brief']]))
        mapping.append({'id':identifier,'kind':item['kind'],'source':item['source'],'brief':item['brief']})
        if item['kind']=='original':original_ids[item['source']]=identifier
    write_json(private/'mapping.json',mapping);write_json(private/'randomization.json',{'seed':seed})
    write_json(OUT/'evaluation.json',evaluations)
    packet_dir=OUT/'review-packets';packet_dir.mkdir(exist_ok=True)
    packet_paths=[]
    for i in range(0,len(packets),5):
        file=packet_dir/f'batch-{i//5+1}.txt';file.write_text('\n\n'.join(packets[i:i+5])+'\n');packet_paths.append(file)
    pairs=[]
    for brief in protocol['briefs']:
        for trial in protocol['seeds']:
            keys=[f'{host}-{brief}-{trial}' for host in ['mac','amd']]
            if not all(k in original_ids for k in keys):continue
            ids=[original_ids[k] for k in keys];rng.shuffle(ids)
            pairs.append({'id':f'P{len(pairs)+1:02d}','brief':brief,'trial':trial,'A':ids[0],'B':ids[1]})
    write_json(public/'pairs.json',pairs)
    write_json(OUT/'blinding-record.json',{'createdAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
      'generationSha256':digest(OUT/'generation.json'),'protocolSha256':digest(OUT/'protocol.json'),
      'mappingSha256':digest(private/'mapping.json'),'packetSha256':{p.name:digest(p) for p in packet_paths},
      'originals':len(complete),'anonymousScores':len(items),'completePairs':len(pairs),
      'unblindingRule':'Do not inspect private mapping or original source scores until all anonymous ratings are saved and hashed.'})
    print(json.dumps({'anonymousScores':len(items),'completePairs':len(pairs),'packets':[p.name for p in packet_paths]}))

if __name__=='__main__':build()
