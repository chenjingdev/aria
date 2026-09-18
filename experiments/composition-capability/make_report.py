# -*- coding: utf-8 -*-
import collections
import csv
import hashlib
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'output/gpt-oss-20b-composition-2026-09-06'
evaluation=json.loads((OUT/'evaluation.json').read_text())
audio={x['id']:x for x in json.loads((OUT/'audio-index.json').read_text())}
environment=json.loads((OUT/'environment.json').read_text())
primary=[x for x in evaluation if x['kind']=='composition']
groups=collections.defaultdict(list)
for row in primary:groups[(row['task'],row['format'])].append(row)

lines=['# 로컬 GPT-OSS-20B: 도구 없는 작곡 능력 진단', '',
'## 판단', '',
'이 설치본은 도구 없이 짧은 선율과 두 성부 악보를 작성할 기초 능력을 보였다. 영어 본실험 12회 중 10회가 지정한 악보 형식·마디·성부 조건을 충족했다. 한국어 8마디 추가 시험은 3회 모두 통과했다. Aria의 입력·검증 흐름을 단순화하는 후속 실험을 진행할 근거가 있다.', '',
'이 결과는 높은 음악적 완성도나 창의성을 증명하지 않는다. 일부 성부의 음역이 겹쳤고, 32마디 확장에서는 왼손이 31마디에 그쳤다. C장조·4/4·고정 템포의 짧은 피아노 과제이며 3분 관현악을 안정적으로 완성하는 능력과는 범위가 다르다.', '',
'## 먼저 들을 결과', '']
for label,identifier in [
 ('영어 16마디 두 성부, 첫 JSON 출력 · 약 41초','duet16-json-101'),
 ('한국어 8마디, 첫 출력 · 약 21초','korean-melody8-json-101'),
 ('ABC 16마디 두 성부, 첫 출력 · 약 41초','duet16-abc-101'),
 ('32마디 확장, 왼손 한 마디 부족을 그대로 보존 · 약 79초','long32-json-101')]:
    lines.append(f"- [{label}]({audio[identifier]['audioPath']})")
lines+=['', '각 조건의 첫 결과이며 가장 좋은 곡을 고른 것이 아니다. 모든 선율과 반주는 모델 출력에서 왔다. 음표를 추가·교정하거나 반주를 대신 만들지 않았다. 동일한 피아노 음원과 velocity 80으로 변환하고 음량을 맞췄다.', '',
'## 본실험', '', '| 과제 | 표기법 | 조건 충족 | 시도 |', '|---|---|---:|---:|']
for (task,fmt),rows in sorted(groups.items()):
    name='8마디 선율' if task=='melody8' else '16마디 두 성부'
    lines.append(f"| {name} | {fmt.upper()} | {sum(x.get('strictSuccess',False) for x in rows)} | {len(rows)} |")
lines+=['',
'조건 충족은 파싱, 마디의 길이 합, 마디 수, 성부 수, 박자·템포·조성 메타데이터와 단선율 과제의 요구를 뜻한다. 음악이 매력적이라는 점수로 해석하지 않는다. JSON에는 JSON 출력 모드를 사용했고 ABC에는 사용하지 않았으므로 표기법만의 인과 비교가 아니다.', '',
'- 지정한 2마디 악보 재현: JSON·ABC 모두 6개 음의 높이와 길이를 정확히 재현했다.',
'- 기본 음악·기호 이해: 12문항 모두 정답. 박수, 음정, 이조, 장·단화음, 조성, 기본 종지와 ABC 마디 읽기를 포함한다. 질문 풀이와 작곡 결과는 따로 보고했다.', '',
'## 실패와 후속 시험', '',
'1. `melody8-json-303`: 쉼표를 `R` 대신 `R4`로 적었다. 본실험에서는 실패로 남겼다. 이후 표기 오류만 알려준 별도 1턴에서 `R`로 고쳤으며 다른 악보 내용은 모두 보존했다. 이를 본실험 성공으로 다시 계산하지 않았다.',
'2. `duet16-json-202`: 왼손 `bars` 배열에 마디와 이벤트가 섞였다. 단순히 괄호만 고치면 된다고 단정하지 않았고 음표나 마디를 채우지 않았다. 원문을 실패 결과로 남겼다.',
'3. 한국어 전이: 같은 8마디 과제를 한국어로 세 번 실행해 3/3 통과했다. 표본이 작으므로 한국어가 영어보다 낫다는 주장은 하지 않는다.',
'4. 길이 확장: 별도의 32마디 두 성부 과제 1회에서 오른손 32마디, 왼손 31마디가 나왔다. 응답은 정상 종료돼 토큰 한도로 잘린 결과가 아니다. 오른손 마지막 화음은 허용되는 피아노 표현이므로 실패 사유로 세지 않았다.', '',
'## 음악적 구조와 대조군', '',
'파싱 가능한 16마디 두 성부 결과 다섯 개 모두 후반부에서 첫 네 마디의 일부 또는 전체가 되돌아왔다. 일부는 네 마디를 그대로 복사한 재현이었다. 두 ABC 결과에서는 왼손이 오른손보다 높은 음역에 자주 놓였다. 악보 형식 통과만으로 편곡의 자연스러움을 보장할 수 없다는 단서다. 성부 교차나 비화성음 자체를 무조건 오류로 채점하지 않았다.', '',
'처음 생성된 두 성부 악보에서 선율 음높이 순서만 섞은 대조군과 첫 마디만 반복한 대조군을 별도로 만들었다. 둘 다 마디와 조성 같은 단순 형식 지표를 통과한다. 그래서 형식·조성 지표를 묶어 음악성 점수로 만들지 않았다.', '',
f"- [선율 순서를 섞은 대조군 — 모델 원출력 아님]({OUT}/controls/shuffled/audio.mp3)",
f"- [첫 마디만 반복한 대조군 — 모델 원출력 아님]({OUT}/controls/loop/audio.mp3)", '',
'강박의 선율음이 반주 화음 구성음에 속하는지와 음높이 순서를 섞은 경우의 차이도 탐색적으로 계산했다. 결과가 출력마다 달랐고 일부 반주는 단음형이라 적용하지 않았다. 첫 결과를 본 뒤 추가한 보조 진단이며 본실험 통과 기준이나 음악적 우열의 증명이 아니다.', '',
'## 전체 결과와 원문', '', '| 실행 | 조건 충족 | 성부별 마디 | 음표 수 | 듣기 | 원문 |', '|---|---|---|---:|---|---|']
for row in evaluation:
    if row['kind']=='understanding':continue
    identifier=row['id'];ext='abc' if row['format']=='abc' else 'json'
    status='통과' if row.get('strictSuccess') else '실패'
    listen=f"[MP3]({audio[identifier]['audioPath']})" if identifier in audio else '—'
    source=f"[악보]({OUT}/runs/{identifier}/score.{ext})"
    lines.append(f"| {identifier} | {status} | {row.get('voiceBars','—')} | {row.get('notes','—')} | {listen} | {source} |")
lines+=['', '## 실행 조건과 검증', '',
f"- 모델: `gpt-oss:20b`, {environment['details']['parameter_size']}, {environment['details']['quantization_level']}. Ollama {environment['version']['version']}.",
f"- 모델 digest: `{environment['modelDigest']}`.",
'- 로컬 `/api/chat`에 직접 요청했다. 모든 요청에서 tools 필드를 생략했고 도구 실행은 없었다. 본실험마다 새로운 메시지 목록을 사용했다.',
'- 생성: temperature 1, thinking medium, seeds 101/202/303, prediction allowance 8192, context 131072. 복사·이해 과제는 temperature 0.',
'- 평가기: music21 8.3.0의 ABC 토큰과 별도 JSON 해석기. 음악적 수정은 하지 않았다. 코드 펜스 제거만 허용했고 명시된 이조는 읽되 bass clef만으로 음을 낮추지 않았다.',
'- 평가기 검증: ABC/JSON 음높이·길이 동치, 두 성부·화음, 마디 부족 검출, 조표·임시표, clef와 명시적 octave/transpose의 구분을 확인했다.',
'- MIDI·MP3는 고정 변환기로 만들었다. 기존 Aria 앱의 곡이나 MCP 도구 구현은 이 시험에서 변경하지 않았다.',
'- 오디오 19개는 전체 디코딩을 확인했고 약 -21 LUFS로 맞췄다. 각 파일의 실제 수치는 audio-verification.json에 있다.',
'- 조건별 3회인 작은 진단이다. 다른 장르·조성·독창성·관현악법에 대한 일반 성능으로 확대 해석하지 않는다.', '',
'## 연구 근거', '',
'[ABC-Eval](https://arxiv.org/abs/2509.23350)은 기본 표기 이해와 구간·시퀀스 수준 추론을 구분한다. [LilyBench](https://arxiv.org/abs/2606.08722)는 악보 생성과 이해를 함께 평가하면서 지표에 따라 결과가 달라짐을 보고했다. 이를 참고해 이번에는 기본 지식, 형식 준수, 음악적 구조 진단과 청취 자료를 나누었다. 공식 벤치를 그대로 실행한 것은 아니다.', '',
'[ABC 2.1 표준](https://abcnotation.com/wiki/abc:standard:v2.1#clefs_and_transposition)에 따라 clef와 playback transpose를 구분했다. [Ollama thinking 문서](https://docs.ollama.com/capabilities/thinking)와 [chat API](https://docs.ollama.com/api/chat)의 설정을 사용했다.', '',
'## 다음 단계', '',
'기초적인 악보 작성 능력은 확인됐으므로, 다음에는 이 모델이 작성한 악보를 Aria에 그대로 입력하는 시험을 붙이는 것이 적절하다. 완성 악보 한 번 입력, 마디·성부·음역 검사, 정확한 오류 위치를 돌려주는 수정 루프를 비교할 수 있다. 이번 결과만으로 120B의 이전 실패 원인이나 MCP가 유일한 문제였다는 결론은 내리지 않는다.', '',
f"[재현 코드와 방법]({ROOT}/experiments/composition-capability/README.md). 원본 요청·응답은 각 실행 폴더의 request.json·result.json에 있다. protocol.json, evaluation.json, musical-diagnostics.json, audio-verification.json, repair-result.json에 조건과 판정을 기록했다."]
(OUT/'REPORT.md').write_text('\n'.join(lines)+'\n',encoding='utf-8')
fields=['id','kind','task','format','seed','strictSuccess','voiceBars','notes','seconds','error']
with (OUT/'results.csv').open('w',newline='',encoding='utf-8') as file:
    writer=csv.DictWriter(file,fieldnames=fields);writer.writeheader()
    for row in evaluation:writer.writerow({k:row.get(k) for k in fields})
environment['experimentCodeSha256']={str(f.relative_to(ROOT)):hashlib.sha256(f.read_bytes()).hexdigest()
    for f in (ROOT/'experiments/composition-capability').glob('*') if f.is_file()}
(OUT/'environment.json').write_text(json.dumps(environment,ensure_ascii=False,indent=2),encoding='utf-8')
print(OUT/'REPORT.md')
