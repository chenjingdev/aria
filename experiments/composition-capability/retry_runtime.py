"""Retry transport-deadline failures separately; original first-pass records stay intact."""
import json
from run import OUT,run

protocol=json.loads((OUT/'protocol.json').read_text())
retries=[]
for job in protocol['jobs']:
    result=json.loads((OUT/'runs'/job['id']/'result.json').read_text())
    if 'time limit' not in (result.get('error') or '').lower():continue
    if result.get('observerTimeoutSeconds',480)>=1200:
        retries.append({'original':job['id'],'retried':False,'reason':'Already reached the relaxed deadline'});continue
    retry={**job,'id':job['id']+'-runtime-retry','kind':'runtime_retry','timeout':1200,'originalId':job['id']}
    run(retry)
    original_request=json.loads((OUT/'runs'/job['id']/'request.json').read_text())
    repeated_request=json.loads((OUT/'runs'/retry['id']/'request.json').read_text())
    if original_request!=repeated_request:raise RuntimeError('Deadline retry changed the model request')
    retries.append({'original':job['id'],'retry':retry['id'],'timeoutSeconds':1200,'modelRequestChanged':False})
(OUT/'runtime-retries.json').write_text(json.dumps(retries,indent=2))
