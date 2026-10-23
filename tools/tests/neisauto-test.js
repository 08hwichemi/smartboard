// 🔁 확장 프로그램 자동 조회: 가짜 나이스(eXBuilder6처럼 생긴 화면 — 위 메뉴 교과담임 → 접힌 왼쪽 메뉴 시간표관리 → 전체시간표조회,
// 변경수업조회 동그라미, 일자 칸 + 하루빼기/더하기 단추, 눌러서 펼치는 학년 목록, 조회 단추, 보고서 뷰어 프레임)에서
// 나이스에 로그인하면(시각이 지났고 오늘 안 했으면) 저절로 1·2·3학년을 이번 주 월~금으로 조회 → 스마트보드 탭에 한꺼번에(auto) 넘김,
// 그날 한 번(3시간 지나 다시 로그인하면 한 번 더), 시각 전엔 안 함, 실패하면 이유를 남기고 스마트보드에 알림, "지금 해 보기".
// 실행: cd tools/tests && NODE_PATH=/opt/node22/lib/node_modules node neisauto-test.js
const { chromium } = require('playwright');
const path = require('path');

const EXT = path.resolve(__dirname, '..', 'neis-ext', 'smartboard-neis');
let failures = 0;
function check(label, cond, detail) {
  console.log((cond ? '  ✅ ' : '  ❌ ') + label + (cond ? '' : '  → ' + JSON.stringify(detail)));
  if (!cond) failures++;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const add = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d; };
const reportsServed = [];
let breakGradeList = false; // 학년 목록이 안 펼쳐지는 경우(실패 기록 시험)

// 가짜 나이스 메인 화면
const neisMain = `<!doctype html><html><head><meta charset="utf-8"><style>.hide{display:none}.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}.cl-combobox-list{position:absolute;background:#fff;border:1px solid #888}</style></head><body>
<div id="sess"><span id="remain">59분 41초</span></div><div id="extdlg" style="display:none"><div class="cl-text">로그인 시간이 얼마 남지 않았습니다.</div><a class="cl-button" onclick="window.extended=(window.extended||0)+1;document.getElementById('remain').textContent='60분 00초';document.getElementById('extdlg').style.display='none'"><div class="cl-text">연장</div></a></div><div id="topnav"><a class="cl-navigationbar-content" id="nav-hak">학급담임 <span>0단계 메뉴항목</span></a> <a class="cl-navigationbar-content" id="nav-gyo">교과담임 <span>0단계 메뉴항목</span></a></div>
<div id="mega" class="hide"><div><span>학교정보</span><a data-role="menuitem">성적/학생부수정이력<span class="sr">1단계 메뉴항목</span></a></div><div><span>교육과정</span><a data-role="menuitem" id="mega-tt"><div class="cl-text">시간표관리</div><span class="sr">1단계 메뉴항목</span></a></div><div><span>학적</span><a data-role="menuitem">출결관리<span class="sr">1단계 메뉴항목</span></a></div></div>
<div id="side" class="hide cl-sidenavigation">
  <a class="cl-folder cl-level-1 cl-expanded" title="시간표관리" id="fold">시간표관리 2단계 메뉴항목</a>
  <div id="leafs"><a class="cl-leaf cl-level-2 cl-sidenavigation-item" title="교사별시간표조회">교사별시간표조회 3단계</a>
  <a class="cl-leaf cl-level-2 cl-sidenavigation-item" title="전체시간표조회" id="leaf">전체시간표조회 3단계</a></div>
</div>
<div id="screen" class="hide">
  <div class="cl-combobox" id="combo"><div class="cl-text cl-preventinput" id="glabel" aria-label="학년, 1">1</div></div>
  <input class="cl-text" aria-label="일자" id="d1"><div class="cl-control cl-button" aria-label="검색시작일 하루빼기" id="d1m">-</div><div class="cl-control cl-button" aria-label="검색시작일 하루더하기" id="d1p">+</div>
  <input class="cl-text" aria-label="일자" id="d2"><div class="cl-control cl-button" aria-label="검색종료일 하루빼기" id="d2m">-</div><div class="cl-control cl-button" aria-label="검색종료일 하루더하기" id="d2p">+</div>
  <div role="radiogroup"><div class="cl-radiobutton-item" role="radio" aria-checked="true"><div class="cl-icon"></div><div class="cl-text">강의실별조회</div></div>
  <div class="cl-radiobutton-item" role="radio" aria-checked="false" id="rchg"><div class="cl-icon"></div><div class="cl-text">변경수업조회</div></div></div>
  <div class="btn-i btn-i-search btn-primary cl-control cl-button" aria-label="조회" id="search"><a class="cl-text-wrapper">조회</a></div>
  <iframe id="viewer" src="about:blank"></iframe>
</div>
<script>
const $ = (id) => document.getElementById(id);
const fmt = (d) => d.getFullYear() + '.' + String(d.getMonth() + 1).padStart(2, '0') + '.' + String(d.getDate()).padStart(2, '0') + '.';
const parse = (v) => { const m = /(\\d{4})\\.(\\d{2})\\.(\\d{2})/.exec(v); return new Date(+m[1], +m[2] - 1, +m[3]); };
$('d1').value = fmt(new Date()); $('d2').value = fmt(new Date());
const shift = (inp, n) => () => { const d = parse(inp.value); d.setDate(d.getDate() + n); setTimeout(() => { inp.value = fmt(d); }, 30); };
$('d1m').addEventListener('mouseup', shift($('d1'), -1)); $('d1p').addEventListener('mouseup', shift($('d1'), 1));
$('d2m').addEventListener('mouseup', shift($('d2'), -1)); $('d2p').addEventListener('mouseup', shift($('d2'), 1));
$('nav-gyo').addEventListener('click', () => setTimeout(() => $('mega').classList.remove('hide'), 200)); // 실제 나이스: 교과담임 → 큰 메뉴판
$('mega-tt').addEventListener('click', () => { $('mega').classList.add('hide'); setTimeout(() => $('side').classList.remove('hide'), 400); });
$('leaf').addEventListener('click', () => setTimeout(() => $('screen').classList.remove('hide'), 600));
$('rchg').addEventListener('mousedown', () => { document.querySelectorAll('[role=radio]').forEach((r) => r.setAttribute('aria-checked', 'false')); $('rchg').setAttribute('aria-checked', 'true'); });
$('combo').addEventListener('mousedown', () => {
  if (window.breakList || document.querySelector('.cl-combobox-list')) return;
  const l = document.createElement('div'); l.className = 'cl-combobox-list'; l.setAttribute('role', 'listbox');
  [1, 2, 3].forEach((g) => { const o = document.createElement('div'); o.setAttribute('role', 'option'); o.className = 'cl-combobox-item'; o.textContent = g;
    o.addEventListener('click', () => { $('glabel').textContent = g; $('glabel').setAttribute('aria-label', '학년, ' + g); l.remove(); }); l.appendChild(o); });
  document.body.appendChild(l);
});
$('search').addEventListener('click', () => {
  const q = 'g=' + $('glabel').textContent + '&f=' + $('d1').value + '&t=' + $('d2').value + '&c=' + ($('rchg').getAttribute('aria-checked') === 'true' ? 1 : 0);
  $('viewer').src = '/thirdparty/crownix/crownixhtml.jsp?' + q;
});
</script></body></html>`;
const viewer = `<!doctype html><html><body><script>var x=new XMLHttpRequest();x.open('POST','/report/service?token=t&'+location.search.slice(1));x.send();</script></body></html>`;
function reportXml(url) {
  const p = new URL(url).searchParams, c8 = (s) => s.replace(/\./g, '');
  return '<?xml version="1.0" encoding="utf-8"?><MML version="2.9"><DOCUMENT><HEAD><VALIST><VA key="$4">' + p.get('g') + '</VA><VA key="$6">' + c8(p.get('f')) + '</VA><VA key="$7">' + c8(p.get('t')) + '</VA></VALIST></HEAD><BODY><PG no="1"><PR><TL>전체시간표 (' + (p.get('c') === '1' ? '변경수업' : '강의실별') + ')</TL></PR></PG></BODY></MML>';
}

(async () => {
  const ctx = await chromium.launchPersistentContext('', { executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', headless: true, viewport: { width: 1400, height: 900 }, args: ['--headless=new', '--disable-extensions-except=' + EXT, '--load-extension=' + EXT] });
  await ctx.route('**/*', (r) => {
    const u = r.request().url();
    if (u.startsWith('chrome-extension://')) return r.continue();
    if (u.startsWith('https://ice.neis.go.kr/jsp/main.jsp')) return r.fulfill({ contentType: 'text/html; charset=utf-8', body: neisMain.replace('<script>', '<script>window.breakList=' + breakGradeList + ';') });
    if (u.includes('/thirdparty/crownix/crownixhtml.jsp')) return r.fulfill({ contentType: 'text/html; charset=utf-8', body: viewer });
    if (u.includes('/report/service')) { reportsServed.push(new URL(u).search); return r.fulfill({ contentType: 'text/xml;charset=utf-8', body: reportXml(u) }); }
    if (u.startsWith('https://08hwichemi.github.io/smartboard/')) return r.fulfill({ contentType: 'text/html; charset=utf-8', body: '<html><body>스마트보드<script>window.got=[];window.st=[];window.addEventListener("message",function(e){var d=e.data||{};if(d.__sbNeis==="reports")window.got.push(d.reports.map(function(r){return {id:r.id,what:r.what,auto:r.auto};}));if(d.__sbNeis==="status")window.st.push(d.msg);});</script></body></html>' });
    return r.abort();
  });
  const ex = await ctx.newPage(); await ex.goto('chrome://extensions'); await wait(800);
  const id = await ex.evaluate(() => [...document.querySelector('extensions-manager').shadowRoot.querySelector('extensions-item-list').shadowRoot.querySelectorAll('extensions-item')].map((e) => e.id)[0]);
  const pop = await ctx.newPage(); await pop.goto('chrome-extension://' + id + '/popup.html'); await wait(300);
  const bg = (m) => pop.evaluate((m) => new Promise((res) => chrome.runtime.sendMessage(m, res)), m);
  const status = () => bg({ t: 'status' });
  const weekday = [1, 2, 3, 4, 5].includes(new Date().getDay());
  const sb = await ctx.newPage(); await sb.goto('https://08hwichemi.github.io/smartboard/'); await wait(400);

  console.log('== 1. 시각 전이면 로그인해도 안 함');
  const later = new Date(Date.now() + 2 * 3600000), early = String(later.getHours()).padStart(2, '0') + ':' + String(later.getMinutes()).padStart(2, '0');
  await bg({ t: 'setAuto', auto: { on: true, time: later.getDate() === new Date().getDate() ? early : '23:59' } });
  let neis = await ctx.newPage(); await neis.goto('https://ice.neis.go.kr/jsp/main.jsp'); await wait(2500);
  check('조회 안 함', reportsServed.length === 0 && !(await status()).running, reportsServed);

  console.log('== 2. 시각이 지났고 오늘 안 했으면 → 나이스 로그인(메인 화면)하자마자 자동 조회');
  await bg({ t: 'setAuto', auto: { time: '00:00' } });
  if (!weekday) { console.log('  (주말이라 "지금 해 보기"로 대신)'); await bg({ t: 'runNow' }); }
  else { await neis.reload(); }
  for (let i = 0; i < 60 && !(await status()).lastRun; i++) await wait(500);
  let st = await status();
  check('자동 조회 성공(1·2·3학년)', st.lastRun && st.lastRun.ok && JSON.stringify(st.lastRun.grades) === '[1,2,3]', st.lastRun);
  check('메뉴를 따라 들어감(교과담임 → 메뉴판 시간표관리 → 왼쪽 전체시간표조회 → 변경수업조회)', st.lastRun && ['위 메뉴 교과담임', '메뉴판 시간표관리', '왼쪽 메뉴 전체시간표조회', '변경수업조회 고름'].every((s) => st.lastRun.steps.some((x) => x.s === s)), st.lastRun && st.lastRun.steps.map((x) => x.s));
  const want = (d) => ymd(d).replace(/-/g, '.') + '.';
  const wd0 = new Date().getDay(), monOff = wd0 === 0 ? -6 : 1 - wd0;
  check('일자 = 이번 주 월 ~ 금', reportsServed.length === 3 && reportsServed.every((q) => decodeURIComponent(q).includes('f=' + want(add(monOff))) && decodeURIComponent(q).includes('t=' + want(add(monOff + 4))) && q.includes('c=1')), reportsServed.map(decodeURIComponent));
  check('학년 1 → 2 → 3 차례로', reportsServed.map((q) => /g=(\d)/.exec(q)[1]).join() === '1,2,3', reportsServed);
  check('오늘 한 것으로 기록', st.lastAutoDate === ymd(new Date()), st.lastAutoDate);
  await wait(800);
  const got = await sb.evaluate(() => window.got);
  check('스마트보드엔 끝난 뒤 한꺼번에(3개, 자동 표시) — 하나씩 따로 오지 않음', got.length >= 1 && got.every((g) => g.length === 3) && got[0].every((r) => r.auto), got);

  console.log('== 3. 곧바로 다시 로그인하면 안 함 · 3시간 지나 다시 로그인하면 한 번 더');
  const n3 = reportsServed.length;
  await neis.reload(); await wait(2500);
  check('3시간 안에 다시 로그인하면 조회 안 함', reportsServed.length === n3, reportsServed.length - n3);
  if (weekday) {
    await sb.evaluate((ids) => window.postMessage({ __sbNeis: 'ack', ids: ids }, '*'), got[got.length - 1].map((r) => r.id)); await wait(300);
    await pop.evaluate(() => chrome.storage.local.set({ lastAutoAt: Date.now() - 4 * 3600000 }));
    const at3 = (await status()).lastRun.at;
    await neis.reload();
    for (let i = 0; i < 60 && (await status()).lastRun.at === at3; i++) await wait(500);
    await wait(500);
    check('3시간 지나 다시 로그인하면 한 번 더(1·2·3학년)', reportsServed.length === n3 + 3 && (await status()).lastRun.ok, reportsServed.length - n3);
    await neis.reload(); await wait(2500);
    check('그 뒤 곧바로 다시 로그인하면 또 안 함', reportsServed.length === n3 + 3, reportsServed.length - n3);
  } else console.log('  (주말이라 로그인 조회는 건너뜀)');

  console.log('== 4. 실패하면 이유를 남기고 스마트보드에 알림 + "지금 해 보기"');
  await sb.evaluate((ids) => window.postMessage({ __sbNeis: 'ack', ids: ids }, '*'), (await sb.evaluate(() => window.got)).flat().map((r) => r.id)); await wait(300);
  breakGradeList = true; await neis.reload(); await wait(1500);
  const n4 = reportsServed.length;
  await bg({ t: 'runNow' });
  for (let i = 0; i < 80 && (await status()).running !== null; i++) await wait(500);
  await wait(500);
  st = await status();
  const bad = st.lastRun && st.lastRun.steps.find((x) => /^✗ 2학년을 고르지 못함/.test(x.s));
  check('2학년을 못 고르면 실패로 기록 + 그 자리 화면 정보', st.lastRun && !st.lastRun.ok && bad && bad.info && bad.info.combo && bad.info.combo.length === 1, st.lastRun && st.lastRun.steps.map((x) => x.s));
  check('1학년 것은 받아서 넘김, 실패 알림', reportsServed.length === n4 + 1 && (await sb.evaluate(() => window.st)).some((m) => /끝내지 못했어요\(1학년만 받음\)/.test(m)), [reportsServed.length - n4, await sb.evaluate(() => window.st)]);
  const pop2 = await ctx.newPage(); await pop2.goto('chrome-extension://' + id + '/popup.html'); await wait(1000);
  const popText = await pop2.evaluate(() => document.getElementById('auto').innerText);
  check('팝업에 마지막 실패와 이유(오늘 아침 것은 끝났다고)', /❌ 마지막 자동 조회 실패/.test(popText) && /2학년을 고르지 못함/.test(popText) && /오늘 아침 조회는 끝났어요/.test(popText), popText);

  console.log('== 5. 나이스 로그인 자동 연장: 남은 시간이 10분 이하이고 "연장" 단추가 보일 때만 누름');
  const keep = () => pop.evaluate(() => new Promise((res) => chrome.tabs.query({ url: 'https://*.neis.go.kr/jsp/main.jsp*' }, (ts) => chrome.tabs.sendMessage(ts[0].id, { t: 'keepAlive' }, { frameId: 0 }, res))));
  let k = await keep();
  check('남은 시간이 많으면 안 누름(59분 41초)', k && k.left === 59 * 60 + 41 && !k.pressed && !(await neis.evaluate(() => window.extended)), k);
  await neis.evaluate(() => { document.getElementById('remain').textContent = '9분 30초'; document.getElementById('extdlg').style.display = 'block'; });
  k = await keep();
  check('10분 이하 + 연장 단추가 보이면 누름 → 남은 시간이 다시 60분', k && k.pressed && (await neis.evaluate(() => window.extended)) === 1 && (await neis.evaluate(() => document.getElementById('remain').textContent)) === '60분 00초', k);
  await neis.evaluate(() => { document.getElementById('remain').textContent = '8분 10초'; const b = document.createElement('a'); b.id = 'iconext'; b.setAttribute('aria-label', '로그인 시간 연장'); b.innerHTML = '<i>⟳</i>'; b.onclick = function () { window.extended++; document.getElementById('remain').textContent = '60분 00초'; b.remove(); }; document.getElementById('sess').appendChild(b); });
  k = await keep();
  check('글자 없는 그림 단추(시간 옆, 이름표 "로그인 시간 연장")도 누름', k && k.pressed && (await neis.evaluate(() => window.extended)) === 2, k);
  await neis.evaluate(() => { document.getElementById('remain').textContent = '5분 00초'; });
  k = await keep();
  check('단추가 안 보이면 누르지 않고 "못 찾음"으로 알림', k && !k.pressed && k.noButton && (await neis.evaluate(() => window.extended)) === 2, k);
  await bg({ t: 'setAuto', auto: { keepLogin: false } });
  check('팝업에서 끄면 꺼진 것으로 저장', (await status()).auto.keepLogin === false);

  await ctx.close();
  console.log(failures ? '\n실패 ' + failures + '개' : '\n모든 검사 통과');
  process.exit(failures ? 1 : 0);
})();
