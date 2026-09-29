// 본인 시간표가 없는 분(교장 등)의 홈: "내 시간표" 칸에서 선생님을 골라 보고, 고른 선생님이
// 계정에 저장돼 다른 기기(휴대폰)에도 반영되는지 확인한다. 가짜 서버 부분은 staff-test.js와 같다.
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
  ['44444444-4444-4444-4444-444444444444']: { id: '44444444-4444-4444-4444-444444444444', name: '교장님', is_admin: false, must_change_password: false, role: '교장', homeroom_grade: null, homeroom_class: null },
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
  const B = '44444444-4444-4444-4444-444444444444';
  const pc = await openDevice(browser, '교장PC', B);
  const P = pc.page;
  await wait(1500);
  const st = await P.evaluate(() => {
    const w = document.getElementById('my-tt-widget');
    const vis = (el) => el && getComputedStyle(el).display !== 'none';
    return {
      browse: w.classList.contains('my-tt-browse'),
      selVis: vis(document.getElementById('m-tt-teacher-select')),
      navVis: [...w.querySelectorAll('.m-tt-nav')].every(vis),
      changeHidden: !vis(w.querySelector('.m-tt-change-btn')),
      title: w.querySelector('.m-tt-title-mobile').offsetParent !== null && !vis(w.querySelector('.m-tt-title-desktop')),
      first: document.getElementById('m-tt-teacher-select').options[0].text,
      opts: document.getElementById('m-tt-teacher-select').options.length,
      cell: document.getElementById('my-tt-1-1-s').innerText,
      editable: document.getElementById('my-tt-1-1-s').getAttribute('contenteditable'),
    };
  });
  check('시간표 없는 분: 선생님 고르는 목록·◀▶ 보이고, 제목 "시간표", 수업변경 숨김, 빈 칸', st.browse && st.selVis && st.navVis && st.changeHidden && st.title && st.first === '-- 선택 --' && st.opts === 9 && st.cell === '' && st.editable === 'false', st);
  await P.selectOption('#m-tt-teacher-select', '김교사'); await wait(300);
  check('김교사 고르면 그 시간표가 보임', await P.evaluate(() => document.getElementById('my-tt-1-1-s').innerText) === '국어');
  await P.click('#my-tt-widget .m-tt-nav >> nth=1'); await wait(300);
  check('▶ 누르면 다음 선생님(박교사)', await P.evaluate(() => document.getElementById('m-tt-teacher-select').value) === '박교사');
  await P.click('#my-tt-widget .m-tt-nav >> nth=0'); await P.click('#my-tt-widget .m-tt-nav >> nth=0'); await wait(300);
  const v = await P.evaluate(() => document.getElementById('m-tt-teacher-select').value);
  check('◀ 두 번이면 "-- 선택 --"을 건너뛰고 맨 끝 선생님으로', v !== '' && v !== '김교사', v);
  await P.selectOption('#m-tt-teacher-select', '김교사'); await wait(2500);
  check('고른 선생님이 계정에 저장됨(서버)', serverVal(B, 'my-tt-view') === '김교사', serverVal(B, 'my-tt-view'));
  await P.locator('#left-bottom-tt').screenshot({ path: 'nosched.png' });
  // 다른 기기에서 받은 자료가 반영되며 칸을 다시 그려도 보여야 함
  await P.evaluate(() => refreshDashboardFromLocalStorage()); await wait(300);
  check('다른 기기 자료 반영(칸 다시 그림) 뒤에도 그대로', await P.evaluate(() => document.getElementById('my-tt-1-1-s').innerText) === '국어');
  await P.reload(); await P.waitForFunction(() => typeof syncAppStarted !== 'undefined' && syncAppStarted === true); await wait(1500);
  check('새로고침해도 김교사 유지', await P.evaluate(() => document.getElementById('m-tt-teacher-select').value + '|' + document.getElementById('my-tt-1-1-s').innerText) === '김교사|국어');
  // 휴대폰에서도 같게
  const mob = await openDevice(browser, '교장폰', B, { mobile: true });
  await wait(1500);
  check('휴대폰에서도 김교사 시간표', await mob.page.evaluate(() => document.getElementById('m-tt-teacher-select').value + '|' + document.getElementById('my-tt-1-1-s').innerText) === '김교사|국어');
  // PC 폭을 휴대폰으로 줄였다 늘려도 유지
  await P.setViewportSize({ width: 400, height: 800 }); await wait(500);
  await P.setViewportSize({ width: 1600, height: 1000 }); await wait(500);
  check('휴대폰 폭 갔다 와도 유지', await P.evaluate(() => document.getElementById('m-tt-teacher-select').value + '|' + document.getElementById('my-tt-1-1-s').innerText) === '김교사|국어');
  // 일반 교사는 그대로
  const t = await openDevice(browser, '김교사PC', T1);
  await wait(1000);
  const tt = await t.page.evaluate(() => { const w = document.getElementById('my-tt-widget'); return { browse: w.classList.contains('my-tt-browse'), selVis: getComputedStyle(document.getElementById('m-tt-teacher-select')).display !== 'none', name: document.getElementById('my-tt-name').innerText, editable: document.getElementById('my-tt-1-1-s').getAttribute('contenteditable') }; });
  check('이름 동그라미는 성 뺀 두 글자(교장님 → 장님, 김교사 → 교사)', await P.evaluate(() => document.getElementById('user-avatar-initial').innerText) === '장님' && await t.page.evaluate(() => document.getElementById('user-avatar-initial').innerText) === '교사');
  check('시간표 있는 교사는 예전 그대로(내 시간표, 목록 안 보임)', !tt.browse && !tt.selVis && tt.name === '김교사' && tt.editable === 'true', tt);
  const allErrors = pages.flatMap(p => (p.errors || []).map(e => p.name + ': ' + e));
  check('전체 페이지 오류 없음', allErrors.length === 0, allErrors);
  console.log(failures === 0 ? '\n모든 검사 통과' : '\n실패 ' + failures + '건');
  await browser.close();
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
