// 개인판 안내 페이지(lite-guide.html) 그림 — lite.html에 예시 자료를 심어 찍고, 크롬·윈도우 화면은 mocks.html로 흉내 낸다.
// 실행: cd tools/guide-lite && XLSX_PATH=…/xlsx.full.min.js NODE_PATH=/opt/node22/lib/node_modules node shots.js  → guide/lite/*.png
// 그 뒤 png→webp: python3 tools/guide-lite/to_webp.py (Pillow). 장면 글은 lite-guide.html의 S 배열.
const { chromium } = require('playwright'); const fs = require('fs'); const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..'); const OUT = path.join(ROOT, 'guide/lite'); const SCR = __dirname;
const html = fs.readFileSync(path.join(ROOT, 'lite.html'), 'utf8');
const BUILD_ID = (/var BUILD_ID = '([^']+)'/.exec(html) || [])[1] || 'x';
const XL = process.env.XLSX_PATH;
const today = new Date(); const ymd = (d) => d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
const dash = (s) => s.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
const addD = (n) => { const d = new Date(today); d.setDate(d.getDate() + n); return d; };
function seed() {
  const s = { name: '김하늘', school: { name: '한빛고등학교', edu: 'J10', eduName: '경기도교육청', code: '7530000', kind: '고등학교', addr: '경기도 ○○시 한빛로 12' }, lat: null, lon: null, hrGrade: 2, hrClass: 3, gradeCount: 3, classCount: 10, setupDone: true,
    classTimes: [{ s: '08:50', e: '09:40' }, { s: '09:50', e: '10:40' }, { s: '10:50', e: '11:40' }, { s: '11:50', e: '12:40' }, { s: '13:40', e: '14:30' }, { s: '14:40', e: '15:30' }, { s: '15:45', e: '16:35' }],
    day: { homeroom: { s: '08:40', e: '08:50' }, lunch: { s: '12:40', e: '13:40' }, clean: null, closing: { s: '16:35', e: '16:45' } }, dayParams: { start: '08:50', len: 50, brk: 10, homeroom: 10, lunchAfter: 4, lunch: 60, cleanAfter: 0, clean: 10, closing: 10 } };
  const o = { 'device-lite-banner-snooze': new Date().toISOString().slice(0, 10), 'lite-settings': JSON.stringify(s), 'my-n': '김하늘',
    'bookmarks': JSON.stringify([{ name: '나이스', url: 'https://www.neis.go.kr' }, { name: '학교 홈페이지', url: 'https://example.com' }, { name: '구글 클래스룸', url: 'https://classroom.google.com' }, { name: '에듀넷', url: 'https://www.edunet.net' }, { name: '교육청', url: 'https://example.com' }, { name: '독서교육', url: 'https://example.com' }, { name: '', url: '' }, { name: '', url: '' }]),
    'lite-roster-2-3': JSON.stringify([{ n: 1, name: '강하람' }, { n: 2, name: '김도윤' }, { n: 3, name: '김서연' }, { n: 4, name: '박지호' }, { n: 5, name: '서예린' }, { n: 6, name: '이준서' }, { n: 7, name: '정민재' }, { n: 8, name: '최수아' }, { n: 9, name: '한지우' }, { n: 10, name: '홍다온' }]),
    ['cal-memo-' + dash(ymd(addD(2)))]: '2-3 상담 (박지호 어머니) 16:00', ['cal-memo-' + dash(ymd(addD(5)))]: '수행평가 채점 마감', ['cal-memo-' + dash(ymd(addD(8)))]: '동아리 발표회 준비' };
  const tt = { '1-1': ['화학Ⅰ', '2-3'], '2-1': ['화학Ⅰ', '2-5'], '4-1': ['통합과학', '1-2'], '1-2': ['화학Ⅰ', '2-1'], '3-2': ['통합과학', '1-4'], '5-2': ['화학Ⅰ', '2-3'], '2-3': ['통합과학', '1-2'], '3-3': ['화학Ⅰ', '2-5'], '6-3': ['화학Ⅰ', '2-1'], '1-4': ['통합과학', '1-4'], '4-4': ['화학Ⅰ', '2-3'], '7-4': ['동아리', '과학실'], '2-5': ['화학Ⅰ', '2-5'], '3-5': ['화학Ⅰ', '2-1'], '5-5': ['통합과학', '1-2'] };
  Object.keys(tt).forEach((k) => { o['my-tt-' + k + '-s'] = tt[k][0]; o['my-tt-' + k + '-r'] = tt[k][1]; });
  ['work-txt1', 'work-txt2', 'work-txt3'].forEach((k, i) => { o[k] = ['수행평가 채점 마감(금)', '교외체험학습 결과보고서 확인', '2학기 독서활동 입력'][i]; });
  return o;
}
const HL = 'outline: 3px solid #E8590C !important; outline-offset: 2px; border-radius: 10px;';
async function shot(page, name, opts = {}) {
  if (opts.hl) await page.evaluate(([sel, css]) => { document.querySelectorAll(sel).forEach((el) => { el.dataset.hlOld = el.getAttribute('style') || ''; el.setAttribute('style', el.dataset.hlOld + ';' + css); }); }, [opts.hl, HL]);
  await page.waitForTimeout(120);
  await page.screenshot({ path: path.join(OUT, name + '.png'), clip: opts.clip });
  if (opts.hl) await page.evaluate((sel) => { document.querySelectorAll(sel).forEach((el) => { el.setAttribute('style', el.dataset.hlOld); }); }, opts.hl);
}
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGEERR', String(e)));
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.includes('lite.html')) return route.fulfill({ body: html, contentType: 'text/html; charset=utf-8' });
    if (url.includes('version.txt')) return route.fulfill({ body: BUILD_ID, contentType: 'text/plain' });
    if (url.includes('absence/forms.json')) return route.fulfill({ body: fs.readFileSync(path.join(ROOT, 'absence/forms.json')), contentType: 'application/json' });
    if (url.includes('sgb/2026-guide.json')) return route.fulfill({ body: fs.readFileSync(path.join(ROOT, 'sgb/2026-guide.json')), contentType: 'application/json' });
    if (url.includes('xlsx.full.min.js') && XL && fs.existsSync(XL)) return route.fulfill({ body: fs.readFileSync(XL, 'utf8'), contentType: 'application/javascript' });
    if (url.includes('mealServiceDietInfo')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ mealServiceDietInfo: [{ head: [] }, { row: [{ DDISH_NM: '잡곡밥<br/>소고기미역국<br/>닭갈비<br/>콩나물무침<br/>배추김치<br/>사과', CAL_INFO: '812 Kcal' }] }] }) });
    if (url.includes('SchoolSchedule')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ SchoolSchedule: [{ head: [] }, { row: [{ AA_YMD: ymd(addD(3)), EVENT_NM: '학부모 상담주간' }, { AA_YMD: ymd(addD(9)), EVENT_NM: '전국연합학력평가' }, { AA_YMD: ymd(addD(23)), EVENT_NM: '2차 지필평가' }, { AA_YMD: ymd(addD(40)), EVENT_NM: '학교 축제' }] }] }) });
    if (url.includes('api.open-meteo.com')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ current_weather: { temperature: 14, weathercode: 2 }, daily: { temperature_2m_max: [17], temperature_2m_min: [8] }, hourly: { time: Array.from({ length: 24 }, (_, i) => dash(ymd(today)) + 'T' + String(i).padStart(2, '0') + ':00'), temperature_2m: Array.from({ length: 24 }, (_, i) => 9 + Math.round(8 * Math.sin((i - 5) / 24 * Math.PI))), weathercode: Array.from({ length: 24 }, () => 2) } }) });
    if (url.includes('air-quality')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ current: { pm10: 22, pm2_5: 11 } }) });
    if (url.includes('/functions/v1/news')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ categories: { '종합': [{ title: '교육부, 2027학년도 고교학점제 안착 지원 방안 발표', link: '#', source: '뉴스', pubDate: new Date(Date.now() - 20 * 60000).toISOString() }, { title: '전국 고등학교 2차 지필평가 일정 안내', link: '#', source: '교육', pubDate: new Date(Date.now() - 90 * 60000).toISOString() }, { title: '겨울방학 앞두고 학교별 독서 프로그램 운영', link: '#', source: '신문', pubDate: new Date(Date.now() - 3 * 3600000).toISOString() }] } }) });
    if (url.includes('cdn.jsdelivr.net/gh/orioncactus/pretendard')) return route.abort();
    return route.abort();
  });
  await page.addInitScript((obj) => { Object.keys(obj).forEach((k) => localStorage.setItem('lite:' + k, obj[k])); }, seed());
  await page.goto('http://app.test/lite.html');
  await page.waitForFunction(() => typeof syncAppStarted !== 'undefined' && syncAppStarted === true, null, { timeout: 15000 });
  await page.waitForTimeout(1500);
  // 홈
  await shot(page, 'home');
  await shot(page, 'home-top', { clip: { x: 70, y: 0, width: 1530, height: 118 }, hl: '.top-center-bar' });
  await shot(page, 'home-tt', { clip: { x: 70, y: 310, width: 440, height: 690 } });
  await shot(page, 'home-right', { clip: { x: 940, y: 120, width: 660, height: 880 } });
  await shot(page, 'home-left', { clip: { x: 70, y: 120, width: 440, height: 190 } });
  await page.evaluate(() => switchMainTab('cal')); await page.waitForTimeout(400);
  await shot(page, 'home-cal', { clip: { x: 70, y: 310, width: 870, height: 690 } });
  await page.evaluate(() => switchMainTab('halfcal')); await page.waitForTimeout(300);
  // 설정
  await page.click('#rail-settings-btn'); await page.waitForTimeout(300);
  await shot(page, 'settings', { hl: '#lite-sec-backup button.accent' });
  await page.evaluate(() => { document.querySelector('#lite-setup-overlay .modal-box').scrollTop = 0; });
  await shot(page, 'settings-name', { clip: { x: 500, y: 0, width: 600, height: 420 }, hl: '#lite-name' });
  await shot(page, 'settings-school', { clip: { x: 500, y: 0, width: 600, height: 560 }, hl: '#lite-school-q' });
  await page.evaluate(() => { document.getElementById('lite-sec-backup').nextElementSibling.nextElementSibling.nextElementSibling.scrollIntoView(); }); await page.waitForTimeout(200);
  await shot(page, 'settings-times', { clip: { x: 500, y: 0, width: 600, height: 760 }, hl: '#lite-fill-row' });
  await page.evaluate(() => { const m = document.querySelector('#lite-setup-overlay .modal-box'); m.scrollTop = m.scrollHeight; }); await page.waitForTimeout(200);
  await shot(page, 'settings-save', { clip: { x: 500, y: 300, width: 600, height: 700 }, hl: '#lite-setup-overlay .modal-box > div:last-child button' });
  await page.click('#lite-setup-close'); await page.waitForTimeout(200);
  // 명렬표
  await page.click('#rail-roster-btn'); await page.waitForTimeout(500);
  await shot(page, 'roster', { clip: { x: 60, y: 0, width: 520, height: 600 }, hl: '#lite-roster-tools > div:first-child' });
  await page.click('#roster-modal-box button:has-text("닫기")'); await page.waitForTimeout(200);
  // 좌석배치표
  await page.click('#rail-seatchart-btn'); await page.waitForTimeout(1200);
  await page.evaluate(() => { try { document.getElementById('sc-cols').value = 3; document.getElementById('sc-rows').value = 4; document.getElementById('sc-pair').value = 1; } catch (e) {} });
  await shot(page, 'seatchart');
  // 결석계
  await page.click('#rail-absence-btn'); await page.waitForTimeout(1200);
  await shot(page, 'absence');
  // 조퇴증
  await page.click('#rail-leavepass-btn'); await page.waitForTimeout(800);
  await shot(page, 'leavepass');
  // 수행평가
  await page.click('#rail-pa-btn'); await page.waitForTimeout(900);
  await shot(page, 'pa');
  // 생기부
  await page.click('#rail-sgb-btn'); await page.waitForTimeout(500);
  await page.evaluate(() => { document.getElementById('sgb-text').value = '화학 반응의 양적 관계를 탐구하는 실험에서 몰 농도 계산 과정을 꼼꼼히 기록하고, 오차의 원인을 스스로 분석하여 보고서에 반영함. 모둠 활동에서 역할을 분담하고 친구들의 의견을 경청하는 태도가 돋보임.'; renderSgb(); }); await page.waitForTimeout(300);
  await shot(page, 'sgb');
  await page.evaluate(() => setSgbTab('edit')); await page.waitForTimeout(900);
  await shot(page, 'sgb-edit');
  // 양식
  await page.click('#rail-forms-btn'); await page.waitForTimeout(900);
  await shot(page, 'forms');
  // 월간일정표
  await page.click('#rail-monthly-btn'); await page.waitForTimeout(900);
  await shot(page, 'monthly');
  // 단축키
  await page.click('#rail-hwpkeys-btn'); await page.waitForTimeout(500);
  await shot(page, 'hwpkeys', { clip: { x: 60, y: 0, width: 760, height: 700 } });
  await page.click('#rail-home-btn'); await page.waitForTimeout(300);
  // 백업 창
  await page.evaluate(() => { liteBackupRefreshStatus(); document.getElementById('backup-overlay').style.display = 'flex'; }); await page.waitForTimeout(200);
  await shot(page, 'backup', { clip: { x: 560, y: 200, width: 480, height: 600 }, hl: '#backup-overlay .lite-only button.accent' });
  await shot(page, 'backup-restore', { clip: { x: 560, y: 200, width: 480, height: 600 }, hl: '#json-backup-input + button' });
  await page.evaluate(() => { document.getElementById('backup-overlay').style.display = 'none'; });
  // 크롬·윈도우 흉내 그림
  const mp = await ctx.newPage();
  await mp.route('**/*', (route) => { const u = route.request().url(); if (u.includes('mocks.html')) return route.fulfill({ body: fs.readFileSync(path.join(SCR, 'mocks.html'), 'utf8'), contentType: 'text/html; charset=utf-8' }); if (u.endsWith('home.png')) return route.fulfill({ body: fs.readFileSync(path.join(OUT, 'home.png')), contentType: 'image/png' }); return route.abort(); });
  await mp.goto('http://app.test/mocks.html'); await mp.waitForTimeout(500);
  for (const id of ['m-addr', 'm-install', 'm-apps', 'm-run', 'm-dual', 'm-move']) { await mp.locator('#' + id).screenshot({ path: path.join(OUT, id.slice(2) + '.png') }); }
  await browser.close();
  console.log('shots:', fs.readdirSync(OUT).length);
})().catch((e) => { console.error(e); process.exit(1); });
