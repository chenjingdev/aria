# -*- coding: utf-8 -*-
"""One matched pair of short fiction; identities stay sealed for the reader."""
import concurrent.futures
import datetime
import hashlib
import html
import json
import os
from pathlib import Path
import secrets
import signal
import socket
import subprocess
import time
import urllib.request

ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'output/fiction-blind-2026-09-06'
PROMPT='''한국어로 완결된 짧은 소설 한 편을 써 줘.

소재: 비 오는 밤, 막차를 놓친 사람이 오래전에 문을 닫은 가게에서 불빛을 본다.
등장인물은 두 명 이내로 하고, 주인공의 작은 선택이 결말을 바꾸게 해 줘. 감정을 설명으로 정리하기보다 행동과 대화로 드러내 줘. 억지 반전보다는 마지막 장면이 남는 이야기를 써 줘.

분량은 공백 포함 약 800~1200자. 제목, 해설, 작가나 모델에 대한 언급 없이 소설 본문만 출력해 줘.'''
SPECS=[{'model':'gpt-oss:20b','think':'low','host':'mac','url':'http://127.0.0.1:11434'},
       {'model':'qwen3.8:27b','think':False,'host':'amd'}]
OPTIONS={'num_ctx':16384,'num_predict':8192,'temperature':1,'top_p':.95,'top_k':20,'repeat_penalty':1,'seed':106}

def write(path,value):
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding='utf-8')
def api(base,route,body=None,timeout=180):
    request=urllib.request.Request(base+route,data=json.dumps(body).encode() if body is not None else None,headers={'Content-Type':'application/json'})
    return json.load(urllib.request.urlopen(request,timeout=timeout))
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()

def setup():
    OUT.mkdir(parents=True,exist_ok=True)
    protocol={'registeredAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'prompt':PROMPT,'settings':OPTIONS,
              'models':[{k:v for k,v in s.items() if k!='url'} for s in SPECS],
              'task':'One first-response story per model, in Korean; source identities randomly assigned to A/B and withheld from reader.',
              'toolsProvided':False,'editing':'No wording, punctuation, paragraph or title editing. Public text is exactly the API final-answer content. Thinking traces remain private. No aesthetic selection, regeneration or assistant ranking.',
              'scope':'A small blind sample of these configurations, not a statistically established model ranking.'}
    path=OUT/'protocol.json'
    if path.exists():
        old=json.loads(path.read_text());protocol['registeredAt']=old['registeredAt'];assert protocol==old
    else:write(path,protocol)
    tunnel_file=OUT/'private/tunnel.json'
    if tunnel_file.exists():tunnel=json.loads(tunnel_file.read_text())
    else:
        with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
        tunnel_file.parent.mkdir(parents=True,exist_ok=True)
        log=(OUT/'private/ssh.log').open('w')
        proc=subprocess.Popen(['ssh','-N','-o','BatchMode=yes','-o','ExitOnForwardFailure=yes','-L',f'127.0.0.1:{port}:127.0.0.1:11434','amd'],stdout=log,stderr=log,start_new_session=True)
        tunnel={'pid':proc.pid,'localPort':port,'baseUrl':f'http://127.0.0.1:{port}'};write(tunnel_file,tunnel)
    SPECS[1]['url']=tunnel['baseUrl']
    deadline=time.monotonic()+60
    while True:
        try:api(tunnel['baseUrl'],'/api/version',timeout=3);break
        except Exception:
            if time.monotonic()>deadline:raise RuntimeError('AMD tunnel not ready')
            time.sleep(1)
    for spec in SPECS:
        file=OUT/'private'/f"environment-{spec['host']}.json"
        if file.exists():continue
        tag=next(m for m in api(spec['url'],'/api/tags')['models'] if m['name']==spec['model'])
        write(file,{'model':spec['model'],'digest':tag['digest'],'details':tag['details'],
                    'version':api(spec['url'],'/api/version'),'loadedBefore':api(spec['url'],'/api/ps')})

def generate(spec):
    folder=OUT/'private'/spec['host'];folder.mkdir(parents=True,exist_ok=True)
    result_file=folder/'result.json'
    if result_file.exists():return json.loads(result_file.read_text())
    request={'model':spec['model'],'messages':[{'role':'user','content':PROMPT}],
             'think':spec['think'],'stream':True,'keep_alive':'10m','options':OPTIONS}
    write(folder/'request.json',request)
    start=time.monotonic();answer=[];thinking=[];final={};error=None
    print('START '+spec['host'],flush=True)
    try:
        req=urllib.request.Request(spec['url']+'/api/chat',data=json.dumps(request).encode(),headers={'Content-Type':'application/json'})
        with urllib.request.urlopen(req,timeout=180) as response,(folder/'stream.jsonl').open('w') as stream:
            for line in response:
                stream.write(line.decode());stream.flush();chunk=json.loads(line);message=chunk.get('message',{})
                if message.get('tool_calls'):raise RuntimeError('Unexpected tool call')
                answer.append(message.get('content',''));thinking.append(message.get('thinking',''))
                if chunk.get('done'):final=chunk;break
                if time.monotonic()-start>600:raise TimeoutError('Observer deadline reached')
    except Exception as exc:error=str(exc)
    result={'model':spec['model'],'host':spec['host'],'content':''.join(answer),'thinking':''.join(thinking),
            'metadata':{k:v for k,v in final.items() if k!='message'},'error':error,'seconds':time.monotonic()-start}
    write(result_file,result);(folder/'story.txt').write_text(result['content'],encoding='utf-8')
    print('DONE '+spec['host'],flush=True)
    return result

def publish(results):
    for r in results:
        assert not r['error'] and r['metadata'].get('done_reason')=='stop' and r['content'].strip(),'Incomplete story response; retain raw failure, do not silently substitute another story'
        assert not any(name in r['content'].lower() for name in ['gpt-oss','qwen','openai','알리바바','챗지피티','오픈에이아이']), 'Identity mention requires separate review'
    assignment=OUT/'private/assignment.json'
    if assignment.exists():mapping=json.loads(assignment.read_text())
    else:
        shuffled=results.copy();secrets.SystemRandom().shuffle(shuffled)
        mapping=[{'label':label,'host':r['host'],'model':r['model']} for label,r in zip(['A','B'],shuffled)];write(assignment,mapping)
    public=OUT/'public';public.mkdir(exist_ok=True);by_host={r['host']:r for r in results}
    markdown=['# 짧은 소설 블라인드 비교','',
              '같은 프롬프트의 첫 응답을 무작위로 A/B에 배치했어. 문장과 문단을 수정하지 않았고, 어느 모델의 글인지 공개하지 않았어.','',
              '공통 소재: 비 오는 밤, 막차를 놓친 사람이 오래전에 문을 닫은 가게에서 불빛을 본다. 두 명 이내의 인물, 주인공의 작은 선택으로 달라지는 결말. 공백 포함 약 800~1200자.','']
    cards=[];audit=[]
    for entry in mapping:
        label=entry['label'];text=by_host[entry['host']]['content'];file=public/(label+'.txt');file.write_text(text,encoding='utf-8')
        assert file.read_text()==by_host[entry['host']]['content']
        markdown+=['## '+label,'',text,'']
        cards.append('<section><h2>'+label+'</h2><div class="story">'+html.escape(text)+'</div></section>')
        audit.append({'label':label,'publicSha256':sha(file),'textUnchanged':True,'characters':len(text)})
    markdown+=['---','','모델 이름을 보기 전에, 더 읽고 싶은 쪽과 문장·이야기에서 좋거나 어색했던 부분을 말해 줘.','']
    (public/'비교.md').write_text('\n'.join(markdown),encoding='utf-8')
    page='''<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>짧은 소설 A/B</title><style>body{font-family:system-ui,sans-serif;background:#f6f3ed;color:#292822;max-width:1100px;margin:40px auto;padding:0 24px;line-height:1.85}header{max-width:760px;margin-bottom:30px}h1{font-size:30px}p{color:#625e54}.grid{display:grid;grid-template-columns:1fr 1fr;gap:24px}section{background:white;border:1px solid #e3ded3;border-radius:12px;padding:24px}h2{margin-top:0;color:#756348}.story{white-space:pre-wrap;font-size:17px;overflow-wrap:anywhere}@media(max-width:750px){.grid{grid-template-columns:1fr}}</style><header><h1>짧은 소설, 이름을 가리고 읽기</h1><p>같은 소재와 조건으로 받은 첫 원문이야. 문장을 고치지 않았고 A/B 순서는 무작위야.</p><p>비 오는 밤, 막차를 놓친 사람이 오래전에 문을 닫은 가게에서 불빛을 본다.</p></header><div class="grid">'''+''.join(cards)+'</div></html>'
    (public/'index.html').write_text(page,encoding='utf-8')
    write(OUT/'blind-audit.json',{'createdAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'assignmentSha256':sha(assignment),'samePromptAndOptions':True,'stories':audit,'identitiesDisclosed':False})
    print('BLIND STORIES READY',flush=True)

def restore():
    state={}
    for spec in SPECS:
        env=json.loads((OUT/'private'/f"environment-{spec['host']}.json").read_text())
        if spec['host']=='mac':
            old=next((m for m in env['loadedBefore']['models'] if m['name']==spec['model']),None)
            if old:
                api(spec['url'],'/api/generate',{'model':spec['model'],'prompt':'','stream':False,'keep_alive':-1,'options':{'num_ctx':old['context_length']}})
        else:
            alias='qwen3-embedding-honcho-8192:latest'
            reply=api(spec['url'],'/api/embed',{'model':alias,'input':'warmup','keep_alive':-1})
            assert len(reply.get('embeddings',[]))==1
        state[spec['host']]=api(spec['url'],'/api/ps')
    tunnel=json.loads((OUT/'private/tunnel.json').read_text())
    command=subprocess.run(['ps','-p',str(tunnel['pid']),'-o','command='],capture_output=True,text=True).stdout
    if command:
        assert 'ssh' in command and str(tunnel['localPort'])+':' in command
        os.kill(tunnel['pid'],signal.SIGTERM)
    write(OUT/'private/post-run-state.json',{'restored':state,'ownedTunnelClosed':True})
    print('RUNTIME RESTORED',flush=True)

if __name__=='__main__':
    setup()
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(generate,SPECS))
    publish(results);restore()
