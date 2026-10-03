// 가짜 Supabase 서버(Node 메모리) 하나에 PC/휴대폰 브라우저 두 개를 붙여서
// index.html의 실제 동기화 코드를 시나리오별로 돌려 본다(다시 열 때 바뀐 것만 받기 포함).
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
    (pageInfo.pulls = pageInfo.pulls || []).push(filters.some(f => f.op === 'gt' && f.col === 'updated_at') ? 'inc' : 'full');
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

  console.log('\n[0] 예전 버전을 쓰던 PC(로고 들어간 ms-data, 탭 위치 등)가 새 버전으로 처음 열림');
  const pc = await openDevice(browser, 'PC', T1, { preload: {
    'cal-memo-2026-09-30': '옛날 캐시', 'ms-data': JSON.stringify({ school: 'A', logo: 'data:image/png;base64,AAAA' }),
    'main-tab': 'halfcal', 'statsig.cached.evaluations.1': 'junk', 'backup-owner-teacher-id': T1,
  } });
  check('서버 값으로 맞춰짐', await ls(pc, 'cal-memo-2026-09-30') === '서버 메모', await ls(pc, 'cal-memo-2026-09-30'));
  check('ms-data에 로고 없음', !(await ls(pc, 'ms-data')).includes('logo'), await ls(pc, 'ms-data'));
  await wait(2000);
  check('서버에 있던 값은 그대로(기본값으로 안 덮임)', serverVal(T1, 'theme') === 'dark' && serverVal(T1, 'work-txt1') === '할일1');
  check('statsig·main-tab 같은 기기 전용 값은 서버로 안 올라감', serverVal(T1, 'statsig.cached.evaluations.1') === undefined && serverVal(T1, 'main-tab') === undefined);
  check('페이지 오류 없음', pc.errors.length === 0, pc.errors);

  console.log('\n[1] PC에서 입력 → 휴대폰 화면에 바로 반영');
  const phone = await openDevice(browser, '휴대폰', T1, { mobile: true });
  await setLs(pc, 'cal-memo-2026-10-02', 'PC에서 쓴 메모');
  await wait(2500);
  check('서버에 저장됨', serverVal(T1, 'cal-memo-2026-10-02') === 'PC에서 쓴 메모');
  check('휴대폰에 실시간 반영', await ls(phone, 'cal-memo-2026-10-02') === 'PC에서 쓴 메모', await ls(phone, 'cal-memo-2026-10-02'));

  console.log('\n[2] 원래 문제: 화면 꺼진 휴대폰(실시간 끊김)이 옛날 값을 들고 있다가 다른 항목을 저장');
  phone.realtimeDown = true;
  await setVisibility(phone, 'hidden');
  await setLs(pc, 'cal-memo-2026-10-02', 'PC에서 고친 최신 메모');
  await wait(2500);
  check('휴대폰은 아직 옛날 값을 들고 있음(재현 조건)', await ls(phone, 'cal-memo-2026-10-02') === 'PC에서 쓴 메모');
  await setLs(phone, 'work-txt2', '휴대폰에서 추가한 할 일');
  await wait(2500);
  check('휴대폰 할 일이 서버에 저장됨', serverVal(T1, 'work-txt2') === '휴대폰에서 추가한 할 일');
  check('PC의 최신 메모가 덮어써지지 않음', serverVal(T1, 'cal-memo-2026-10-02') === 'PC에서 고친 최신 메모', serverVal(T1, 'cal-memo-2026-10-02'));
  check('PC에도 휴대폰 할 일이 반영', await ls(pc, 'work-txt2') === '휴대폰에서 추가한 할 일');
  phone.realtimeDown = false;
  await setVisibility(phone, 'visible');
  await wait(1500);
  check('휴대폰을 다시 켜면 최신 메모를 받아옴', await ls(phone, 'cal-memo-2026-10-02') === 'PC에서 고친 최신 메모', await ls(phone, 'cal-memo-2026-10-02'));

  console.log('\n[3] 지우기도 다른 기기에 전달');
  await rmLs(pc, 'work-txt1');
  await wait(2500);
  check('서버에 "지워짐"(null)으로 기록', serverVal(T1, 'work-txt1') === null);
  check('휴대폰에서도 지워짐', await ls(phone, 'work-txt1') === null);

  console.log('\n[4] 인터넷 끊긴 휴대폰에서 입력 → 새로고침 → 연결되면 올라감');
  phone.offline = true;
  await setLs(phone, 'cal-memo-2026-10-05', '오프라인 메모');
  await wait(2500);
  check('저장 실패해도 이 기기에 남아 있음', await ls(phone, 'cal-memo-2026-10-05') === '오프라인 메모');
  check('못 올린 목록에 있음', (await dirty(phone)).includes('cal-memo-2026-10-05'));
  await phone.page.reload();
  await phone.page.waitForFunction(() => typeof syncAppStarted !== 'undefined' && syncAppStarted === true, null, { timeout: 15000 });
  check('오프라인 새로고침 뒤에도 남아 있음', await ls(phone, 'cal-memo-2026-10-05') === '오프라인 메모');
  phone.offline = false;
  await phone.page.evaluate(() => window.dispatchEvent(new Event('online')));
  await wait(2000);
  check('연결되자 서버에 올라감', serverVal(T1, 'cal-memo-2026-10-05') === '오프라인 메모');
  check('PC에도 반영', await ls(pc, 'cal-memo-2026-10-05') === '오프라인 메모');
  check('못 올린 목록 비워짐', (await dirty(phone)).length === 0, await dirty(phone));

  console.log('\n[5] 저장 대기 중(1.5초 안)에 다른 기기 변경이 도착해도 내 입력이 안 날아감');
  await setLs(phone, 'cal-memo-2026-10-06', '휴대폰 입력 중');
  await setLs(pc, 'cal-memo-2026-10-07', 'PC 다른 메모');
  await wait(3000);
  check('휴대폰 입력이 서버에 저장', serverVal(T1, 'cal-memo-2026-10-06') === '휴대폰 입력 중');
  check('PC 입력도 서버에 저장', serverVal(T1, 'cal-memo-2026-10-07') === 'PC 다른 메모');
  check('양쪽 모두 둘 다 가짐', await ls(pc, 'cal-memo-2026-10-06') === '휴대폰 입력 중' && await ls(phone, 'cal-memo-2026-10-07') === 'PC 다른 메모');

  console.log('\n[6] 같은 항목을 두 기기에서 동시에 고침 → 나중 것이 남고, 앞의 것은 이력에 남음');
  await setLs(pc, 'cal-memo-2026-10-08', 'PC 버전');
  await setLs(phone, 'cal-memo-2026-10-08', '휴대폰 버전');
  await wait(3500);
  const final = serverVal(T1, 'cal-memo-2026-10-08');
  check('두 기기와 서버가 같은 값으로 수렴', await ls(pc, 'cal-memo-2026-10-08') === final && await ls(phone, 'cal-memo-2026-10-08') === final, { final, pc: await ls(pc, 'cal-memo-2026-10-08'), phone: await ls(phone, 'cal-memo-2026-10-08') });
  check('진 쪽 값이 이력에 남음', history.some(h => h.key === 'cal-memo-2026-10-08'));

  console.log('\n[7] 입력 중에는 화면을 다시 그리지 않고, 입력칸을 벗어나면 반영');
  await phone.page.evaluate(() => { const i = document.createElement('input'); i.id = '__t'; document.body.appendChild(i); i.focus(); window.__refreshes = 0; const o = refreshDashboardFromLocalStorage; window.refreshDashboardFromLocalStorage = o; });
  await phone.page.evaluate(() => { const orig = loadAllData; window.__loadCount = 0; });
  await setLs(pc, 'cal-memo-2026-10-09', '입력 중에 온 메모');
  await wait(2500);
  check('입력 중엔 반영 보류 상태', await phone.page.evaluate(() => remoteRefreshPending === true));
  check('값 자체는 저장소에 들어와 있음', await ls(phone, 'cal-memo-2026-10-09') === '입력 중에 온 메모');
  await phone.page.evaluate(() => document.getElementById('__t').blur());
  await wait(300);
  check('입력칸을 벗어나자 반영됨', await phone.page.evaluate(() => remoteRefreshPending === false));

  console.log('\n[8] 공용 PC에서 로그아웃 후 다른 선생님 로그인');
  const pcPage2 = await pc.ctx.newPage();
  await pc.page.close();
  const pcB = { page: pcPage2, ctx: pc.ctx, name: 'PC-박교사', uid: T2, offline: false, realtimeDown: false, errors: [] };
  // 로그아웃 동작(개인 자료 지우기)을 흉내: 새 버전 logout()은 못 올린 게 없으면 개인 자료를 지운다
  pages.push(pcB);
  pcPage2.on('pageerror', e => pcB.errors.push(String(e)));
  await pcPage2.exposeFunction('__db', (q) => handleDb(pcB, q));
  await pcPage2.route('**/*', route => {
    const url = route.request().url();
    if (url.includes('version.txt')) return route.fulfill({ body: 'x' });
    if (url.startsWith('http://app.test/')) return route.fulfill({ body: html, contentType: 'text/html; charset=utf-8' });
    if (url.includes('@supabase/supabase-js')) return route.fulfill({ body: mockLib, contentType: 'application/javascript' });
    return route.abort();
  });
  await pcPage2.goto('http://app.test/?uid=' + T2);
  await pcPage2.waitForFunction(() => typeof syncAppStarted !== 'undefined' && syncAppStarted === true, null, { timeout: 15000 });
  check('김교사 메모가 안 보임', await ls(pcB, 'cal-memo-2026-10-02') === null);
  check('박교사 메모가 보임', await ls(pcB, 'cal-memo-2026-10-01') === '박교사 메모');
  await wait(2000);
  check('김교사 자료가 박교사 계정으로 섞여 올라가지 않음', serverVal(T2, 'cal-memo-2026-10-02') === undefined);

  console.log('\n[9] 백업 파일 복원 → 서버에도 그대로(지운 것까지) 반영');
  await phone.page.evaluate(async () => {
    const data = { 'cal-memo-2026-01-01': '백업 메모', 'ms-data': JSON.stringify({ school: 'B', logo: 'data:xxx' }), 'sb-x-auth-token': 'old' };
    window.customConfirm = async () => true; window.customAlert = async () => {};
    const file = new File([JSON.stringify(data)], 'b.json');
    const origReload = location.reload;
    await new Promise((resolve) => {
      window.__restoreDone = resolve;
      const ev = { target: { files: [file], value: '' } };
      restoreFromBackupFile(ev);
      const t = setInterval(() => { if (getSyncDirtyKeys().length === 0 && localStorage.getItem('cal-memo-2026-01-01')) { clearInterval(t); resolve(); } }, 100);
    });
  }).catch(() => {});
  await wait(2500);
  check('백업 메모가 서버에 올라감', serverVal(T1, 'cal-memo-2026-01-01') === '백업 메모');
  check('백업에 없는 항목은 서버에서도 지워짐', serverVal(T1, 'cal-memo-2026-10-02') === null, serverVal(T1, 'cal-memo-2026-10-02'));
  check('복원한 ms-data에 로고 없음', !String(serverVal(T1, 'ms-data')).includes('logo'), serverVal(T1, 'ms-data'));

  console.log('\n[10] 새 기기인데 첫 연결이 실패 → 기본값이 서버 자료를 덮지 않음');
  seed(T1, { 'work-chk-1': 'true' });
  const tablet = await openDevice(browser, '태블릿', T1, { mobile: true, startOffline: true });
  await wait(2500);
  check('오프라인 동안 아무것도 안 올라감', serverVal(T1, 'work-chk-1') === 'true', serverVal(T1, 'work-chk-1'));
  tablet.offline = false;
  await tablet.page.evaluate(() => pullRemoteChanges(false));
  await wait(2500);
  check('연결 후에도 서버 값 유지', serverVal(T1, 'work-chk-1') === 'true', serverVal(T1, 'work-chk-1'));
  check('태블릿이 서버 값을 받음', await ls(tablet, 'work-chk-1') === 'true', await ls(tablet, 'work-chk-1'));
  await setLs(tablet, 'cal-memo-2026-10-10', '태블릿 메모');
  await wait(2500);
  check('이후 태블릿 입력은 정상 저장', serverVal(T1, 'cal-memo-2026-10-10') === '태블릿 메모');

  console.log('\n[11] 다시 열 때는 바뀐 것만 받음(무료 전송량) — 7일에 한 번은 전체를 받아 맞춤');
  const reopen = async (d) => { d.pulls = []; await d.page.reload(); await d.page.waitForFunction(() => typeof syncAppStarted !== 'undefined' && syncAppStarted === true, null, { timeout: 15000 }); await wait(800); };
  tablet.realtimeDown = true;
  items.set(T1 + '|cal-memo-2026-10-11', { teacher_id: T1, key: 'cal-memo-2026-10-11', value: '닫혀 있는 동안 쓴 메모', updated_at: nowIso() });
  await reopen(tablet);
  tablet.realtimeDown = false;
  check('다시 열면 전체가 아니라 바뀐 것만 받음', tablet.pulls.length > 0 && !tablet.pulls.includes('full'), tablet.pulls);
  check('닫혀 있는 동안 다른 기기에서 쓴 것도 받아옴', await ls(tablet, 'cal-memo-2026-10-11') === '닫혀 있는 동안 쓴 메모');
  // 서버에서 줄이 통째로 없어진 항목(관리자가 SQL로 지움 등)은 바뀐 것만 받기로는 모름 → 7일 지나 전체 받기 때 지움
  await tablet.page.evaluate(() => { rawSetItem('cal-memo-2020-01-01', '서버에 없는 옛 항목'); rawSetItem('sync-last-full-pull', String(Date.now() - 8 * 24 * 3600 * 1000)); });
  await reopen(tablet);
  check('마지막 전체 받기가 7일 지나면 전체를 받고, 서버에 없는 항목은 이 기기에서도 지움', tablet.pulls[0] === 'full' && await ls(tablet, 'cal-memo-2020-01-01') === null &&
    Date.now() - Number(await ls(tablet, 'sync-last-full-pull')) < 60000, [tablet.pulls, await ls(tablet, 'cal-memo-2020-01-01')]);
  check('전체 받기 시각은 이 기기에만(서버로 안 올라감)', serverVal(T1, 'sync-last-full-pull') === undefined);
  await setLs(tablet, 'search-tt-1-1-s', '화면 값'); await wait(2500);
  check('다른 선생님 시간표 찾기 칸(search-tt-)은 서버로 안 올라감(화면 값)', serverVal(T1, 'search-tt-1-1-s') === undefined && !(await dirty(tablet)).includes('search-tt-1-1-s'));

  const allErrors = pages.flatMap(p => (p.errors || []).map(e => p.name + ': ' + e));
  check('전체 페이지 오류 없음', allErrors.length === 0, allErrors);
  console.log(failures === 0 ? '\n모든 검사 통과' : '\n실패 ' + failures + '건');
  await browser.close();
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
