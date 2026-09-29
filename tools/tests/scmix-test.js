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
  await P.click('#rail-seatchart-btn'); await wait(600);
  check('처음엔 붙여넣기 칸 숨김', await P.evaluate(() => getComputedStyle(document.getElementById('sc-mix-box')).display === 'none'));
  await P.check('#sc-mix-toggle'); await wait(300)
  check('섞기 켜면 붙여넣기 칸 보이고 학년/반 숨김', await P.evaluate(() => getComputedStyle(document.getElementById('sc-mix-box')).display !== 'none' && getComputedStyle(document.getElementById('sc-roster-select-row')).display === 'none'));
  await P.fill('#sc-mix-names', '20305\t김철수\n10101 가나다\n3. 박영희\n\n김철수\n나민수, 다솜');
  await P.click('#sc-mix-apply-btn'); await wait(300);
  const studs = await P.evaluate(() => scStudents.map(s => s.num + ':' + s.name).join(','));
  check('가나다순 번호', studs === '1:가나다,2:김철수,3:김철수,4:나민수,5:다솜,6:박영희', studs);
  check('같은 이름 안내', (await P.evaluate(() => document.getElementById('sc-roster-status').innerText)).includes('같은 이름 1건'));
  await P.fill('#sc-cfg-groups', '3'); await P.fill('#sc-cfg-rows', '2'); await P.fill('#sc-cfg-seats', '1');
  await P.click('#sc-build-btn'); await wait(200);
  await P.fill('#sc-exclude-nums', '5');
  await P.evaluate(() => scArrangeSeats('seq')); await wait(300);
  const seated = await P.evaluate(() => [...document.querySelectorAll('.sc-desk')].map(d => d.querySelector('.sc-desk-num').innerText + d.querySelector('.sc-desk-name').innerText).filter(Boolean));
  check('번호순 배치 5명(5번 제외)', seated.length === 5 && seated.includes('1번가나다') && !seated.some(x => x.includes('다솜')), seated);
  await wait(1500);
  const saved = JSON.parse(await ls(pc, 'sc-data-mix') || 'null');
  check('섞기 결과 자동저장(sc-data-mix)', saved && saved.mix === true && saved.mixNames.includes('박영희') && !saved.grade, saved && { mix: saved.mix, grade: saved.grade });
  check('반 키로는 저장 안 함', await P.evaluate(() => Object.keys(localStorage).filter(k => /^sc-data-\d/.test(k)).length) === 0);

  // 다른 기기에서 섞기 켜면 복원
  const pc2 = await openDevice(browser, 'PC2', T1);
  const Q = pc2.page;
  await Q.click('#rail-seatchart-btn'); await wait(600);
  await Q.check('#sc-mix-toggle'); await wait(500);
  const q = await Q.evaluate(() => ({ n: scStudents.length, names: document.getElementById('sc-mix-names').value, seated: [...document.querySelectorAll('.sc-desk .sc-desk-name')].map(d => d.innerText).filter(Boolean).length }));
  check('서버(계정)에 올라감', !!serverVal(T1, 'sc-data-mix'));
  check('다른 기기: 명단·배치 복원', q.n === 6 && q.names.includes('김철수') && q.seated === 5, q);
  // 섞기 해제 → 한 반 모드
  await Q.uncheck('#sc-mix-toggle'); await wait(300);
  check('섞기 끄면 학년/반 선택 다시 보임', await Q.evaluate(() => getComputedStyle(document.getElementById('sc-roster-select-row')).display !== 'none' && scStudents.length === 0));
  // 홈 갔다가 다시 열어도 섞기 유지(PC)
  await P.click('#rail-seatchart-btn'); await wait(300);
  await P.click('#rail-seatchart-btn'); await wait(500);
  check('다시 열어도 섞기 모드 유지', await P.evaluate(() => scIsMix() && scStudents.length === 6));
  // 결과 파일 불러오기(한 반 파일)면 섞기 해제
  await P.evaluate(async () => { await scApplyArrangement({ grade: '', classNo: '', seatData: [], rows: 1, groups: 1, seats: 1 }); });
  check('한 반 결과 불러오면 섞기 UI 꺼짐', await P.evaluate(() => !scIsMix()));

  // 월간일정표 "나이스 일정 표시" 체크박스가 자기 onchange를 유지하는지(예전엔 saveAllData로 덮어써짐)
  check('다른 체크박스 onchange 유지', await P.evaluate(() => { loadAllData(); return String(document.getElementById('ms-cfg-show-neis').onchange).includes('msRenderCalendar') && String(document.getElementById('sc-mix-toggle').onchange).includes('scToggleMix'); }));
  const errs = [...pc.errors, ...pc2.errors];
  check('페이지 오류 없음', errs.length === 0, errs);
  await P.screenshot({ path: 'scmix.png' });
  console.log(failures ? ('실패 ' + failures + '건') : '모든 검사 통과');
  await browser.close();
  process.exit(failures ? 1 : 0);
})();
