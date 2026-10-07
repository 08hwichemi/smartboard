// 수업 변경 큰 창: 왼쪽·오른쪽 시간표에서 칸을 눌러 교환·보강 등록(두 쪽 주를 따로), 겹침 경고, 연속 교환(바뀐 칸을 다시 바꾸면 지금 그 칸의 수업이 옮겨감·지울 때 이어진 변경 경고),
// 변경 내역(기간·구분·이름 거르기, 날짜별 묶음), 엑셀 내려받기(틀 고정·필터·색 — exceljs가 있을 때).
// 수업변경 담당(계정 관리 체크)은 아무 선생님 수업을, 일반 교사는 본인 수업만. 가짜 서버는 staff-test.js와 같다.
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
  ['33333333-3333-3333-3333-333333333333']: { id: '33333333-3333-3333-3333-333333333333', name: '최실무', is_admin: false, must_change_password: false, role: '실무사', homeroom_grade: null, homeroom_class: null },
  ['55555555-5555-5555-5555-555555555555']: { id: '55555555-5555-5555-5555-555555555555', name: '수업계', is_admin: false, must_change_password: false, role: '실무사', homeroom_grade: null, homeroom_class: null, schedule_manager: true },
  ['66666666-6666-6666-6666-666666666666']: { id: '66666666-6666-6666-6666-666666666666', name: '수업계교사', is_admin: false, must_change_password: false, role: '교사', homeroom_grade: null, homeroom_class: null, schedule_manager: true },
  [T2]: { id: T2, name: '박교사', is_admin: false, must_change_password: false, role: '교사', homeroom_grade: null, homeroom_class: null },
};
const items = new Map(); // teacher|key -> {teacher_id,key,value,updated_at}
const history = [];
const changes = [];
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
  if (table === 'app_settings' && op === 'select' && filters.some(f => f.val === 'semester_ranges')) {
    // 오늘이 속한 학기: 한 달 전 ~ 두 달 뒤
    const d = (n) => { const x = new Date(); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };
    return { data: { value: { '1학기': { start: '2000-03-01', end: '2000-07-20' }, '2학기': { start: d(-30), end: d(60) } } }, error: null };
  }
  if (table === 'schedule_changes') {
    if (op === 'insert') { const r = Array.isArray(rows) ? rows : [rows]; r.forEach(x => changes.push(Object.assign({ id: changes.length + 1, created_by: teachers[pageInfo.uid].name }, x))); return { data: null, error: null }; }
    if (op === 'select') { let l = changes.slice().sort((x, y) => x.id - y.id); const r0 = range ? range[0] : 0, r1 = range ? range[1] + 1 : l.length; l = l.slice(r0, Math.min(r1, r0 + 1000)); return { data: l, error: null }; } // 진짜 서버처럼 한 번에 최대 1000줄(max_rows)
    return { data: null, error: null };
  }
  if (table === 'timetable' && op === 'select') {
    const subj = ['국어','수학','영어','과학','사회','체육','음악','미술'];
    const rows = ['김교사','박교사','이교사','정교사','한교사','오교사','윤교사','장교사'].map((nm, t) => ({ teacher_name: nm, cells: Array.from({length:35}, (_, j) => (j + t) % 3 === 0 ? subj[(j + t) % 8] + '\n' + (200 + j) : '') }));
    // 10/7 담당 선생님이 검증한 실제 시간표(화·목만): 백경미 화1 독서 302·목1 독서 307 / 하영우 화2 물리 302 / 김용남 화1 심화영어 307·화4 302
    const real = (m) => { const c = Array(35).fill(''); for (const k in m) c[k] = m[k]; return c; };
    rows.push({ teacher_name: '백경미', cells: real({ 7: '독서\n302', 10: '독서\n306', 21: '독서\n307', 22: '독서\n303' }) });
    rows.push({ teacher_name: '하영우', cells: real({ 8: '물리학Ⅱ\n302', 9: '물리학Ⅱ\n303', 11: '물리학Ⅱ\n301', 22: '물리학Ⅱ\n301' }) });
    rows.push({ teacher_name: '김용남', cells: real({ 7: '심화영어Ⅰ\n307', 10: '심화영어Ⅰ\n302', 22: '심화영어Ⅰ\n307' }) });
    return { data: rows, error: null };
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
    if (url.includes('/exceljs@')) { try { return route.fulfill({ body: fs.readFileSync(require.resolve('exceljs/dist/exceljs.min.js')), contentType: 'application/javascript' }); } catch (e) {} }
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
  const M = '55555555-5555-5555-5555-555555555555';
  const d = await openDevice(browser, '수업계PC', M);
  const P = d.page;
  await P.setViewportSize({ width: 2000, height: 1030 }); await wait(1500);
  check('실무사 홈은 그대로 + 둘째 줄에 수업변경 버튼 없음(사용자 요청으로 뺌)', await P.evaluate(() => document.getElementById('main-dashboard').classList.contains('staff-mode') && !document.getElementById('btn-scc-manager') && ![...document.querySelectorAll('.quick-row .qbtn')].some(b => b.innerText.includes('수업변경'))));
  await P.evaluate(() => openScheduleChangeModal()); await wait(400);
  const cellSel = (side, date, p) => '#scc-grid-' + side + ' .scc-cell[data-date="' + date + '"][data-p="' + p + '"]';
  const pick = (side, date, p) => P.click(cellSel(side, date, p));
  const cls = (side, date, p) => P.evaluate((q) => { const e = document.querySelector(q); return e ? e.className : null; }, cellSel(side, date, p));
  const setWeek = async (side, date) => { await P.fill('#scc-week-' + side, date); await P.dispatchEvent('#scc-week-' + side, 'change'); await wait(100); };
  const preview = () => P.evaluate(() => document.getElementById('scc-preview').innerText);
  const save = async () => { await P.click('#scc-save-btn'); await wait(500); await P.click('#custom-alert-ok-btn'); await wait(300); };
  const m = await P.evaluate(() => {
    const box = document.querySelector('#schedule-change-overlay .scc-box').getBoundingClientRect();
    const ga = document.getElementById('scc-grid-a').getBoundingClientRect(), gb = document.getElementById('scc-grid-b').getBoundingClientRect();
    return {
      open: getComputedStyle(document.getElementById('schedule-change-overlay')).display === 'flex',
      aSel: getComputedStyle(document.getElementById('scc-teacher-a')).display !== 'none',
      aOpts: document.getElementById('scc-teacher-a').options.length,
      big: box.width > 1200 && box.height > 850, sideBySide: Math.abs(ga.top - gb.top) < 2 && gb.left > ga.right,
      saveOff: document.getElementById('scc-save-btn').disabled,
    };
  });
  check('큰 창: 담당은 왼쪽 선생님 고르기, 두 시간표가 좌우로, 칸 고르기 전엔 등록 버튼 꺼짐', m.open && m.aSel && m.aOpts === 12 && m.big && m.sideBySide && m.saveOff, m);
  await P.selectOption('#scc-teacher-a', '김교사'); await wait(100);
  // ---- 선생님 이름을 글자로 찾기(10/7 사용자: 드롭다운 + 치면 맞는 이름이 뜨게) ----
  const tcIn = '#scc-partner + .tc-input';
  const pop = () => P.evaluate(() => { const p = document.getElementById('tc-pop'); return p && p.style.display !== 'none' ? [...p.querySelectorAll('.tc-item')].map(e => e.innerText) : null; });
  const tc0 = await P.evaluate(() => { const i = document.querySelector('#scc-partner + .tc-input'), s = document.getElementById('scc-partner'); const a = i.getBoundingClientRect(), b = s.getBoundingClientRect(); return { ph: i.placeholder, over: a.left >= b.left - 1 && a.right < b.right - 10 && Math.abs(a.top - b.top) < 3, arrow: b.right - a.right }; });
  check('② 선생님 칸: 드롭다운 위에 글자 칸(오른쪽 ▾는 드롭다운 그대로), 비었을 땐 "선생님 선택"', tc0.ph === '선생님 선택' && tc0.over && tc0.arrow >= 15, tc0);
  await P.click(tcIn); await wait(100);
  const all = await pop();
  check('글자 칸을 누르면 전체 이름 목록(왼쪽 선생님 김교사는 빠짐)', all && all.length === 10 && !all.includes('김교사'), all);
  await P.fill(tcIn, '경'); await wait(100);
  check('"경"을 치면 백경미만', JSON.stringify(await pop()) === '["백경미"]', await pop());
  await P.fill(tcIn, 'ㅎㅇㅇ'); await wait(100);
  check('초성 "ㅎㅇㅇ"로 하영우', JSON.stringify(await pop()) === '["하영우"]', await pop());
  await P.fill(tcIn, '없는이름'); await wait(100);
  check('맞는 이름이 없으면 안내', /맞는 이름이 없어요/.test(await P.evaluate(() => document.getElementById('tc-pop').innerText)));
  await P.fill(tcIn, '영'); await wait(100); await P.keyboard.press('Enter'); await wait(200);
  const ent = await P.evaluate(() => ({ v: document.getElementById('scc-partner').value, t: document.querySelector('#scc-partner + .tc-input').value, cells: document.querySelectorAll('#scc-grid-b .scc-cell.has').length }));
  check('"영" + Enter → 드롭다운 값·글자 칸 하영우, onchange로 오른쪽 시간표가 하영우 수업으로, 목록 닫힘', ent.v === '하영우' && ent.t === '하영우' && ent.cells > 0 && (await pop()) === null, ent);
  await P.selectOption('#scc-partner', '박교사'); await wait(100);
  check('드롭다운으로 고르면 글자 칸도 따라감(박교사)', await P.evaluate(() => document.querySelector('#scc-partner + .tc-input').value) === '박교사');
  await P.evaluate(() => { document.getElementById('scc-partner').value = ''; }); await wait(50);
  check('코드가 값을 비우면 글자 칸도 비고 "선생님 선택"', await P.evaluate(() => { const i = document.querySelector('#scc-partner + .tc-input'); return i.value === '' && i.placeholder === '선생님 선택'; }));
  await P.evaluate(() => sccOnPartnerChange()); await wait(100);
  check('오른쪽 목록에서 왼쪽 선생님은 빠짐', await P.evaluate(() => ![...document.getElementById('scc-partner').options].some(o => o.value === '김교사')));
  const wk = await P.evaluate(() => getCurrentWeekDates());
  await setWeek('a', wk[0]);
  check('오른쪽은 처음엔 왼쪽 주를 따라감', await P.evaluate(() => scc.weekB) === wk[0]);
  // 교환 칸 규칙: 왼쪽 빈 시간은 못 누름, 오른쪽은 수업 칸만
  check('왼쪽 빈 시간(월2)은 못 누름, 수업 칸(월1)은 누를 수 있음', !/pick/.test(await cls('a', wk[0], 2)) && /pick/.test(await cls('a', wk[0], 1)), [await cls('a', wk[0], 2), await cls('a', wk[0], 1)]);
  await P.selectOption('#scc-partner', '박교사'); await wait(100);
  check('교환: 오른쪽 빈 시간(박교사 월1)은 흐리게, 수업 칸(수1)은 누를 수 있음', /\bno\b/.test(await cls('b', wk[0], 1)) && /pick/.test(await cls('b', wk[2], 1)));

  // ---- 서로 다른 날짜끼리 교환: 김교사 월1 ↔ 박교사 수1 ----
  await pick('a', wk[0], 1); await wait(100);
  check('한쪽만 고르면 등록 버튼 꺼짐 + 단계 안내', await P.evaluate(() => document.getElementById('scc-save-btn').disabled) && /✅ ① \d+\/\d+\(월\) 1교시 국어/.test(await preview()) && /⬜ ② 맞바꿀 수업 칸을 누르세요/.test(await preview()), await preview());
  await pick('b', wk[2], 1); await wait(100);
  const pv2 = await preview();
  check('미리보기: "김교사쌤 …", 두 날짜(월 1교시 ↔ 수 1교시), 겹침 경고 없음', pv2.includes('김교사쌤') && !pv2.includes('나(') && /\(월\) 1교시/.test(pv2) && /\(수\) 1교시/.test(pv2) && !/겹쳐요/.test(pv2), pv2);
  await save();
  const ex = changes[changes.length - 1];
  check('다른 날짜 교환 저장: 김교사 월1 ↔ 박교사 수1', changes.length === 1 && ex.type === 'exchange' && ex.teacher_a === '김교사' && ex.teacher_b === '박교사' && ex.change_date === wk[0] && ex.change_date_b === wk[2] && ex.period_a === 1 && ex.period_b === 1, ex);
  check('등록하면 고른 칸이 풀리고, 방금 바꾼 칸은 "교환" 표시(빈 칸이라 왼쪽에선 못 누름)', await P.evaluate(() => !scc.pickA && !scc.pickB) && /chg/.test(await cls('a', wk[0], 1)) && await P.evaluate((q) => { const e = document.querySelector(q); return !e.getAttribute('onclick') && e.querySelector('.badge').innerText === '교환'; }, cellSel('a', wk[0], 1)));
  check('왼쪽 김교사 수1 칸에 옮겨 온 국어(교환 표시) — 바뀐 칸도 다시 누를 수 있음(연속 교환)', await P.evaluate((q) => { const e = document.querySelector(q); return e.querySelector('.s').innerText === '국어' && /chg/.test(e.className) && /pick/.test(e.className) && !!e.getAttribute('onclick'); }, cellSel('a', wk[2], 1)));

  // 시간표에 반영: 김교사 월1(국어)은 비고 수1로, 박교사 수1(미술)은 비고 월1로
  const cell = (tn, period, d) => P.evaluate(([tn, period, d]) => {
    document.getElementById('search-select').value = tn; renderSearchTimetable(true);
    const e = document.getElementById('search-tt-' + period + '-' + d + '-s'); return e ? e.innerText.trim() : null;
  }, [tn, period, d]);
  const k1 = await cell('김교사', 1, 1), k3 = await cell('김교사', 1, 3);
  const b3 = await cell('박교사', 1, 3), b1 = await cell('박교사', 1, 1);
  check('교환 반영(홈 시간표): 김교사 월1 빔·수1 국어 / 박교사 수1 빔·월1 미술', k1 === '' && k3 === '국어' && b3 === '' && b1 === '미술', { k1, k3, b3, b1 });

  changes.push({ id: 2, change_date: wk[0], type: 'makeup', teacher_a: '이교사', period_a: 2, teacher_b: '정교사', period_b: 2, created_by: '이교사' });

  // ---- 연속 교환(10/7 사용자: 많다): 첫 교환으로 김교사 수1에 와 있는 국어를 다시 이교사 화1(수학)과 교환 → 옮겨 가는 건 "지금 그 칸의 수업"(국어) ----
  await P.evaluate(() => fetchScheduleChanges()); await wait(200);
  await pick('a', wk[2], 1); await P.selectOption('#scc-partner', '이교사'); await wait(100); await pick('b', wk[1], 1); await wait(150);
  const pvC = await preview();
  check('연속 교환 미리보기: 김교사 수1 "국어"(교환으로 와 있는 수업) ↔ 이교사 화1 "수학"', /\(수\) 1교시 "국어/.test(pvC) && /이교사쌤 .*\(화\) 1교시 "수학/.test(pvC), pvC);
  await save();
  const ex2 = changes[changes.length - 1];
  check('연속 교환 저장: 김교사 수1 ↔ 이교사 화1', changes.length === 3 && ex2.teacher_a === '김교사' && ex2.change_date === wk[2] && ex2.period_a === 1 && ex2.teacher_b === '이교사' && ex2.change_date_b === wk[1] && ex2.period_b === 1, ex2);
  const c2 = { k3: await cell('김교사', 1, 3), k2: await cell('김교사', 1, 2), k1: await cell('김교사', 1, 1), i2: await cell('이교사', 1, 2), i3: await cell('이교사', 1, 3), b1: await cell('박교사', 1, 1) };
  check('연속 교환 반영(홈 시간표): 김교사 월1 빔·수1 빔·화1 국어 / 이교사 화1 빔·수1 수학 / 박교사 월1 미술 그대로', c2.k1 === '' && c2.k3 === '' && c2.k2 === '국어' && c2.i2 === '' && c2.i3 === '수학' && c2.b1 === '미술', c2);
  check('변경 창에도 같게: 김교사 화1 국어(교환 표시), 수1 빈 칸(교환 표시)', await P.evaluate((q) => { const e = document.querySelector(q); return e.querySelector('.s').innerText === '국어' && /chg/.test(e.className); }, cellSel('a', wk[1], 1)) && await P.evaluate((q) => { const e = document.querySelector(q); return !e.querySelector('.s') && /chg/.test(e.className); }, cellSel('a', wk[2], 1)));
  check('변경 내역 글: 둘째 교환의 원래 수업은 "국어"(정규 시간표의 수1이 아니라 옮겨 온 수업), 첫 교환엔 이어진 변경 1건', await P.evaluate(() => { const d = sccDescribe(scheduleChangesAll.find(c => c.id === 3)); return d.classA === '국어 200' && d.classB === '수학 207' && sccChainDependents(1) === 1 && sccChainDependents(3) === 0; }));
  await P.evaluate(() => { window.__confirmMsg = ''; window.customConfirm = async (m) => { window.__confirmMsg = m; return false; }; });
  await P.evaluate(() => sccDelete(1)); await wait(200);
  check('첫 교환을 지우려 하면 "뒤에 이어진 변경이 1건" 경고(취소하면 그대로)', /이어진 변경이 1건/.test(await P.evaluate(() => window.__confirmMsg)) && changes.length === 3);
  await P.evaluate(() => sccDelete(3)); await wait(200);
  check('이어진 것이 없는 둘째 교환은 그냥 "삭제할까요?"', await P.evaluate(() => window.__confirmMsg === '이 변경 내역을 삭제할까요?'));
  changes.pop(); await P.evaluate(() => fetchScheduleChanges().then(() => { loadMyTimetable(); renderSearchTimetable(true); sccRenderNew(); })); await wait(300);
  check('둘째 교환을 지우면(가짜 서버에서) 첫 교환만 남아 김교사 화1 빔·수1 국어', changes.length === 2 && await cell('김교사', 1, 2) === '' && await cell('김교사', 1, 3) === '국어');

  // ---- 창을 연 뒤 다른 기기에서 같은 칸을 바꾸면: 저장 직전에 다시 받아 확인하고 등록하지 않음(연속 교환은 "지금 그 칸의 수업"을 옮기므로) ----
  await pick('a', wk[2], 1); await P.selectOption('#scc-partner', '이교사'); await wait(100); await pick('b', wk[1], 1); await wait(150);
  check('(다른 기기 변경 전) 미리보기: 김교사 수1 "국어"', /\(수\) 1교시 "국어/.test(await preview()), await preview());
  changes.push({ id: 50, change_date: wk[2], change_date_b: wk[2], type: 'makeup', teacher_a: '김교사', period_a: 1, teacher_b: '정교사', period_b: 1, created_by: '이교사' }); // 다른 기기에서 방금 등록
  await P.click('#scc-save-btn'); await wait(500);
  const staleMsg = await P.evaluate(() => document.getElementById('custom-alert-msg') ? document.getElementById('custom-alert-msg').innerText : document.body.innerText);
  await P.click('#custom-alert-ok-btn'); await wait(300);
  check('다른 기기가 같은 칸을 먼저 바꿨으면 등록하지 않고 알림, 고른 칸 풀림, 바뀐 시간표(김교사 수1 보강 표시)', changes.length === 3 && /방금 다른 분이/.test(staleMsg) && await P.evaluate(() => !scc.pickA && !scc.pickB) && /chg/.test(await cls('a', wk[2], 1)), { n: changes.length, staleMsg: staleMsg.slice(0, 80) });
  changes.pop(); await P.evaluate(() => fetchScheduleChanges().then(() => { loadMyTimetable(); renderSearchTimetable(true); sccRenderNew(); })); await wait(300);

  // ---- 넣는 순서와 상관없이(10/7 담당 선생님 검증: 나이스 순서 ①②③은 되고 ③①②는 안 됨) ----
  // ③ 김용남 화1(307) ↔ 백경미 목1(307)을 먼저 넣으면 백경미 화1에 302·307 두 수업이 잠시 겹친다 — 예전엔 307이 302를 덮어써서
  // 다음 ① 백경미 화1 ↔ 하영우 화2에서 302가 아니라 307이 옮겨지고 302반 독서가 사라졌다.
  const nOrd = changes.length, tue2 = await P.evaluate((d) => sccAddDays(d, 14), wk[1]);
  await P.selectOption('#scc-teacher-a', '김용남'); await wait(100); await setWeek('a', wk[0]);
  await pick('a', wk[1], 1); await P.selectOption('#scc-partner', '백경미'); await wait(100); await setWeek('b', wk[0]); await pick('b', wk[3], 1); await wait(150);
  check('③ 먼저: 미리보기에 "백경미쌤은 화 1교시에 이미 독서 302 수업이 있어서 겹쳐요"', /백경미쌤은 .*\(화\) 1교시에 이미 "독서 302"/.test(await preview()), await preview());
  await save();
  await P.selectOption('#scc-teacher-a', '백경미'); await wait(100); await setWeek('a', wk[0]);
  const dbl = await P.evaluate((q) => { const e = document.querySelector(q); return { cls: e.className, txt: e.innerText.replace(/\s+/g, ' ') }; }, cellSel('a', wk[1], 1));
  check('백경미 화1 칸에 두 수업(독서 302·독서 307)이 같이 보이고 "겹침" 표시(빨간 테두리), 누를 수 있음', /\bdbl\b/.test(dbl.cls) && /pick/.test(dbl.cls) && /302/.test(dbl.txt) && /307/.test(dbl.txt) && /겹침/.test(dbl.txt), dbl);
  await pick('a', wk[1], 1); await P.selectOption('#scc-partner', '하영우'); await wait(100); await setWeek('b', wk[0]); await pick('b', wk[1], 2); await wait(150);
  const pvO = await preview();
  check('① 백경미 화1 ↔ 하영우 화2: 상대 수업과 같은 반(302)이 저절로 골라짐 + 옮길 수업 고르기 단추 두 개', /"독서 302" → .*\(화\) 2교시/.test(pvO) && /수업이 2개 겹쳐 있어요/.test(pvO) && await P.evaluate(() => [...document.querySelectorAll('#scc-preview .scc-room-btn')].map(b => b.innerText + (b.classList.contains('active') ? '*' : '')).join(',')) === '독서 302*,독서 307', pvO);
  await P.click('#scc-preview .scc-room-btn:not(.active)'); await wait(100);
  check('단추로 307을 고르면 미리보기도 307로', /"독서 307" → /.test(await preview()), await preview());
  await P.click('#scc-preview .scc-room-btn:not(.active)'); await wait(100);
  await save();
  const ro = changes[changes.length - 1];
  check('① 저장: 옮긴 수업의 반도 같이 저장(room_a 302 · room_b 302)', ro.teacher_a === '백경미' && ro.room_a === '302' && ro.room_b === '302', ro);
  await P.selectOption('#scc-teacher-a', '김용남'); await wait(100); await setWeek('a', wk[0]);
  await pick('a', wk[1], 4); await P.selectOption('#scc-partner', '하영우'); await wait(100); await setWeek('b', tue2); await pick('b', tue2, 2); await wait(150);
  await save();
  const fin = await P.evaluate(([w, t2]) => { const g = (t, d, p) => sccClassAt(t, d, p) || '·'; return [g('백경미', w[1], 1), g('백경미', w[1], 2), g('하영우', w[1], 1), g('하영우', w[1], 2), g('하영우', w[1], 4), g('김용남', w[1], 1), g('김용남', w[1], 4), g('김용남', w[3], 1), g('김용남', t2, 2), g('백경미', w[3], 1), g('하영우', t2, 2)].join('|'); }, [wk, tue2]);
  check('③①② 순서로 넣어도 나이스 순서(①②③)와 같은 결과: 화 302반 1교시 물리·2교시 독서·4교시 물리, 307반 1교시 독서(백경미)',
    changes.length === nOrd + 3 && fin === '독서 307|독서 302|물리학Ⅱ 302|·|물리학Ⅱ 302|·|·|심화영어Ⅰ 307|심화영어Ⅰ 302|·|·', fin);
  const homeR = await P.evaluate(() => { document.getElementById('search-select').value = '백경미'; renderSearchTimetable(true); return [1, 2].map(p => document.getElementById('search-tt-' + p + '-2-s').innerText.trim() + ' ' + document.getElementById('search-tt-' + p + '-2-r').innerText.trim()); });
  check('홈 시간표(선생님 찾기) 백경미 화1 독서 307 · 화2 독서 302', homeR.join(',') === '독서 307,독서 302', homeR);
  changes.splice(nOrd); await P.evaluate(() => fetchScheduleChanges().then(() => { loadMyTimetable(); renderSearchTimetable(true); sccRenderNew(); })); await wait(300);
  await P.selectOption('#scc-teacher-a', '김교사'); await wait(100); await setWeek('a', wk[0]);

  // ---- 📋 일자·교시 고르기(10/7 사용자: 나이스 "수업 교체"처럼 목록이 편한 분 — 계정에 기억) ----
  await P.click('#scc-view-list'); await wait(200);
  check('📋 일자·교시 고르기: 시간표 대신 일자·교시·과목정보 칸, 주 이동 숨김, 계정 자료 scc-view=list', await P.evaluate(() => document.getElementById('scc-grid-a').classList.contains('scc-listpick') && !!document.getElementById('scc-ld-a') && !!document.getElementById('scc-lp-a') && getComputedStyle(document.querySelector('#scc-side-a .scc-week')).display === 'none' && localStorage.getItem('scc-view') === 'list' && document.getElementById('scc-view-list').classList.contains('active')));
  await P.fill('#scc-ld-a', wk[1]); await P.dispatchEvent('#scc-ld-a', 'change'); await wait(150);
  const opts = await P.evaluate(() => [...document.getElementById('scc-lp-a').options].map(o => o.text + (o.disabled ? '|x' : '')));
  check('교시 목록에 그 날(화) 수업이 글로: 3교시 수학 209·6교시 사회, 빈 시간은 고를 수 없음', /3교시.*수학 209/.test(opts[3]) && /6교시.*사회/.test(opts[6]) && /빈 시간\|x$/.test(opts[1]), opts);
  await P.selectOption('#scc-lp-a', '3'); await wait(150);
  check('교시를 고르면 과목정보에 수업, 미리보기 ①에 (화) 3교시 수학', await P.evaluate(() => scc.pickA && scc.pickA.period === 3 && /수학 209/.test(document.querySelector('#scc-grid-a .scc-lp-info').innerText)) && /✅ ① \d+\/\d+\(화\) 3교시 수학/.test(await preview()), await preview());
  await P.selectOption('#scc-partner', '박교사'); await wait(100);
  await P.fill('#scc-ld-b', wk[1]); await P.dispatchEvent('#scc-ld-b', 'change'); await wait(150);
  await P.selectOption('#scc-lp-b', '2'); await wait(150);
  check('② 박교사 화2 수학 → 미리보기 둘 다 · 등록 가능', /\(화\) 2교시 "수학 208"/.test(await preview()) && !(await P.evaluate(() => document.getElementById('scc-save-btn').disabled)), await preview());
  await P.click('#scc-side-a .scc-lp-day:last-child'); await wait(150);
  check('일자 + → 수요일로, 교시는 다시 고름', await P.evaluate((d) => document.getElementById('scc-ld-a').value === d && !scc.pickA && scc.weekA === sccMondayOf(d), wk[2]));
  await P.evaluate(() => closeScheduleChangeModal()); await P.evaluate(() => openScheduleChangeModal()); await wait(400);
  check('다시 열어도 📋 방식 기억', await P.evaluate(() => document.getElementById('scc-grid-a').classList.contains('scc-listpick') && document.getElementById('scc-view-list').classList.contains('active')));
  await P.click('#scc-view-grid'); await wait(200);
  check('🗓 시간표 방식으로 돌아감(칸 35개), 기억 지움', await P.evaluate(() => !document.getElementById('scc-grid-a').classList.contains('scc-listpick') && !localStorage.getItem('scc-view')) && await P.evaluate(() => { document.getElementById('scc-teacher-a').value = '김교사'; sccOnTeacherAChange(); return document.querySelectorAll('#scc-grid-a .scc-cell').length === 35; }));
  await setWeek('a', wk[0]); await P.selectOption('#scc-partner', '박교사'); await wait(100);

  // ---- 주 옮기기: 날짜 칸·◀ ▶, 오른쪽을 직접 옮기면 그 뒤론 따로 ----
  const dr = await P.evaluate(() => {
    const r = sccDateRange();
    const ymd = (x) => x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
    // 2주 뒤 수요일 = 이번 주 월요일(주말이면 다음 주 월요일, 앱과 같게) + 16일 — 목~일에 돌려도 3주 뒤가 되지 않게
    const next = new Date(sccAddDays(sccMondayOf(ymd(new Date())), 16) + 'T00:00:00');
    const far = new Date(); far.setDate(far.getDate() + 90);
    const sat = new Date(next); sat.setDate(sat.getDate() + 3);
    const pr = sccPickRange(), sem = semesterRanges['2학기'];
    // 지난주 수요일(학기 안) / 학기 시작 전날
    const lastWed = sccAddDays(sccMondayOf(ymd(new Date())), -5), before = sccAddDays(sem.start, -1);
    return { r, pr, sem, nextOk: sccDateProblem(ymd(next)) === '', farBad: sccDateProblem(ymd(far)) !== '', satBad: sccDateProblem(ymd(sat)) !== '', next: ymd(next),
      lastWedOk: sccDateProblem(lastWed) === '', beforeBad: sccDateProblem(before) !== '', inputMin: document.getElementById('scc-week-a').min, inputMax: document.getElementById('scc-week-a').max, prevOn: !document.getElementById('scc-week-a-prev').disabled,
      text: document.getElementById('scc-week-a-text').textContent };
  });
  check('기간: 학기 시작 ~ 학기 끝(지난주도 고를 수 있음), 2주 뒤 수요일 가능 / 학기 앞·뒤·토요일 불가, 이번 주에서도 ◀ 켜짐', dr.nextOk && dr.lastWedOk && dr.beforeBad && dr.farBad && dr.satBad && dr.pr.min === dr.sem.start && dr.inputMin === dr.sem.start && dr.inputMax === dr.r.max && dr.r.max > dr.next && dr.prevOn, dr);
  check('날짜 칸 대신 그 주(월~금)로 표시 + "이번 주" 표시', /^📅 \d+\.\d+\(월\) ~ \d+\.\d+\(금\) 이번 주$/.test(dr.text), dr.text);
  // ◀로 학기 첫 주까지 가면 ◀ 꺼짐, 지난주로 가면 "이번 주" 표시 없음
  await P.click('#scc-week-a-prev'); await wait(100);
  check('◀ → 지난주(이번 주 표시 없음)', await P.evaluate(() => scc.weekA === sccAddDays(sccMondayOf(todayYmdDash()), -7) && !/이번 주/.test(document.getElementById('scc-week-a-text').textContent)));
  for (let i = 0; i < 12 && !(await P.evaluate(() => document.getElementById('scc-week-a-prev').disabled)); i++) { await P.click('#scc-week-a-prev'); await wait(50); }
  check('학기 첫 주까지 가면 ◀ 꺼짐', await P.evaluate(() => scc.weekA === sccMondayOf(sccPickRange().min) && document.getElementById('scc-week-a-prev').disabled));
  await setWeek('a', wk[0]);
  await P.click('#scc-week-a-next'); await wait(100);
  await P.click('#scc-week-a-next'); await wait(100);
  const w2 = await P.evaluate(() => [scc.weekA, scc.weekB, document.getElementById('scc-week-a').value]);
  const nextMon = await P.evaluate((d) => sccMondayOf(d), dr.next);
  check('▶ 두 번 = 2주 뒤, 오른쪽도 따라감', w2[0] === nextMon && w2[1] === nextMon && w2[2] === nextMon, [w2, nextMon]);
  await setWeek('b', wk[0]);
  await P.click('#scc-week-a-prev'); await wait(100);
  check('오른쪽을 직접 옮기면 왼쪽을 옮겨도 그대로', await P.evaluate(() => scc.weekB) === wk[0] && await P.evaluate(() => scc.weekA) !== wk[0]);
  // 2주 뒤 수2 김교사 ↔ 이교사 수3 (같은 주로 오른쪽도 맞춤)
  await setWeek('a', dr.next);
  await setWeek('b', dr.next);
  check('날짜 칸에서 고른 날짜의 주가 보임', await P.evaluate(() => scc.weekA) === nextMon);
  await P.selectOption('#scc-partner', '이교사'); await wait(100);
  await pick('a', dr.next, 2); await pick('b', dr.next, 3); await wait(100);
  await save();
  const nextSlot = await P.evaluate((d) => sccSlotText(d, 2), dr.next);
  check('2주 뒤 변경 등록됨', changes.some(c => c.change_date === dr.next && c.period_a === 2 && c.teacher_b === '이교사'), changes.map(c => [c.change_date, c.period_a, c.teacher_b]));

  // ---- 같은 날짜·같은 교시 교환(서로 반 맞바꿈): 다음 주 김교사 월1 ↔ 정교사 월1 ----
  const nw = await P.evaluate((d) => sccAddDays(d, 7), wk[0]);
  await setWeek('a', nw); await setWeek('b', nw);
  await P.selectOption('#scc-partner', '정교사'); await wait(100);
  await pick('a', nw, 1); await pick('b', nw, 1); await wait(100);
  const pvSame = await preview();
  check('같은 날짜·같은 교시 미리보기: 서로 반을 맞바꿈', /서로 반을 맞바꿔/.test(pvSame), pvSame);
  const n0 = changes.length;
  await save();
  check('같은 날짜·같은 교시 교환 저장됨', changes.length === n0 + 1 && changes[changes.length - 1].period_a === changes[changes.length - 1].period_b && changes[changes.length - 1].change_date === nw, changes[changes.length - 1]);

  // ---- 겹침 경고: 김교사 화3 ↔ 정교사 화6 (김교사는 화6에 이미 수업) — 경고만, 등록 버튼은 켜짐 ----
  await P.click(cellSel('a', nw, 3)); await wait(50); // 월3은 빈 시간 — 눌러도 안 골라짐
  check('왼쪽 빈 시간은 눌러도 안 골라짐', await P.evaluate(() => !scc.pickA));
  const tue = await P.evaluate((d) => sccAddDays(d, 1), nw);
  await pick('a', tue, 3); await pick('b', tue, 6); await wait(100);
  const pvW = await preview();
  check('교환 겹침 경고(김교사가 화6에 이미 수업) + 등록은 가능', /김교사쌤은 .*\(화\) 6교시에 이미 .* 겹쳐요/.test(pvW) && !(await P.evaluate(() => document.getElementById('scc-save-btn').disabled)), pvW);
  await P.click('button[onclick="sccClearPicks()"]'); await wait(100);
  check('"선택 지우기"', await P.evaluate(() => !scc.pickA && !scc.pickB && document.getElementById('scc-save-btn').disabled));

  // ---- 다른 날짜·교시 보강: 김교사 월4(과학)를 이교사가 목1(빈 시간)에 ----
  await P.click('#scc-type-makeup-btn'); await wait(100);
  await setWeek('a', wk[0]); await setWeek('b', wk[0]);
  await P.selectOption('#scc-partner', '이교사'); await wait(100);
  const lab = await P.evaluate(() => document.getElementById('scc-side-a-label').innerText + '/' + document.getElementById('scc-side-b-label').innerText);
  check('보강 칸 이름 + 오른쪽은 빈 시간만(이교사 목2 수업 칸은 흐리게, 목1 빈 칸은 누를 수 있음)', lab === '① 보강이 필요한 수업/② 보강해 줄 빈 시간' && /\bno\b/.test(await cls('b', wk[3], 2)) && /pick/.test(await cls('b', wk[3], 1)), [lab, await cls('b', wk[3], 2), await cls('b', wk[3], 1)]);
  await pick('a', wk[0], 4); await pick('b', wk[3], 1); await wait(100);
  await save();
  const mk = changes[changes.length - 1];
  check('다른 날짜 보강 저장', mk.type === 'makeup' && mk.teacher_a === '김교사' && mk.change_date === wk[0] && mk.change_date_b === wk[3] && mk.period_a === 4 && mk.period_b === 1, mk);
  const l4 = await cell('이교사', 1, 4), k4 = await cell('김교사', 4, 1);
  check('보강 반영: 이교사 목1에 김교사 과학, 김교사 월4 빔', l4 === '과학' && k4 === '', { l4, k4 });

  // ---- 변경 내역 ----
  await P.click('#scc-tab-list-btn'); await wait(200);
  check('내역 기간 탭 순서: 전체 · 오늘부터 · 이번 주 · 다음 주 · 이번 달 · 지난 내역(10/7 사용자)', await P.evaluate(() => [...document.querySelectorAll('#scc-range-btns .tab-btn')].map(b => b.innerText).join(',')) === '전체,오늘부터,이번 주,다음 주,이번 달,지난 내역');
  await P.click('#scc-range-btns [data-range="all"]'); await wait(100);
  const lst = await P.evaluate(() => ({ text: document.getElementById('scc-list').innerText, sum: document.getElementById('scc-list-summary').innerText, del: document.querySelectorAll('#scc-list button').length, days: [...document.querySelectorAll('#scc-list tr.scc-day')].map(t => t.innerText) }));
  check('내역(전체): 남이 등록한 것도, 두 날짜 표시, 날짜별 묶음, 담당은 전부 삭제 가능', lst.text.includes('이교사') && lst.text.includes('정교사') && /↔ 박교사 \d+\/\d+\(수\) 1교시/.test(lst.text) && /이교사가 대신 \(\d+\/\d+\(목\) 1교시에\)/.test(lst.text) && lst.del === changes.length && /전체 5건 \(교환 3 · 보강 2\)/.test(lst.sum) && lst.days.length >= 3, lst);
  await P.selectOption('#scc-type-filter', 'makeup'); await wait(100);
  check('구분: 보강만', /전체 2건/.test(await P.innerText('#scc-list-summary')));
  await P.selectOption('#scc-type-filter', 'all');
  await P.fill('#scc-search', '정교사'); await wait(100);
  check('이름 찾기', /전체 2건/.test(await P.innerText('#scc-list-summary')), await P.innerText('#scc-list-summary'));
  await P.fill('#scc-search', ''); await wait(50);
  await P.click('#scc-range-btns [data-range="nextweek"]'); await wait(100);
  check('다음 주만', /전체 1건/.test(await P.innerText('#scc-list-summary')) && (await P.innerText('#scc-list')).includes('같은 시간 반 맞바꿈'));
  await P.click('#scc-range-btns [data-range="past"]'); await wait(100);
  // 이번 주 월요일 기록(id 2)은 오늘이 화요일 이후면 지난 내역 — 요일마다 달라서 직접 센다
  const todayStr = await P.evaluate(() => todayYmdDash());
  const nPast = changes.filter(c => c.change_date < todayStr && (c.change_date_b || c.change_date) < todayStr).length;
  const pastTxt = [await P.innerText('#scc-list'), await P.innerText('#scc-list-summary'), await P.evaluate(() => document.getElementById('scc-excel-btn').disabled)];
  check('지난 내역: 두 날짜가 다 지난 것만(없으면 안내), 엑셀 버튼은 학기 전체라 그대로 켜짐', (nPast ? pastTxt[1].includes('전체 ' + nPast + '건') : pastTxt[0].includes('등록된 변경이 없어요')) && !pastTxt[2], [nPast, pastTxt]);
  const pastEmpty = await P.evaluate(() => { const keep = window.scheduleChangesAll; window.scheduleChangesAll = []; sccRenderList(); const r = [document.getElementById('scc-list').innerText, document.getElementById('scc-excel-btn').disabled]; window.scheduleChangesAll = keep; sccRenderList(); return r; });
  check('학기 내역이 하나도 없으면 안내 + 엑셀 버튼 꺼짐', pastEmpty[0].includes('등록된 변경이 없어요') && pastEmpty[1], pastEmpty);
  // 엑셀은 화면 거르기(다음 주·보강만)와 상관없이 학기 전체
  await P.click('#scc-range-btns [data-range="nextweek"]'); await P.selectOption('#scc-type-filter', 'makeup'); await wait(100);
  check('엑셀 버튼 이름: "2학기 전체 엑셀로 받기"', /2학기 전체 엑셀로 받기/.test(await P.innerText('#scc-excel-btn')), await P.innerText('#scc-excel-btn'));
  const si = await P.evaluate(() => sccSemesterInfo());

  // ---- 엑셀: 제목·틀 고정·필터·색 ----
  let excelPath = null;
  try { excelPath = require.resolve('exceljs/dist/exceljs.min.js'); } catch (e) {}
  if (!excelPath) {
    console.log('  ⚠️ exceljs가 없어 엑셀 검사를 건너뜀 (npm i exceljs 후 NODE_PATH에 추가)');
  } else {
    const ExcelJS = require('exceljs');
    // 이 테스트 브라우저는 한글 파일 이름을 "download"로 바꿔 버려서, 파일 이름은 링크에 붙인 값으로 확인한다.
    await P.evaluate(() => { const orig = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function() { window.__dlName = this.download; return orig.apply(this, arguments); }; });
    const [dl] = await Promise.all([P.waitForEvent('download', { timeout: 15000 }), P.click('#scc-excel-btn')]);
    const out = path.join(__dirname, 'scc-export-test.xlsx');
    await dl.saveAs(out);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(out);
    const ws = wb.worksheets[0];
    const v = ws.views[0] || {};
    const head = ws.getRow(3).values.slice(1);
    const r4 = ws.getRow(4);
    const x = {
      name: await P.evaluate(() => window.__dlName), sheet: ws.name, title: ws.getCell('A1').value, sub: ws.getCell('A2').value, frozen: v.state === 'frozen' && v.ySplit === 3,
      filter: ws.autoFilter, head: head.join(','), rows: ws.rowCount - 3, headFill: ws.getCell('A3').fill && ws.getCell('A3').fill.fgColor.argb,
      d1: r4.getCell(1).value instanceof Date ? r4.getCell(1).value.toISOString().slice(0, 10) : r4.getCell(1).value, fmt: r4.getCell(1).numFmt,
      landscape: ws.pageSetup.orientation, fitW: ws.pageSetup.fitToWidth, border: !!(r4.getCell(5).border && r4.getCell(5).border.top),
    };
    fs.unlinkSync(out);
    check('엑셀: 화면 거르기와 상관없이 학기 전체 5건, 파일 이름·제목에 학기, 기간 줄, 머리줄 틀 고정, 필터(A3~P), 머리줄 색, 날짜는 진짜 날짜, 테두리, A4 가로 한 장 폭',
      /^수업변경내역_\d{4}학년도_2학기\.xlsx$/.test(x.name) && x.title === si.label + ' 수업 변경 내역' && /^\d{4}학년도 2학기$/.test(si.label) &&
      String(x.sub).startsWith('기간: ' + si.start + ' ~ ' + si.end + ' · 총 5건') && x.sheet === '수업 변경 내역' && x.frozen &&
      /^A3:P8$/.test(typeof x.filter === 'string' ? x.filter : '') && x.head.startsWith('날짜,요일,교시,구분,원래 선생님,과목') && x.rows === 5 &&
      x.headFill === 'FF1F3A5F' && x.d1 === wk[0] && x.fmt === 'yyyy-mm-dd' && x.landscape === 'landscape' && x.fitW === 1 && x.border, x);
    // 연속 교환 기록의 과목·반 칸 = 그 기록이 실제로 옮긴 수업(정규 시간표 칸이 아니라)
    const xc = await P.evaluate(async (wk) => {
      const keep = window.scheduleChangesAll;
      window.scheduleChangesAll = [
        { id: 1, change_date: wk[0], change_date_b: wk[2], type: 'exchange', teacher_a: '김교사', period_a: 1, teacher_b: '박교사', period_b: 1, created_by: 'x' },
        { id: 3, change_date: wk[2], change_date_b: wk[1], type: 'exchange', teacher_a: '김교사', period_a: 1, teacher_b: '이교사', period_b: 1, created_by: 'x' }];
      const wb = await sccBuildWorkbook(window.scheduleChangesAll.slice(1));
      window.scheduleChangesAll = keep;
      const r = wb.worksheets[0].getRow(4);
      return [6, 7, 12, 13].map(n => String(r.getCell(n).value || ''));
    }, wk);
    check('엑셀 연속 교환: 둘째 교환의 과목·반 = 옮겨 온 "국어 200", 상대 = "수학 207"', xc.join('|') === '국어|200|수학|207', xc);
  }
  await P.selectOption('#scc-type-filter', 'all'); await P.click('#scc-range-btns [data-range="all"]');
  await P.click('#scc-tab-new-btn'); await wait(100);

  // 같은 시간 교환 반영: 김교사 월1 국어 ↔ 정교사 월1 과학 → 김교사 칸에 과학, 정교사 칸에 국어
  await P.evaluate((d) => { window.scheduleChangesAll = window.scheduleChangesRaw = [{ id: 98, change_date: d, change_date_b: d, type: 'exchange', teacher_a: '김교사', period_a: 1, teacher_b: '정교사', period_b: 1, created_by: 'x' }]; }, wk[0]); // 기록 전부를 바꿔 넣음(연속 교환 계산은 전체 기록을 씀)
  const sk = await cell('김교사', 1, 1), sj = await cell('정교사', 1, 1);
  check('같은 시간 교환 반영: 김교사 월1 과학 / 정교사 월1 국어', sk === '과학' && sj === '국어', { sk, sj });

  // 예전 기록(change_date_b 없음)은 예전처럼 같은 날로
  await P.evaluate((d) => { window.scheduleChangesAll = window.scheduleChangesRaw = [{ id: 99, change_date: d, type: 'exchange', teacher_a: '김교사', period_a: 1, teacher_b: '박교사', period_b: 4, created_by: 'x' }]; }, wk[0]);
  const o1 = await cell('김교사', 4, 1);
  check('예전 기록(날짜 하나)도 그대로: 김교사 월1 국어가 월4로(월4엔 원래 과학이 있어서 두 수업이 겹쳐 같이 보임 — 예전엔 과학이 덮여 사라졌음)', o1 === '과학 / 국어' && await cell('김교사', 1, 1) === '', o1);
  await P.evaluate(async () => { await fetchScheduleChanges(); });
  // 역할 "교사" + 담당 + 본인 시간표 없음: 내 시간표 자리에서 선생님 골라 보기 + 수업변경 버튼 둘 다
  const g = await openDevice(browser, '수업계교사PC', '66666666-6666-6666-6666-666666666666');
  await wait(1000);
  const gs = await g.page.evaluate(() => { const w = document.getElementById('my-tt-widget'); const vis = (el) => getComputedStyle(el).display !== 'none'; return { browse: w.classList.contains('my-tt-browse'), sel: vis(document.getElementById('m-tt-teacher-select')), wBtn: vis(w.querySelector('.m-tt-change-btn')) }; });
  check('교사 역할 담당: 선생님 골라 보기 + 시간표 칸 수업변경 버튼', gs.browse && gs.sel && gs.wBtn, gs);
  // 일반 교사: 같은 큰 창, 왼쪽은 나로 고정, 내역은 내 것만, 남이 등록한 건 못 지움
  const t = await openDevice(browser, '김교사PC', T1);
  await wait(1000);
  const tb = await t.page.evaluate(() => document.getElementById('btn-scc-manager') ? 'exists' : 'none');
  await t.page.click('#my-tt-widget .m-tt-change-btn'); await wait(400);
  const tm = await t.page.evaluate(() => ({
    big: document.querySelector('#schedule-change-overlay .scc-box').getBoundingClientRect().width > 1200,
    aSel: getComputedStyle(document.getElementById('scc-teacher-a')).display, fixed: document.getElementById('scc-teacher-a-fixed').innerText,
    grid: document.querySelectorAll('#scc-grid-a .scc-cell').length,
  }));
  await t.page.click('#scc-tab-list-btn'); await wait(100);
  await t.page.click('#scc-range-btns [data-range="all"]'); await wait(100);
  const tl = await t.page.evaluate(() => ({ rows: [...document.querySelectorAll('#scc-list tbody tr:not(.scc-day)')].map(r => r.innerText), del: document.querySelectorAll('#scc-list button').length, sum: document.getElementById('scc-list-summary').innerText }));
  check('일반 교사: 둘째 줄 버튼 없음, 같은 큰 창·왼쪽은 나(김교사) 고정', tb === 'none' && tm.big && tm.aSel === 'none' && tm.fixed === '김교사 (나)' && tm.grid === 35, [tb, tm]);
  check('일반 교사 내역: 내 것만(이교사→정교사 보강 없음), 남이 등록한 건 삭제 버튼 없음', tl.rows.length === 4 && tl.rows.every(r => r.includes('김교사')) && tl.del === 0 && /^내 변경 4건/.test(tl.sum), tl);
  // 휴대폰: 두 시간표를 위아래로
  await t.page.setViewportSize({ width: 390, height: 800 }); await wait(300);
  await t.page.evaluate(() => sccShowTab('new')); await wait(100); // 휴대폰 폭에선 테스트용 새로고침 띠가 버튼을 가림
  const mob = await t.page.evaluate(() => { const a = document.getElementById('scc-grid-a').getBoundingClientRect(), b = document.getElementById('scc-grid-b').getBoundingClientRect(); return { stacked: b.top > a.bottom, fits: a.width <= 390 && b.width <= 390, h: a.height }; });
  check('휴대폰: 두 시간표 위아래, 화면 폭 안', mob.stacked && mob.fits && mob.h > 300, mob);
  // 서버가 한 번에 1000줄만 주어도 끝까지 받는지(연속 교환은 기록이 하나라도 빠지면 틀림)
  const nBefore = changes.length;
  for (let i = 0; i < 1500; i++) changes.push({ id: 1000 + i, change_date: wk[4], change_date_b: wk[4], type: 'makeup', teacher_a: '더미' + i, period_a: 7, teacher_b: '더미선생', period_b: 7, created_by: 'x' });
  const got = await t.page.evaluate(async () => { await fetchScheduleChanges(); return window.scheduleChangesAll.length; });
  check('기록이 1000건을 넘어도 끝까지 받음(1000줄씩 나눠서)', got === nBefore + 1500, { got, want: nBefore + 1500 });
  changes.splice(nBefore);
  const allErrors = pages.flatMap(p => (p.errors || []).map(e => p.name + ': ' + e));
  check('전체 페이지 오류 없음', allErrors.length === 0, allErrors);
  console.log(failures === 0 ? '\n모든 검사 통과' : '\n실패 ' + failures + '건');
  await browser.close();
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
