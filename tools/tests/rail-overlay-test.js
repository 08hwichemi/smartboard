// 왼쪽 레일에서 "창처럼 위에 뜨는" 명렬표·단축키·생기부 패널을 홈이 아닌 화면(시간표·월간일정표·이름표·양식·좌석배치표·조퇴증·결석계·자율·진로 편집기)
// 위에서 열었다 닫아도 원래 화면이 그대로 남는지(예전엔 결석계·이름표·양식·편집기가 닫혀 빈 화면이 됨 — 이름표는 10/5부터 양식의 탭), 세 패널은 한 번에 하나만 뜨는지,
// 다른 화면 버튼을 누르면 패널이 닫히는지.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
// 엑셀 가져오기 검사용 SheetJS(index.html이 CDN에서 받는 것과 같은 0.18.5). 없으면 npm에서 한 번 받아 둠.
const XLSXLIB = (() => {
  const dir = path.join(require('os').tmpdir(), 'sb-test-xlsx');
  const f = path.join(dir, 'package', 'dist', 'xlsx.full.min.js');
  if (!fs.existsSync(f)) {
    try { fs.mkdirSync(dir, { recursive: true }); require('child_process').execSync('npm pack xlsx@0.18.5 --silent && tar xzf xlsx-0.18.5.tgz', { cwd: dir, stdio: 'ignore' }); } catch (e) {}
  }
  return fs.existsSync(f) ? f : null;
})();
// 엑셀 내려받기(ExcelJS) 검사는 exceljs가 있을 때만(forms-test와 같음 — npm i exceljs@4.4.0 후 NODE_PATH에 추가)
let EXCELJS_PATH = ''; try { EXCELJS_PATH = require.resolve('exceljs/dist/exceljs.min.js'); } catch (e) {}
const html = fs.readFileSync(process.env.HTML_PATH || path.join(ROOT, 'index.html'), 'utf8');

// ---------- 가짜 서버 ----------
const T1 = '11111111-1111-1111-1111-111111111111';
const T2 = '22222222-2222-2222-2222-222222222222';
const teachers = {
  [T1]: { id: T1, name: '김교사', is_admin: false, must_change_password: false, role: '담임', homeroom_grade: 3, homeroom_class: 1 },
  [T2]: { id: T2, name: '박교사', is_admin: false, must_change_password: false, role: '교사', homeroom_grade: null, homeroom_class: null },
};
const items = new Map(); // teacher|key -> {teacher_id,key,value,updated_at}
const history = [];
let lastTs = Date.now();
function nowIso() { lastTs = Math.max(Date.now(), lastTs + 1); return new Date(lastTs).toISOString(); }
const pages = []; // {page, name, offline, realtimeDown}
const formFetches = [];
const studentSelects = [];

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
  if (table === 'students' && op === 'select') {
    studentSelects.push(filters.map(f => f.col + '=' + f.val).join('&'));
    const g = filters.find(f => f.col === 'grade'), c = filters.find(f => f.col === 'class_no');
    if (g && Number(g.val) === 3 && c && Number(c.val) === 1) {
      return { data: ['가나다', '라마바', '사아자', '차카타', '파하가'].map((n, i) => ({ number: i + 1, name: n })), error: null };
    }
    if (g && Number(g.val) === 3 && c && Number(c.val) === 2) { // 28명 반
      return { data: Array.from({ length: 28 }, (_, i) => ({ number: i + 1, name: '학생' + (i + 1) })), error: null };
    }
    return { data: [], error: null };
  }
  // 학급 구성(학년별 반 수) — 결석계 반 목록이 이걸 보고 만들어진다(예전엔 안 받아서 "1반"만 보였음)
  if (table === 'app_settings' && filters.some(f => f.val === 'class_structure')) return { data: { value: { gradeCount: 3, classCounts: [8, 9, 10] } }, error: null };
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
      const pathOnly = url.split('?')[0].split('#')[0].replace('http://app.test/', '');
      if (pathOnly.startsWith('absence/')) {
        const f = path.join(ROOT, pathOnly);
        if (fs.existsSync(f)) { formFetches.push(pathOnly); return route.fulfill({ body: fs.readFileSync(f), contentType: 'application/json' }); }
      }
      if (url.split('?')[0] === 'http://app.test/' || url.includes('index.html')) return route.fulfill({ body: html, contentType: 'text/html; charset=utf-8' });
      return route.fulfill({ status: 404, body: '' });
    }
    if (url.includes('@supabase/supabase-js')) return route.fulfill({ body: mockLib, contentType: 'application/javascript' });
    if (url.includes('open.neis.go.kr/hub/SchoolSchedule') && url.includes('AA_FROM_YMD=20260301')) {
      const row = [];
      const add = (ymd, ev, kind) => row.push({ AA_YMD: ymd, EVENT_NM: ev, SBTR_DD_SC_NM: kind });
      add('20260721', '여름방학식', '해당없음');
      for (let d = new Date('2026-07-22T00:00:00'); d <= new Date('2026-08-16T00:00:00'); d.setDate(d.getDate() + 1)) {
        const ymd = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
        add(ymd, d.getDay() === 6 ? '토요휴업일' : '여름방학', '휴업일');
      }
      return route.fulfill({ body: JSON.stringify({ SchoolSchedule: [{ head: [] }, { row }] }), contentType: 'application/json' });
    }
    if (url.includes('xlsx.full.min.js') && XLSXLIB) return route.fulfill({ body: fs.readFileSync(XLSXLIB), contentType: 'application/javascript' });
    if (url.includes('/exceljs@') && EXCELJS_PATH) return route.fulfill({ body: fs.readFileSync(EXCELJS_PATH), contentType: 'application/javascript' });
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



const PAGES = [
  ['rail-persontt-btn', 'persontt-page', '시간표'], ['rail-monthly-btn', 'monthly-page', '월간일정표'],
  ['rail-forms-btn', 'form-page', '양식(이름표 탭 포함)'], ['rail-seatchart-btn', 'seatchart-page', '좌석배치표'], ['rail-leavepass-btn', 'leavepass-page', '조퇴증'],
  ['rail-absence-btn', 'absence-page', '결석계'], ['rail-sgb-btn', 'se-page', '생기부(문장 점검·길라잡이)'], [null, 'se-page', '생기부(편집기)'], ['rail-home-btn', 'main-dashboard', '홈'],
];
// 생기부는 10/4부터 창이 아니라 화면(위 PAGES) — 창처럼 뜨는 패널은 명렬표·단축키 둘
const OVERLAYS = [['rail-roster-btn', 'roster-overlay', '명렬표', 'closeStudentRoster()'], ['rail-hwpkeys-btn', 'hwpkeys-overlay', '단축키', 'closeHwpKeys()']];

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }).catch(() => chromium.launch());
  const pc = await openDevice(browser, 'PC', T1);
  const P = pc.page;
  const shownPages = () => P.evaluate((ids) => ids.filter(id => { const el = document.getElementById(id); return el && getComputedStyle(el).display !== 'none'; }), [...new Set(PAGES.map(p => p[1]))]); // 생기부 두 탭은 같은 화면(se-page)
  const ovShown = (id) => P.evaluate((id) => document.getElementById(id).style.display === 'flex', id);
  const openPage = async (btn, page) => {
    if (btn === 'rail-sgb-btn') await P.evaluate(() => setSgbTab('check')); else if (btn) await P.click('#' + btn); else await P.evaluate(() => openSeEditor());
    await wait(500);
  };
  for (const [btn, page, label] of PAGES) {
    for (const [ob, ov, olabel, closeJs] of OVERLAYS) {
      await P.evaluate(() => goHome()); await wait(200);
      await openPage(btn, page);
      const before = await shownPages();
      await P.click('#' + ob); await wait(400);
      const during = await shownPages(), ovOn = await ovShown(ov);
      await P.evaluate((js) => eval(js), closeJs); await wait(300);
      const after = await shownPages();
      check(label + ' 위에서 ' + olabel + ' 열었다 닫아도 ' + label + ' 그대로', before.join() === page && during.join() === page && ovOn && after.join() === page && !(await ovShown(ov)), { before, during, ovOn, after });
    }
  }
  // 레일 버튼을 다시 눌러 닫아도 마찬가지(명렬표·단축키 버튼은 토글)
  await P.evaluate(() => goHome()); await wait(200);
  await P.click('#rail-absence-btn'); await wait(500);
  for (const [ob, ov, olabel] of OVERLAYS) {
    await P.click('#' + ob); await wait(300); await P.click('#' + ob); await wait(300);
    check('결석계 위에서 ' + olabel + ' 버튼 두 번(열고 닫기) → 결석계 그대로', (await shownPages()).join() === 'absence-page' && !(await ovShown(ov)));
  }
  // 두 패널은 한 번에 하나만
  await P.click('#rail-roster-btn'); await wait(300);
  await P.click('#rail-hwpkeys-btn'); await wait(300);
  check('명렬표 펴 둔 채 단축키 → 명렬표 닫히고 단축키만', !(await ovShown('roster-overlay')) && await ovShown('hwpkeys-overlay'));
  await P.click('#rail-roster-btn'); await wait(300);
  check('단축키 펴 둔 채 명렬표 → 단축키 닫히고 명렬표만, 밑에 결석계 그대로', !(await ovShown('hwpkeys-overlay')) && await ovShown('roster-overlay') && (await shownPages()).join() === 'absence-page');
  // 생기부는 화면: 패널을 펴 둔 채 생기부 → 패널 닫히고 결석계 대신 생기부
  await P.click('#rail-sgb-btn'); await wait(400);
  check('명렬표 펴 둔 채 생기부 → 명렬표 닫히고 생기부 화면(결석계 닫힘)', !(await ovShown('roster-overlay')) && (await shownPages()).join() === 'se-page');
  await P.click('#rail-roster-btn'); await wait(300);
  // 패널을 펴 둔 채 다른 화면 버튼 → 패널 닫히고 그 화면
  await P.click('#rail-monthly-btn'); await wait(500);
  check('명렬표 펴 둔 채 월간일정표 → 명렬표 닫히고 월간일정표', !(await ovShown('roster-overlay')) && (await shownPages()).join() === 'monthly-page');
  await P.click('#rail-sgb-btn'); await wait(400);
  await P.click('#rail-forms-btn'); await wait(500);
  check('생기부 화면에서 양식 → 생기부 닫히고 양식', (await shownPages()).join() === 'form-page');
  check('페이지 오류 없음', pc.errors.length === 0, pc.errors);
  await browser.close();
  console.log(failures ? '실패 ' + failures + '건' : '모든 검사 통과');
  process.exit(failures ? 1 : 0);
})();
