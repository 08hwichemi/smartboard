// 🧳 개인판(lite.html): 서버 없이 뜨는지, 첫 설정 → 학교 찾기 → 저장, 공용판 요소 숨김, 명렬표 붙여넣기가
// 좌석배치표까지 이어지는지, 내 시간표 직접 입력 저장, 백업 파일, localStorage 'lite:' 분리를 확인한다.
// 실행: cd tools/tests && NODE_PATH=/opt/node22/lib/node_modules node lite-test.js
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(ROOT, process.env.HTML_PATH || 'lite.html'), 'utf8');
const BUILD_ID = (/var BUILD_ID = '([^']+)'/.exec(html) || [])[1] || 'x';

let failures = 0;
function check(label, cond, detail) {
  console.log((cond ? '  ✅ ' : '  ❌ ') + label + (cond ? '' : '  → ' + JSON.stringify(detail)));
  if (!cond) failures++;
}
const wait = (ms) => new Promise(r => setTimeout(r, ms));

const requests = [];
async function openPage(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.route('**/*', route => {
    const url = route.request().url();
    requests.push(url);
    if (url.startsWith('http://app.test/')) {
      if (url.includes('version.txt')) return route.fulfill({ body: BUILD_ID, contentType: 'text/plain' });
      if (url.includes('lite.html')) return route.fulfill({ body: html, contentType: 'text/html; charset=utf-8' });
      return route.fulfill({ status: 404, body: '' });
    }
    if (url.includes('open.neis.go.kr/hub/schoolInfo')) {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ schoolInfo: [{ head: [] }, { row: [
        { ATPT_OFCDC_SC_CODE: 'E10', ATPT_OFCDC_SC_NM: '인천광역시교육청', SD_SCHUL_CODE: '7310046', SCHUL_NM: '부광고등학교', SCHUL_KND_SC_NM: '고등학교', ORG_RDNMA: '인천광역시 부평구 ...' },
        { ATPT_OFCDC_SC_CODE: 'J10', ATPT_OFCDC_SC_NM: '경기도교육청', SD_SCHUL_CODE: '7530999', SCHUL_NM: '부광중학교', SCHUL_KND_SC_NM: '중학교', ORG_RDNMA: '경기도 ...' } ] }] }) });
    }
    if (url.includes('open.neis.go.kr/hub/mealServiceDietInfo')) {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ mealServiceDietInfo: [{ head: [] }, { row: [{ DDISH_NM: '현미밥<br/>된장국 (5.6)<br/>불고기', CAL_INFO: '800 Kcal' }] }] }) });
    }
    if (url.includes('open.neis.go.kr/hub/SchoolSchedule')) {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ SchoolSchedule: [{ head: [] }, { row: [{ AA_YMD: '20261105', EVENT_NM: '테스트 학사일정' }] }] }) });
    }
    if (url.includes('open-meteo.com')) {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ current_weather: { temperature: 12, weathercode: 1 }, daily: { temperature_2m_max: [15], temperature_2m_min: [5] }, hourly: { time: [], temperature_2m: [], weathercode: [] }, current: { pm10: 20, pm2_5: 10 } }) });
    }
    if (url.includes('/functions/v1/news')) {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ categories: { '종합': [{ title: '개인판 뉴스 테스트', link: 'https://example.com', source: '테스트', pubDate: new Date().toISOString() }] } }) });
    }
    return route.abort();
  });
  await page.goto('http://app.test/lite.html');
  await page.waitForFunction(() => typeof syncAppStarted !== 'undefined' && syncAppStarted === true, null, { timeout: 15000 });
  return { page, ctx, errors };
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }).catch(() => chromium.launch());
  let { page, ctx, errors } = await openPage(browser);
  const vis = (sel) => page.isVisible(sel);
  // 진짜(접두어 없는) localStorage — 같은 주소의 iframe 창에서 꺼낸다(개인판은 window.localStorage를 바꿔 끼웠으므로)
  await page.evaluate(() => { const f = document.createElement('iframe'); f.style.display = 'none'; document.body.appendChild(f); window.__realLs = f.contentWindow.localStorage; });

  console.log('== 1. 서버 없이 뜨고 첫 설정이 열린다');
  check('LITE 모드', await page.evaluate(() => LITE === true));
  check('제목 = 내 스마트보드', (await page.title()) === '내 스마트보드');
  check('로그인 창 안 보임', !(await vis('#login-gate-overlay')));
  check('첫 설정 창 보임', await vis('#lite-setup-overlay'));
  check('첫 설정은 닫기 단추 없음', !(await vis('#lite-setup-close')));
  check('supabase 서버 요청 없음(뉴스 공개 함수 빼고)', !requests.some(u => u.includes('supabase.co') && !u.includes('/functions/v1/news')), requests.filter(u => u.includes('supabase.co')));
  check('localStorage는 lite: 접두어로만', await page.evaluate(() => { const real = window.__realLs; const ks = []; for (let i = 0; i < real.length; i++) ks.push(real.key(i)); return ks.length > 0 && ks.every(k => k.startsWith('lite:')); }));

  console.log('== 2. 첫 설정: 이름·학교·담임 반 저장');
  await page.screenshot({ path: 'lite-setup.png' });
  await page.fill('#lite-name', '김하늘');
  await page.fill('#lite-school-q', '부광');
  await page.click('text=🔍 찾기');
  await page.waitForSelector('.lite-school-item');
  check('나이스 학교 검색 결과 2개', (await page.$$('.lite-school-item')).length === 2);
  await page.click('.lite-school-item >> nth=0');
  check('고른 학교 표시', (await page.textContent('#lite-school-picked')).includes('부광고등학교'));
  check('날씨 = 인천 기준', (await page.textContent('#lite-weather-label')).includes('인천'));
  await page.selectOption('#lite-grade-count', '3');
  await page.fill('#lite-class-count', '8');
  await page.selectOption('#lite-hr-grade', '1');
  await page.selectOption('#lite-hr-class', '2');
  await page.fill('#lite-time-s-1', '850'); await page.dispatchEvent('#lite-time-s-1', 'blur');
  check('시간 850 → 08:50', (await page.inputValue('#lite-time-s-1')) === '08:50');
  await Promise.all([page.waitForNavigation(), page.click('text=저장하고 시작하기')]);
  await page.waitForFunction(() => typeof syncAppStarted !== 'undefined' && syncAppStarted === true, null, { timeout: 15000 });
  await wait(800);
  await page.evaluate(() => { const f = document.createElement('iframe'); f.style.display = 'none'; document.body.appendChild(f); window.__realLs = f.contentWindow.localStorage; });
  check('다시 열면 설정 창 없음', !(await vis('#lite-setup-overlay')));
  const s = await page.evaluate(() => liteSettings());
  check('설정 저장됨', s.name === '김하늘' && s.school && s.school.code === '7310046' && s.hrGrade === 1 && s.hrClass === 2 && s.classCount === 8, s);
  check('학교 코드 적용', await page.evaluate(() => EDU_CODE === 'E10' && SCH_CODE === '7310046'));
  check('이름 동그라미', (await page.textContent('#user-chip-name')) === '김하늘');
  check('담임이면 currentTeacher 담임', await page.evaluate(() => currentTeacher.role === '담임' && currentTeacher.homeroom_grade === 1));

  console.log('== 3. 홈: 공용판 요소 숨김, 급식·학사일정·뉴스는 나옴');
  for (const sel of ['#btn-notice', '#quick-school-btns', '#duty-alert-pill', '#notice-widget', '#search-teacher-picker', '#tab-tt', '#rail-persontt-btn', '.m-tt-change-btn', '#btn-logout']) check('숨김 ' + sel, !(await vis(sel)));
  for (const sel of ['#rail-settings-btn', '#rail-roster-btn', '#rail-pa-btn', '#rail-absence-btn', '#rail-leavepass-btn', '#my-tt-widget', '#news-widget', '#meal-widget', '#favorites-panel', '#upcoming-schedule-pill']) check('보임 ' + sel, await vis(sel));
  check('기본 탭 = 1/2 캘린더', await page.evaluate(() => currentMainTab === 'halfcal' && document.getElementById('half-cal-wrapper').style.display !== 'none'));
  check('급식 나옴', (await page.textContent('#meal-list')).includes('불고기'));
  check('학사일정 나옴', (await page.textContent('#upcoming-schedule-teaser')).includes('테스트 학사일정'));
  await page.waitForFunction(() => (document.getElementById('news-list').textContent || '').includes('개인판 뉴스 테스트'), null, { timeout: 5000 }).catch(() => {});
  check('뉴스 나옴(공개 함수 직접 호출)', (await page.textContent('#news-list')).includes('개인판 뉴스 테스트'));
  check('날씨 라벨 인천', (await page.textContent('#weather-location-label')) === '인천');
  check('즐겨찾기 8칸', (await page.$$('#bookmark-grid .fav-cell')).length === 8);
  check('내 시간표 칸 편집 가능', await page.evaluate(() => document.getElementById('my-tt-1-1-s').getAttribute('contenteditable') === 'true'));
  check('일과 시간 적용(1교시 08:50)', await page.evaluate(() => currentTimes[0].s === '08:50'));

  console.log('== 4. 내 시간표 직접 입력 → 저장 → 다시 열어도 남음');
  await page.click('#my-tt-1-1-s');
  await page.keyboard.type('화학');
  await page.click('#my-tt-1-1-r'); await page.keyboard.type('301');
  await page.click('#clock');
  await wait(300);
  check('시간표 칸 저장', (await page.evaluate(() => localStorage.getItem('my-tt-1-1-s'))) === '화학' && (await page.evaluate(() => localStorage.getItem('my-tt-1-1-r'))) === '301');

  console.log('== 5. 명렬표 붙여넣기 → 좌석배치표·결석계가 같은 명단을 씀');
  await page.click('#rail-roster-btn'); await wait(400);
  check('명렬표 열림 + 담임 반(1-2)으로', await vis('#roster-modal-box') && (await page.inputValue('#roster-grade-select')) === '1' && (await page.inputValue('#roster-class-select')) === '2');
  check('개인판 명단 도구 보임', await vis('#lite-roster-tools'));
  check('반 수 8 반영', (await page.$$('#roster-class-select option[value="8"]')).length === 1 && (await page.$$('#roster-class-select option[value="9"]')).length === 0);
  await page.click('text=📋 붙여넣기');
  await page.fill('#lite-roster-paste-text', '1 김하늘 010-1111-2222\n2\t이바다\n박산들');
  await page.click('text=이 반에 넣기'); await wait(400);
  const rows = await page.evaluate(() => liteRosterGet(1, 2));
  check('3명 저장(번호 자동)', rows.length === 3 && rows[2].number === 3 && rows[2].name === '박산들' && rows[0].student_phone === '010-1111-2222', rows);
  check('목록에 3명', (await page.$$('[id^="roster-row-"]')).length === 3);
  check('개수 표시', (await page.textContent('#lite-roster-count')).includes('3명'));
  await page.screenshot({ path: 'lite-roster.png' });
  const sc = await page.evaluate(async () => { const r = await rosterRows(1, 2); return r.data.map(x => x.name); });
  check('rosterRows(좌석배치표·결석계·수행평가 공용) = 같은 명단', JSON.stringify(sc) === JSON.stringify(['김하늘', '이바다', '박산들']), sc);
  const multi = await page.evaluate(async () => { const r = await rosterRows(1, [2, 3]); return r.data.length; });
  check('여러 반 읽기(양식 명렬표 수합)', multi === 3);
  const cs = await page.evaluate(async () => await ensureClassStructureLoaded());
  check('학급 구성 = 설정 3학년·8반', cs.gradeCount === 3 && cs.classCounts[0] === 8, cs);
  await page.evaluate(() => liteRosterSet(2, 12, [{ number: 1, name: '최별' }]));
  const cs2 = await page.evaluate(async () => await ensureClassStructureLoaded());
  check('명렬표에 12반이 있으면 2학년 반 수 12로 늘어남', cs2.classCounts[1] === 12, cs2);
  // 전화번호 수정(개인판은 브라우저에)
  await page.evaluate(() => liteRosterUpdatePhone(10202, '010-9', '010-8', ''));
  check('전화 수정 저장', (await page.evaluate(() => liteRosterGet(1, 2)[1].mother_phone)) === '010-8');

  console.log('== 6. 백업: 파일 내려받기에 설정·명단 포함, 복원');
  const bk = await page.evaluate(() => collectBackupData());
  check('백업에 lite-settings·명단·시간표 포함', !!bk['lite-settings'] && !!bk['lite-roster-1-2'] && bk['my-tt-1-1-s'] === '화학', Object.keys(bk).filter(k => k.startsWith('lite')));
  check('백업에 기기 전용 값 없음', !Object.keys(bk).some(k => k.startsWith('device-')));
  await page.evaluate(() => { window.__dlName = null; const orig = downloadBackupFile; window.downloadBackupFile = function(n) { window.__dlName = n; }; });
  await page.evaluate(() => manualBackupNow());
  const dlName = await page.evaluate(() => window.__dlName);
  check('내려받기 파일 이름', !!dlName && dlName.startsWith('내 스마트보드_백업_') && dlName.endsWith('.json'), dlName);
  check('백업 날짜 기록(오늘은 띠 안 뜸)', (await page.evaluate(() => localStorage.getItem('device-lite-backup-date'))) === (await page.evaluate(() => todayYmdDash())));
  await page.evaluate(() => document.getElementById('custom-alert-ok-btn').click());
  const restored = await page.evaluate(async () => { const data = collectBackupData(); localStorage.removeItem('lite-roster-1-2'); await applyBackupText(JSON.stringify(data)); return liteRosterGet(1, 2).length; });
  check('백업 글로 복원하면 명단 돌아옴', restored === 3);

  console.log('== 7. 설정 창 다시 열기·닫기, 설명서');
  await page.click('#rail-settings-btn'); await wait(200);
  check('설정 창 열림(닫기 있음)', await vis('#lite-setup-overlay') && await vis('#lite-setup-close'));
  check('설정 값 다시 채움', (await page.inputValue('#lite-name')) === '김하늘' && (await page.textContent('#lite-school-picked')).includes('부광고등학교'));
  await page.click('#lite-setup-close'); await wait(100);
  check('설정 창 닫힘', !(await vis('#lite-setup-overlay')));
  await page.click('#user-chip'); await wait(100);
  check('이름 동그라미 눌러도 설정', await vis('#lite-setup-overlay'));
  await page.click('#lite-setup-close');
  const steps = await page.evaluate(() => tourSteps.map(s => s.selector));
  check('설명서에 공지·감독표·시간표 관리 단계 없음', !steps.some(s => ['#btn-notice', '#duty-alert-pill', '#notice-widget', '#schedule-overlay .modal-box', '#duty-overlay .modal-box'].includes(s)) && steps.includes('#my-tt-widget'), steps);
  await page.evaluate(() => openTour()); await wait(300);
  check('설명서 열림', await page.evaluate(() => document.getElementById('tour-overlay').style.display === 'block' && document.getElementById('tour-card-title').innerText.length > 0));
  await page.evaluate(() => closeTour());

  console.log('== 8. 공용판(index.html) 자료와 섞이지 않음');
  const mixed = await page.evaluate(() => { window.__realLs.setItem('my-tt-1-1-s', '공용판값'); return localStorage.getItem('my-tt-1-1-s'); });
  check('공용판 키를 써도 개인판은 제 값', mixed === '화학');
  check('Object.keys(localStorage) 동작', await page.evaluate(() => Object.keys(localStorage).includes('lite-settings') && !Object.keys(localStorage).some(k => k.startsWith('lite:'))));

  check('페이지 JS 오류 없음', errors.length === 0, errors);
  await page.screenshot({ path: 'lite-home.png' });
  // 휴대폰 화면
  const mctx = await browser.newContext({ viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true });
  const mpage = await mctx.newPage();
  const merrors = []; mpage.on('pageerror', e => merrors.push(String(e)));
  await mpage.route('**/*', route => { const url = route.request().url(); if (url.includes('lite.html')) return route.fulfill({ body: html, contentType: 'text/html; charset=utf-8' }); if (url.includes('version.txt')) return route.fulfill({ body: BUILD_ID, contentType: 'text/plain' }); return route.abort(); });
  await mpage.addInitScript((s) => { localStorage.setItem('lite:lite-settings', s); }, JSON.stringify(s));
  await mpage.goto('http://app.test/lite.html');
  await mpage.waitForFunction(() => typeof syncAppStarted !== 'undefined' && syncAppStarted === true, null, { timeout: 15000 });
  await wait(800);
  await mpage.screenshot({ path: 'lite-mobile.png' });
  check('휴대폰 화면 JS 오류 없음', merrors.length === 0, merrors);
  await browser.close();
  console.log(failures ? ('\n실패 ' + failures + '건') : '\n모든 검사 통과');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
