#!/usr/bin/env python3
"""개인판 만들기 — index.html에서 lite.html(서버 없는 개인판)을 만든다.

    python3 tools/개인판만들기.py

왜 필요한가
-----------
개인판(lite.html)은 공용판(index.html)과 같은 코드다. 다른 건 스크립트 맨 앞의
`const APP_MODE = 'school';` 한 줄이 `'personal'`인 것과, PWA 설치용 manifest가
manifest-lite.json인 것뿐이다. 손으로 두 파일을 따로 고치면 금방 어긋나므로,
index.html만 고치고 이 스크립트로 lite.html을 다시 만든다. 판올리기.py가 끝에 이걸
함께 돌리므로 보통은 따로 돌릴 일이 없다.

주소: https://08hwichemi.github.io/smartboard/lite.html
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent


def build():
    src = (ROOT / 'index.html').read_text(encoding='utf-8')
    out, n = re.subn(r"const APP_MODE = 'school';", "const APP_MODE = 'personal';", src)
    if n != 1:
        sys.exit("index.html에서 const APP_MODE = 'school'; 를 찾지 못했습니다 (%d곳 찾음)" % n)
    out, n = re.subn(r'<link rel="manifest" href="manifest.json">', '<link rel="manifest" href="manifest-lite.json">', out)
    if n != 1:
        sys.exit('index.html에서 manifest 링크를 찾지 못했습니다 (%d곳 찾음)' % n)
    out = out.replace('<title>부광고 스마트보드</title>', '<title>내 스마트보드</title>', 1)
    out = '<!-- 이 파일은 tools/개인판만들기.py가 index.html에서 만든 것입니다. 직접 고치지 말고 index.html을 고친 뒤 다시 만드세요. -->\n' + out
    (ROOT / 'lite.html').write_text(out, encoding='utf-8')
    print('lite.html을 index.html에서 다시 만들었습니다 (APP_MODE = personal).')


if __name__ == '__main__':
    build()
