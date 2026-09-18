"""Validate source preservation, blind commitments and actual audio decoding."""
import hashlib
import json
from pathlib import Path
import re
import subprocess

ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'output/music-quality-grid-2026-09-06'
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()

generation=json.loads((OUT/'generation.json').read_text());sources={r['key']:r for r in generation}
requests=[];pairs={}
for row in generation:
    assert row['chosen'],row['key']
    folder=Path(row['chosen']);request=json.loads((folder/'request.json').read_text());result=json.loads((folder/'result.json').read_text())
    score=json.loads((folder/'grid-score.json').read_text())
    assert json.loads(result['content'])==score
    assert not request.get('tools') and not request.get('tool_choice')
    assert not result.get('error') and result['metadata'].get('done_reason')=='stop'
    if row['model']=='qwen3.8:27b':assert request['think'] is False and not result['thinking']
    pairs.setdefault((row['brief'],row['seed']),[]).append(request)
    requests.append({'source':row['key'],'model':row['model'],'requestSha256':sha(folder/'request.json'),'resultSha256':sha(folder/'result.json'),'gridSha256':sha(folder/'grid-score.json'),'attempts':len(row['attempts'])})
for pair in pairs.values():
    assert len(pair)==2
    assert pair[0]['messages']==pair[1]['messages'] and pair[0]['format']==pair[1]['format'] and pair[0]['options']==pair[1]['options']
mapping=json.loads((OUT/'private/mapping.json').read_text())
for row in mapping:
    current=json.loads((OUT/'anonymous'/row['id']/'grid-score.json').read_text())
    source=json.loads((Path(sources[row['source']]['chosen'])/'grid-score.json').read_text())
    if row['kind'] in ['original','duplicate']:assert current==source
    elif row['kind']=='loop':assert all(current[v]==[source[v][0]]*16 for v in ['melody','accompaniment'])
    else:
        assert current['accompaniment']==source['accompaniment']
        a=[e for b in current['melody'] for e in b];b=[e for bar in source['melody'] for e in bar]
        assert sorted(a)==sorted(b)
        assert [(i,e) for i,e in enumerate(a) if e in ['R','_']]==[(i,e) for i,e in enumerate(b) if e in ['R','_']]
audio=[]
for row in json.loads((OUT/'audio-index.json').read_text()):
    path=Path(row['audioPath']);assert sha(path)==sha(OUT/'public'/(row['id']+'.mp3'))
    probe=subprocess.run(['ffprobe','-v','error','-show_entries','format=duration:format_tags','-of','json',str(path)],capture_output=True,text=True,check=True)
    meta=json.loads(probe.stdout);duration=float(meta['format']['duration'])
    assert not any(word in json.dumps(meta).lower() for word in ['qwen','gpt-oss','lanterns','snowfall','toyshop'])
    decoded=subprocess.run(['ffmpeg','-hide_banner','-nostats','-i',str(path),'-af','ebur128=peak=true','-f','null','-'],capture_output=True,text=True,check=True)
    summary=decoded.stderr.rsplit('Summary:',1)[-1]
    level=float(re.search(r'I:\s+(-?[\d.]+) LUFS',summary)[1]);peak=float(re.search(r'Peak:\s+(-?[\d.]+) dBFS',summary)[1])
    assert abs(duration-40.6)<.15 and abs(level+21)<=.3 and peak<=-.7,(row['id'],duration,level,peak)
    audio.append({'id':row['id'],'decoded':True,'duration':duration,'integratedLufs':level,'truePeakDbfs':peak,'sha256':sha(path),'identityTagsAbsent':True})
(OUT/'audio-verification.json').write_text(json.dumps(audio,indent=2))
audit={'toolFreeRequests':True,'pairedPromptsSchemasAndSamplingIdentical':True,'onlyModelAndReasoningDiffer':True,
       'modelScoreValuesPreserved':True,'controlledAlterationsVerified':True,'allFirstAttempt':all(len(r['attempts'])==1 for r in generation),
       'compositionCount':len(generation),'pairCount':len(pairs),'audioCount':len(audio),'requests':requests,
       'codeSha256':{p.name:sha(p) for p in (ROOT/'experiments/composition-capability').glob('*.py')}}
(OUT/'artifact-audit.json').write_text(json.dumps(audit,indent=2))
print(json.dumps({k:v for k,v in audit.items() if k not in ['requests','codeSha256']},indent=2))
