#!/usr/bin/env python3
# 교외체험학습 "결과보고서"(학교 한글 양식 .hwpx)를 HTML 표로 옮겨 absence/forms.json의 "report"로 넣는다.
# 결석계 화면에서 교외체험학습 기록을 고르면 신청서(엑셀에서 옮긴 "trip") 뒤에 이 결과보고서가 둘째 장으로 같이 나온다.
# 칸 크기(mm)·병합·테두리·바탕색·글꼴·글자 크기·줄 맞춤을 한글 파일에서 그대로 읽고, 학생이 달라지는 칸만 data-c로 비워 둔다
# (성명·학년 반 번·기간·총 사용일수·학생 이름 — 화면이 채움). 장소·학습 형태·제목·날짜·보호자는 학생이 손으로 쓰는 칸이라 비워 둔다.
# 쓰는 법: python3 tools/absence_report_build.py 결과보고서.hwpx absence/forms.json
# (한글 양식이 바뀌면 새 .hwpx로 다시 돌리면 됨. 원본 .hwpx는 저장소에 올리지 않는다.)
import json, re, sys, zipfile, html

HU = 7200 / 25.4          # HWPUNIT per mm
PX = 96 / 25.4            # px per mm
PT = 72 / 25.4            # pt per mm

def main(hwpx, out):
    z = zipfile.ZipFile(hwpx)
    head = z.read('Contents/header.xml').decode('utf-8')
    sec = z.read('Contents/section0.xml').decode('utf-8')

    fonts = {}
    for m in re.finditer(r'<hh:fontface lang="HANGUL"[^>]*>(.*?)</hh:fontface>', head, re.S):
        for f in re.finditer(r'<hh:font id="(\d+)" face="([^"]*)"', m.group(1)):
            fonts[f.group(1)] = f.group(2)
    chars = {}
    for m in re.finditer(r'<hh:charPr id="(\d+)"(.*?)</hh:charPr>', head, re.S):
        c = m.group(0)
        chars[m.group(1)] = {
            'pt': int(re.search(r'height="(\d+)"', c).group(1)) / 100,
            'font': fonts.get(re.search(r'<hh:fontRef hangul="(\d+)"', c).group(1), ''),
            'bold': '<hh:bold/>' in c,
            'sp': int(re.search(r'<hh:spacing hangul="(-?\d+)"', c).group(1)),
        }
    paras = {}
    for m in re.finditer(r'<hh:paraPr id="(\d+)".*?<hh:align horizontal="(\w+)"', head, re.S):
        paras[m.group(1)] = m.group(2)
    bfs = {}
    for m in re.finditer(r'<hh:borderFill id="(\d+)"(.*?)</hh:borderFill>', head, re.S):
        b = m.group(0)
        sides = {}
        for k in ['left', 'right', 'top', 'bottom']:
            t, w = re.search(r'<hh:%sBorder type="(\w+)" width="([\d.]+) mm"' % k, b).groups()
            sides[k] = (t, float(w))
        fill = re.search(r'<hc:winBrush faceColor="(#\w+)"', b)
        bfs[m.group(1)] = {'s': sides, 'fill': fill.group(1) if fill else None}

    def css_border(t, w):
        if t == 'NONE': return 'none'
        if t.startswith('DASH'): return '1px dashed #000'
        if t.startswith('DOT'): return '1px dotted #000'
        return ('2px' if w >= 0.3 else '1px') + ' solid #000'

    def font_css(cp, with_font=True):
        c = chars[cp]
        s = 'font-size:%gpt;' % c['pt']
        if c['bold']: s += 'font-weight:bold;'
        if c['sp']: s += 'letter-spacing:%.2fem;' % (c['sp'] / 100)
        if with_font and c['font']:
            fam = c['font']
            stack = {'맑은 고딕': "'맑은 고딕','Malgun Gothic',sans-serif", '함초롬바탕': "'함초롬바탕','HCR Batang','바탕',Batang,serif",
                     '휴먼명조': "'휴먼명조','HY명조','함초롬바탕','바탕',serif"}.get(fam, "'" + fam + "',sans-serif")
            s += 'font-family:%s;' % stack
        return s

    ALIGN = {'CENTER': 'center', 'RIGHT': 'right', 'LEFT': 'left', 'JUSTIFY': 'left', 'DISTRIBUTE': 'left'}

    # 학생마다 달라지는 칸: (행, 열) → 어떻게 채울지
    #  whole: td 전체가 값 / para: n번째 문단의 글을 "앞글 + <span data-c> + 뒷글"로
    DYN = {
        (3, 1): {'whole': 'name'},
        (3, 4): {'para': {0: ('', 'cls', '')}},
        (4, 3): {'para': {0: ('', 'period', ''), 1: ('* 현재까지 교외체험학습(가정학습 제외) 총 사용일수: ( ', 'total', ' )일 ')}},
        # 보호자·학생 줄: 손으로 쓰는 칸이라 이름 자리를 넓게(34mm), 두 줄의 "이름 자리·(인)"이 같은 세로선에 오게 — 라벨은 18mm 오른쪽 맞춤
        (24, 0): {'para': {1: ('', 'date', ''), 2: ('sig', '보호자 :', 'guardian'), 3: ('sig', '학생 :', 'student')}},
    }

    tbl = re.search(r'<hp:tbl (.*?)>(.*?)</hp:tbl>', sec, re.S)
    rows_n, cols_n = map(int, re.search(r'rowCnt="(\d+)" colCnt="(\d+)"', tbl.group(1)).groups())
    cells = []
    for tc in re.finditer(r'<hp:tc [^>]*borderFillIDRef="(\d+)">(.*?)</hp:tc>', tbl.group(2), re.S):
        bf, body = tc.groups()
        c, r = map(int, re.search(r'colAddr="(\d+)" rowAddr="(\d+)"', body).groups())
        cs, rs = map(int, re.search(r'colSpan="(\d+)" rowSpan="(\d+)"', body).groups())
        w, h = map(int, re.search(r'cellSz width="(\d+)" height="(\d+)"', body).groups())
        ps = []
        for p in re.finditer(r'<hp:p [^>]*paraPrIDRef="(\d+)"[^>]*>(.*?)</hp:p>', body, re.S):
            runs = [(cp, ''.join(re.findall(r'<hp:t[^>]*>([^<]*)</hp:t>', rb))) for cp, rb in re.findall(r'<hp:run charPrIDRef="(\d+)">(.*?)</hp:run>', p.group(2), re.S)]
            ps.append({'align': ALIGN.get(paras.get(p.group(1), 'LEFT'), 'left'), 'runs': [(cp, html.unescape(t)) for cp, t in runs]})
        cells.append({'r': r, 'c': c, 'cs': cs, 'rs': rs, 'w': w / HU, 'h': h / HU, 'bf': bf, 'ps': ps})

    # 칸 너비·줄 높이: 병합 안 된 칸부터 풀어 나간다
    colw = [None] * cols_n
    for _ in range(cols_n + 2):
        for ce in cells:
            idx = list(range(ce['c'], ce['c'] + ce['cs']))
            unknown = [i for i in idx if colw[i] is None]
            if len(unknown) == 1:
                colw[unknown[0]] = ce['w'] - sum(colw[i] for i in idx if colw[i] is not None)
    assert all(v is not None for v in colw), colw
    rowh = [None] * rows_n
    for ce in cells:
        if ce['rs'] == 1: rowh[ce['r']] = ce['h']
    for _ in range(rows_n + 2):
        for ce in cells:
            idx = list(range(ce['r'], ce['r'] + ce['rs']))
            unknown = [i for i in idx if rowh[i] is None]
            if len(unknown) == 1:
                rowh[unknown[0]] = ce['h'] - sum(rowh[i] for i in idx if rowh[i] is not None)
    assert all(v is not None for v in rowh), rowh

    def para_html(p, dyn=None):
        inner = ''
        if dyn and dyn[0] == 'sig':
            _, label, key = dyn
            cp = p['runs'][0][0] if p['runs'] else '7'
            inner = ('<span style="%s"><span style="display:inline-block;width:18mm;text-align:right;">%s</span>'
                     '<span data-c="%s" style="display:inline-block;width:34mm;text-align:center;"></span><span>(인)</span></span>') % (font_css(cp), html.escape(label), key)
        elif dyn:
            pre, key, post = dyn
            cp = p['runs'][0][0] if p['runs'] else '7'
            inner = '<span style="%s">%s<span data-c="%s"></span>%s</span>' % (font_css(cp), html.escape(pre), key, html.escape(post))
        else:
            for cp, t in p['runs']:
                if not t: continue
                inner += '<span style="%s">%s</span>' % (font_css(cp), html.escape(t))
            if not inner: inner = '&nbsp;'
        return '<div style="text-align:%s">%s</div>' % (p['align'], inner)

    grid = {(ce['r'], ce['c']): ce for ce in cells}
    out_rows = []
    for r in range(rows_n):
        tds = []
        for c in range(cols_n):
            ce = grid.get((r, c))
            if not ce: continue
            b = bfs[ce['bf']]
            st = ''.join('border-%s:%s;' % (k, css_border(*b['s'][k])) for k in ['left', 'right', 'top', 'bottom'])
            if b['fill'] and b['fill'].upper() not in ('#FFFFFF', '#FFFFFFFF'): st += 'background:%s;' % b['fill']
            first_cp = next((cp for p in ce['ps'] for cp, t in p['runs'] if t), None) or (ce['ps'][0]['runs'][0][0] if ce['ps'] and ce['ps'][0]['runs'] else '7')
            st += font_css(first_cp)
            if ce['ps']: st += 'text-align:%s;' % ce['ps'][0]['align']
            d = DYN.get((r, c))
            attrs = ''
            if ce['cs'] > 1: attrs += ' colspan="%d"' % ce['cs']
            if ce['rs'] > 1: attrs += ' rowspan="%d"' % ce['rs']
            if d and 'whole' in d:
                attrs += ' data-c="%s"' % d['whole']
                body = ''
            else:
                body = ''.join(para_html(p, (d or {}).get('para', {}).get(i)) for i, p in enumerate(ce['ps']))
            tds.append('<td%s style="%s">%s</td>' % (attrs, st, body))
        out_rows.append('<tr style="height:%.2fpt">%s</tr>' % (rowh[r] * PT, ''.join(tds)))

    # 표 아래 "※ …" 문단 두 개 → 테두리 없는 마지막 줄
    outside = re.sub(r'<hp:tbl .*?</hp:tbl>', '', sec, flags=re.S)
    notes = []
    for p in re.finditer(r'<hp:p [^>]*paraPrIDRef="(\d+)"[^>]*>(.*?)</hp:p>', outside, re.S):
        runs = [(cp, html.unescape(''.join(re.findall(r'<hp:t[^>]*>([^<]*)</hp:t>', rb)))) for cp, rb in re.findall(r'<hp:run charPrIDRef="(\d+)">(.*?)</hp:run>', p.group(2), re.S)]
        if ''.join(t for _, t in runs).strip():
            notes.append({'align': 'left', 'runs': runs})
    if notes:
        out_rows.append('<tr style="height:%.2fpt"><td colspan="%d" style="border:none;padding-top:1.5mm;white-space:normal;">%s</td></tr>' % (len(notes) * 5.5 * PT, cols_n, ''.join(para_html(p) for p in notes)))

    table_w = sum(colw)
    html_out = '<table class="xf" data-form="report" style="width:%dpx">\n<colgroup>\n%s\n</colgroup>\n%s\n</table>' % (
        round(table_w * PX), '\n'.join('<col style="width:%dpx">' % round(w * PX) for w in colw), '\n'.join(out_rows))

    pg = re.search(r'<hp:margin header="(\d+)" footer="(\d+)" gutter="\d+" left="(\d+)" right="(\d+)" top="(\d+)" bottom="(\d+)"/>', sec)
    header, footer, left, right, top, bottom = (int(v) / HU for v in pg.groups())
    form = {
        'html': html_out, 'scale': 100, 'hcenter': True, 'hwpx': True,
        # 한글: 본문은 위 여백 + 머리말 아래부터, 좌우는 용지 여백 그대로(엑셀 양식처럼 5mm를 더하지 않음)
        'margin_in': [round((top + header) / 25.4, 4), round(right / 25.4, 4), round((bottom + footer) / 25.4, 4), round(left / 25.4, 4)],
        'dyn': ['name', 'cls', 'period', 'total', 'date', 'guardian', 'student'],
        'src': '학교장허가 교외체험학습 결과보고서(.hwpx) — tools/absence_report_build.py',
    }
    data = json.load(open(out, encoding='utf-8'))
    data['report'] = form
    json.dump(data, open(out, 'w', encoding='utf-8'), ensure_ascii=False, indent=0)
    print('report: table %.1fmm × %d rows, margins(in) %s' % (table_w, len(out_rows), form['margin_in']))

if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
