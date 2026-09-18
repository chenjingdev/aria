"""Audit saved requests and independently decode rendered audio; no inference."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

ROOT=Path(__file__).resolve().parents[2]
BASELINE=ROOT/'output/gpt-oss-20b-composition-2026-09-06'
OUT=Path(os.environ.get('COMPOSITION_BENCH_OUT',str(ROOT/'output/qwen3.8-27b-composition-2026-09-06')))

def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()

audio=[]
for row in json.loads((OUT/'audio-index.json').read_text()):
    if row.get('error'):raise RuntimeError('Audio render failed: '+row['id'])
    path=Path(row['audioPath'])
    probe=subprocess.run(['ffprobe','-v','error','-show_entries','format=duration','-of','json',str(path)],capture_output=True,text=True,check=True)
    duration=float(json.loads(probe.stdout)['format']['duration'])
    decoded=subprocess.run(['ffmpeg','-hide_banner','-nostats','-i',str(path),'-af','ebur128=peak=true','-f','null','-'],capture_output=True,text=True,check=True)
    summary=decoded.stderr.rsplit('Summary:',1)[-1]
    level=float(re.search(r'I:\s+(-?[\d.]+) LUFS',summary)[1])
    peak=float(re.search(r'Peak:\s+(-?[\d.]+) dBFS',summary)[1])
    valid=abs(duration-row['duration'])<.15 and abs(level+21)<=.3 and peak<=-.7
    audio.append({'id':row['id'],'decodePassed':True,'duration':duration,'pcmDuration':row['duration'],
                  'integratedLufs':level,'truePeakDbfs':peak,'sha256':sha(path),'checksPassed':valid})
    if not valid:raise RuntimeError('Audio verification failed: '+json.dumps(audio[-1]))
(OUT/'audio-verification.json').write_text(json.dumps(audio,indent=2))

protocol=json.loads((OUT/'protocol.json').read_text())
reference=json.loads((BASELINE/'protocol.json').read_text())
assert protocol['jobs']==reference['jobs'], 'Primary prompts or seeds differ'
requests=[]
context_observations=[]
for file in sorted((OUT/'runs').glob('*/request.json')):
    request=json.loads(file.read_text())
    assert not request.get('tools') and not request.get('tool_choice')
    assert request['model']=='qwen3.8:27b'
    assert all(message['role'] in ['system','user'] for message in request['messages'])
    result=file.with_name('result.json')
    requests.append({'id':file.parent.name,'requestSha256':sha(file),'resultSha256':sha(result) if result.exists() else None})
    if result.exists():
        metadata=json.loads(result.read_text())['metadata']
        prompt_count=metadata.get('prompt_eval_count')
        if prompt_count is not None:
            allowance=request['options']['num_predict'];context=request['options']['num_ctx']
            assert prompt_count+allowance<=context, 'Recorded prompt plus output allowance exceeds context'
            context_observations.append({'id':file.parent.name,'reportedPromptTokens':prompt_count,
              'outputAllowance':allowance,'context':context,'promptPlusAllowanceFits':True})
code={str(p.relative_to(ROOT)):sha(p) for p in sorted((ROOT/'experiments/composition-capability').glob('*')) if p.is_file()}
audit={'toolsProvided':False,'allPrimaryPromptsAndSeedsIdentical':True,'requests':requests,'codeSha256':code,
       'contextObservations':context_observations,
       'primaryResultCount':sum((OUT/'runs'/job['id']/'result.json').exists() for job in protocol['jobs']),
       'audioCount':len(audio),'audioChecksPassed':all(r['checksPassed'] for r in audio)}
(OUT/'artifact-audit.json').write_text(json.dumps(audit,indent=2))
print(json.dumps({k:v for k,v in audit.items() if k not in ['requests','codeSha256','contextObservations']},indent=2))
