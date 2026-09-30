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

  teachers[T1].is_admin = true;
  const pc = await openDevice(browser, 'PC관리자', T1);
  const P = pc.page;
  await P.setViewportSize({ width: 1600, height: 1000 });
  await P.click('#rail-settings-btn'); await wait(1200);
  await P.screenshot({ path: 'adm-tt.png' });
  check('교사 시간표 폭 제한', await P.evaluate(() => document.getElementById('schedule-modal-box').getBoundingClientRect().width) <= 861, await P.evaluate(() => document.getElementById('schedule-modal-box').getBoundingClientRect().width));
  await P.evaluate(() => switchAdminTab('school')); await wait(800);
  await P.screenshot({ path: 'adm-school.png', fullPage: true });
  const rows = await P.evaluate(() => document.querySelectorAll('#admin-time-rows tr').length);
  check('일과 시간 표 7교시 바로 보임', rows === 7, rows);
  await P.fill('#admin-time-e-2', '09:40'); await P.dispatchEvent('#admin-time-e-2', 'input');
  check('잘못된 시간 빨간 표시', await P.evaluate(() => document.getElementById('admin-time-dur-2').classList.contains('bad')));
  await P.evaluate(() => { window.customAlert = async (m) => { window.__lastAlert = m; }; });
  await P.evaluate(() => saveClassTimesUI()); await wait(300);
  check('잘못된 시간은 저장 막힘', (await P.evaluate(() => window.__lastAlert || '')).includes('빨갛게'));
  await P.fill('#admin-time-e-2', '10:45'); await P.dispatchEvent('#admin-time-e-2', 'input');
  await P.fill('#admin-time-s-3', '1050'); await P.dispatchEvent('#admin-time-s-3', 'input'); await P.evaluate(() => normalizeTimeInput(document.getElementById('admin-time-s-3')));
  check('"1050"처럼 쳐도 10:50으로 맞춤', await P.evaluate(() => document.getElementById('admin-time-s-3').value) === '10:50');
  await P.evaluate(() => saveClassTimesUI()); await wait(300);
  console.log(await P.evaluate(() => [window.__lastAlert, currentTimes[1], [...document.querySelectorAll('.admin-time-dur')].map(e => e.innerText)]));
  check('저장 후 시간표 반영', await P.evaluate(() => currentTimes[1].e === '10:45' && document.getElementById('my-timetable-grid').innerText.includes('10:45') && (window.__lastAlert || '').includes('저장했습니다')));
  await P.evaluate(() => switchAdminTab('students')); await wait(800);
  await P.screenshot({ path: 'adm-students.png', fullPage: true });
  check('학생 자료 탭에 명렬표·학생 시간표 업로드 둘 다', await P.evaluate(() => document.querySelectorAll('#student-upload-rows > div').length >= 3 && document.querySelectorAll('#stt-upload-rows > div').length >= 3));
  await P.evaluate(() => switchAdminTab('duty')); await wait(800);
  await P.screenshot({ path: 'adm-duty.png' });
  // 계정: "역할·담당 전체 저장"은 바뀐 선생님만 서버에 보낸다(예전엔 누를 때마다 모든 계정을 다시 저장)
  await P.evaluate(() => switchAdminTab('accounts')); await wait(800);
  await P.evaluate(() => { window.__rpcCalls = []; const orig = sb.rpc.bind(sb); sb.rpc = function(n, p) { window.__rpcCalls.push([n, p && p.p_teacher_id]); return orig(n, p); }; window.__lastAlert = ''; });
  await P.evaluate(() => saveAllTeacherRolesUI()); await wait(300);
  const r0 = await P.evaluate(() => [window.__rpcCalls.length, window.__lastAlert]);
  check('역할 저장: 바뀐 게 없으면 서버에 안 보냄', r0[0] === 0 && r0[1].includes('바뀐 내용이 없어요'), r0);
  const S3 = '33333333-3333-3333-3333-333333333333';
  await P.evaluate(([t2, s3]) => {
    const sel = document.getElementById('role-select-' + t2);
    sel.value = [...sel.options].map(o => o.value).find(v => v && v !== '교사' && v !== '담임'); onTeacherRoleChange(t2);
    document.getElementById('scc-mgr-' + s3).checked = true;
  }, [T2, S3]);
  await P.evaluate(() => saveAllTeacherRolesUI()); await wait(400);
  const r1 = await P.evaluate(() => [window.__rpcCalls, window.__lastAlert]);
  check('역할 저장: 박교사 역할 1건 + 최실무 수업변경 담당 1건만', r1[0].length === 2 && r1[0].some(c => c[0] === 'admin_set_teacher_role' && c[1] === T2) && r1[0].some(c => c[0] === 'admin_set_schedule_manager' && c[1] === S3) && r1[1].includes('2명'), r1);
  for (const t of ['bookmarks', 'danger']) { await P.evaluate((t) => switchAdminTab(t), t); await wait(400); }
  await P.screenshot({ path: 'adm-danger.png' });
  await P.evaluate(() => switchAdminTab('semester')); await wait(300);
  check('예전 탭 이름도 새 탭으로', await P.evaluate(() => adminSettingsActiveTab) === 'school');
  const allErrors = pages.flatMap(p => (p.errors || []).map(e => p.name + ': ' + e));
  check('전체 페이지 오류 없음', allErrors.length === 0, allErrors);
  console.log(failures === 0 ? '\n모든 검사 통과' : '\n실패 ' + failures + '건');
  await browser.close();
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
