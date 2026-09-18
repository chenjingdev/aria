"""Qwen-only secondary ablation: same requests with thinking disabled."""
import datetime
import json
import run as runner

if runner.MODEL!='qwen3.8:27b':raise RuntimeError('This secondary test is only for the selected Qwen model')
if not (runner.OUT/'protocol.json').exists():
    print('Primary protocol not yet registered; defer this secondary test',flush=True)
    raise SystemExit(0)
protocol=json.loads((runner.OUT/'protocol.json').read_text())
registration={'registeredAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
 'reason':'The thinking-enabled 16-bar ABC trial exhausted its token allowance before any final score. Test whether reasoning mode is contributing to this failure.',
 'change':'think=false only; prompts, seeds, temperature, top_p, context and output allowance are unchanged',
 'scope':'One matched seed per task/notation cell; secondary diagnosis, not pooled with primary results'}
file=runner.OUT/'instruct-ablation-protocol.json'
if not file.exists():file.write_text(json.dumps(registration,indent=2))
runner.THINK=False
audits=[]
for original in protocol['jobs']:
    if original['kind']!='composition' or original['seed']!=101:continue
    if not (runner.OUT/'runs'/original['id']/'request.json').exists():continue
    job={**original,'id':original['id']+'-no-think','kind':'reasoning_ablation','originalId':original['id']}
    runner.run(job)
    before=json.loads((runner.OUT/'runs'/original['id']/'request.json').read_text())
    after=json.loads((runner.OUT/'runs'/job['id']/'request.json').read_text())
    before['think']=False
    if before!=after:raise RuntimeError('Ablation changed more than thinking mode')
    result=json.loads((runner.OUT/'runs'/job['id']/'result.json').read_text())
    audits.append({'id':job['id'],'thinkingChars':len(result.get('thinking','')),'onlyThinkingFlagChanged':True})
(runner.OUT/'instruct-ablation-audit.json').write_text(json.dumps(audits,indent=2))
