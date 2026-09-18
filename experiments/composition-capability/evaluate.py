"""Mechanical score parsing and diagnostics; no note repair or aesthetic judge."""
import collections
import hashlib
import json
import math
import os
import pathlib
import random
import re
import warnings
warnings.filterwarnings('ignore', category=Warning, module='urllib3')
from music21 import abcFormat, pitch as m21pitch

ROOT=pathlib.Path(__file__).resolve().parents[2]
OUT=pathlib.Path(os.environ.get('COMPOSITION_BENCH_OUT',str(ROOT/'output/gpt-oss-20b-composition-2026-09-06')))
MAJOR={0,2,4,5,7,9,11}

def write_json(path,value):
    temporary=path.with_name(path.name+'.'+str(os.getpid())+'.tmp')
    temporary.write_text(json.dumps(value,ensure_ascii=False,indent=2))
    temporary.replace(path)

def clean(text):
    text=text.strip()
    match=re.fullmatch(r'```(?:json|abc)?\s*\n([\s\S]*?)\n```',text)
    return (match.group(1).strip(),True) if match else (text,False)

def midi(value):
    if not isinstance(value,str):raise ValueError('Pitch must be a note name')
    m=re.fullmatch(r'([A-Ga-g])([#b]?)(-?\d+)',value)
    if not m:raise ValueError('Invalid pitch '+value)
    number=(int(m[3])+1)*12+{'C':0,'D':2,'E':4,'F':5,'G':7,'A':9,'B':11}[m[1].upper()]+({'#':1,'b':-1}.get(m[2],0))
    if not 0<=number<=127:raise ValueError('Pitch outside MIDI range')
    return number

def note_name(n):return ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'][n%12]+str(n//12-1)

def parse_json(text):
    raw=json.loads(text)
    if not isinstance(raw,dict):raise ValueError('Score must be an object')
    if not isinstance(raw.get('voices'),list) or not raw['voices']:raise ValueError('Missing voices')
    score={'title':str(raw.get('title','Untitled')),'bpm':raw.get('bpm'),'meter':raw.get('meter'),'key':raw.get('key'),'voices':[],'notationWarnings':[]}
    for v in raw['voices']:
        if not isinstance(v.get('bars'),list):raise ValueError('Missing bars')
        bars=[]
        for bar in v['bars']:
            if not isinstance(bar,list):raise ValueError('Bar must be an event list')
            events=[]
            for event in bar:
                if not isinstance(event,list) or len(event)!=2:raise ValueError('Event must be [pitch,duration]')
                p,d=event
                if isinstance(d,bool) or not isinstance(d,(int,float)) or not math.isfinite(d) or d<=0:raise ValueError('Invalid duration')
                pitches=[] if p=='R' else [midi(x) for x in p] if isinstance(p,list) else [midi(p)]
                if isinstance(p,list) and not p:raise ValueError('Empty chord')
                events.append({'pitches':pitches,'duration':float(d)})
            bars.append(events)
        score['voices'].append({'name':str(v.get('name','voice')),'bars':bars})
    return score

def parse_abc(text):
    handler=abcFormat.ABCHandler();handler.process(text)
    get=lambda name:re.search(r'^'+name+r':\s*(.*)$',text,re.M)
    meter=get('M');meter_value=[int(x) for x in meter[1].strip().split('/')] if meter and re.fullmatch(r'\d+/\d+',meter[1].strip()) else None
    tempo=get('Q');bpm=None
    if tempo:
        m=re.search(r'(\d+)\s*/\s*(\d+)\s*=\s*(\d+(?:\.\d+)?)',tempo[1])
        if m:bpm=float(m[3])*4*int(m[1])/int(m[2])
        elif re.fullmatch(r'\d+(?:\.\d+)?',tempo[1].strip()):bpm=float(tempo[1])
    key=get('K');key_value='C major' if key and key[1].strip() in ['C','Cmaj','C major','Cmaj clef=treble'] else key[1].strip() if key else None
    score={'title':get('T')[1] if get('T') else 'Untitled','bpm':bpm,'meter':meter_value,'key':key_value,'voices':[],'notationWarnings':[]}
    for header in ['X','T','M','L','Q','K']:
        if not get(header):score['notationWarnings'].append('missing '+header+' header')
    if '|:' in text or ':|' in text:score['notationWarnings'].append('repeat shorthand')
    if re.search(r'\(\d|\{|\}',text):score['notationWarnings'].append('tuplets or grace notes outside requested subset')
    def transpose_parameters(source):
        octave=re.search(r'\boctave\s*=\s*([+-]?\d+)',source)
        transpose=re.search(r'\b(?:transpose|t)\s*=\s*([+-]?\d+)',source)
        clef_shift=re.search(r'\b(?:clef=)?(?:treble|bass|alto|tenor)[1-5]?([+-]8)\b',source)
        return {'octave':int(octave[1]) if octave else 0,'transpose':int(transpose[1]) if transpose else 0,
                'clef':int(clef_shift[1])/8*12 if clef_shift else 0}
    global_shift=transpose_parameters(key[1] if key else '')
    voices_by_id={}
    for v in handler.splitByVoice():
        if not any(isinstance(t,abcFormat.ABCNote) for t in v.tokens):continue
        voice_sources=[t.src for t in v.tokens if isinstance(t,abcFormat.ABCMetadata) and t.src.startswith('V:')]
        voice_source=voice_sources[0] if voice_sources else 'V:1'
        voice_id=voice_source.split(':',1)[1].strip().split()[0]
        shift=dict(global_shift)
        parameters=transpose_parameters(voice_source)
        for field,pattern in [('octave',r'\boctave\s*='),('transpose',r'\b(?:transpose|t)\s*='),('clef',r'(?:treble|bass|alto|tenor)[1-5]?[+-]8\b')]:
            if re.search(pattern,voice_source):shift[field]=parameters[field]
        semitones=int(shift['transpose']+12*shift['octave']+shift['clef'])
        bars=[]
        for b in v.splitByMeasure():
            tokens=[t for t in b.tokens if isinstance(t,abcFormat.ABCNote)]
            if not tokens:continue  # Metadata-only segments are not measures.
            events=[]
            for t in tokens:
                d=float(t.quarterLength)
                if not math.isfinite(d) or d<=0:raise ValueError('Invalid ABC duration')
                if t.tie:score['notationWarnings'].append('tie outside requested subset')
                if t.isRest:pitches=[]
                elif isinstance(t,abcFormat.ABCChord):pitches=[int(m21pitch.Pitch(n.pitchName).midi) for n in t.subTokens if not n.isRest]
                else:pitches=[int(m21pitch.Pitch(t.pitchName).midi)]
                pitches=[p+semitones for p in pitches]
                if any(p<0 or p>127 for p in pitches):raise ValueError('Transposed ABC pitch outside MIDI range')
                events.append({'pitches':pitches,'duration':d})
            bars.append(events)
        if voice_id in voices_by_id:voices_by_id[voice_id]['bars'].extend(bars)
        else:
            voice={'name':'voice'+voice_id,'bars':bars};voices_by_id[voice_id]=voice;score['voices'].append(voice)
    if not score['voices']:raise ValueError('ABC produced no voices')
    return score

def events(score):
    out=[]
    for vi,v in enumerate(score['voices']):
        for bi,bar in enumerate(v['bars']):
            offset=0
            for e in bar:
                for p in e['pitches']:out.append({'voice':vi,'bar':bi+1,'beat':offset,'pitch':p,'duration':e['duration']})
                offset+=e['duration']
    return out

def diagnose(score,job):
    ns=events(score);errors=[]
    counts=[len(v['bars']) for v in score['voices']]
    if len(counts)!=job['voices']:errors.append('voice_count')
    if any(n!=job['bars'] for n in counts):errors.append('bar_count')
    if score['meter']!=[4,4]:errors.append('meter')
    if score['bpm']!=100:errors.append('tempo')
    if score['key']!='C major':errors.append('key_metadata')
    bad_bars=[]
    for vi,v in enumerate(score['voices']):
        for bi,bar in enumerate(v['bars']):
            total=sum(e['duration'] for e in bar)
            if abs(total-4)>1e-6:bad_bars.append({'voice':vi+1,'bar':bi+1,'beats':total})
    if bad_bars:errors.append('bar_duration')
    if not ns:errors.append('empty_score')
    melody_chords=sum(len(e['pitches'])>1 for bar in score['voices'][0]['bars'] for e in bar)
    # Only the single-melody task explicitly forbids chords. A two-hand piano
    # miniature may legitimately end with a right-hand chord.
    if job['voices']==1 and melody_chords:errors.append('polyphonic_melody')
    if score['notationWarnings']:errors.append('notation_instructions')
    melody=[n for n in ns if n['voice']==0]
    differences=[b['pitch']-a['pitch'] for a,b in zip(melody,melody[1:])]
    melody_bars=score['voices'][0]['bars']
    signatures=[json.dumps(b,sort_keys=True) for b in melody_bars]
    durations=[n['duration'] for n in melody]
    total_note_time=sum(n['duration'] for n in ns)
    first_four=signatures[:4];last_four=signatures[-4:]
    return {'parsed':True,'strictSuccess':not errors,'errors':errors,'voiceBars':counts,'invalidBars':bad_bars,
            'notes':len(ns),'melodyNotes':len(melody),'uniqueMelodyBars':len(set(signatures)),
            'exactBarRepeatFraction':1-len(set(signatures))/max(1,len(signatures)),
            'uniqueDurations':sorted(set(durations)),
            'melodyChordEvents':melody_chords,
            'stepFraction':sum(1<=abs(d)<=2 for d in differences)/max(1,len(differences)) if not melody_chords else None,
            'largeLeapFraction':sum(abs(d)>7 for d in differences)/max(1,len(differences)) if not melody_chords else None,
            'pitchRange':[min(n['pitch'] for n in ns),max(n['pitch'] for n in ns)] if ns else None,
            'scaleConsistency':sum(n['duration'] for n in ns if n['pitch']%12 in MAJOR)/max(1e-9,total_note_time),
            'tonicMelodyEnding':bool(melody and melody[-1]['pitch']%12==0) if not melody_chords else None,
            'openingFourEqualsEndingFour':first_four==last_four if len(signatures)>=8 else None,
            'notationWarnings':score['notationWarnings']}

def to_render_song(score,run_id):
    tracks=[]
    for vi,v in enumerate(score['voices']):
        notes=[]
        for n in events(score):
            if n['voice']==vi:notes.append({'bar':n['bar'],'beat':n['beat'],'pitch':note_name(n['pitch']),'dur':n['duration'],'vel':80})
        tracks.append({'name':v['name']+' '+str(vi+1),'preset':'sf-piano-gm','seed':1,'volume':.7,'pan':0,'velRange':1,'reverb':.08,'notes':notes})
    return {'title':run_id+' — '+score['title'],'bpm':score['bpm'] if isinstance(score['bpm'],(int,float)) and score['bpm']>0 else 100,
            'timeSig':[4,4],'tempoMap':[],'sections':[],'feedback':[],'tracks':tracks}

def self_test():
    a='X:1\nT:Reference\nM:4/4\nL:1/8\nQ:1/4=100\nK:C\nC2 D2 E4 | F2 E2 D4 |]'
    b={'title':'Reference','bpm':100,'meter':[4,4],'key':'C major','voices':[{'name':'melody','bars':[[['C4',1],['D4',1],['E4',2]],[['F4',1],['E4',1],['D4',2]]]}]}
    aa=parse_abc(a);bb=parse_json(json.dumps(b));assert events(aa)==events(bb)
    assert diagnose(aa,{'bars':2,'voices':1})['strictSuccess']
    unbarred=parse_abc(a.replace(' | ','\n').replace(' |]',''))
    assert len(unbarred['voices'][0]['bars'])==1, 'A newline is not an ABC bar line'
    assert sum(e['duration'] for e in unbarred['voices'][0]['bars'][0])==8
    assert 'bar_count' in diagnose(unbarred,{'bars':2,'voices':1})['errors']
    b['voices'][0]['bars'][0][-1][1]=1
    assert 'bar_duration' in diagnose(parse_json(json.dumps(b)),{'bars':2,'voices':1})['errors']
    two=a.replace('C2 D2','V:1 clef=treble\nC2 D2')+'\nV:2 clef=bass\n[C,E,G,]8 | [D,F,A,]8 |]'
    s=parse_abc(two);assert len(s['voices'])==2 and len(s['voices'][1]['bars'])==2
    assert s['voices'][1]['bars'][0][0]['pitches']==[48,52,55]
    s['voices'][0]['bars'][0][0]['pitches']=[60,64]
    assert diagnose(s,{'bars':2,'voices':2})['strictSuccess'], 'A right-hand chord is allowed in a piano duet'
    acc=parse_abc(a.replace('K:C\nC2 D2 E4','K:G\nF2 =F2 F4'))
    assert acc['voices'][0]['bars'][0][0]['pitches']==[66]
    assert acc['voices'][0]['bars'][0][1]['pitches']==[65]
    bass=parse_abc(a.replace('C2 D2','V:1 clef=bass\nC2 D2'))
    assert bass['voices'][0]['bars'][0][0]['pitches']==[60], 'Bass clef alone must not transpose sound'
    lowered=parse_abc(a.replace('C2 D2','V:1 clef=bass octave=-1 transpose=2\nC2 D2'))
    assert lowered['voices'][0]['bars'][0][0]['pitches']==[50]
    assert midi('Bb4')==70 and note_name(70)=='A#4'
    return 'PASS: equivalent ABC/JSON pitches and durations; bar-underflow detection; two voices/chords; key signatures/accidentals; scientific pitches; ABC clef vs explicit octave/transposition.'

def evaluate_all():
    protocol=json.loads((OUT/'protocol.json').read_text());summary=[]
    for file in sorted((OUT/'runs').glob('*/result.json')):
        result=json.loads(file.read_text());job=result['job'];folder=file.parent
        text,fence=clean(result['content'])
        record={'id':job['id'],'kind':job['kind'],'task':job.get('task'),'format':job['format'],'seed':job['seed'],'seconds':result['seconds'],
                'doneReason':result['metadata'].get('done_reason'),'transportError':result.get('error'),'fenceStripped':fence}
        if job['kind']=='understanding':
            try:
                answers=json.loads(text);correct=[]
                for q in protocol['questions']:
                    value=answers.get(q['id']);match=value==q['answer']
                    correct.append({'id':q['id'],'answer':value,'expected':q['answer'],'correct':match})
                record.update({'parsed':True,'correct':sum(q['correct'] for q in correct),'total':len(correct),'items':correct})
            except Exception as e:record.update({'parsed':False,'error':str(e)})
        else:
            try:
                score=parse_json(text) if job['format']=='json' else parse_abc(text)
                record.update(diagnose(score,job))
                if result['metadata'].get('done_reason')!='stop' or result.get('error'):record['strictSuccess']=False
                if job['kind']=='control':
                    expected=[(60,1),(62,1),(64,2),(65,1),(64,1),(62,2)]
                    record['exactCopy']=[(n['pitch'],n['duration']) for n in events(score)]==expected
                write_json(folder/'parsed-score.json',score)
                if record['notes']:
                    write_json(folder/'render-song.json',to_render_song(score,job['id']))
                    record['renderBars']=max(record['voiceBars'])
            except Exception as e:record.update({'parsed':False,'strictSuccess':False,'error':str(e)})
        write_json(folder/'evaluation.json',record);summary.append(record)
    write_json(OUT/'evaluation.json',summary)
    print(json.dumps([{k:x.get(k) for k in ['id','parsed','strictSuccess','voiceBars','invalidBars','notes','uniqueMelodyBars','correct','total','error']} for x in summary],ensure_ascii=False,indent=2))

if __name__=='__main__':
    result=self_test();(OUT/'parser-tests.txt').write_text(result+'\n');print(result)
    evaluate_all()
