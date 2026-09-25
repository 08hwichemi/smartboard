# 부광고 스마트보드

교무실 화면(TV/키오스크)에 띄워 두는 대시보드. 시계·시간표·공지·급식·날씨·할 일을 한 화면에 모아 보여줍니다.
원래 구글 앱스크립트 + 구글시트로 돌아가던 것을, GitHub Pages + Supabase로 옮겼습니다.

**개발**: 이용휘

---

## 어디서든 코드 고치는 법

이 저장소를 깃허브에서 연 다음, 주소창에서 `github.com` → **`github.dev`** 로 바꾸면 (또는 파일 목록 화면에서 키보드 `.` 를 누르면) 브라우저 안에서 바로 VS Code가 열립니다. 설치할 것도 로그인할 것도 없고, 아이패드에서도 됩니다.

고친 뒤 왼쪽 소스 제어 탭에서 메시지를 쓰고 커밋하면 그대로 저장됩니다.

---

## 로그인이 없습니다

이 화면은 교무실 공용 화면이라 **로그인이 없습니다.** 링크만 있으면 누구나 공지를 올리고 시간표·감독표를 고칠 수 있습니다 — 원래 구글 앱스크립트 웹앱도 같은 방식이었습니다. 그래서 아래 세 표(공지사항·시간표·감독표)만 Supabase에 있고, 민감한 개인정보는 다루지 않습니다.

날씨·급식·학사일정은 공개 API(open-meteo, 나이스 교육정보 개방포털)를 그대로 불러오고, 캘린더 메모·즐겨찾기·할 일 등은 각자 브라우저의 `localStorage`에만 저장됩니다(기기마다 따로).

---

## 파일 구조

```
.
├── index.html    화면 전체 (위젯 스타일 + 데이터 불러오기 스크립트가 한 파일에 있습니다)
└── docs/
    ├── 이어서-작업하기.md              다른 곳에서 이어 작업할 때 먼저 읽는 문서
    └── NEIS-시간표-연동-설계.md        나이스 학급 시간표 연동 설계 + 진행 상황
```

### 고칠 곳 찾기

| 하고 싶은 일 | 볼 곳 |
|---|---|
| 공지·시간표·감독표를 서버에서 가져오는 방식 바꾸기 | `index.html` 안 `gasGetDuty`/`gasSetDuty`/`gasGetNotice`/`gasGetSchedule` 등 `gas` 로 시작하는 함수들 |
| 화면 모양(위젯 배치·색) 바꾸기 | `index.html` 안 `<style>` |
| 날씨·급식·학사일정 API 바꾸기 | `fetchWeather()`, `updateMeal()`, `renderHalfCalendar()`/`renderBigCalendar()` |
| 전체 선생님 시간표 엑셀 업로드 양식 바꾸기 | `index.html` 안 `parseTimetableWorkbook()` (요일 셀과 "N교시" 글자 위치를 스스로 찾아서 읽습니다) |
| 나이스 학급 시간표 연동 | `index.html` 안 `NEIS_TIMETABLE_SVC`/`gasFetchNeisClassTimetable` 등 `neis` 로 시작하는 함수들, 자세한 설계는 `docs/NEIS-시간표-연동-설계.md` |

### ⚠️ 스크립트는 일반 `<script>` 입니다 — `type="module"` 로 바꾸지 마세요

버튼들이 `onclick="..."` 처럼 **함수를 이름으로 직접 부릅니다.** 모듈로 바꾸면 함수가 전역에서 사라져 모든 버튼이 한꺼번에 죽습니다.

---

## 데이터베이스 (Supabase)

프로젝트: `pqreeimkjnphupqqwiqo`

| 테이블 | 용도 | 비고 |
|---|---|---|
| `notices` | 공지사항 | 좋아요·하트는 `bump_reaction()` 함수로 원자적으로 더하고 뺍니다 |
| `timetable` | 선생님 시간표 | `teacher_name` 유니크, `cells`는 35칸(월~금 × 1~7교시) jsonb 배열 |
| `duty_roster` | 야자·급식·아침 감독표 세 개를 한 표로 | `board` 컬럼으로 구분(`'야자감독'`/`'급식감독'`/`'아침감독'`), `col_index`로 몇 번째 이름칸인지 |
| `neis_timetable_snapshot` | 나이스 학급 시간표를 조회한 기록(스냅샷) | 아직 시험 조회 화면에서만 씀, 자세한 내용은 `docs/NEIS-시간표-연동-설계.md` |

로그인이 없는 화면이라 **RLS가 `anon`에게 모두 열려 있습니다** (읽기·쓰기·수정·삭제). 확인 방법:

```bash
curl -s "https://pqreeimkjnphupqqwiqo.supabase.co/rest/v1/notices?select=*&limit=3" \
  -H "apikey: sb_publishable_3LTnOme1yT3sNFka2PhUHQ_MWuTPYK1"
```

행이 있으면(또는 빈 배열 `[]`이면) 정상입니다.

---

## 로컬에서 실행하기

```bash
npx serve
```

## 배포

GitHub Pages — `https://08hwichemi.github.io/smartboard/`
