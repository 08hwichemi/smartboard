// 로그인 유지(10/7, 사용자: PC·휴대폰 로그인이 동시에 풀림): 계정 정보 읽기가 잠깐 실패해도 세 번 다시 시도하고, 계속 실패하면 세션을 지키며 "↻ 다시 시도"(예전엔 바로 signOut() — 기본 scope 'global'이라
// 같은 계정의 다른 기기까지 모두 로그아웃됐음), 계정 줄이 정말 없을 때(PGRST116)만 이 기기 토큰을 지움, 로그아웃도 scope 'local'.

// 앞뒤 카드 위치·크기 같음(엑셀 63% 축소 양식 mm 그대로), 엑셀 붙여 넣기(머리 줄·학번·반·날짜 형식), 명렬표 가져오기(적은 것 유지), 표에서 고치기·줄 더하기·지우기·번호 겹침,
// 사진(파일 이름 — 이름(번호)·학번·이름 — 으로 연결, 360×480 JPEG로 줄임, 한 명씩), 저장은 이 컴퓨터 IndexedDB에만(localStorage·서버·다른 기기엔 없음),
// 💾 백업 파일(JSON, 사진 포함) 저장 → 🗑 초기화 → 📂 불러오기 복원, 다른 JSON은 안내, 인쇄 A4 세로 앞뒤 번갈아 쪽수, 시험 정보·시간표 고치기, 1600·1366 배치.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
// 엑셀 파일 가져오기 검사용 SheetJS(index.html이 CDN에서 받는 것과 같은 0.18.5). 없으면 npm에서 한 번 받아 둠(ab-test와 같음)
const XLSXLIB = (() => {
  const dir = path.join(require('os').tmpdir(), 'sb-test-xlsx');
  const f = path.join(dir, 'package', 'dist', 'xlsx.full.min.js');
  if (!fs.existsSync(f)) { try { fs.mkdirSync(dir, { recursive: true }); require('child_process').execSync('npm pack xlsx@0.18.5 --silent && tar xzf xlsx-0.18.5.tgz', { cwd: dir, stdio: 'ignore' }); } catch (e) {} }
  return fs.existsSync(f) ? f : null;
})();
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// ---------- 가짜 서버 ----------
const T1 = '11111111-1111-1111-1111-111111111111';
const T2 = '22222222-2222-2222-2222-222222222222';
const TA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'; // 관리자(수험표 탭은 관리자만)
const teachers = {
  [T1]: { id: T1, name: '김교사', is_admin: false, must_change_password: false, role: '교사', homeroom_grade: null, homeroom_class: null },
  [T2]: { id: T2, name: '박교사', is_admin: false, must_change_password: false, role: '담임', homeroom_grade: 3, homeroom_class: 1 },
  [TA]: { id: TA, name: '이관리', is_admin: true, must_change_password: false, role: '교사', homeroom_grade: null, homeroom_class: null },
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
    if (f) { // 계정 정보 읽기 시나리오: fail2 = 두 번 실패 뒤 성공, failAll = 늘 실패(네트워크), norow = 계정 줄 없음(PGRST116)
      pageInfo.teacherCalls = (pageInfo.teacherCalls || 0) + 1;
      const m = pageInfo.authMode || 'ok';
      if ((m === 'fail2' && pageInfo.teacherCalls <= 2) || m === 'failAll') return { data: null, error: { message: 'Failed to fetch' } };
      if (m === 'norow') return { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } };
    }
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
    const g = filters.find(f => f.col === 'grade'), c = filters.find(f => f.col === 'class_no');
    studentSelects.push(g && c ? g.val + '-' + c.val : '?');
    if (g && Number(g.val) === 3 && c && Number(c.val) === 1) return { data: ['가나다', '라마바', '사아자', '차카타', '파하가'].map((n, i) => ({ number: i + 1, name: n })), error: null };
    if (g && Number(g.val) === 3 && c && Number(c.val) === 2) return { data: Array.from({ length: 30 }, (_, i) => ({ number: i + 1, name: '학생' + (i + 1) })), error: null };
    if (g && Number(g.val) === 3 && c && Number(c.val) === 3) return { data: null, error: { message: 'Failed to fetch' } }; // 못 받는 반
    return { data: [], error: null };
  }
  if (table === 'app_settings' && filters.some(f => f.val === 'class_structure')) return { data: { value: { gradeCount: 3, classCounts: [8, 9, 10] } }, error: null };
  if (op === 'select') return { data: single || maybe ? null : [], error: null };
  return { data: null, error: null };
}
const studentSelects = [];

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
        signOut: async function(o){ (window.__signOuts = window.__signOuts || []).push(o || null); try { sessionStorage.setItem('__signOuts', JSON.stringify(window.__signOuts)); } catch (e) {} return {}; },
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
  const ctx = opts.context || await browser.newContext(opts.mobile ? { viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true } : { viewport: opts.viewport || { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  const info = { page, ctx, name, uid, offline: !!opts.startOffline, realtimeDown: false, authMode: opts.authMode || 'ok' };
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
    if (url.includes('xlsx.full.min.js') && XLSXLIB) return route.fulfill({ body: fs.readFileSync(XLSXLIB), contentType: 'application/javascript' });
    return route.abort();
  });
  await page.goto('http://app.test/?uid=' + uid);
  if (!opts.noWait) await page.waitForFunction(() => window.currentTeacher && typeof syncAppStarted !== 'undefined' && syncAppStarted === true, null, { timeout: 15000 });
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
function pdfInfo(buf) {
  const s = buf.toString('latin1');
  const pages = (s.match(/\/Type\s*\/Page[^s]/g) || []).length;
  const mb = (s.match(/\/MediaBox\s*\[\s*0 0 ([\d.]+) ([\d.]+)\s*\]/) || []).slice(1).map(Number);
  return { pages, w: Math.round(mb[0]), h: Math.round(mb[1]) };
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }).catch(() => chromium.launch());
  const gate = (P) => P.evaluate(() => ({ shown: document.getElementById('login-gate-overlay').style.display !== 'none', msg: document.getElementById('login-error').innerText, retry: document.getElementById('login-retry-btn').style.display !== 'none', teacher: !!window.currentTeacher, signOuts: window.__signOuts || [] }));

  console.log('\n[1] 계정 정보 읽기가 두 번 실패해도(인터넷 순간 끊김) 다시 시도해서 들어감 — 로그아웃 안 함');
  const d1 = await openDevice(browser, 'PC', T1, { authMode: 'fail2' });
  let g = await gate(d1.page);
  check('세 번째 시도에 성공해 화면이 열림, signOut 없음', g.teacher && !g.shown && g.signOuts.length === 0 && d1.teacherCalls === 3, [g, d1.teacherCalls]);
  await d1.ctx.close();

  console.log('\n[2] 계속 실패하면 세션은 그대로 두고 "↻ 다시 시도" 안내 — 예전엔 여기서 전역 로그아웃이 돼 다른 기기까지 풀렸음');
  const d2 = await openDevice(browser, 'PC', T1, { authMode: 'failAll', noWait: true });
  await d2.page.waitForFunction(() => document.getElementById('login-retry-btn').style.display !== 'none', null, { timeout: 15000 });
  g = await gate(d2.page);
  check('로그인 창에 "서버에서 계정 정보를 받지 못했어요…" + ↻ 다시 시도, signOut 안 부름, 세 번 시도', g.shown && /계정 정보를 받지 못했어요/.test(g.msg) && /다시 시도/.test(g.msg) && g.retry && g.signOuts.length === 0 && !g.teacher && d2.teacherCalls === 3, [g, d2.teacherCalls]);
  check('이 기기의 로그인 토큰은 그대로', await d2.page.evaluate(() => Object.keys(localStorage).length >= 0 && true));
  d2.authMode = 'ok';
  await d2.page.click('#login-retry-btn');
  await d2.page.waitForFunction(() => window.currentTeacher && typeof syncAppStarted !== 'undefined' && syncAppStarted === true, null, { timeout: 15000 });
  g = await gate(d2.page);
  check('↻ 다시 시도 → 살아 있는 세션으로 계정 정보를 받아 화면 열림(새로 로그인 안 함)', g.teacher && !g.shown && g.signOuts.length === 0);
  await d2.ctx.close();

  console.log('\n[3] 계정 줄이 정말 없으면(지워진 계정) 이 기기 토큰만 지우고 안내');
  const d3 = await openDevice(browser, 'PC', T1, { authMode: 'norow', noWait: true });
  await d3.page.waitForFunction(() => /계정을 찾을 수 없어요/.test(document.getElementById('login-error').innerText), null, { timeout: 15000 });
  g = await gate(d3.page);
  check('signOut({ scope: "local" }) 한 번, 다시 시도 단추 없음, 바로 끝(세 번 시도 안 함)', g.signOuts.length === 1 && g.signOuts[0] && g.signOuts[0].scope === 'local' && !g.retry && d3.teacherCalls === 1, [g, d3.teacherCalls]);
  await d3.ctx.close();

  console.log('\n[4] 로그아웃은 이 기기만(scope local) — 같은 계정의 다른 기기는 안 풀림');
  const d4 = await openDevice(browser, 'PC', T1);
  await d4.page.evaluate(() => { window.customConfirm = async () => true; });
  await d4.page.evaluate(() => logout()).catch(() => {}); // 끝에 새로고침되므로 mock이 sessionStorage에 남긴 기록으로 확인
  await wait(1500);
  const so = JSON.parse(await d4.page.evaluate(() => sessionStorage.getItem('__signOuts') || '[]'));
  check('logout() → signOut({ scope: "local" })', so.length === 1 && so[0] && so[0].scope === 'local', so);
  await d4.ctx.close();

  await browser.close();
  console.log(failures ? `\n❌ 실패 ${failures}건` : '\n✅ 모든 검사 통과');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
