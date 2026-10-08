// 가짜 Supabase 서버(Node 메모리) 하나에 PC/휴대폰 브라우저 두 개를 붙여서
// index.html의 실제 동기화 코드를 시나리오별로 돌려 본다.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(process.env.HTML_PATH || path.join(ROOT, 'index.html'), 'utf8');

// ---------- 가짜 서버 ----------
const T1 = '11111111-1111-1111-1111-111111111111';
const T2 = '22222222-2222-2222-2222-222222222222';
const teachers = {
  [T1]: { id: T1, name: '김교사', is_admin: false, must_change_password: false, role: '교사', homeroom_grade: null, homeroom_class: null },
  [T2]: { id: T2, name: '박교사', is_admin: false, must_change_password: false, role: '교사', homeroom_grade: null, homeroom_class: null },
};
const items = new Map(); // teacher|key -> {teacher_id,key,value,updated_at}
const history = [];
let lastTs = Date.now();
function nowIso() { lastTs = Math.max(Date.now(), lastTs + 1); return new Date(lastTs).toISOString(); }
const pages = []; // {page, name, offline, realtimeDown}

function seed(teacherId, obj) {
  for (const [k, v] of Object.entries(obj)) items.set(teacherId + '|' + k, { teacher_id: teacherId, key: k, value: v, updated_at: nowIso() });
}
function serverVal(teacherId, key) { const r = items.get(teacherId + '|' + key); return r ? r.value : undefined; }

async function fireRealtime(teacherId) {
  for (const p of pages) {
    if (p.realtimeDown || p.page.isClosed()) continue;
    try { await p.page.evaluate((tid) => window.__fireRealtime && window.__fireRealtime('user_data_items', tid), teacherId); } catch (e) {}
  }
}

async function handleDb(pageInfo, req) {
  if (pageInfo.offline && req.table === 'user_data_items') return { data: null, error: { message: 'Failed to fetch (offline)' } };
  const { table, op, filters, orders, range, rows, single, maybe } = req;
  if (table === 'teachers') {
    const f = filters.find(x => x.col === 'id');
    const list = f ? [teachers[f.val]].filter(Boolean) : Object.values(teachers);
    return { data: single || maybe ? (list[0] || null) : list, error: null };
  }
  if (table === 'user_data_items') {
    if (op === 'upsert') {
      const touched = new Set();
      for (const r of rows) {
        if (r.teacher_id !== pageInfo.uid) return { data: null, error: { message: 'RLS violation' } };
        const k = r.teacher_id + '|' + r.key;
        const old = items.get(k);
        if (old && old.value !== r.value) history.push({ teacher_id: r.teacher_id, key: r.key, old_value: old.value });
        items.set(k, { teacher_id: r.teacher_id, key: r.key, value: r.value, updated_at: nowIso() });
        touched.add(r.teacher_id);
      }
      setTimeout(() => { for (const t of touched) fireRealtime(t); }, 50);
      return { data: null, error: null };
    }
    let list = [...items.values()];
    for (const f of filters) {
      if (f.op === 'eq') list = list.filter(r => String(r[f.col]) === String(f.val));
      if (f.op === 'gt') list = list.filter(r => r[f.col] > f.val);
    }
    if (pageInfo.uid) list = list.filter(r => r.teacher_id === pageInfo.uid); // RLS
    list.sort((a, b) => (a.updated_at < b.updated_at ? -1 : a.updated_at > b.updated_at ? 1 : a.key < b.key ? -1 : 1));
    if (range) list = list.slice(range[0], range[1] + 1);
    return { data: list.map(r => ({ key: r.key, value: r.value, updated_at: r.updated_at })), error: null };
  }
  if (table === 'student_timetable_card' && op === 'select') {
    const mk = (cls, n) => ({ num: '2' + String(cls).padStart(2,'0') + String(n).padStart(2,'0'), name: '학생' + cls + '-' + n, motto: '', schedule: [{ day: '월', period: 1, subject: '국어', teacher: '김', room: '201' }] });
    const students = []; for (let c = 1; c <= 2; c++) for (let n = 1; n <= 5; n++) students.push(mk(c, n));
    return { data: [{ grade: 2, students, updated_at: new Date().toISOString() }], error: null };
  }
  if (op === 'select') return { data: single || maybe ? null : [], error: null };
  return { data: null, error: null };
}

// ---------- 브라우저에 심는 가짜 supabase-js ----------
const mockLib = `
(function(){
  const uid = new URLSearchParams(location.search).get('uid');
  const channels = [];
  window.__fireRealtime = function(table, tid) {
    channels.forEach(function(ch){ ch.handlers.forEach(function(h){
      if (h.opts.table !== table) return;
      if (h.opts.filter && h.opts.filter !== 'teacher_id=eq.' + tid) return;
      h.cb({});
    }); });
  };
  function builder(table) {
    const q = { table: table, op: 'select', filters: [], orders: [], range: null, rows: null, single: false, maybe: false };
    const b = {
      select: function(){ return b; },
      eq: function(c,v){ q.filters.push({op:'eq',col:c,val:v}); return b; },
      gt: function(c,v){ q.filters.push({op:'gt',col:c,val:v}); return b; },
      gte: function(){ return b; }, lte: function(){ return b; }, in: function(){ return b; }, limit: function(){ return b; },
      order: function(c){ q.orders.push(c); return b; },
      range: function(a,z){ q.range=[a,z]; return b; },
      single: function(){ q.single=true; return b; },
      maybeSingle: function(){ q.maybe=true; return b; },
      upsert: function(rows){ q.op='upsert'; q.rows=Array.isArray(rows)?rows:[rows]; return b; },
      insert: function(rows){ q.op='insert'; q.rows=rows; return b; },
      update: function(){ q.op='update'; return b; },
      delete: function(){ q.op='delete'; return b; },
      then: function(res, rej){ return window.__db(q).then(res, rej); }
    };
    return b;
  }
  window.supabase = { createClient: function(){
    return {
      auth: {
        getSession: async function(){ return { data: { session: uid ? { user: { id: uid } } : null } }; },
        signOut: async function(){ return {}; },
        signInWithPassword: async function(){ return { error: { message: 'no' } }; },
      },
      from: builder,
      rpc: async function(){ return { data: null, error: null }; },
      functions: { invoke: async function(){ return { data: null, error: { message: 'mock' } }; } },
      channel: function(name){
        const ch = { name: name, handlers: [] };
        ch.on = function(type, opts, cb){ ch.handlers.push({opts: opts, cb: cb}); return ch; };
        ch.subscribe = function(cb){ channels.push(ch); if (cb) setTimeout(function(){ cb('SUBSCRIBED'); }, 10); return ch; };
        return ch;
      },
    };
  }};
})();
`;

async function openDevice(browser, name, uid, opts = {}) {
  const ctx = opts.context || await browser.newContext(opts.mobile ? { viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true } : { viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  const info = { page, ctx, name, uid, offline: !!opts.startOffline, realtimeDown: false };
  pages.push(info);
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  info.errors = errors;
  await page.exposeFunction('__db', (q) => handleDb(info, q));
  if (opts.preload) {
    await page.addInitScript((obj) => {
      if (sessionStorage.getItem('__preloaded')) return;
      sessionStorage.setItem('__preloaded', '1');
      Object.entries(obj).forEach(([k, v]) => localStorage.setItem(k, v));
    }, opts.preload);
  }
  await page.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith('http://app.test/')) {
      if (url.includes('version.txt')) return route.fulfill({ body: 'x', contentType: 'text/plain' });
      if (url.split('?')[0] === 'http://app.test/' || url.includes('index.html')) return route.fulfill({ body: html, contentType: 'text/html; charset=utf-8' });
      return route.fulfill({ status: 404, body: '' });
    }
    if (url.includes('@supabase/supabase-js')) return route.fulfill({ body: mockLib, contentType: 'application/javascript' });
    return route.abort();
  });
  await page.goto('http://app.test/?uid=' + uid);
  await page.waitForFunction(() => window.currentTeacher && typeof syncAppStarted !== 'undefined' && syncAppStarted === true, null, { timeout: 15000 });
  return info;
}

const ls = (d, k) => d.page.evaluate((k) => localStorage.getItem(k), k);
const setLs = (d, k, v) => d.page.evaluate(([k, v]) => localStorage.setItem(k, v), [k, v]);
const rmLs = (d, k) => d.page.evaluate((k) => localStorage.removeItem(k), k);
const dirty = (d) => d.page.evaluate(() => getSyncDirtyKeys());
const wait = (ms) => new Promise(r => setTimeout(r, ms));
async function setVisibility(d, state) {
  await d.page.evaluate((s) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => s });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
}

let failures = 0;
function check(label, cond, detail) {
  console.log((cond ? '  ✅ ' : '  ❌ ') + label + (cond ? '' : '  → ' + JSON.stringify(detail)));
  if (!cond) failures++;
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }).catch(() => chromium.launch());

  const pc = await openDevice(browser, 'PC', T1);
  const P = pc.page;
  await P.click('#rail-monthly-btn'); await wait(800);

  // 넓은 화면(1600): 왼쪽 칸 넓게 두 줄 — 세부 일정이 맨 위부터 오른쪽 줄 / 1366: 예전처럼 한 줄(세부 일정은 맨 아래)
  const msLay = () => P.evaluate(() => { const R = id => document.getElementById(id).getBoundingClientRect(); const i = R('ms-section-info'), c = R('ms-section-cat'), t = R('ms-section-table');
    return { w: document.getElementById('ms-panel').offsetWidth, twoCol: t.left > i.right - 1 && Math.abs(t.top - i.top) < 2 && c.left === i.left, below: t.top > c.bottom, tw: Math.round(t.width) }; });
  const lay1 = await msLay();
  check('넓은 화면: 왼쪽 칸 넓게(700+)·세부 일정이 맨 위 오른쪽 줄', lay1.w >= 700 && lay1.twoCol && lay1.tw >= 380, lay1);
  await P.setViewportSize({ width: 1366, height: 768 }); await wait(400);
  const lay2 = await msLay();
  check('1366: 예전처럼 360 한 줄(세부 일정은 분류 아래)', lay2.w === 360 && lay2.below, lay2);
  await P.setViewportSize({ width: 1600, height: 1000 }); await wait(400);

  const state = () => P.evaluate(() => {
    const heads = [...document.querySelectorAll('#ms-table-body tr.ms-month-head')].map(h => h.innerText.replace(/\s+/g, ' ').trim());
    const rows = msDataRows().map(tr => ({ d: tr.children[0].innerText.trim(), c: tr.children[1].innerText.trim(), m: tr.dataset.month, hidden: tr.offsetParent === null }));
    return { heads, rows, expandAll: document.getElementById('ms-expand-all').checked };
  });

  let s = await state();
  check('처음엔 항상 펼치기 꺼짐', s.expandAll === false, s);
  check('빈 줄 15개는 "새 일정 입력" 묶음에 펼쳐져 있음', s.rows.length === 15 && s.rows.every(r => !r.hidden) && s.heads.length === 1 && /새 일정 입력/.test(s.heads[0]), s);

  // 여러 달 일정 붙여넣기 (엑셀에서 복사한 것처럼)
  await P.click('#ms-table-body tr:not(.ms-example-row):not(.ms-month-head) td:first-child .ms-cell-input');
  await P.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/plain', '3/2\t입학식\n5/5\t어린이날\n3/15\t학부모총회\n1/7\t겨울방학 보충\n5/20\t체육대회');
    document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await wait(400);
  s = await state();
  check('새 일정 입력(예시 줄 바로 아래) + 달 머리줄이 학기 순서(3월→5월→1월)', s.heads.length === 4 && /새 일정 입력/.test(s.heads[0]) && /^▶ 3월 2건/.test(s.heads[1]) && /^▶ 5월 2건/.test(s.heads[2]) && /^▶ 1월 1건/.test(s.heads[3]), s.heads);
  check('항상 펼치기 꺼짐 → 달 일정은 접혀 있음', s.rows.filter(r => r.c).every(r => r.hidden), s.rows);
  check('빈 줄은 계속 보임', s.rows.filter(r => !r.c).every(r => !r.hidden) && s.rows.filter(r => !r.c).length === 10, s.rows);
  check('달력 데이터는 그대로(3월 2일 입학식)', await P.evaluate(() => { msCurMonth = 3; const d = msGetUserData(); return !!(d[msCurYear + '-3-2'] && d[msCurYear + '-3-2'][0].text === '입학식'); }));
  // 🐞 접힌 달(display:none) 줄은 innerText가 줄바꿈을 버려서 달력에 "수능대비분반수업 신청"처럼 붙어 나오다가, 그 달을 펼치면 다시 맞게 나왔다
  const brk = await P.evaluate(() => {
    const tr = msDataRows().find(r => r.dataset.month === '5' && /어린이날/.test(r.textContent));
    const cell = tr.children[1].querySelector('.ms-cell-input');
    cell.innerHTML = '수능대비<br>분반수업 신청';
    const tr2 = msDataRows().find(r => r.dataset.month === '5' && /체육대회/.test(r.textContent));
    tr2.children[1].querySelector('.ms-cell-input').innerHTML = '체육<div>대회</div><div><br></div><div>우천 시 연기</div>';
    msCurMonth = 5; const d = msGetUserData();
    return { hidden: tr.offsetParent === null, a: d[msCurYear + '-5-5'][0].text, b: d[msCurYear + '-5-20'][0].text };
  });
  check('접힌 달의 일정도 줄바꿈 그대로 달력에(<br>·한 줄씩 div)', brk.hidden && brk.a === '수능대비\n분반수업 신청' && brk.b === '체육\n대회\n\n우천 시 연기', brk);
  await P.evaluate(() => { msRenderCalendar(); });
  await wait(300);
  const calTxt = await P.evaluate(() => [...document.querySelectorAll('#ms-cal-grid .ms-event-item')].map(e => e.innerText).filter(t => /수능대비/.test(t))[0] || '');
  check('달력 칸에 두 줄로 그려짐', calTxt.split('\n').length === 2, calTxt);
  // 🔠 달력 일정 글자 크기(① 기본 설정 A− / A+): 일정 글씨·분류 점만 70~150%, 날짜·D-Day 그대로, ms-data.evPct로 저장
  const evSz = () => P.evaluate(() => { const it = document.querySelector('#ms-cal-grid .ms-event-item'); const cs = (el, k) => el ? parseFloat(getComputedStyle(el)[k]) : null;
    return { fs: cs(it, 'fontSize'), dot: cs(it && it.querySelector('.ms-ev-dot'), 'width'), date: cs(document.querySelector('#ms-cal-grid .ms-date-num'), 'fontSize'), dd: cs(document.querySelector('#ms-cal-grid .ms-dday-mini'), 'fontSize'), label: document.getElementById('ms-ev-size-val').textContent, saved: JSON.parse(localStorage.getItem('ms-data')).evPct }; });
  let ev = await evSz();
  check('처음엔 일정 글자 10px·점 6px·100%', ev.fs === 10 && ev.dot === 6 && ev.label === '100%' && ev.saved === 100, ev);
  await P.click('#ms-section-info button[title="일정 글자 크게"]'); await P.click('#ms-section-info button[title="일정 글자 크게"]'); await wait(200);
  ev = await evSz();
  check('A+ 두 번 → 120%: 일정 12px·점 7.2px, D-Day 띠(따로)·날짜 숫자 18px는 그대로, 저장 120', Math.abs(ev.fs - 12) < 0.01 && Math.abs(ev.dot - 7.2) < 0.3 && (ev.dd === null || Math.abs(ev.dd - 8.5) < 0.3) && ev.date === 18 && ev.label === '120%' && ev.saved === 120, ev);
  // ⏳ D-Day 글자는 따로(--ms-dd, ms-data.ddPct)
  await P.click('#ms-section-info button[title="D-Day 글자 크게"]'); await P.click('#ms-section-info button[title="D-Day 글자 크게"]'); await P.click('#ms-section-info button[title="D-Day 글자 크게"]'); await wait(200);
  const dd = await P.evaluate(() => ({ v: getComputedStyle(document.getElementById('ms-a4-paper')).getPropertyValue('--ms-dd').trim(), ev: getComputedStyle(document.getElementById('ms-a4-paper')).getPropertyValue('--ms-ev').trim(), label: document.getElementById('ms-dd-size-val').textContent, saved: JSON.parse(localStorage.getItem('ms-data')).ddPct, evSaved: JSON.parse(localStorage.getItem('ms-data')).evPct }));
  check('D-Day A+ 세 번 → 130%(--ms-dd 1.3), 일정 글자는 120% 그대로, ddPct 130 저장', dd.v === '1.3' && dd.ev === '1.2' && dd.label === '130%' && dd.saved === 130 && dd.evSaved === 120, dd);
  await P.click('#ms-dd-size-val'); await wait(200);
  check('D-Day 숫자 누르면 100%', await P.evaluate(() => document.getElementById('ms-dd-size-val').textContent === '100%' && JSON.parse(localStorage.getItem('ms-data')).ddPct === 100));
  for (let k = 0; k < 7; k++) await P.click('#ms-section-info button[title="일정 글자 작게"]');
  await wait(200); ev = await evSz();
  check('A− 계속 눌러도 70%에서 멈춤(7px)', ev.fs === 7 && ev.label === '70%' && ev.saved === 70, ev);
  await P.click('#ms-ev-size-val'); await wait(200); ev = await evSz();
  check('숫자를 누르면 100%로', ev.fs === 10 && ev.label === '100%' && ev.saved === 100, ev);
  // 넘침 경고: 한 날에 8줄짜리 일정을 넣고 150%로 키우면 그 칸이 넘침 → ① 아래·미리보기 위에 경고, 70%면 사라짐, 줄을 지우면 사라짐
  const warn = () => P.evaluate(() => ({ top: document.getElementById('ms-overflow-warn').textContent, box: document.getElementById('ms-ev-warn').textContent, shown: getComputedStyle(document.getElementById('ms-overflow-warn')).display !== 'none', days: msOverflowDays.slice() }));
  check('넘친 칸이 없으면 경고 없음', !(await warn()).top && !(await warn()).shown, await warn());
  await P.evaluate(() => { document.getElementById('ms-table-body').appendChild(msCreateRow(msCurMonth + '/15', ['진로 특강', '3·4교시', '시청각실', '준비물 지참', '학부모 참관', '사진 촬영', '설문 조사', '정리 정돈'].join('<br>'))); msUpdateSelectOptions(); msGroupRows(); return msRenderCalendar(); }); await wait(300);
  for (let k = 0; k < 5; k++) await P.click('#ms-section-info button[title="일정 글자 크게"]');
  await wait(200); let wn = await warn();
  check('150%에서 15일 칸이 넘치면 경고(①·미리보기 위, 날짜·지금 배율)', wn.shown && /15일/.test(wn.top) && /150%/.test(wn.top) && wn.box === wn.top && wn.days.includes(15), wn);
  await P.evaluate(() => msGuideGo(5)); await wait(300);
  check('"지금 할 일" ⑤에도 넘침 경고 + 일정 글자 숫자 반짝', await P.evaluate(() => /15일/.test(document.getElementById('ms-next').innerText) && document.getElementById('ms-ev-size-val').classList.contains('pa-glow')));
  for (let k = 0; k < 8; k++) await P.click('#ms-section-info button[title="일정 글자 작게"]');
  await wait(200); wn = await warn();
  check('70%로 줄이면 들어가서 경고 사라짐', !wn.shown && !wn.top && !wn.box, wn);
  await P.click('#ms-ev-size-val'); await wait(200);
  await P.evaluate(() => { msDataRows().find(r => /정리 정돈/.test(r.textContent)).remove(); msGroupRows(); return msRenderCalendar(); }); await wait(300);
  wn = await warn();
  check('그 줄을 지우고 100%여도 경고 없음', !wn.shown && !wn.top, wn);
  // D-Day 띠가 칸보다 넓으면(긴 이름 + 150%) 따로 경고
  await P.evaluate(() => { document.getElementById('ms-dd-name-4').value = '아주아주 긴 이름의 커스텀 디데이'; document.getElementById('ms-dd-show-4').checked = true; const t = new Date(msCurYear, msCurMonth, 0); document.getElementById('ms-dd-date-4').value = t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0'); return msRenderCalendar(); }); await wait(300);
  for (let k = 0; k < 5; k++) await P.click('#ms-section-info button[title="D-Day 글자 크게"]');
  await wait(200); wn = await warn();
  check('D-Day 글자 150% + 긴 이름 → "D-Day 띠가 칸보다 넓어" 경고(칸 수·150%), 일정 넘침 경고는 없음', wn.shown && /D-Day 띠가 칸보다 넓어/.test(wn.top) && /150%/.test(wn.top) && !/아래 줄이 잘려요/.test(wn.top), wn);
  await P.evaluate(() => { document.getElementById('ms-dd-name-4').value = ''; document.getElementById('ms-dd-show-4').checked = false; msSizeSet('dd', 100); return msRenderCalendar(); }); await wait(300);
  wn = await warn();
  check('D-Day를 지우고 100%면 경고 없음', !wn.shown && !wn.top, wn);
  await P.evaluate(() => msGuideGo(4)); await wait(200);
  await P.click('#ms-section-info button[title="일정 글자 크게"]'); await P.click('#ms-section-info button[title="일정 글자 크게"]'); await wait(200); // 120%로 두고 아래 다른 기기에서 확인
  await P.evaluate(() => {
    msDataRows().find(r => /수능대비/.test(r.textContent)).children[1].querySelector('.ms-cell-input').innerHTML = '어린이날';
    msDataRows().find(r => /우천/.test(r.textContent)).children[1].querySelector('.ms-cell-input').innerHTML = '체육대회';
  });

  // 머리줄 눌러 한 달만 펼치기
  await P.click('#ms-table-body tr.ms-month-head[data-month="5"]'); await wait(200);
  s = await state();
  check('5월만 펼쳐짐', s.rows.filter(r => r.m === '5').every(r => !r.hidden) && s.rows.filter(r => r.m === '3').every(r => r.hidden) && /^▼ 5월/.test(s.heads[2]), s);
  await P.click('#ms-table-body tr.ms-month-head[data-month="5"]'); await wait(200);
  s = await state();
  check('다시 누르면 접힘', s.rows.filter(r => r.m === '5').every(r => r.hidden), s);

  // 새 줄에 날짜를 적고 줄을 벗어나면 그 달로 옮겨지고 펼쳐짐
  await P.evaluate(() => { const tr = msDataRows().find(r => !r.children[0].innerText.trim()); tr.id = 'newrow'; });
  await P.click('#newrow td:first-child .ms-cell-input');
  await P.keyboard.type('3/10');
  await P.click('#newrow td:nth-child(2) .ms-cell-input'); await wait(200);
  check('같은 줄 내용 칸으로 넘어갈 땐 안 옮겨짐(입력 계속)', await P.evaluate(() => document.activeElement === document.querySelector('#newrow td:nth-child(2) .ms-cell-input') && document.getElementById('newrow').dataset.month === '0'));
  await P.keyboard.type('진단평가');
  await P.click('#ms-cfg-title'); await wait(300);
  s = await state();
  check('줄을 벗어나면 3월 묶음으로 옮겨지고 3월이 펼쳐짐', /^▼ 3월 3건/.test(s.heads[1]) && s.rows.filter(r => r.m === '3').every(r => !r.hidden) && s.rows.filter(r => r.m === '5').every(r => r.hidden), s);
  const saved = JSON.parse(await ls(pc, 'ms-data'));
  check('저장 데이터에 머리줄이 섞이지 않음', saved.table.length === 15 && saved.table.some(r => r.d === '3/10' && r.c === '진단평가'), saved.table);

  // 항상 펼치기 켜기 → 전부 펼침, 기억
  await P.click('#ms-expand-all'); await wait(300);
  s = await state();
  check('항상 펼치기 켜면 모든 달 펼침', s.rows.every(r => !r.hidden) && s.heads.slice(1, 4).every(h => h.startsWith('▼')), s);
  check('설정 기억(localStorage)', await ls(pc, 'ms-expand-all') === '1');
  await wait(1500);
  check('서버(계정)에 저장됨', serverVal(T1, 'ms-expand-all') === '1', serverVal(T1, 'ms-expand-all'));

  // 날짜순 정렬 후에도 묶음 유지
  await P.click('#ms-schedule-table th'); await wait(300);
  s = await state();
  check('정렬 후에도 달별 묶음 유지', s.heads.length === 4 && s.rows.filter(r => r.m === '3').map(r => r.d).join(',') === '3/2,3/10,3/15', s);

  // 5칸 추가 후 패널 맨 아래에서 🗑️를 연달아 눌러도 스크롤이 위로 끌려가지 않음
  await P.setViewportSize({ width: 1400, height: 700 }); await wait(300);
  await P.evaluate(() => { const p = document.getElementById('ms-panel'); p.scrollTop = document.getElementById('ms-section-table').offsetTop - 10; });
  await wait(200);
  { const b = await P.locator('text=+ 5칸 추가').boundingBox(); await P.mouse.click(b.x + b.width / 2, b.y + b.height / 2); await wait(300); }
  s = await state();
  check('+ 5칸 추가한 빈 줄도 예시 줄 바로 아래(새 일정 입력)에', /새 일정 입력/.test(s.heads[0]) && s.rows.findIndex(r => r.m !== '0') === s.rows.filter(r => r.m === '0').length, s);
  await P.evaluate(() => { const p = document.getElementById('ms-panel'); p.scrollTop = p.scrollHeight; }); await wait(200);
  const lastBtn = P.locator('#ms-table-body .ms-del-row-btn').last();
  const box = await lastBtn.boundingBox();
  const top0 = await P.evaluate(() => document.getElementById('ms-panel').scrollTop);
  const rows0 = (await state()).rows.length;
  const x = box.x + box.width / 2, y = box.y - box.height * 3;   // 끝에서 몇 번째 줄 🗑️
  for (let i = 0; i < 3; i++) { await P.mouse.click(x, y); await wait(250); }
  const top1 = await P.evaluate(() => document.getElementById('ms-panel').scrollTop);
  check('맨 아래에서 3줄 지워도 스크롤 그대로', top1 === top0 && (await state()).rows.length === rows0 - 3, { top0, top1 });
  await P.evaluate(() => { document.getElementById('ms-panel').scrollTop = 0; }); await wait(300);
  check('위로 스크롤하면 채워 둔 빈 칸은 사라짐', await P.evaluate(() => document.getElementById('ms-panel-spacer').style.height === ''));

  // 같은 계정 다른 기기: 켜진 채로 복원, 일정도 달별로 묶임
  // (빈 줄이 맨 위로 가서 위 🗑️ 검사가 맨 아래 날짜 있는 줄을 지움 — 지운 것이 서버에 올라간 뒤 열고, 머리줄 수는 PC와 견줌)
  await wait(2000);
  const pcHeads = (await state()).heads.length;
  const pc2 = await openDevice(browser, 'PC2', T1);
  const Q = pc2.page;
  await Q.click('#rail-monthly-btn'); await wait(800);
  const s2 = await Q.evaluate(() => ({ expandAll: document.getElementById('ms-expand-all').checked, heads: [...document.querySelectorAll('#ms-table-body tr.ms-month-head')].map(h => h.innerText.replace(/\s+/g, ' ').trim()), hidden: msDataRows().filter(tr => tr.offsetParent === null).length }));
  check('다른 기기: 항상 펼치기 켜진 채로, 전부 펼쳐져 있음', s2.expandAll && s2.hidden === 0 && s2.heads.length === pcHeads && pcHeads >= 2, { s2, pcHeads });
  check('다른 기기: 달력 일정 글자 120%도 그대로(ms-data에 같이 저장)', await Q.evaluate(() => document.getElementById('ms-ev-size-val').textContent === '120%' && getComputedStyle(document.getElementById('ms-a4-paper')).getPropertyValue('--ms-ev').trim() === '1.2'));

  // 끄면 다시 접히고, 끈 것도 기억
  await Q.click('#ms-expand-all'); await wait(300);
  check('끄면 모두 접힘', await Q.evaluate(() => msDataRows().filter(tr => tr.dataset.month !== '0').every(tr => tr.offsetParent === null)));
  check('끈 설정도 기억', await ls(pc2, 'ms-expand-all') === '0');
  await Q.reload(); await Q.waitForFunction(() => window.currentTeacher && syncAppStarted === true);
  await Q.click('#rail-monthly-btn'); await wait(800);
  check('새로고침 후에도 꺼진 채 + 접힘', await Q.evaluate(() => !document.getElementById('ms-expand-all').checked && msDataRows().filter(tr => tr.dataset.month !== '0').every(tr => tr.offsetParent === null)));
  await Q.locator('#ms-panel').screenshot({ path: 'msfold-panel.png' });

  const errs = [...pc.errors, ...pc2.errors];
  check('페이지 오류 없음', errs.length === 0, errs);
  // 📖 설명서 = 예시 일정: 단계마다 채워 보여 주고, 저장 안 하고, 닫으면 원래대로
  {
    const D = pc.page;
    await D.setViewportSize({ width: 1600, height: 1000 });
    if (!(await D.evaluate(() => document.getElementById('monthly-page').style.display === 'flex'))) { await D.click('#rail-monthly-btn'); await wait(800); }
    const before = await D.evaluate(() => ({ now: JSON.stringify(msCollectData()), ls: localStorage.getItem('ms-data'), rows: msDataRows().map(tr => tr.children[1].innerText.trim()).join('|'), grade: document.getElementById('ms-cfg-grade').value, cats: msCategories.length, y: msCurYear, m: msCurMonth }));
    await D.evaluate(() => msOpenTour()); await wait(400);
    const seen = [];
    for (let k = 0; k < 20; k++) {
      await wait(250);
      const cur = await D.evaluate(() => ({ title: document.getElementById('tour-card-title').innerText, open: document.getElementById('tour-overlay').style.display !== 'none',
        grade: document.getElementById('ms-cfg-grade').value, paperHead: document.querySelector('#ms-a4-paper .ms-paper-header').innerText.replace(/\s+/g, ' '),
        cal: document.getElementById('ms-cal-grid').innerText.replace(/\s+/g, ' '), cats: msCategories.map(c => c.name).join(','),
        rows: msDataRows().filter(tr => tr.children[1].innerText.trim()).length, colored: document.querySelectorAll('#ms-cal-grid .ms-event-item').length,
        ls: localStorage.getItem('ms-data') }));
      if (!cur.open) break;
      seen.push(cur);
      await D.click('#tour-next-btn');
    }
    const S = (re) => seen.find(x => re.test(x.title)) || {};
    check('월간 설명서: 모든 단계', seen.length === await D.evaluate(() => msTourSteps.length), seen.map(x => x.title));
    check('월간 설명서: 처음엔 빈 예시', seen[0].rows === 0 && seen[0].grade === '', seen[0]);
    check('월간 설명서: 1단계 결과 — 종이 머리에 부서명·제목', /2학년부/.test(S(/1단계 결과/).paperHead) && /월간 학년 일정/.test(S(/1단계 결과/).paperHead), S(/1단계 결과/).paperHead);
    check('월간 설명서: 2단계 결과 — 달력에 기말고사·체육대회 D-Day', /기말고사/.test(S(/2단계 결과/).cal) && /체육대회 D-/.test(S(/2단계 결과/).cal) && /1일차/.test(S(/2단계 결과/).cal), S(/2단계 결과/).cal.slice(0, 300));
    check('월간 설명서: 3단계 분류 진로·시험 더함', /진로/.test(S(/3단계/).cats) && /시험/.test(S(/3단계/).cats));
    check('월간 설명서: 4단계 예시 일정 7줄·달력에 색 칠한 일정', S(/4단계 결과/).rows === 7 && S(/4단계 결과/).colored >= 6 && /진로 특강/.test(S(/4단계 결과/).cal), S(/4단계 결과/));
    check('월간 설명서: 설명서 동안 저장 안 됨', seen.every(x => x.ls === before.ls));
    await wait(800);
    const after = await D.evaluate(() => ({ ls: localStorage.getItem('ms-data'), rows: msDataRows().map(tr => tr.children[1].innerText.trim()).join('|'), grade: document.getElementById('ms-cfg-grade').value, cats: msCategories.length, y: msCurYear, m: msCurMonth, demo: !!msDemo }));
    check('월간 설명서 끝나면 원래 자료·달로', after.rows === before.rows && after.grade === before.grade && after.cats === before.cats && after.y === before.y && after.m === before.m && !after.demo, { before, after });
    check('월간 설명서 끝난 뒤 저장 자료 = 설명서 전 화면 그대로', after.ls === before.now, (() => { const a = JSON.parse(after.ls), b = JSON.parse(before.ls); return Object.keys(b).filter(k => JSON.stringify(a[k]) !== JSON.stringify(b[k])).map(k => k + ': ' + JSON.stringify(b[k]).slice(0, 200) + ' => ' + JSON.stringify(a[k]).slice(0, 200)); })());
    await D.evaluate(() => msOpenTour()); await wait(200);
    for (let k = 0; k < 6; k++) { await D.click('#tour-next-btn'); await wait(200); }
    await D.evaluate(() => closePageTour()); await wait(800);
    const mid = await D.evaluate(() => ({ rows: msDataRows().map(tr => tr.children[1].innerText.trim()).join('|'), ls: localStorage.getItem('ms-data') }));
    check('월간 설명서 중간에 닫아도 원래대로', mid.rows === before.rows && mid.ls === before.now);
  }
  // 👉 "지금 할 일" 상자: 선생님처럼 상자만 따라 누르며 ①→⑥ 한 단계씩(건너뜀 없음), 단계마다 칸 쓰는 법
  {
    const g = await openDevice(browser, 'T2', T2);
    const G = g.page;
    await G.setViewportSize({ width: 1600, height: 1000 });
    await G.click('#rail-monthly-btn'); await wait(800);
    const box = () => G.evaluate(() => ({ t: document.getElementById('ms-next').innerText, done: !!document.querySelector('#ms-next .pa-next.done'),
      btns: [...document.querySelectorAll('#ms-next .top-btn')].map(b => b.innerText),
      glow: [...document.querySelectorAll('#monthly-page .pa-glow')].map(e => e.id || e.className.replace(' pa-glow', '') + (e.closest('tr') ? '@' + e.closest('tr').dataset.month : '')),
      st: [1, 2, 3, 4].map(i => document.getElementById('ms-st-' + i).textContent),
      lay: (() => { const R = id => document.getElementById(id).getBoundingClientRect(); const n = R('ms-next'), i = R('ms-section-info'), t = R('ms-section-table'); return { full: n.width > i.width + t.width, above: n.bottom <= i.top && n.bottom <= t.top }; })() }));
    const seen = [];
    const step = (b) => (b.t.match(/[①②③④⑤⑥]/) || ['?'])[0];
    const goNext = async () => { await G.click('#ms-next .top-btn:not(.ms-again)'); await wait(300); const b = await box(); seen.push(step(b)); return b; };
    let b = await box(); seen.push(step(b));
    check('상자: 넓은 화면에서 두 줄 위 한 줄 전체', b.lay.full && b.lay.above, b.lay);
    check('상자 ①: 기본 설정 칸마다 쓰는 법(학교명·부서명·제목·나이스·글꼴)', /①/.test(b.t) && /학교명/.test(b.t) && /부서명/.test(b.t) && /나이스/.test(b.t) && /글꼴/.test(b.t) && b.st[0] === '지금', b);
    check('상자 ①: 부서명 칸 반짝', b.glow.includes('ms-cfg-grade'), b.glow);
    await G.fill('#ms-cfg-grade', '3학년부'); await wait(400);
    b = await box();
    check('상자 ①: 적은 제목이 바로 보임', /3학년부 월간 일정표/.test(b.t), b.t);
    b = await goNext();
    check('상자 ②: D-Day 줄 쓰는 법(기간·시작일·커스텀·비워도 됨)', /②/.test(b.t) && /기간/.test(b.t) && /시작일/.test(b.t) && /커스텀/.test(b.t) && /비워 두고/.test(b.t) && b.st[0] === '✓' && b.st[1] === '지금', b);
    await G.fill('#ms-dd-name-0', '기말고사'); await wait(400);
    b = await box();
    check('상자 ②: 이름만 적은 줄은 달력에 안 나온다고 알림', /⚠️/.test(b.t) && /기말고사/.test(b.t), b.t);
    await G.evaluate(() => { const el = document.getElementById('ms-dd-date-0'); const t = new Date(msCurYear, msCurMonth - 1, 20); el.value = t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-20'; el.dispatchEvent(new Event('change', { bubbles: true })); });
    await wait(400);
    b = await box();
    check('상자 ②: 날짜까지 적으면 경고 없이 "정기고사 기말고사"', !/⚠️/.test(b.t) && /정기고사 기말고사/.test(b.t), b.t);
    b = await goNext();
    check('상자 ③: 분류 더하기·지우기 방법과 지금 분류', /③/.test(b.t) && /\+ 추가/.test(b.t) && /✕/.test(b.t) && /자율·동아리·행사/.test(b.t), b.t);
    b = await goNext();
    check('상자 ④: 날짜·내용·분류·붙여 넣기 설명, 일정이 없으면 다음 단추 없음', /④/.test(b.t) && /날짜/.test(b.t) && /Enter/.test(b.t) && /붙여 넣/.test(b.t) && b.btns.length === 0, b);
    check('상자 ④: 빈 줄 날짜 칸 반짝', b.glow.some(x => /ms-cell-input@0/.test(x)), b.glow);
    await G.click('#ms-table-body tr[data-month="0"] td:first-child .ms-cell-input');
    await G.keyboard.type(String(await G.evaluate(() => msCurMonth)) + '/10');
    await G.click('#ms-table-body tr[data-month="0"] td:nth-child(2) .ms-cell-input');
    await G.keyboard.type('학급 회의'); await wait(400);
    b = await box();
    check('상자 ④: 치는 동안에도 건수가 따라옴(1건·이번 달 1건)·다음 단추', /1건/.test(b.t) && /이번 달 1건/.test(b.t) && b.btns.length === 1, b);
    await G.evaluate(() => { const tr = msDataRows().filter(r => !r.children[0].innerText.trim())[1]; tr.children[0].querySelector('.ms-cell-input').innerText = '12/3'; msRenderCalendar(); });
    await wait(400);
    b = await box();
    check('상자 ④: 날짜만 적힌 줄은 달력에 안 나온다고 알림', /⚠️/.test(b.t) && /1개/.test(b.t), b.t);
    b = await goNext();
    check('상자 ⑤: 위쪽 ◀ ▶·용지·이 달 일정', /⑤/.test(b.t) && /◀ ▶/.test(b.t) && /용지/.test(b.t) && /이 달 일정 1건/.test(b.t) && b.glow.includes('ms-month-nav') && b.st.every(x => x === '✓'), b);
    b = await goNext();
    check('상자 ⑥: 완료 모양 + 🖨️ 인쇄 단추 + 처음부터 안내', b.done && /인쇄/.test(b.t) && b.btns.includes('🖨️ 인쇄/PDF') && b.btns.includes('처음부터 안내') && b.glow.includes('ms-print-btn'), b);
    check('상자: ①→⑥ 건너뜀 없이 한 단계씩', seen.join('') === '①②③④⑤⑥', seen);
    await wait(1500);
    check('상자 단계는 계정에 저장(ms-guide)', serverVal(T2, 'ms-guide') === '6', serverVal(T2, 'ms-guide'));
    // 설명서 동안엔 예시 단계를 보이고, 끝나면 내 단계로(저장 안 바뀜)
    await G.evaluate(() => msOpenTour()); await wait(300);
    const tour = [];
    for (let k = 0; k < 20; k++) {
      await wait(250);
      const cur = await G.evaluate(() => ({ open: document.getElementById('tour-overlay').style.display !== 'none', title: document.getElementById('tour-card-title').innerText, t: document.getElementById('ms-next').innerText }));
      if (!cur.open) break;
      tour.push(cur);
      await G.click('#tour-next-btn');
    }
    const T = (re) => tour.find(x => re.test(x.title)) || { t: '' };
    check('설명서: 상자 소개 단계가 있고 예시라 저장 안 된다고 보임', /①/.test(T(/지금 할 일/).t) && /설명서 예시/.test(T(/지금 할 일/).t), T(/지금 할 일/));
    check('설명서: 단계마다 상자도 그 단계(2단계 ② · 4단계 ④ · 인쇄 ⑥)', /②/.test(T(/^2단계\./).t) && /④/.test(T(/^4단계\./).t) && /⑥/.test(T(/^6단계/).t), tour.map(x => x.title + ' / ' + x.t.slice(0, 12)));
    await wait(500);
    b = await box();
    check('설명서 끝나면 상자는 내 단계(⑥)·저장 그대로', b.done && await ls(g, 'ms-guide') === '6', b.t);
    // 일정을 다 지우면 ④로 돌아감, 처음부터 안내 → ①
    await G.evaluate(() => { msDataRows().forEach(tr => { tr.children[0].querySelector('.ms-cell-input').innerText = ''; tr.children[1].querySelector('.ms-cell-input').innerText = ''; }); msRenderCalendar(); });
    await wait(400);
    b = await box();
    check('일정을 다 지우면 ④로 돌아감', /④/.test(b.t) && !b.done, b.t);
    await G.evaluate(() => { const tr = msDataRows()[0]; tr.children[0].querySelector('.ms-cell-input').innerText = msCurMonth + '/11'; tr.children[1].querySelector('.ms-cell-input').innerText = '상담'; msRenderCalendar(); });
    await wait(400);
    b = await box();
    check('다시 적으면 ⑥으로', b.done, b.t);
    await G.click('#ms-next .ms-again'); await wait(300);
    b = await box();
    check('처음부터 안내 → ①', /①/.test(b.t) && b.st[0] === '지금', b.t);
    // 접어 둔 칸이면 그 단계로 갈 때 펼침
    await G.click('#ms-section-dday .ms-section-title'); await wait(200);
    await goNext();
    check('접어 둔 ② 칸은 그 단계에서 펼쳐짐', await G.evaluate(() => !document.getElementById('ms-sec-dday').classList.contains('ms-collapsed')));
    await G.setViewportSize({ width: 1366, height: 768 }); await wait(400);
    check('1366: 상자가 한 줄 맨 위', await G.evaluate(() => document.getElementById('ms-next').getBoundingClientRect().bottom <= document.getElementById('ms-section-info').getBoundingClientRect().top));
    await G.locator('#ms-panel').screenshot({ path: 'ms-next-1366.png' });
    await G.setViewportSize({ width: 1600, height: 1000 }); await wait(400);
    await G.locator('#ms-panel').screenshot({ path: 'ms-next-1600.png' });
    check('상자 검사 중 페이지 오류 없음', g.errors.length === 0, g.errors);
  }
  console.log(failures ? ('실패 ' + failures + '건') : '모든 검사 통과');
  await browser.close();
  process.exit(failures ? 1 : 0);
})();
