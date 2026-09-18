"""Follow-up to the user's P01 preference: isolate accompaniment density.
These are intentionally modified listening controls, never new model compositions.
"""
import copy
import datetime
import json
from pathlib import Path

from evaluate import midi,write_json
from grid_quality import to_song,validate

ROOT=Path(__file__).resolve().parents[2]
PARENT=ROOT/'output/music-quality-grid-2026-09-06'
OUT=PARENT/'density-ablation'
pair=json.loads((PARENT/'public/pairs.json').read_text())[0]
assert pair['id']=='P01'
OUT.mkdir(exist_ok=True)
protocol={'registeredAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
 'trigger':'The user preferred B but suspected repeated chord attacks made it seem richer.',
 'sourcePair':pair,
 'melodyOnly':'Set accompaniment to silence; preserve every melody slot and note duration.',
 'sustainChords':'Replace a new accompaniment chord with a hold only when its full pitch multiset equals the currently sounding chord. Preserve the sounding pitch multiset in every eighth-note slot, including rests. Melody remains exact.',
 'interpretation':'These intentionally alter accompaniment texture and performance onsets. They isolate two aspects of the observed preference, not an overall music-quality score. Do not replace the original ratings with these controls.'}
file=OUT/'protocol.json'
if not file.exists():write_json(file,protocol)
def sounded(voice):
    active=[];timeline=[]
    for bar in voice:
        for slot in bar:
            if slot!='_':active=[] if slot=='R' else sorted(slot,key=midi)
            timeline.append(active.copy())
    return timeline
evaluations=[];audits=[]
for side in ['A','B']:
    source_id=pair[side];raw=json.loads((PARENT/'anonymous'/source_id/'grid-score.json').read_text())
    for mode in ['melody-only','sustain-chords']:
        score=copy.deepcopy(raw);removed=0
        if mode=='melody-only':score['accompaniment']=[['R']*8 for _ in range(16)]
        else:
            active=[]
            for bar in score['accompaniment']:
                for i,slot in enumerate(bar):
                    if slot=='_':continue
                    if slot=='R':active=[];continue
                    chord=sorted(slot,key=midi)
                    if chord==active:bar[i]='_';removed+=1
                    active=chord
            assert sounded(score['accompaniment'])==sounded(raw['accompaniment'])
        assert score['melody']==raw['melody'];validate(score)
        identifier=mode+'-'+side;folder=OUT/'runs'/identifier;folder.mkdir(parents=True,exist_ok=True)
        song=to_song(score,identifier);original=to_song(raw,source_id)
        assert song['tracks'][0]['notes']==original['tracks'][0]['notes']
        write_json(folder/'grid-score.json',score);write_json(folder/'render-song.json',song)
        evaluations.append({'id':identifier,'kind':'listening_ablation','folder':str(folder),'parsed':True,'notes':sum(len(t['notes']) for t in song['tracks']),'renderBars':16,'harnessAltered':True})
        audits.append({'id':identifier,'sourceId':source_id,'melodyNotesExact':True,'chordReattacksRemoved':removed,'originalAccompanimentNoteOnsets':len(original['tracks'][1]['notes']),'resultAccompanimentNoteOnsets':len(song['tracks'][1]['notes']),'soundingChordTimelineExact':mode=='sustain-chords','modelOutputChangedForDiagnostic':True})
write_json(OUT/'evaluation.json',evaluations);write_json(OUT/'transformation-audit.json',audits)
print(json.dumps(audits,indent=2))
