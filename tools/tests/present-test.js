// 🎤 발표 모드: Ctrl+Shift+P·이름 메뉴로 켜고 끄기, 노란 동그라미·물결, 마우스 아래 작은 것(단추)만 테두리+이름표(큰 칸은 안 잡음), 효과 고르기는 이 컴퓨터에만(device-present).
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

// 각 설명서를 끝까지 넘기며 단계마다 실제로 짚는 위치를 기록한다(빠진 단계·엉뚱한 순서 확인용).
async function walk(P, openExpr) {
  await P.evaluate(openExpr); await wait(400);
  const seen = [];
  for (let k = 0; k < 80; k++) { // 양식 설명서는 50단계 넘음(이름표 묶음까지)
    const st = await P.evaluate(() => {
      const ov = document.getElementById('tour-overlay');
      if (ov.style.display === 'none') return null;
      const sp = document.getElementById('tour-spotlight').getBoundingClientRect();
      return { title: document.getElementById('tour-card-title').innerText, prog: document.getElementById('tour-card-progress').innerText, x: Math.round(sp.left), y: Math.round(sp.top), w: Math.round(sp.width), h: Math.round(sp.height), btn: document.getElementById('tour-next-btn').innerText };
    });
    if (!st) break;
    seen.push(st);
    await P.click('#tour-next-btn'); await wait(450);
  }
  return seen;
}
function show(name, seen) {
  console.log('--- ' + name);
  seen.forEach(s => console.log('   ' + s.prog.padEnd(7) + ' (' + s.x + ',' + s.y + ' ' + s.w + 'x' + s.h + ') ' + s.title));
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }).catch(() => chromium.launch());
  const pc = await openDevice(browser, 'PC', T1);
  const P = pc.page;
  await wait(800);
  const st = () => P.evaluate(() => { const bar = document.getElementById('pm-bar'), box = document.getElementById('pm-box'), halo = document.getElementById('pm-halo'), tag = document.getElementById('pm-tag');
    return { bar: !!bar && bar.style.display === 'flex', halo: !!halo && halo.style.display !== 'none', box: !!box && parseInt(box.style.left) > -1000, nob: !!box && box.classList.contains('nob'), tag: tag ? (tag.style.display === 'none' ? '' : tag.textContent) : '', on: pmOn }; });
  const hover = async (sel, dx, dy) => { const b = await P.locator(sel).first().boundingBox(); await P.mouse.move(b.x + (dx == null ? b.width / 2 : dx), b.y + (dy == null ? b.height / 2 : dy)); await wait(120); };

  console.log('[1] 켜기');
  check('처음엔 꺼짐(막대 없음)', !(await st()).bar);
  await P.keyboard.press('Control+Shift+KeyP'); await wait(150);
  await hover('.qbtn.tour-btn');
  let s = await st();
  check('Ctrl+Shift+P → 막대 + 노란 동그라미', s.on && s.bar && s.halo, s);
  check('설명서 단추 위 → 그 단추만 테두리 + 이름표 "설명서"', s.box && /설명서/.test(s.tag), s);
  await wait(250);
  const fit = await P.evaluate(() => { const a = document.getElementById('pm-box').getBoundingClientRect(), b = document.querySelector('.qbtn.tour-btn').getBoundingClientRect(); return Math.abs(a.width - b.width - 6) < 2 && Math.abs(a.height - b.height - 6) < 2; });
  check('테두리 크기 = 단추 크기(+3px)', fit);

  console.log('[2] 큰 칸은 안 잡음 · 빈틈은 잠깐 그대로');
  await hover('#todo-work-panel, #todo-work', 4, 260);
  const mid = await st();
  await wait(450);
  const after = await st();
  check('빈 곳으로 옮긴 직후엔 테두리 그대로(깜빡임 방지), 0.35초 뒤 사라짐', mid.box && !after.box, [mid, after]);
  await hover('#my-tt-widget', 8, 8);
  await wait(450);
  check('내 시간표 칸 모서리(칸 전체) → 테두리 없음', !(await st()).box, await st());

  console.log('[3] 물결 · 효과 고르기');
  await hover('.qbtn.tour-btn');
  await P.evaluate(() => { const o = document.getElementById('pm-bar'); o.style.opacity = 1; });
  const rings = await P.evaluate(async () => { const b = document.querySelector('.qbtn.tour-btn').getBoundingClientRect(); document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: b.left + 5, clientY: b.top + 5 })); return document.querySelectorAll('.pm-ring').length; });
  check('누르면 빨간 물결', rings === 1, rings);
  await P.click('#pm-bar input[data-pm="tag"]'); await hover('.qbtn.tour-btn');
  check('④ 이름표 끄기 → 테두리만', (await st()).box && (await st()).tag === '', await st());
  await P.click('#pm-bar input[data-pm="tag"]'); await P.click('#pm-bar input[data-pm="box"]'); await hover('.qbtn.tour-btn');
  s = await st();
  check('③ 테두리 끄기 → 이름표만(테두리 투명)', s.box && s.nob && /설명서/.test(s.tag), s);
  await P.click('#pm-bar input[data-pm="box"]');
  await P.click('#pm-bar input[data-pm="dim"]'); await hover('.qbtn.tour-btn');
  check('⑤ 어둡게 → 그 단추 둘레만 밝게', await P.evaluate(() => parseInt(document.getElementById('pm-spot').style.left) > -1000));
  const saved = await P.evaluate(() => JSON.parse(localStorage.getItem('device-present') || '{}'));
  check('고른 효과는 이 컴퓨터에만 기억(device-present, 서버로 안 보냄)', saved.dim === true && saved.box === true && saved.tag === true && await P.evaluate(() => !getSyncDirtyKeys().includes('device-present')), saved);

  console.log('[4] 끄기 · 이름 메뉴');
  await P.click('#pm-off'); await wait(100);
  s = await st();
  check('✕ 끄기 → 막대·동그라미·테두리 모두 사라짐', !s.on && !s.bar && !s.halo && !s.box, s);
  await P.click('#user-chip'); await wait(150);
  check('이름 메뉴에 🎤 발표 모드', /발표 모드/.test(await P.innerText('#user-menu-dropdown')));
  await P.click('#btn-present'); await wait(150);
  check('이름 메뉴로 켜짐 + 메뉴 닫힘 + 지난번 고른 효과 그대로(⑤ 켜짐)', (await st()).on && await P.evaluate(() => document.getElementById('user-menu-dropdown').style.display === 'none' && document.querySelector('#pm-bar input[data-pm="dim"]').checked));
  await P.click('#pm-bar input[data-pm="dim"]');
  await hover('.qbtn.tour-btn'); await P.evaluate(() => { document.getElementById('pm-bar').style.opacity = 1; });
  await P.screenshot({ path: 'present.png' });
  await P.keyboard.press('Control+Shift+KeyP'); await wait(100);
  check('Ctrl+Shift+P 다시 → 꺼짐', !(await st()).on);
  check('페이지 오류 없음', pc.errors.length === 0, pc.errors);
  await browser.close();
  console.log(failures ? '실패 ' + failures + '건' : '모든 검사 통과');
  process.exit(failures ? 1 : 0);
})();
