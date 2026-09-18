# -*- coding: utf-8 -*-
"""Local anonymous listening page. Human choices are kept separate from AI review."""
import datetime
import functools
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import secrets

ROOT=Path(__file__).resolve().parents[2]
OUT=Path(os.environ.get('MUSIC_QUALITY_OUT',str(ROOT/'output/music-quality-2026-09-06')))
PUBLIC=OUT/'public'

HTML='''<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>이름을 가리고 듣는 피아노 비교</title>
<style>body{font-family:system-ui,sans-serif;background:#f5f3ee;color:#252923;max-width:960px;margin:48px auto;padding:0 24px;line-height:1.65}h1{font-size:32px;letter-spacing:-1px;margin-bottom:8px}p{color:#586154}.eyebrow{font-size:12px;letter-spacing:2px;color:#587055}article{margin:24px 0;border:1px solid #d8ded1;border-radius:16px;padding:24px;background:white}h2{margin:0 0 8px;font-size:22px}.players{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin:22px 0}.player{background:#f1f5ef;border-radius:12px;padding:18px}.player strong{font-size:28px}audio{display:block;width:100%;margin-top:12px}button{border:1px solid #b8c5b0;border-radius:8px;padding:9px 15px;background:#fff;color:#31432b;cursor:pointer;font:inherit}button.primary{background:#314b2d;color:white;border-color:#314b2d}fieldset{border:0;padding:0;margin:18px 0}label{display:inline-block;padding:8px 16px;border:1px solid #d5ded0;border-radius:8px;margin:6px 8px 6px 0}label:has(input:checked){background:#dfead9;border-color:#607759}textarea{width:100%;box-sizing:border-box;min-height:70px;border:1px solid #d5ded0;border-radius:8px;padding:10px;font:inherit}.actions{display:flex;gap:12px;align-items:center;margin-top:12px}.status{font-size:14px;color:#4b6542}footer{font-size:13px;color:#697164;padding:20px 0 40px}@media(max-width:650px){.players{grid-template-columns:1fr}body{margin:24px auto}h1{font-size:27px}}</style>
<div class="eyebrow">PIANO · BLIND COMPARISON</div><h1>이름을 가리고, 음악만 비교하기</h1><p>같은 과제로 만든 두 곡이야. 음색과 음량을 맞췄고, 곡마다 약 40초야.<br>선율·반주·전개를 합쳐 더 좋은 쪽을 골라줘. 선택은 이 컴퓨터에만 저장돼.</p><div id="pairs">음원을 준비하고 있어.</div><footer>모델의 이름과 제작 정보는 이 페이지에 표시하지 않았어. 아래 선택은 실제 청취 의견이며, AI의 악보 심사와 따로 기록돼.</footer>
<script>
const titles={lanterns:'불빛 아래 크리스마스 마을',snowfall:'창가의 조용한 겨울 저녁',toyshop:'장난기 가득한 장난감 가게'};
let listener=localStorage.getItem('music-quality-listener');if(!listener){listener=crypto.randomUUID();localStorage.setItem('music-quality-listener',listener)}
fetch('pairs.json').then(r=>r.json()).then(pairs=>{const root=document.querySelector('#pairs');root.textContent='';pairs.forEach((p,i)=>{const a=document.createElement('article');a.innerHTML=`<h2>${i+1}. ${titles[p.brief]}</h2><p>두 곡의 길이와 피아노 소리는 같아. 처음부터 듣거나 같은 위치를 번갈아 들어봐.</p><div class="players"><div class="player"><strong>A</strong><audio id="${p.id}-A" controls preload="none" src="${p.A}.mp3"></audio></div><div class="player"><strong>B</strong><audio id="${p.id}-B" controls preload="none" src="${p.B}.mp3"></audio></div></div><button data-switch="A">A 위치에서 B 듣기</button> <button data-switch="B">B 위치에서 A 듣기</button><fieldset><legend>전체적으로 더 좋은 곡</legend><label><input type="radio" name="${p.id}" value="A"> A</label><label><input type="radio" name="${p.id}" value="B"> B</label><label><input type="radio" name="${p.id}" value="tie"> 비슷함</label></fieldset><textarea placeholder="좋았거나 어색했던 구간을 적어도 돼. 예: 후반에 주제가 돌아오는 부분" aria-label="선택 이유"></textarea><div class="actions"><button class="primary" data-save>이 비교 저장</button><span class="status" aria-live="polite"></span></div>`;root.append(a);
 a.querySelectorAll('audio').forEach(el=>el.addEventListener('play',()=>document.querySelectorAll('audio').forEach(other=>{if(other!==el)other.pause()})));
 a.querySelectorAll('[data-switch]').forEach(b=>b.onclick=async()=>{let source=a.querySelector('#'+p.id+'-'+b.dataset.switch),target=a.querySelector('#'+p.id+'-'+(b.dataset.switch==='A'?'B':'A'));const at=source.currentTime;source.pause();if(target.readyState===0){target.load();await new Promise(resolve=>target.addEventListener('loadedmetadata',resolve,{once:true}))}target.currentTime=Math.min(at,target.duration||at);target.play().catch(()=>{})});
 a.querySelector('[data-save]').onclick=async()=>{const choice=a.querySelector('input:checked'),status=a.querySelector('.status');if(!choice){status.textContent='A, B, 비슷함 중 하나를 골라줘.';return}const record={listener,pair:p.id,choice:choice.value,comment:a.querySelector('textarea').value,listenedSeconds:{A:a.querySelector('#'+p.id+'-A').currentTime,B:a.querySelector('#'+p.id+'-B').currentTime}};const r=await fetch('/api/ratings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(record)});status.textContent=r.ok?'선택을 저장했어.':'저장에 실패했어. 다시 시도해줘.'};
})}).catch(()=>document.querySelector('#pairs').textContent='아직 비교 음원이 준비되지 않았어. 잠시 후 새로고침해줘.');
</script></html>'''

class Handler(SimpleHTTPRequestHandler):
    def do_POST(self):
        if self.path!='/api/ratings':self.send_error(404);return
        try:
            length=int(self.headers.get('Content-Length','0'))
            if not 0<length<=65536:raise ValueError('invalid size')
            data=json.loads(self.rfile.read(length))
            pairs=json.loads((PUBLIC/'pairs.json').read_text())
            if data.get('pair') not in {p['id'] for p in pairs}:raise ValueError('invalid pair')
            if data.get('choice') not in ['A','B','tie']:raise ValueError('invalid choice')
            if not re.fullmatch(r'[a-f0-9-]{36}',data.get('listener','')):raise ValueError('invalid listener')
            record={'type':'human_listener_choice','receivedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),**data}
            folder=OUT/'listener-ratings';folder.mkdir(exist_ok=True)
            (folder/(secrets.token_hex(12)+'.json')).write_text(json.dumps(record,ensure_ascii=False,indent=2))
        except (ValueError,TypeError):self.send_error(400);return
        self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(b'{"saved":true}')

if __name__=='__main__':
    PUBLIC.mkdir(parents=True,exist_ok=True);(PUBLIC/'index.html').write_text(HTML)
    server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(PUBLIC)))
    import os
    state={'pid':os.getpid(),'port':server.server_port,'url':f'http://127.0.0.1:{server.server_port}'}
    (OUT/'listening-server.json').write_text(json.dumps(state,indent=2));print(state,flush=True)
    server.serve_forever()
