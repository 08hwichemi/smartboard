# 양식 만들기 — 한글(.hwpx) 바탕 파일

`skeleton.hwpx`는 빈 한글 문서입니다. "양식" 화면에서 한글 파일로 내려받을 때 이 파일을 열어서
`Contents/header.xml`(글꼴·글자 모양·문단 모양·테두리)에 필요한 것만 더하고
`Contents/section0.xml`(본문)을 새로 써서 다시 묶습니다(`index.html`의 `fmBuildHwpx`).

- 출처: [python-hwpx](https://github.com/airmang/python-hwpx) 6.6.0의 `hwpx/data/Skeleton.hwpx`
- 라이선스: Apache License 2.0 — `LICENSE-python-hwpx.txt`, `NOTICE-python-hwpx.txt`
- 바꾸지 말고 그대로 두세요(한글이 정상적으로 여는 기본 구조라서). 새 양식은 본문(section0.xml)만 만들어 넣습니다.
