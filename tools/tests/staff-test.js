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
  ['33333333-3333-3333-3333-333333333333']: { id: '33333333-3333-3333-3333-333333333333', name: '최실무', is_admin: false, must_change_password: false, role: '실무사', homeroom_grade: null, homeroom_class: null },
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
  if (table === 'timetable' && op === 'select') {
    const subj = ['국어','수학','영어','과학','사회','체육','음악','미술'];
    const rows = ['김교사','박교사','이교사','정교사','한교사','오교사','윤교사','장교사'].map((nm, t) => ({ teacher_name: nm, cells: Array.from({length:35}, (_, j) => (j + t) % 3 === 0 ? subj[(j + t) % 8] + '\n' + (200 + j) : '') }));
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
  seed(T1, { 'cal-memo-2026-09-30': '서버 메모', 'work-txt1': '할일1', 'theme': 'dark', 'ms-data': JSON.stringify({ school: 'A', title: 't' }) });
  seed(T2, { 'cal-memo-2026-10-01': '박교사 메모' });

  const S = '33333333-3333-3333-3333-333333333333';
  const staff = await openDevice(browser, '실무사PC', S);
  const P = staff.page;
  await P.setViewportSize({ width: 2000, height: 1030 }); await wait(1500);
  const st = await P.evaluate(() => ({
    mode: document.getElementById('main-dashboard').classList.contains('staff-mode'),
    grids: document.querySelectorAll('#staff-grid .timetable-grid').length,
    noticeIn: !!document.querySelector('#staff-info-top #notice-widget'),
    mealIn: !!document.querySelector('#staff-info-top #meal-widget'),
    colsHidden: [...document.querySelectorAll('#main-dashboard > .dash-col')].every(c => getComputedStyle(c).display === 'none'),
    opts: document.getElementById('staff-tt-select-1').options.length,
  }));
  check('실무사 홈: 시간표 7칸 + 공지·급식 이동 + 기존 칸 숨김', st.mode && st.grids === 7 && st.noticeIn && st.mealIn && st.colsHidden && st.opts === 9, st);
  await P.selectOption('#staff-tt-select-1', '김교사'); await wait(300);
  await P.click('#staff-grid button[onclick="moveStaffTeacher(2, 1)"]'); await wait(300);
  await P.click('#staff-grid button[onclick="moveStaffTeacher(2, 1)"]'); await wait(300);
  const sel = await P.evaluate(() => [1,2].map(i => [document.getElementById('staff-tt-name-' + i).innerText, document.getElementById('staff' + i + '-tt-1-1-s').innerText]));
  check('선생님 고르기/▶ 넘기기', sel[0][0] === '김교사' && sel[0][1] === '국어' && sel[1][0] === '박교사', sel);
  check('조회 칸은 편집 불가', await P.evaluate(() => document.getElementById('staff1-tt-1-1-s').getAttribute('contenteditable') === 'false' && !document.getElementById('staff1-tt-1-1-s').classList.contains('editable')));
  await wait(2500);
  check('고른 선생님 서버 저장(다른 기기 동기화)', serverVal(S, 'staff-tt-sel-1') === '김교사' && serverVal(S, 'staff-tt-sel-2') === '박교사', [serverVal(S, 'staff-tt-sel-1'), serverVal(S, 'staff-tt-sel-2')]);
  await P.evaluate(() => {
    document.getElementById('meal-list').innerHTML = ['혼합잡곡밥','뼈없는감자탕','탕평채','*쭈꾸미오징어볶음','석박지'].map(m => '<li>' + m + '</li>').join('');
    document.getElementById('meal-kcal').innerText = '열량: 804.6 Kcal';
    document.getElementById('meal-date-label').innerText = '9/29';
  });
  await wait(200);
  const hd = await P.evaluate(() => { const t = document.querySelector('#meal-widget .widget-title'); const k = document.getElementById('meal-kcal').getBoundingClientRect(); const w = document.getElementById('meal-widget').getBoundingClientRect(); return { titleH: t.getBoundingClientRect().height, kcalBottom: w.bottom - k.bottom, kcalInside: k.right <= w.right && k.bottom <= w.bottom }; });
  const listB = await P.evaluate(() => document.getElementById('meal-list').getBoundingClientRect().bottom); const kTop = await P.evaluate(() => document.getElementById('meal-kcal').getBoundingClientRect().top); check('급식 제목줄 한 줄 + 칼로리는 메뉴와 안 겹치고 칸 안 아래쪽', hd.titleH < 30 && hd.kcalInside && hd.kcalBottom < 20 && kTop >= listB - 1, [hd, listB, kTop]);
  await P.screenshot({ path: 'staff.png', clip: { x: 1500, y: 160, width: 500, height: 440 } });
  const fz = () => P.evaluate(() => parseFloat(getComputedStyle(document.getElementById('staff3-tt-1-1-s')).fontSize));
  const f0 = await fz();
  await P.click('#staff-grid button[onclick="changeFontSize(\'staff-tt\', 1)"]'); await P.click('#staff-grid button[onclick="changeFontSize(\'staff-tt\', 1)"]'); await wait(300);
  const f1 = await fz();
  const myTt = await P.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--fz-tt').trim());
  check('A+ 두 번 → 7칸 시간표 글씨 +2px, 일반 시간표 크기와는 별개', f1 === f0 + 2 && myTt === '13px', [f0, f1, myTt]);
  await P.screenshot({ path: 'staff-fz.png', clip: { x: 70, y: 160, width: 1000, height: 440 } });
  await wait(2000);
  await P.reload(); await P.waitForFunction(() => typeof syncAppStarted !== 'undefined' && syncAppStarted === true); await wait(1500);
  check('새로고침해도 고른 선생님 유지', await P.evaluate(() => document.getElementById('staff-tt-name-1').innerText) === '김교사');
  check('새로고침해도 글씨 크기 유지', await fz() === f1, [await fz(), f1]);
  // 휴대폰 폭으로 줄였다 늘리기
  await P.setViewportSize({ width: 400, height: 800 }); await wait(500);
  await P.setViewportSize({ width: 2000, height: 1030 }); await wait(500);
  check('휴대폰 폭 갔다 와도 공지·급식이 정보 칸에', await P.evaluate(() => !!document.querySelector('#staff-info-top #notice-widget') && !!document.querySelector('#staff-info-top #meal-widget')));
  // 일반 교사는 그대로
  const pc = await openDevice(browser, 'PC', T1);
  check('일반 교사 홈은 그대로', await pc.page.evaluate(() => !document.getElementById('main-dashboard').classList.contains('staff-mode') && !!document.querySelector('.dash-col #notice-widget')));
  const allErrors = pages.flatMap(p => (p.errors || []).map(e => p.name + ': ' + e));
  check('전체 페이지 오류 없음', allErrors.length === 0, allErrors);
  console.log(failures === 0 ? '\n모든 검사 통과' : '\n실패 ' + failures + '건');
  await browser.close();
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
