"""Tool-free, local GPT-OSS composition diagnostic. No model-generated code is executed."""
import argparse
import hashlib
import json
import os
import pathlib
import time
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = pathlib.Path(os.environ.get('COMPOSITION_BENCH_OUT',str(ROOT/'output/gpt-oss-20b-composition-2026-09-06')))
MODEL = os.environ.get('COMPOSITION_MODEL','gpt-oss:20b')
BASE_URL = os.environ.get('COMPOSITION_BASE_URL','http://127.0.0.1:11434').rstrip('/')
CONTEXT = int(os.environ.get('COMPOSITION_CONTEXT','131072'))
THINK = os.environ.get('COMPOSITION_THINK','medium')
if THINK in ('true','false'):THINK=THINK=='true'
KEEP_ALIVE = os.environ.get('COMPOSITION_KEEP_ALIVE',-1)
TIME_LIMIT = float(os.environ.get('COMPOSITION_TIMEOUT','480'))
if MODEL!='gpt-oss:20b' and 'COMPOSITION_BENCH_OUT' not in os.environ:
    raise RuntimeError('A separate output directory is required for a different model')

JSON_FORMAT = '''Return only a JSON score with keys title, bpm, meter, key, voices.
bpm is 100, meter is [4,4], key is "C major".
voices is a list of objects with name and bars. Each bar is a list of events.
Each event is [pitch, duration_in_quarter_note_beats]. pitch is a scientific note name such as "C4", "R" for a rest, or an array of note names for a chord.
A quarter note lasts 1 beat, an eighth note 0.5 beats, and each 4/4 bar totals exactly 4 beats including rests.
Write every bar and every event explicitly. Do not output code or instructions for making a score.'''

ABC_FORMAT = '''Return only a complete standard ABC score, without prose or code fences.
Include X:, T:, M:4/4, L:1/8, Q:1/4=100, and K:C headers.
Write every bar explicitly. No repeats, ties, tuplets, grace notes, lyrics or inline chord-name annotations.
Notes, rests and ordinary simultaneous note chords are allowed.
For two voices, use separately written V:1 clef=treble and V:2 clef=bass blocks, with a complete bar sequence in each voice.'''

TASKS = {
 'melody8': 'Compose an original, singable eight-bar piano melody. Scene: a snowy Christmas village, warm, bright, and playful. Use exactly 8 bars in 4/4, C major, at 100 quarter-notes per minute. End with a clear sense of arrival. Melody only, one monophonic voice, no accompaniment. Do not quote an existing tune.',
 'duet16': 'Compose an original sixteen-bar piano miniature. Scene: a snowy Christmas village, warm, bright, and playful. Use exactly 16 bars in 4/4, C major, at 100 quarter-notes per minute. Write two voices: a singable right-hand melody and a left-hand accompaniment. Include a contrasting middle passage and a recognizable return of the opening musical idea. End with a clear sense of arrival. Do not quote an existing tune.',
}

QUESTIONS = [
 {'id':'q1','question':'How many quarter-note beats are in a 4/4 bar? Answer a number.','answer':4},
 {'id':'q2','question':'A bar contains durations 1, 0.5, 0.5, 2 measured in quarter-note beats. What is their total?','answer':4},
 {'id':'q3','question':'In 4/4, which bar is too short: A=[1,1,2], B=[0.5,0.5,1,2], C=[1,1,1]? Answer A, B, or C.','answer':'C'},
 {'id':'q4','question':'How many semitones are between C4 and E4? Answer a number.','answer':4},
 {'id':'q5','question':'Transpose MIDI pitches [60,62,64,67] upward by 5 semitones. Answer an array of integers.','answer':[65,67,69,72]},
 {'id':'q6','question':'Which is a C major triad: A=[C,E,G], B=[C,Eb,G], C=[C,F,G]? Answer A, B, or C.','answer':'A'},
 {'id':'q7','question':'Which is an A minor triad: A=[A,C#,E], B=[A,C,E], C=[A,D,E]? Answer A, B, or C.','answer':'B'},
 {'id':'q8','question':'Which pitch is outside the C major scale: A=F, B=B, C=F#? Answer A, B, or C.','answer':'C'},
 {'id':'q9','question':'For a conventional perfect authentic cadence in C major, which chord normally follows G7: A=C major, B=F# major, C=G7 again? Answer A, B, or C.','answer':'A'},
 {'id':'q10','question':'Which pitches preserve the ordered intervals of [60,62,65,64]: A=[67,69,72,71], B=[67,72,69,71], C=[67,69,71,72]? Answer A, B, or C.','answer':'A'},
 {'id':'q11','question':'In ABC with M:4/4 and L:1/8, does C2 D2 E4 fill exactly one bar? Answer true or false.','answer':True},
 {'id':'q12','question':'How many explicitly written bars are in this ABC body (ignore the final double bar): C2 D2 E4 | F2 E2 D4 | G2 A2 G4 | E2 D2 C4 |]? Answer a number.','answer':4},
]

def jobs():
    copy = 'Write this exact two-bar melody without changing any note: bar 1 C4 quarter, D4 quarter, E4 half; bar 2 F4 quarter, E4 quarter, D4 half. One monophonic voice, 4/4, C major, tempo 100.'
    result = [dict(id='control-'+fmt, kind='control', task='copy2', format=fmt, seed=101, temperature=0, bars=2, voices=1,
                   prompt=copy+'\n\n'+(JSON_FORMAT if fmt=='json' else ABC_FORMAT)) for fmt in ['json','abc']]
    qa = 'Answer these basic music-representation questions. Return only a JSON object mapping each question id to its answer.\n'+json.dumps([{k:v for k,v in q.items() if k!='answer'} for q in QUESTIONS])
    result.append(dict(id='understanding', kind='understanding', format='json', seed=101, temperature=0, prompt=qa))
    for seed in [101,202,303]:
        for task in ['melody8','duet16']:
            for fmt in ['json','abc']:
                result.append(dict(id=f'{task}-{fmt}-{seed}',kind='composition',task=task,format=fmt,seed=seed,temperature=1,
                                   bars=8 if task=='melody8' else 16,voices=1 if task=='melody8' else 2,
                                   prompt=TASKS[task]+'\n\n'+(JSON_FORMAT if fmt=='json' else ABC_FORMAT)))
    return result

def run(job):
    folder=OUT/'runs'/job['id'];folder.mkdir(parents=True,exist_ok=True)
    result_file=folder/'result.json'
    if result_file.exists():
        print(job['id']+': already recorded',flush=True);return
    payload={'model':MODEL,'messages':job.get('messages',[{'role':'user','content':job['prompt']}]),
             'stream':True,'think':THINK,'keep_alive':KEEP_ALIVE,
             'options':{'temperature':job['temperature'],'top_p':1,'seed':job['seed'],'num_predict':job.get('num_predict',8192),'num_ctx':CONTEXT}}
    if job['format']=='json':payload['format']='json'
    assert 'tools' not in payload
    (folder/'request.json').write_text(json.dumps(payload,ensure_ascii=False,indent=2))
    start=time.monotonic(); content=[];thinking=[];final={};error=None;last_progress=0
    print('START '+job['id'],flush=True)
    try:
        request=urllib.request.Request(BASE_URL+'/api/chat',data=json.dumps(payload).encode(),headers={'Content-Type':'application/json'})
        with urllib.request.urlopen(request,timeout=180) as response, (folder/'stream.jsonl').open('w') as raw:
            for line in response:
                raw.write(line.decode());raw.flush()
                chunk=json.loads(line);message=chunk.get('message',{})
                content.append(message.get('content',''));thinking.append(message.get('thinking',''))
                if message.get('tool_calls'):raise RuntimeError('Unexpected tool call in a tool-free request')
                elapsed=time.monotonic()-start
                if elapsed-last_progress>20:
                    print(f"PROGRESS {job['id']}: {elapsed:.0f}s; answer {sum(map(len,content))} characters",flush=True)
                    last_progress=elapsed
                (OUT/'progress.json').write_text(json.dumps({'job':job['id'],'seconds':elapsed,'answerChars':sum(map(len,content)),'phase':'answer' if any(content) else 'thinking'}))
                if chunk.get('done'):final=chunk;break
                if elapsed>job.get('timeout',TIME_LIMIT):raise TimeoutError('Run time limit reached')
    except Exception as exc:error=str(exc)
    text=''.join(content)
    result={'job':job,'requestSha256':hashlib.sha256(json.dumps(payload,sort_keys=True).encode()).hexdigest(),
            'content':text,'thinking':''.join(thinking),'metadata':{k:v for k,v in final.items() if k!='message'},
            'seconds':time.monotonic()-start,'error':error,'observerTimeoutSeconds':job.get('timeout',TIME_LIMIT)}
    temporary=result_file.with_suffix('.tmp')
    temporary.write_text(json.dumps(result,ensure_ascii=False,indent=2));temporary.replace(result_file)
    (folder/('score.abc' if job['format']=='abc' else 'score.json')).write_text(text)
    print(f"DONE {job['id']}: {result['seconds']:.1f}s; {len(text)} chars; reason={final.get('done_reason')}; error={error}",flush=True)

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--only');args=parser.parse_args()
    OUT.mkdir(parents=True,exist_ok=True)
    plan={'model':MODEL,'seeds':[101,202,303],'thinking':THINK,'generationTemperature':1,'understandingTemperature':0,
          'toolsProvided':False,'repairPolicy':'No musical edits, completion, or retries in the primary analysis. Strip code fences only.',
          'metrics':'Parsing; exact bar and voice counts; bar duration; note count; rests; step/leap distribution; exact-bar repetition; opening-return similarity. No combined aesthetic score.',
          'rendering':'All voices use the same fixed piano sound at velocity 80, no supplied accompaniment or humanization. Audio loudness matched.',
          'interpretation':'Question answering is not composition. Valid syntax is not attractive music. N=3 per cell is a capability diagnostic, not a model ranking.',
          'conditionalExtensions':'If basic generation succeeds, test the same melody prompt in Korean and a longer 32-bar version separately. If output truncates, preserve failure and report any higher-budget retry separately.',
          'questions':QUESTIONS,'jobs':jobs()}
    if MODEL!='gpt-oss:20b':plan['runtime']={'host':os.environ.get('COMPOSITION_HOST','local'),'context':CONTEXT,'comparison':'Same prompts, seeds, output allowance, evaluator and piano renderer; hardware and model-native reasoning implementation differ.'}
    plan_file=OUT/'protocol.json'
    if plan_file.exists():
        existing=json.loads(plan_file.read_text())
        if existing!=plan:raise RuntimeError('Protocol changed after registration; use a separately labelled experiment')
    else:plan_file.write_text(json.dumps(plan,ensure_ascii=False,indent=2))
    for job in plan['jobs']:
        if not args.only or job['id']==args.only:run(job)
