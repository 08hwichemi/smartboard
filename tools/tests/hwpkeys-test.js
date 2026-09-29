// 가짜 Supabase 서버(Node 메모리) 하나에 PC/휴대폰 브라우저 두 개를 붙여서
// index.html의 실제 동기화 코드를 시나리오별로 돌려 본다.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

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
  const open = () => P.evaluate(() => document.getElementById('hwpkeys-overlay').style.display === 'flex');

  // 레일에서 명렬표 바로 아래
  const order = await P.evaluate(() => [...document.querySelectorAll('#app-rail .rail-item')].map(e => e.title));
  check('레일 순서: 명렬표 바로 아래 한글 단축키', order[order.indexOf('명렬표') + 1] === '한글 단축키', order);

  await P.click('#rail-hwpkeys-btn'); await wait(300);
  check('누르면 열림 + 버튼 표시', await open() && await P.evaluate(() => document.getElementById('rail-hwpkeys-btn').classList.contains('active')));
  const info = await P.evaluate(() => ({ secs: [...document.querySelectorAll('#hwpkeys-list .hwp-sec')].map(e => e.innerText), rows: document.querySelectorAll('#hwpkeys-list .hwp-row').length }));
  check('분류 7개, 단축키 전부 표시', info.secs.join(',') === '파일 / 쪽,글자,수식,표 / 셀,문단,서식,조판' && info.rows === 50, info);
  const panelBox = await P.locator('#hwpkeys-overlay .modal-box').boundingBox();
  check('왼쪽 레일 바로 옆에 붙어 열림', Math.round(panelBox.x) === 68, panelBox);
  await P.locator('#hwpkeys-overlay .modal-box').screenshot({ path: 'hwpkeys.png' });

  // 줄이 넘치지 않음(이름·키가 한 줄 안에서 겹치지 않음)
  const overflow = await P.evaluate(() => [...document.querySelectorAll('.hwp-row')].filter(r => r.scrollWidth > r.clientWidth + 1).map(r => r.innerText));
  check('가로로 넘치는 줄 없음', overflow.length === 0, overflow);

  // 찾기
  await P.fill('#hwpkeys-search', '정렬'); await wait(150);
  const found = await P.evaluate(() => [...document.querySelectorAll('.hwp-row .hwp-name')].map(e => e.innerText));
  check('"정렬" 찾기 → 정렬 5개만', found.length === 5 && found.every(n => n.includes('정렬')), found);
  await P.fill('#hwpkeys-search', '셀 선택'); await wait(150);
  check('띄어쓰기 달라도 찾음("셀 선택")', await P.evaluate(() => document.querySelectorAll('.hwp-row').length) >= 3);
  await P.fill('#hwpkeys-search', '없는말'); await wait(150);
  check('없으면 안내 문구', /찾는 단축키가 없어요/.test(await P.locator('#hwpkeys-list').innerText()));
  await P.fill('#hwpkeys-search', ''); await wait(150);

  // 글자 크기
  await P.click('#hwpkeys-overlay button:has-text("A+")'); await wait(150);
  check('A+ → 글자 13px, 계정 자료로 저장', await ls(pc, 'fz-hwp') === '13' && await P.evaluate(() => getComputedStyle(document.querySelector('.hwp-name')).fontSize) === '13px');

  // 닫기 방법들
  await P.click('#rail-hwpkeys-btn'); await wait(200);
  check('같은 버튼 한 번 더 → 닫힘', !(await open()) && !(await P.evaluate(() => document.getElementById('rail-hwpkeys-btn').classList.contains('active'))));
  await P.click('#rail-hwpkeys-btn'); await wait(200);
  await P.mouse.click(1200, 500); await wait(200);
  check('바깥(어두운 곳) 누르면 닫힘', !(await open()));
  await P.click('#rail-hwpkeys-btn'); await wait(200);
  await P.click('#rail-monthly-btn'); await wait(600);
  check('다른 메뉴(월간일정표) 누르면 닫히고 그 화면으로', !(await open()) && await P.evaluate(() => document.getElementById('monthly-page').style.display === 'flex'));
  await P.click('#rail-hwpkeys-btn'); await wait(200);
  await P.click('#rail-home-btn'); await wait(300);
  check('홈 누르면 닫힘', !(await open()));
  await P.click('#rail-hwpkeys-btn'); await wait(200);
  await P.click('#rail-app-roster, .rail-item[title="명렬표"]'); await wait(500);
  check('명렬표 누르면 단축키 닫히고 명렬표 열림', !(await open()) && await P.evaluate(() => document.getElementById('roster-overlay').style.display === 'flex'));
  await P.click('#rail-hwpkeys-btn'); await wait(300);
  check('단축키 누르면 명렬표 닫히고 단축키 열림', await open() && await P.evaluate(() => document.getElementById('roster-overlay').style.display === 'none'));

  // 휴대폰에서도 열림
  const m = await openDevice(browser, 'M', T1, { mobile: true });
  const railShown = await m.page.evaluate(() => { const b = document.getElementById('rail-hwpkeys-btn'); return b && b.offsetParent !== null; });
  if (railShown) {
    await m.page.click('#rail-hwpkeys-btn'); await wait(300);
    check('휴대폰: 열림', await m.page.evaluate(() => document.getElementById('hwpkeys-overlay').style.display === 'flex'));
  } else console.log('  (휴대폰은 왼쪽 레일이 없음 — 건너뜀)');

  const errs = [...pc.errors, ...m.errors];
  check('페이지 오류 없음', errs.length === 0, errs);
  console.log(failures ? ('실패 ' + failures + '건') : '모든 검사 통과');
  await browser.close();
  process.exit(failures ? 1 : 0);
})();
