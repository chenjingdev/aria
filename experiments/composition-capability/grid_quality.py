"""Separate controlled experiment: musical choices on an identical 8th-note grid."""
import concurrent.futures
import datetime
import json
from pathlib import Path
import shutil

import music_quality as mq
from evaluate import clean, midi, note_name, write_json

ROOT=mq.ROOT
OUT=ROOT/'output/music-quality-grid-2026-09-06'
PRIOR=ROOT/'output/music-quality-2026-09-06'
mq.OUT=OUT
mq.MODEL_SPECS[0]['think']='low'

MELODY=[note_name(n) for n in range(60,85)]
BASS=[note_name(n) for n in range(36,60)]
def array(item,length):return {'type':'array','items':item,'minItems':length,'maxItems':length}
SCHEMA={'type':'object','properties':{
 'melody':array(array({'type':'string','enum':MELODY+['R','_']},8),16),
 'accompaniment':array(array({'anyOf':[{'type':'string','enum':['R','_']},{'type':'array','items':{'type':'string','enum':BASS},'minItems':1,'maxItems':3}]},8),16)},
 'required':['melody','accompaniment'],'additionalProperties':False}
INSTRUCTIONS='''Compose a new 16-bar piano miniature in C major, 4/4, quarter note = 100. Create a memorable opening, develop it, contrast it in the middle, and bring it back with a convincing ending. Choose your own melody, harmony, rhythm and rests. Do not quote an existing song.
Use the supplied JSON schema: melody and accompaniment each have 16 bars; each bar has 8 eighth-note slots. In melody, a note name starts a note, "_" sustains the previous sound for another eighth, and "R" begins silence. In accompaniment, an array of 1 to 3 note names starts those notes together; "_" sustains them and "R" begins silence. Holds may cross bars; the initial state is silence. Repeated note names rearticulate. Choose melody notes from C4 to C6 and accompaniment notes from C2 to B3, with suitable register and voice leading.
For notation only: ["C5","_","D5","_","E5","_","_","_"] is one bar of quarter C5, quarter D5, half E5. This is only an example; compose your own music. Return the JSON score only.'''

def validate(raw):
    assert isinstance(raw,dict) and set(raw)=={'melody','accompaniment'}
    for voice,allowed in [('melody',MELODY),('accompaniment',BASS)]:
        assert len(raw[voice])==16
        for bar in raw[voice]:
            assert isinstance(bar,list) and len(bar)==8
            for event in bar:
                if event in ['R','_']:continue
                if voice=='melody':assert isinstance(event,str) and event in allowed
                else:assert isinstance(event,list) and 1<=len(event)<=3 and all(p in allowed for p in event)

def to_song(raw,identifier):
    tracks=[]
    for vi,voice in enumerate(['melody','accompaniment']):
        notes=[];active=[]
        for index,slot in enumerate(event for bar in raw[voice] for event in bar):
            if slot=='_':
                for note in active:note['dur']+=.5
            else:
                active=[]
                if slot!='R':
                    pitches=[slot] if isinstance(slot,str) else slot
                    for pitch in pitches:
                        note={'bar':index//8+1,'beat':(index%8)*.5,'pitch':pitch,'dur':.5,'vel':80}
                        notes.append(note);active.append(note)
        tracks.append({'name':voice,'preset':'sf-piano-gm','seed':1,'volume':.7 if vi==0 else .45,'pan':0,'velRange':1,'reverb':.08,'notes':notes})
    return {'title':identifier,'bpm':100,'timeSig':[4,4],'tempoMap':[],'sections':[],'feedback':[],'tracks':tracks}

def protocol():
    OUT.mkdir(parents=True,exist_ok=True)
    prior=json.loads((PRIOR/'protocol.json').read_text())
    p={k:v for k,v in prior.items() if k not in ['registeredAt','scoreInstructions','formatHandling','models']}
    p.update({'registeredAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'representation':'fixed eighth-note grid with explicit pitches/chords, holds and rests',
      'scoreInstructions':INSTRUCTIONS,'schema':SCHEMA,
      'models':[{k:v for k,v in spec.items() if k!='url'} for spec in mq.MODEL_SPECS],
      'formatHandling':'Constrained JSON grammar fixes exactly 16 bars and eight slots per bar. No supplied melody, harmony progression or rhythm beyond the grid. The model chooses every onset, hold and rest. One retry is allowed only for transport/parse/schema failure and is disclosed. All musical content is retained, including weak or repetitive music.',
      'changeFromPrior':'The free ABC comparison was superseded because notation failures again obstructed musical evaluation. This is a separately registered constrained task, not a rescore of that trial. GPT-OSS uses low reasoning and Qwen no reasoning as practical configurations; this is not an isolated weights-only comparison.',
      'limits':'Fixed tempo, register bounds, eighth-note resolution and at most three simultaneous accompaniment notes. This assesses musical choice under those constraints, not unrestricted composition or orchestration.'})
    file=OUT/'protocol.json'
    if file.exists():
        old=json.loads(file.read_text());p['registeredAt']=old['registeredAt'];assert p==old
    else:write_json(file,p)
    if not (OUT/'tunnel.json').exists():shutil.copyfile(PRIOR/'tunnel.json',OUT/'tunnel.json')
    return p

def generate(spec,p):
    records=[]
    for brief in mq.BRIEFS:
        for seed in p['seeds']:
            key=f"{spec['host']}-{brief}-{seed}";chosen=None;attempts=[]
            messages=[{'role':'user','content':mq.BRIEFS[brief]+'\n\n'+INSTRUCTIONS}]
            for attempt in [1,2]:
                folder=OUT/'runs'/key/f'attempt-{attempt}'
                result=mq.infer(spec,folder,messages,seed,p['settings'],SCHEMA)
                try:
                    if result.get('error') or result['metadata'].get('done_reason')!='stop':raise ValueError('Incomplete response')
                    score=json.loads(clean(result['content'])[0]);validate(score)
                    write_json(folder/'grid-score.json',score);write_json(folder/'render-song.json',to_song(score,key));chosen=str(folder)
                    verdict={'success':True}
                except Exception as exc:verdict={'success':False,'error':str(exc)}
                attempts.append({'attempt':attempt,'verdict':verdict,'seconds':result['seconds']})
                if chosen:break
            records.append({'key':key,'model':spec['model'],'brief':brief,'seed':seed,'chosen':chosen,'attempts':attempts})
            write_json(OUT/f"generation-{spec['host']}.json",records)
    return records

if __name__=='__main__':
    p=protocol();mq.setup()
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        futures=[pool.submit(generate,spec,p) for spec in mq.MODEL_SPECS]
        rows=[r for future in futures for r in future.result()]
    write_json(OUT/'generation.json',rows);print('GRID GENERATION COMPLETE',flush=True)
