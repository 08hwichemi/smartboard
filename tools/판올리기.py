#!/usr/bin/env python3
"""판 올리기 — 새 판을 올릴 때 이것만 돌리면 됩니다.

    python3 tools/판올리기.py            # 오늘 날짜로 다음 번호
    python3 tools/판올리기.py 2026-09-26.1

왜 필요한가
-----------
GitHub Pages는 index.html도 잠시(몇 분) 캐시에 쥐고 있을 수 있습니다.
그래서 열어 둔 탭은 새 판이 올라가도 예전 화면 그대로 남고, 화면 속
BUILD_ID와 저장소 맨 위 version.txt가 다르면 "새 버전이 있습니다" 띠가
뜹니다.

두 곳(version.txt, index.html의 BUILD_ID)이 항상 같은 값이어야 하는데
손으로 고치면 한 곳을 빠뜨리기 쉬워서, 이 스크립트가 한꺼번에 맞춥니다.
"""
import datetime
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent


def next_version(today):
    cur = (ROOT / 'version.txt').read_text(encoding='utf-8').strip()
    if cur.startswith(today):
        try:
            return '%s.%d' % (today, int(cur.rsplit('.', 1)[1]) + 1)
        except (IndexError, ValueError):
            pass
    return today + '.1'


def main():
    today = datetime.date.today().isoformat()
    ver = sys.argv[1] if len(sys.argv) > 1 else next_version(today)

    (ROOT / 'version.txt').write_text(ver + '\n', encoding='utf-8')

    html = ROOT / 'index.html'
    t = html.read_text(encoding='utf-8')
    t, n = re.subn(r"var BUILD_ID = '[^']*';", "var BUILD_ID = '%s';" % ver, t)
    if n != 1:
        sys.exit('index.html에서 BUILD_ID를 찾지 못했습니다 (%d곳 찾음)' % n)
    html.write_text(t, encoding='utf-8')

    print('판 %s — version.txt와 index.html의 BUILD_ID를 맞췄습니다.' % ver)
    print('이제 git add/commit/push 하면 됩니다.')


if __name__ == '__main__':
    main()
