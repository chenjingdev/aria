"""Frozen, tool-free composition comparison, followed by anonymous score review.
No music-quality ratings are produced by this runner.
"""
import concurrent.futures
import datetime
import hashlib
import json
import os
from pathlib import Path
import random
import socket
import subprocess
import time
import urllib.request

from evaluate import parse_abc, clean, diagnose, to_render_song, write_json

ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'output/music-quality-2026-09-06'
MODEL_SPECS=[{'model':'gpt-oss:20b','think':'medium','host':'mac','url':'http://127.0.0.1:11434'},
             {'model':'qwen3.8:27b','think':False,'host':'amd'}]
BRIEFS={
 'lanterns':'A warm, bright Christmas village at dusk: people gather beneath lights. Make the melody memorable, with a lively middle and a satisfying homecoming.',
 'snowfall':'A quiet winter evening beside a window: tender and lyrical, with a brief shadow of longing before a reassuring ending. Stay in C major, but choose your own harmony.',
 'toyshop':'A playful Christmas toy shop: light-footed, witty and a little mischievous. Use rhythmic character and a surprising middle that still belongs to the same piece.'}
FORMAT='''Write exactly 16 bars in 4/4, C major, at 100 quarter notes per minute. Write two separately notated piano voices: a monophonic right-hand melody and a lower left-hand accompaniment. Choose the notes, harmony and rhythm yourself. Develop an opening idea, contrast it in the middle, and bring it back near the end with a convincing close. Do not quote an existing tune.
Return only an ABC score with X:1, T:, M:4/4, L:1/8, Q:1/4=100, K:C headers. Write the entire V:1 clef=treble block, then the entire V:2 clef=bass block. Use explicit bar lines. A 4/4 bar contains eight L:1/8 units. Notes, rests and simultaneous note chords are allowed. No repeats, ties, tuplets, grace notes, lyrics or inline fields. Use commas for notes below C4; a bass clef alone does not change sounding pitch. No prose or code.'''

def api(base,route,body=None,timeout=90):
    req=urllib.request.Request(base+route,data=json.dumps(body).encode() if body is not None else None,headers={'Content-Type':'application/json'})
    return json.load(urllib.request.urlopen(req,timeout=timeout))

def register():
    OUT.mkdir(parents=True,exist_ok=True)
    protocol={
      'registeredAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
      'question':'Which tested configuration produces more musically coherent short piano pieces, beyond notation correctness?',
      'scope':'Fresh 16-bar piano pieces. Six paired tasks, three briefs times two seeds. Not a universal model ranking or a completed human listening study.',
      'seeds':[701,907],'briefs':BRIEFS,'scoreInstructions':FORMAT,
      'settings':{'num_predict':8192,'num_ctx':16384,'temperature':1,'top_p':1,'top_k':20,'repeat_penalty':1},
      'models':[{k:v for k,v in x.items() if k!='url'} for x in MODEL_SPECS],
      'toolsProvided':False,
      'formatHandling':'One model-authored revision is allowed for mechanically detected notation, bar-duration or voice errors, with the same rule for both models. Preserve all attempts. No harness-added notes, rests, chords or bar completion. A remaining incomplete score is unranked, not an aesthetic zero.',
      'rendering':{'preset':'sf-piano-gm','velocity':80,'melodyVolume':.7,'accompanimentVolume':.45,'targetLufs':-21,'humanization':False},
      'assessor':'The current assistant performs a model-label-blind analysis of canonical note scores. It does not claim to have heard audio. Anonymous audio is supplied for actual listening and any listener votes are recorded separately.',
      'rubric':{
        'melody':'0–5: memorable motif, purposeful contour, phrasing and coherent development; do not reward mere note count or scale membership.',
        'harmony':'0–5: melody/accompaniment relation, intentional tension and resolution, voice leading and cadential direction; repetition and non-chord tones are not automatic defects.',
        'form':'0–5: coherent contrast and a meaningful return; distinguish development from a copy-only loop or unrelated new material.',
        'rhythm':'0–5: purposeful rhythmic identity, pacing and phrase breathing appropriate to the brief; complexity alone earns no credit.'},
      'ratingProcedure':'Read canonical scores with anonymous IDs and brief only, in randomized order. Give four ratings plus exact bar/note evidence and a limitation. Freeze ratings and their SHA256 before revealing source mapping. Equal weights; paired totals and criterion profiles are descriptive, not validated human preference scores.',
      'controls':'A single-bar loop and melody-pitch shuffle derived from prespecified selected originals; plus one exact duplicate. Controls are hidden among originals. Check form sensitivity for the loop, melody/harmony sensitivity for the shuffle, and duplicate consistency. A failed control check weakens the assessor and prevents a confident ranking.',
      'selection':'Use the first mechanically complete attempt per task, never select by aesthetic quality. All six pairs, failures and revisions remain visible after unblinding.',
      'primaryClaimRule':'No universal musical superiority or listener preference claim. Report the blinded score-review direction, concrete note evidence, counterexamples and whether controls supported using this assessor. Do not turn formal completion counts into music quality.'}
    path=OUT/'protocol.json'
    if not path.exists():write_json(path,protocol)
    else:
        previous=json.loads(path.read_text());protocol['registeredAt']=previous['registeredAt'];assert protocol==previous
    return protocol

def setup():
    tunnel_file=OUT/'tunnel.json'
    if tunnel_file.exists():
        tunnel=json.loads(tunnel_file.read_text())
        try:api(tunnel['baseUrl'],'/api/version',timeout=3)
        except Exception:raise RuntimeError('Recorded tunnel is unavailable; do not overwrite its provenance')
    else:
        with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
        log=(OUT/'ssh.log').open('w')
        proc=subprocess.Popen(['ssh','-N','-o','BatchMode=yes','-o','ExitOnForwardFailure=yes','-L',f'127.0.0.1:{port}:127.0.0.1:11434','amd'],stdout=log,stderr=log,start_new_session=True)
        tunnel={'pid':proc.pid,'localPort':port,'baseUrl':f'http://127.0.0.1:{port}','host':'amd'}
        write_json(tunnel_file,tunnel)
        for _ in range(30):
            if proc.poll() is not None:raise RuntimeError('SSH tunnel failed')
            try:api(tunnel['baseUrl'],'/api/version',timeout=2);break
            except Exception:time.sleep(.3)
        else:raise RuntimeError('SSH tunnel did not become ready')
    MODEL_SPECS[1]['url']=tunnel['baseUrl']
    for spec in MODEL_SPECS:
        file=OUT/f"environment-{spec['host']}.json"
        if file.exists():continue
        tags=api(spec['url'],'/api/tags')['models'];tag=next(x for x in tags if x['name']==spec['model'])
        show=api(spec['url'],'/api/show',{'model':spec['model']})
        write_json(file,{'model':spec['model'],'digest':tag['digest'],'details':show.get('details'),
                        'parameters':show.get('parameters'),'version':api(spec['url'],'/api/version'),
                        'loadedBefore':api(spec['url'],'/api/ps')})

def infer(spec,folder,messages,seed,settings,output_format=None):
    result_file=folder/'result.json'
    if result_file.exists():return json.loads(result_file.read_text())
    folder.mkdir(parents=True,exist_ok=True)
    payload={'model':spec['model'],'messages':messages,'think':spec['think'],'stream':True,'keep_alive':'10m',
             'options':dict(settings,seed=seed)}
    if output_format is not None:payload['format']=output_format
    assert 'tools' not in payload
    write_json(folder/'request.json',payload)
    start=time.monotonic();content=[];thinking=[];final={};error=None
    print('START '+str(folder.relative_to(OUT)),flush=True)
    try:
        req=urllib.request.Request(spec['url']+'/api/chat',data=json.dumps(payload).encode(),headers={'Content-Type':'application/json'})
        with urllib.request.urlopen(req,timeout=180) as response,(folder/'stream.jsonl').open('w') as stream:
            for line in response:
                stream.write(line.decode());stream.flush();chunk=json.loads(line);message=chunk.get('message',{})
                if message.get('tool_calls'):raise RuntimeError('Unexpected tool call')
                content.append(message.get('content',''));thinking.append(message.get('thinking',''))
                write_json(OUT/f"progress-{spec['host']}.json",{'run':str(folder.relative_to(OUT)),'seconds':time.monotonic()-start,'answerChars':sum(map(len,content))})
                if chunk.get('done'):final=chunk;break
                if time.monotonic()-start>900:raise TimeoutError('Observer deadline reached')
    except Exception as exc:error=str(exc)
    result={'content':''.join(content),'thinking':''.join(thinking),'metadata':{k:v for k,v in final.items() if k!='message'},'error':error,'seconds':time.monotonic()-start}
    write_json(result_file,result);(folder/'score.abc').write_text(result['content'])
    print('DONE '+str(folder.relative_to(OUT))+f" {result['seconds']:.1f}s",flush=True)
    return result

def generate(spec,protocol):
    records=[]
    for brief in BRIEFS:
        for seed in protocol['seeds']:
            key=f"{spec['host']}-{brief}-{seed}"
            messages=[{'role':'user','content':'Compose a new piano miniature. '+BRIEFS[brief]+'\n\n'+FORMAT}]
            chosen=None;attempts=[]
            for attempt in [1,2]:
                folder=OUT/'runs'/key/f'attempt-{attempt}'
                result=infer(spec,folder,messages,seed,protocol['settings'])
                try:
                    score=parse_abc(clean(result['content'])[0]);verdict=diagnose(score,{'bars':16,'voices':2})
                    if result.get('error') or result['metadata'].get('done_reason')!='stop':verdict['strictSuccess']=False
                except Exception as exc:score=None;verdict={'strictSuccess':False,'error':str(exc)}
                write_json(folder/'formal-evaluation.json',verdict);attempts.append({'attempt':attempt,'verdict':verdict,'seconds':result['seconds']})
                if verdict['strictSuccess']:
                    write_json(folder/'parsed-score.json',score)
                    song=to_render_song(score,key);song['tracks'][1]['volume']=.45
                    write_json(folder/'render-song.json',song)
                    chosen=str(folder);break
                feedback={k:verdict.get(k) for k in ['error','errors','voiceBars','invalidBars','notationWarnings'] if verdict.get(k)}
                messages=messages+[{'role':'assistant','content':result['content']},{'role':'user','content':'The notation checker found these problems: '+json.dumps(feedback)+'. Correct the score while preserving your musical ideas. Return the full corrected ABC score only.'}]
            record={'key':key,'model':spec['model'],'brief':brief,'seed':seed,'chosen':chosen,'attempts':attempts}
            records.append(record);write_json(OUT/f"generation-{spec['host']}.json",records)
    return records

if __name__=='__main__':
    protocol=register();setup()
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        futures=[pool.submit(generate,spec,protocol) for spec in MODEL_SPECS]
        records=[record for future in futures for record in future.result()]
    write_json(OUT/'generation.json',records)
    print('GENERATION COMPLETE',flush=True)
