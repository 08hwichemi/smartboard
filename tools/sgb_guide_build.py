# 생기부 기재 길라잡이 PDF → 찾기용 JSON(sgb/<연도>-guide.json).
# 쓰는 법: pip install pymupdf 후
#   python3 tools/sgb_guide_build.py "<길라잡이.pdf>" 2026
# 원본 PDF는 비공개 저장소 08hwichemi/smartboard-files에 있고, 찾기 화면에서 여는 PDF는 sgb/<연도>-guide.pdf(같은 파일 복사본).
# 해마다 새 길라잡이가 나오면: 목차(CHAPTERS)·쪽 범위를 새 PDF에 맞게 고치고 다시 돌린다.
import json, re, sys
import pymupdf

pdf_path, year = sys.argv[1], sys.argv[2]
doc = pymupdf.open(pdf_path)

# 목차(p.4~5)를 옮긴 것: (부분, 장 이름, 시작 쪽)
CHAPTERS = [
    ('주요 변경 사항', '유의사항', 8), ('주요 변경 사항', '용어의 정의·처리요령', 9), ('주요 변경 사항', '인적·학적사항', 11),
    ('주요 변경 사항', '출결상황', 15), ('주요 변경 사항', '수상경력·자격증', 24), ('주요 변경 사항', '창의적 체험활동상황', 26),
    ('주요 변경 사항', '일상생활 활동상황', 35), ('주요 변경 사항', '교과학습발달상황', 36), ('주요 변경 사항', '독서활동상황', 68),
    ('주요 변경 사항', '행동특성 및 종합의견', 69), ('주요 변경 사항', '자료의 보존·정정·제공 등', 70), ('주요 변경 사항', '참고자료(최대 글자수)', 73),
    ('현장점검 도움자료', '현장점검 도움자료', 76), ('현장점검 도움자료', '확인 자료 목록', 89),
    ('Q&A', '처리요령', 92), ('Q&A', '인적·학적사항', 94), ('Q&A', '출결상황', 106), ('Q&A', '수상경력', 123),
    ('Q&A', '학교폭력 조치상황 관리', 124), ('Q&A', '창의적 체험활동상황', 125), ('Q&A', '일상생활 활동상황', 139),
    ('Q&A', '교과학습발달상황', 140), ('Q&A', '독서활동상황', 152), ('Q&A', '행동특성 및 종합의견', 154), ('Q&A', '자료의 정정', 156),
]
FIRST, QA_FIRST = 8, 92
LAST = doc.page_count

def chapter_of(p):
    cur = None
    for c in CHAPTERS:
        if c[2] <= p: cur = c
    return cur

NOISE = re.compile(r'^(?:2026학년도\s*학교생활기록부\s*기재\s*길라잡이\s*\|\s*고등학교\s*\||PART\.\s*[ⅠⅡⅢ]+|2026학년도\s*학교생활기록부\s*기재요령\s*(?:Q&A|현장점검\s*도움자료|주요\s*변경\s*사항)?|\d{1,3})$')

def page_lines(p):
    out = []
    for ln in doc[p - 1].get_text().split('\n'):
        ln = ln.strip()
        if not ln or NOISE.match(ln.replace(' ', '') if False else ln): continue
        out.append(ln)
    return out

PUA = re.compile('[\ue000-\uf8ff]')  # PDF 속 아이콘 글자(화면에선 네모로 보임)

def join(lines):
    # PDF 줄바꿈을 한 문단으로 — 한글 사이 줄바꿈은 띄어쓰기로.
    return re.sub(r'\s+', ' ', PUA.sub(' ', ' '.join(lines))).strip()

pages = []
for p in range(FIRST, QA_FIRST):
    c = chapter_of(p)
    pages.append({'p': p, 'part': c[0], 'ch': c[1], 't': join(page_lines(p))})

# Q&A: 글꼴 정보로 나눈다 — 흰 글씨 ❶❷…⓬ = 문항 번호, 주황 글씨(Q_COLOR) = 질문, 검은 글씨 = 답(다음 쪽으로 이어질 수 있음),
# 번호 앞 "#…" = 주제 해시태그. 머리말(작은 글씨)·쪽 번호(DINM)·장 제목(큰 글씨)은 뺀다.
Q_COLOR, WHITE = 15830528, 16777215
MARKS = set(chr(c) for c in range(0x2776, 0x2780)) | set(chr(c) for c in range(0x24EB, 0x24F5))
qa, cur, tags = [], None, []
for p in range(QA_FIRST, LAST + 1):
    c = chapter_of(p)
    for blk in doc[p - 1].get_text('dict')['blocks']:
        for line in blk.get('lines', []):
            for sp in line['spans']:
                t = sp['text'].replace('\xa0', ' ')
                if not t.strip(): continue
                if sp['size'] < 8 or sp['size'] > 20 or sp['font'] == 'DINM': continue
                if sp['color'] == WHITE:
                    if t.strip() in MARKS:
                        if cur: qa.append(cur)
                        cur = {'p': p, 'ch': c[1], 'tags': [x.strip() for x in ''.join(tags).split('#') if x.strip()], 'q': [], 'a': []}
                        tags = []
                    continue
                if abs(sp['size'] - 10) < 0.1 and sp['color'] == 0 and sp['font'].startswith('TT851'):
                    tags.append(t)  # 해시태그 줄: '#', '학적변동사유' … 조각으로 옴
                    continue
                if cur is None: continue
                (cur['q'] if sp['color'] == Q_COLOR and not cur['a'] else cur['a']).append(t)
            if cur is not None:
                (cur['a'] if cur['a'] else cur['q']).append(' ')
if cur: qa.append(cur)
def tidy(parts):
    return re.sub(r'\s+', ' ', PUA.sub(' ', ''.join(parts))).strip()
for x in qa:
    x['q'], x['a'] = tidy(x['q']), tidy(x['a'])

out = {'year': int(year), 'title': str(year) + '학년도 학교생활기록부 기재 길라잡이(고)', 'pdf': 'sgb/' + year + '-guide.pdf',
       'pages': pages, 'qa': qa}
path = 'sgb/' + year + '-guide.json'
with open(path, 'w', encoding='utf-8') as f:
    json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
print(path, 'pages', len(pages), 'qa', len(qa))
