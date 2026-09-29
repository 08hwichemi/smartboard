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
  seed(T1, { 'cal-memo-2026-09-30': '서버 메모', 'work-txt1': '할일1', 'theme': 'dark', 'ms-data': JSON.stringify({ school: 'A', title: 't' }) });
  seed(T2, { 'cal-memo-2026-10-01': '박교사 메모' });

  const pc = await openDevice(browser, 'PC', T1);
  const phone = await openDevice(browser, '휴대폰', T1, { mobile: true });
  const today = new Date(); const dStr = today.getFullYear() + String(today.getMonth()+1).padStart(2,'0') + '15';
  const key = 'cal-memo-' + dStr;
  // 사용자처럼 편집: 포커스 → 내용 바꾸고 input 이벤트 → blur
  async function typeInto(page, sel, text) {
    await page.evaluate(([sel, text]) => { const el = document.querySelector(sel); el.focus(); el.innerHTML = text; el.dispatchEvent(new Event('input', { bubbles: true })); }, [sel, text]);
  }
  const blur = (page) => page.evaluate(() => document.activeElement && document.activeElement.blur());

  await pc.page.evaluate(() => switchMainTab('cal')); await wait(300);
  console.log('\n[A] 휴대폰 달력 편집칸으로 메모 입력 → PC에 반영');
  await phone.page.evaluate(() => mSwitchTab && mSwitchTab('cal')).catch(() => {});
  await phone.page.evaluate((k) => mOpenCalDayDetail(k, '테스트날'), key); await wait(400);
  await typeInto(phone.page, '#m-cal-detail-editor', '테스트'); await blur(phone.page);
  await wait(2500);
  check('서버 저장', serverVal(T1, key) === '테스트', serverVal(T1, key));
  check('PC 화면 칸에 표시', await pc.page.evaluate((k) => document.getElementById(k) && document.getElementById(k).innerText, key) === '테스트');

  console.log('\n[B] PC 화면에서 그 메모를 지움 → 휴대폰이 되살리지 않음');
  console.log('PC 칸 존재?', await pc.page.evaluate((k) => { const el = document.getElementById(k); return el ? [el.tagName, el.getAttribute('contenteditable'), el.innerHTML, document.querySelectorAll('[id="'+k+'"]').length] : null; }, key));
  await typeInto(pc.page, '#' + key, ''); 
  console.log('flag', await pc.page.evaluate((k) => [document.activeElement.id, document.getElementById(k).__userEdited], key));
  await blur(pc.page);
  console.log('after blur', await pc.page.evaluate((k) => [localStorage.getItem(k), getSyncDirtyKeys()], key));
  await wait(2500);
  console.log('phone ls', await phone.page.evaluate((k) => localStorage.getItem(k), key), phone.page.isClosed());
  check('서버에서 지워짐', serverVal(T1, key) === null, serverVal(T1, key));
  check('휴대폰 저장소에서도 지워짐', await ls(phone, key) === null);
  // 휴대폰에서 다른 할 일 칸을 편집하고 나감(예전엔 이때 화면 전체를 다시 저장해서 되살아났음)
  await phone.page.evaluate(() => mSwitchTab('work')); await wait(200);
  await typeInto(phone.page, '#work-txt-3', '휴대폰 할 일'); await blur(phone.page);
  await wait(2500);
  check('휴대폰 할 일은 저장됨', serverVal(T1, 'work-txt-3') === '휴대폰 할 일', serverVal(T1, 'work-txt-3'));
  check('지운 메모가 되살아나지 않음', serverVal(T1, key) === null, serverVal(T1, key));
  // 같은 날짜를 휴대폰에서 열었다가 안 고치고 닫음
  await phone.page.evaluate((k) => mOpenCalDayDetail(k, '테스트날'), key); await wait(400); await blur(phone.page); await wait(2500);
  check('열었다 그냥 닫아도 되살아나지 않음', serverVal(T1, key) === null, serverVal(T1, key));

  console.log('\n[C] 휴대폰에서 입력 중일 때 PC가 메모 지움 → 입력 마치면');
  await typeInto(pc.page, '#' + key, 'PC 메모'); await blur(pc.page); await wait(2500);
  check('휴대폰에 도착', await ls(phone, key) === 'PC 메모');
  await phone.page.evaluate(() => { const el = document.getElementById('work-txt-4'); el.focus(); });
  await typeInto(pc.page, '#' + key, ''); await blur(pc.page); await wait(2500);
  check('휴대폰 저장소에선 지워짐(화면 반영은 입력 끝날 때까지 보류)', await ls(phone, key) === null);
  await typeInto(phone.page, '#work-txt-4', '입력 중이던 할 일'); await blur(phone.page); await wait(2500);
  check('입력하던 할 일 저장', serverVal(T1, 'work-txt-4') === '입력 중이던 할 일');
  check('PC에서 지운 메모 그대로 지워져 있음', serverVal(T1, key) === null, serverVal(T1, key));

  console.log('\n[D] 할 일 삭제·체크 해제가 다른 기기 화면에도 반영');
  await typeInto(pc.page, '#work-txt-5', '지울 할 일'); await blur(pc.page);
  await pc.page.evaluate(() => { const c = document.getElementById('work-chk-6'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); });
  await wait(2500);
  check('휴대폰 화면에 할 일·체크 표시', await phone.page.evaluate(() => document.getElementById('work-txt-5').innerText === '지울 할 일' && document.getElementById('work-chk-6').checked));
  await typeInto(pc.page, '#work-txt-5', ''); await blur(pc.page);
  await pc.page.evaluate(() => { const c = document.getElementById('work-chk-6'); c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); });
  await wait(2500);
  check('휴대폰 화면에서 할 일 사라짐', await phone.page.evaluate(() => document.getElementById('work-txt-5').innerText) === '', await phone.page.evaluate(() => document.getElementById('work-txt-5').innerText));
  check('휴대폰 화면에서 체크 해제', await phone.page.evaluate(() => document.getElementById('work-chk-6').checked) === false);
  await typeInto(phone.page, '#work-txt-7', '또 다른 할 일'); await blur(phone.page); await wait(2500);
  check('지운 할 일·해제한 체크 안 되살아남', serverVal(T1, 'work-txt-5') === null && serverVal(T1, 'work-chk-6') === 'false', [serverVal(T1, 'work-txt-5'), serverVal(T1, 'work-chk-6')]);

  console.log('\n[E] 테마를 다른 기기에서 바꾸면 되돌리지 않음');
  await pc.page.evaluate(() => changeTheme('mint')); await wait(2500);
  await typeInto(phone.page, '#work-txt-8', 'x'); await blur(phone.page); await wait(2500);
  check('테마 mint 유지', serverVal(T1, 'theme') === 'mint', serverVal(T1, 'theme'));
  console.log('\n[F] PC가 반쪽 캘린더를 보고 있을 때 휴대폰에서 쓰고 지우면 바로 반영');
  await pc.page.evaluate(() => switchMainTab('halfcal')); await wait(500);
  const halfText = () => pc.page.evaluate((d) => { const cells = [...document.querySelectorAll('.half-cal-memo')]; const c = cells.find(el => (el.getAttribute('onblur') || '').includes(d)); return c ? c.innerText : '(칸 없음)'; }, dStr);
  await phone.page.evaluate(() => mSwitchTab('cal')); await wait(200);
  await phone.page.evaluate((k) => mOpenCalDayDetail(k, '테스트날'), key); await wait(400);
  await typeInto(phone.page, '#m-cal-detail-editor', '반쪽 확인'); await blur(phone.page);
  await wait(2500);
  check('반쪽 캘린더에 바로 표시', await halfText() === '반쪽 확인', await halfText());
  await phone.page.evaluate((k) => mOpenCalDayDetail(k, '테스트날'), key); await wait(400);
  await typeInto(phone.page, '#m-cal-detail-editor', ''); await blur(phone.page);
  await wait(2500);
  check('휴대폰에서 지우면 반쪽 캘린더에서 바로 사라짐', await halfText() === '', await halfText());

  const allErrors = pages.flatMap(p => (p.errors || []).map(e => p.name + ': ' + e));
  check('전체 페이지 오류 없음', allErrors.length === 0, allErrors);
  console.log(failures === 0 ? '\n모든 검사 통과' : '\n실패 ' + failures + '건');
  await browser.close();
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
