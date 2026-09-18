# -*- coding: utf-8 -*-
"""Compare recorded results; no LLM judging and no changes to emitted music."""
import collections
import csv
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
BASELINE=ROOT/'output/gpt-oss-20b-composition-2026-09-06'
OUT=ROOT/'output/qwen3.8-27b-composition-2026-09-06'
baseline=json.loads((BASELINE/'evaluation.json').read_text())
current=json.loads((OUT/'evaluation.json').read_text())
environment=json.loads((OUT/'environment.json').read_text())
audio={x['id']:x for x in json.loads((OUT/'audio-index.json').read_text())}

def rate(rows,task,fmt=None,kind='composition'):
    selected=[x for x in rows if x.get('kind')==kind and x.get('task')==task and (fmt is None or x['format']==fmt)]
    return f"{sum(x.get('strictSuccess',False) for x in selected)}/{len(selected)}" if selected else '미실행'

def qa(rows):
    row=next(x for x in rows if x['kind']=='understanding')
    return f"{row.get('correct',0)}/{row.get('total',12)}"

def controls(rows):
    selected=[x for x in rows if x['kind']=='control']
    return f"{sum(x.get('exactCopy',False) for x in selected)}/{len(selected)}"

def error_label(row):
    if row.get('transportError'):return '클라이언트 기한 초과: '+row['transportError']
    if row.get('doneReason')=='length':return '출력 토큰 한도 도달'+(' · 최종 악보 없음' if not row.get('parsed') else '')
    return row.get('error') or ', '.join(row.get('errors',[])) or '—'

primary=[x for x in current if x['kind']=='composition']
success=sum(x.get('strictSuccess',False) for x in primary)
runtime_retries=[x for x in current if x['kind']=='runtime_retry']
ablations=[x for x in current if x['kind']=='reasoning_ablation']
normalization_file=OUT/'notation-normalizations.json'
normalizations=json.loads(normalization_file.read_text()) if normalization_file.exists() else []
lines=['# Qwen3.8-27B 대 GPT-OSS-20B: 도구 없는 작곡 진단', '',
'Qwen도 짧은 선율과 두 성부의 악보를 작성할 수 있다. 다만 추론 설정과 악보 표기 방식에 따라 완성 여부가 크게 달랐다. 이번 결과는 기본적인 악보 작성 능력의 증거이며, 음악적 완성도의 우열을 판정하는 청취 실험은 아니다.', '',
'## 모델 확인', '',
'사용자가 AMD 컴퓨터에서 테스트했던 모델은 **Qwen3.8-27B**였다. Honcho의 2026-08-30 정리 기록에서 `qwen3.8:27b`와 같은 가중치를 공유하는 `qwen3.8-27b-opencode` 태그가 삭제됐음을 확인했다. 이번에는 AMD에 `qwen3.8:27b`를 다시 내려받아 직접 추론했다.', '',
f"- 설치 모델: {environment['details']['parameter_size']} · {environment['details']['quantization_level']}.",
f"- 모델 digest: `{environment['modelDigest']}`.",
f"- Ollama: {environment['version']['version']}, Windows AMD 호스트.",
'- SSH 루프백 터널을 통해 요청했고 모델 추론은 AMD에서 수행했다. 악보 검증과 동일한 피아노 렌더링은 Mac에서 수행했다.', '',
'## 같은 과제의 결과', '',
'| 시험 | GPT-OSS-20B | Qwen3.8-27B |', '|---|---:|---:|',
f"| 기본 음악·기호 이해 | {qa(baseline)} | {qa(current)} |",
f"| 정해진 2마디 악보 재현 | {controls(baseline)} | {controls(current)} |"]
for task,label in [('melody8','8마디 선율'),('duet16','16마디 두 성부')]:
    for fmt in ['json','abc']:lines.append(f"| {label} · {fmt.upper()} | {rate(baseline,task,fmt)} | {rate(current,task,fmt)} |")
for task,label in [('korean-melody8','한국어 8마디 추가'),('long32','32마디 추가')]:
    lines.append(f"| {label} | {rate(baseline,task,kind='extension')} | {rate(current,task,kind='extension')} |")
decisions_file=OUT/'extensions-decisions.json'
if decisions_file.exists():
    decisions=json.loads(decisions_file.read_text())
    if decisions.get('length','').startswith('skipped'):
        lines+=['','32마디 추가 시험은 사전에 정한 “본실험 JSON 16마디 2/3 이상 통과” 조건을 충족하지 못해 실행하지 않았다.']
lines+=['',
f"Qwen의 본실험은 {len(primary)}회 중 {success}회가 기계적으로 확인하는 악보 조건을 충족했다. 조건 충족은 파싱, 마디 수·길이, 성부 수와 지정된 박자·조성 표기·템포 등의 검사 결과다. 음악적 매력이나 독창성의 점수가 아니다. 흥얼거리기 쉬운지, 크리스마스 정서나 중간부의 대비가 충분한지, 기존 곡을 인용했는지는 자동 통과 판정에 포함하지 않았다.", '',
'ABC의 본실험 8마디 응답 중 두 개는 마디 구분 기호를 생략했다. 음표가 존재하더라도 명시적인 마디 구조를 요구한 검사를 통과한 것으로 처리하지 않았다. 16마디의 시간·토큰 한도 초과와 JSON 배열 구조 오류도 각각 기록했다.', '',
'두 모델에 사용한 본실험 프롬프트와 seed 목록은 완전히 동일하다. 출력 한도 8192와 명시한 temperature/top_p도 같다. Qwen의 문맥 설정은 AMD 메모리 조건에 맞춰 16384로 설정했고 GPT-OSS는 기존 131072 설정을 사용했다. 입력과 출력 허용량이 Qwen의 설정 안에 들어오는지 기록했다. 양자화 방식, 하드웨어, 모델별 기본 샘플링과 추론 구현은 다르므로 순수 가중치 비교나 장비 속도 비교로 해석하지 않는다.', '',
'## 먼저 들을 결과', '']
if runtime_retries:
    lines[-2:-2]=['## 시간 제한에 걸린 실행', '',
      '초기 8분 클라이언트 기한에 걸린 응답은 첫 실행 실패로 남기고, 모델에 보내는 요청·출력 토큰 한도는 그대로 두어 20분 기한에서 별도 재실행했다. 후속 첫 실행도 20분 기한을 사용했다. 이는 기다리는 시간만 늘린 것으로, 악보 수정이나 다른 프롬프트로 재생성한 것이 아니다. 최초 결과와 재실행은 아래 표에서 구분한다.', '']
    for r in runtime_retries:lines[-2:-2]=[f"- {r['id']}: {'악보 조건 통과' if r.get('strictSuccess') else error_label(r)}"]
    lines[-2:-2]=['']
if ablations:
    section=['## 추론을 끈 별도 진단', '',
      '추론 단계에서 토큰 한도를 소진한 사례를 본 뒤 추가했다. seed 101의 같은 네 과제에서 think 플래그만 false로 바꿨다. 다른 요청 값이 같음을 검사했고, 이 결과를 본실험 통과율에 합치지 않았다. 각 조건 1회이므로 안정적인 성공률을 뜻하지 않는다.', '',
      '| 과제 | 조건 충족 | 소요 | 듣기 |','|---|---|---:|---|']
    for r in ablations:
        listen=f"[MP3]({audio[r['id']]['audioPath']})" if r['id'] in audio else '—'
        section.append(f"| {r['id']} | {'통과' if r.get('strictSuccess') else '실패'} | {r['seconds']:.1f}초 | {listen} |")
    lines[-2:-2]=section+['']
if normalizations:
    section=['## 괄호 구조만 표준화한 별도 검사','',
      '일부 JSON 출력은 한 마디를 [음높이,길이,음높이,길이] 형태로 평평하게 적었다. 같은 마디 안에서 인접한 두 값을 이벤트로 묶는 공통 규칙을 두 모델에 적용했다. 음높이·길이 같은 모든 값의 순서, 마디 경계, 나머지 필드가 보존됐음을 검사했다. 음표나 부족한 마디는 추가하지 않았고 본실험의 형식 실패는 유지했다.','']
    for r in normalizations:
        if r.get('verdict',{}).get('strictSuccess'):
            identifier=r['source']+'-normalized'
            listen=f"[MP3]({audio[identifier]['audioPath']})" if identifier in audio else '—'
            section.append(f"- {r['source']}: 값 변경 없이 악보 조건 충족. {listen}")
    lines[-2:-2]=section+['']
for task in ['duet16','melody8','korean-melody8','long32']:
    candidates=[x for x in current if x.get('task')==task and x['id'] in audio and x.get('strictSuccess') and x['kind']!='runtime_retry']
    candidates.sort(key=lambda x:(x['format']!='json',x['seed'],x['id']))
    if candidates:
        x=candidates[0];lines.append(f"- [{x['id']} · {audio[x['id']]['duration']:.1f}초]({audio[x['id']]['audioPath']})")
lines+=['',
'각 과제에서 형식 검사를 통과한 첫 seed의 결과를 제시했다. JSON을 먼저, 그 안에서 실행 ID 순으로 골랐으며 음악적 매력에 따라 선별하지 않았다. 모델이 적은 음표를 그대로 변환했고, 반주·음표·표현을 추가하지 않았다. 같은 피아노와 고정 velocity 80을 사용했다.', '',
'## 모든 결과', '', '| 실행 | 조건 충족 | 성부별 마디 | 음표 수 | 오류 | 듣기 |', '|---|---|---|---:|---|---|']
for row in current:
    if row['kind']=='understanding':continue
    identifier=row['id'];listen=f"[MP3]({audio[identifier]['audioPath']})" if identifier in audio else '—'
    error=error_label(row)
    lines.append(f"| {identifier} | {'통과' if row.get('strictSuccess') else '실패'} | {row.get('voiceBars','—')} | {row.get('notes','—')} | {error} | {listen} |")
lines+=['',
'## 음표 내용에서 확인한 점', '',
'추론을 끈 ABC 16마디는 앞의 네 마디 중 세 마디를 13마디부터 그대로 재현하고 마지막 마디를 바꿨다. 괄호 구조를 표준화한 JSON 16마디에는 서로 다른 선율 마디가 14개 있고, 13마디부터 처음의 네 마디 중 두 마디가 재현됐다. 따라서 모든 마디를 단순 반복한 출력은 아니다.', '',
'표준화한 JSON의 강박 28개에서 선율이 동시에 울리는 반주 화음의 음에 해당한 비율은 64.3%였다. 같은 음높이를 499회 섞은 대조의 평균은 33.9%였다. 이는 이 한 사례에서 선율과 반주 사이 관계를 확인하는 보조 관찰이다. 음악적 매력의 점수, 독립된 표본 499개, 사전에 등록한 우월성 검정으로 해석하지 않는다. ABC 결과의 반주는 단음이어서 이 화음 검사는 적용하지 않았다. `secondary-composition-diagnostics.json`에 값을 보관했다.', '',
'추론을 끈 ABC 곡은 두 성부가 함께 활동한 강박 31개 중 5개에서 반주의 음높이가 선율과 같거나 높았다. bass clef는 소리의 옥타브를 자동으로 낮추지 않으므로 적힌 음높이를 그대로 재생했다. 의도적인 성부 교차도 가능해 이를 자동 실패로 세지는 않았지만, 형식 통과가 좋은 음역 배치를 보장하지 않는 실제 사례다.', '',
'## 해석 범위', '',
'이번 시험은 C장조·4/4·고정 템포의 짧은 피아노 작곡이다. 형식 준수, 기본 이해, 반복·성부 배치 같은 기호적 특성과 실제 청취 자료를 각각 제시했다. 긴 관현악곡의 완성도, 넓은 장르 대응이나 인간 선호도 순위까지 검증한 것은 아니다. 실패한 응답도 모두 남겼고, 본실험에서 악보를 자동 수정하지 않았다.', '',
'`musical-diagnostics.json`에는 후반부 주제 재현과 성부 관계의 보조 진단을 남겼다. 비화성음·성부 교차·반복이 음악적으로 의도적일 수 있으므로 이를 하나의 음악성 점수로 합치지 않았다.', '',
'## 도구 설계에 주는 단서', '',
'작곡 내용을 낼 능력은 확인됐으므로 도구를 개선해 볼 근거는 있다. 다만 지식 문항과 짧은 복사를 모두 통과해도 긴 생성에서 마디 길이·성부·괄호를 틀렸다. 작은 악보 단위를 받고, 모델 밖에서 마디 길이와 음표 구조를 검사해 정확한 오류 위치를 알려주는 방식이 다음 실험 후보가 된다. 이번에는 이 피드백 도구나 자동 음악 수정을 제공하지 않았다.', '',
'Qwen의 별도 진단에서는 추론을 끈 ABC가 8마디와 16마디를 각각 완성했고 JSON은 두 과제 모두 실패했다. 이는 추론과 표현 방식을 함께 살펴볼 이유지만 조건당 1회 결과다. JSON은 JSON 출력 모드를 사용하고 ABC는 자유 텍스트이므로 표기법만의 효과를 분리한 비교도 아니다.', '',
'## 근거와 재현', '',
'모델의 이름과 기본 기능은 [공식 Qwen3.8-27B 카드](https://huggingface.co/Qwen/Qwen3.8-27B)와 [Ollama 배포](https://ollama.com/library/qwen3.8:27b)에서도 확인했다. 공식 카드는 추론 강도 조절을 설명하지만, 같은 이름의 강도가 모델 간 같은 계산량을 뜻하지는 않는다.', '',
'평가 방법은 [ABC-Eval](https://arxiv.org/abs/2509.23350)과 [LilyBench](https://arxiv.org/abs/2606.08722)를 참고한 자체 진단이다. 공식 벤치를 그대로 실행한 결과가 아니다.', '',
f"- [GPT-OSS 원본 실험 보고서]({BASELINE}/REPORT.md)",
f"- [공통 실험 코드와 방법]({ROOT}/experiments/composition-capability/README.md)",
f"- [Qwen 실행 조건]({OUT}/environment.json)",
f"- [Qwen 원자료 요약]({OUT}/evaluation.json)",
'',
'각 실행 폴더의 request.json·result.json에 정확한 요청과 원응답이 있고, score.json/score.abc·MIDI·MP3와 평가 결과를 함께 보관했다. 모델에는 도구를 제공하지 않았고 생성한 코드를 실행하지 않았다.']
(OUT/'REPORT.md').write_text('\n'.join(lines)+'\n',encoding='utf-8')
fields=['model','id','kind','task','format','seed','strictSuccess','voiceBars','notes','seconds','error']
with (OUT/'comparison.csv').open('w',newline='',encoding='utf-8') as file:
    writer=csv.DictWriter(file,fieldnames=fields);writer.writeheader()
    for model,rows in [('gpt-oss:20b',baseline),('qwen3.8:27b',current)]:
        for row in rows:writer.writerow({k:model if k=='model' else row.get(k) for k in fields})
print(OUT/'REPORT.md')
