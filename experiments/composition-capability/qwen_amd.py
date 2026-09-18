"""Run the same tool-free score protocol against Qwen on AMD through an SSH tunnel."""
import hashlib
import json
import os
import pathlib
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT=pathlib.Path(__file__).resolve().parents[2]
OUT=ROOT/'output/qwen3.8-27b-composition-2026-09-06'
BASELINE=ROOT/'output/gpt-oss-20b-composition-2026-09-06'
MODEL='qwen3.8:27b'
base=json.loads((OUT/'tunnel.json').read_text())['baseUrl']

def api(route,body=None,timeout=40):
    request=urllib.request.Request(base+route,data=json.dumps(body).encode() if body is not None else None,headers={'Content-Type':'application/json'})
    return json.load(urllib.request.urlopen(request,timeout=timeout))

print('Waiting for the exact Qwen model download to finish',flush=True)
deadline=time.monotonic()+3600
while True:
    tags=api('/api/tags')['models']
    tag=next((m for m in tags if m['name']==MODEL),None)
    if tag:break
    if time.monotonic()>deadline:raise TimeoutError('Model download did not finish')
    time.sleep(5)

show=api('/api/show',{'model':MODEL})
version=api('/api/version')
if 'completion' not in show.get('capabilities',[]):raise RuntimeError('Selected model does not support text completion')
environment={'model':MODEL,'host':'amd','transport':'SSH loopback tunnel','details':show.get('details'),
             'capabilities':show.get('capabilities'),'parameters':show.get('parameters'),'version':version,
             'modelDigest':tag['digest'],'modelBytes':tag['size'],'template':show.get('template'),
             'templateSha256':hashlib.sha256(show.get('template','').encode()).hexdigest(),
             'context':16384,'outputAllowance':8192,'wallTimeLimitSeconds':1200,
             'comparison':'Same prompts, seeds, explicit temperature/top_p and output allowance as GPT-OSS. Context, quantization, hardware, and model-native reasoning differ; wall time is not a model-only comparison.'}
(OUT/'environment.json').write_text(json.dumps(environment,ensure_ascii=False,indent=2))
print(json.dumps({k:environment[k] for k in ['model','details','version','modelDigest']},ensure_ascii=False),flush=True)

think='medium'
pilot={'model':MODEL,'messages':[{'role':'user','content':'Return exactly this JSON object: {"ready":true}'}],
       'stream':False,'think':think,'format':'json','keep_alive':'10m',
       'options':{'temperature':0,'seed':101,'num_predict':512,'num_ctx':16384}}
start=time.monotonic()
try:response=api('/api/chat',pilot,timeout=480)
except urllib.error.HTTPError as error:
    body=error.read().decode()
    (OUT/'pilot-error.json').write_text(json.dumps({'status':error.code,'body':body,'request':pilot},indent=2))
    if error.code==400 and 'think' in body.lower():
        think=True;pilot['think']=True;response=api('/api/chat',pilot,timeout=480)
    else:raise
(OUT/'transport-sanity.json').write_text(json.dumps({'request':pilot,'response':response,'seconds':time.monotonic()-start},ensure_ascii=False,indent=2))
if json.loads(response.get('message',{}).get('content',''))!={'ready':True}:raise RuntimeError('Model transport sanity failed')
environment['requestedThinking']=think
environment['loadedModels']=api('/api/ps')
(OUT/'environment.json').write_text(json.dumps(environment,ensure_ascii=False,indent=2))
print('Transport sanity passed; beginning the frozen score protocol',flush=True)

env=os.environ.copy()
env.update({'COMPOSITION_BENCH_OUT':str(OUT),'COMPOSITION_MODEL':MODEL,'COMPOSITION_BASE_URL':base,
            'COMPOSITION_CONTEXT':'16384','COMPOSITION_THINK':'true' if think is True else str(think),
            'COMPOSITION_KEEP_ALIVE':'10m','COMPOSITION_HOST':'amd','COMPOSITION_TIMEOUT':'1200'})
python=BASELINE/'.venv/bin/python'
commands=[
 ([str(python),'-W','ignore','experiments/composition-capability/instruct_probe.py'],'instruct-ablation.log'),
 ([str(python),'-W','ignore','experiments/composition-capability/run.py'],'run.log'),
 ([str(python),'-W','ignore','experiments/composition-capability/instruct_probe.py'],'instruct-ablation-final.log'),
 ([str(python),'-W','ignore','experiments/composition-capability/retry_runtime.py'],'runtime-retries.log'),
 ([str(python),'-W','ignore','experiments/composition-capability/extend.py'],'extensions.log'),
 ([str(python),'-W','ignore','experiments/composition-capability/evaluate.py'],'evaluation.log'),
 ([str(python),'-W','ignore','experiments/composition-capability/diagnostics.py'],'diagnostics.log'),
 ([str(python),'-W','ignore','experiments/composition-capability/normalize_notation.py'],'notation-normalizations.log'),
 (['node','experiments/composition-capability/render.mjs'],'render.log'),
]
for command,logname in commands:
    print('RUN '+logname,flush=True)
    with (OUT/logname).open('w') as log:subprocess.run(command,cwd=ROOT,env=env,stdout=log,stderr=subprocess.STDOUT,check=True)
    if logname=='run.log':
        baseline=json.loads((BASELINE/'protocol.json').read_text())
        current=json.loads((OUT/'protocol.json').read_text())
        if baseline['jobs']!=current['jobs']:raise RuntimeError('Prompts differ from the baseline')
        print('Primary prompts and seeds exactly match the GPT-OSS baseline',flush=True)
(OUT/'completed.json').write_text(json.dumps({'model':MODEL,'completed':True,'host':'amd'},indent=2))
print('Qwen experiment completed',flush=True)
