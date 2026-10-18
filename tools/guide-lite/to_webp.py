#!/usr/bin/env python3
"""guide/lite/*.png → *.webp (너비 1400 이하로 줄이고 품질 82). shots.js를 돌린 뒤 실행. pip install pillow"""
from PIL import Image
import pathlib
d = pathlib.Path(__file__).resolve().parent.parent.parent / 'guide' / 'lite'
for p in sorted(d.glob('*.png')):
    im = Image.open(p).convert('RGB')
    if im.width > 1400:
        im = im.resize((1400, round(im.height * 1400 / im.width)), Image.LANCZOS)
    out = p.with_suffix('.webp')
    im.save(out, 'WEBP', quality=82, method=6)
    p.unlink()
    print(out.name, im.size, out.stat().st_size // 1024, 'KB')
