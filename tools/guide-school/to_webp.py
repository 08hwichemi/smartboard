#!/usr/bin/env python3
"""guide/school/*.png → *.webp (너비 1400 이하로 줄이고 품질 84). shots.js를 돌린 뒤 실행. pip install pillow"""
from PIL import Image
import pathlib
d = pathlib.Path(__file__).resolve().parent.parent.parent / 'guide' / 'school'
# 홈 맨 윗줄은 가로로 너무 길어서 왼쪽·오른쪽 반을 위아래로 붙여 한 장으로(home-top)
a, b = d / 'home-top-a.png', d / 'home-top-b.png'
if a.exists() and b.exists():
    ia, ib = Image.open(a).convert('RGB'), Image.open(b).convert('RGB')
    gap = 16
    im = Image.new('RGB', (max(ia.width, ib.width), ia.height + ib.height + gap), '#E9ECF1')
    im.paste(ia, (0, 0)); im.paste(ib, (0, ia.height + gap)); im.save(d / 'home-top.png'); a.unlink(); b.unlink()
for p in sorted(x for x in d.glob('*.png') if x.name != 'qr.png'):  # qr.png는 그대로
    im = Image.open(p).convert('RGB')
    if im.width > 1400:
        im = im.resize((1400, round(im.height * 1400 / im.width)), Image.LANCZOS)
    out = p.with_suffix('.webp')
    im.save(out, 'WEBP', quality=84, method=6)
    p.unlink()
    print(out.name, im.size, out.stat().st_size // 1024, 'KB')
