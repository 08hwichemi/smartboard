// 학교판 설치 안내(guide.html) 그림 — index.html에 가짜 서버(홍길동 선생님·2학년 3반 예시 자료)를 붙여 찍고, 크롬·윈도우·휴대폰 화면은 mocks.html로 흉내 낸다.
// 실행: NODE_PATH=/opt/node22/lib/node_modules node tools/guide-school/shots.js → guide/school/*.png
// 그 뒤 png→webp: python3 tools/guide-school/to_webp.py (Pillow). 장면 글은 guide.html의 S 배열.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const BUILD_ID = (/var BUILD_ID = '([^']+)'/.exec(html0()) || [])[1] || 'x';
function html0() { return fs.readFileSync(path.join(path.resolve(__dirname, '..', '..'), 'index.html'), 'utf8'); }
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// ---------- 가짜 서버 ----------
const T1 = '11111111-1111-1111-1111-111111111111';
const T2 = '22222222-2222-2222-2222-222222222222';
const teachers = {
  [T1]: { id: T1, name: '홍길동', is_admin: false, must_change_password: false, role: '담임', homeroom_grade: 2, homeroom_class: 3, schedule_manager: false, trip_viewer: false },
  [T2]: { id: T2, name: '홍길동', is_admin: false, must_change_password: true, role: '교사', homeroom_grade: null, homeroom_class: null },
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
  const x = extraTable(table, op, filters, single, maybe); if (x) return x;
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
      if (url.includes('version.txt')) return route.fulfill({ body: BUILD_ID, contentType: 'text/plain' });
      if (url.split('?')[0] === 'http://app.test/' || url.includes('index.html')) return route.fulfill({ body: html, contentType: 'text/html; charset=utf-8' });
      const f = path.join(ROOT, decodeURIComponent(url.slice('http://app.test/'.length).split('?')[0]));
      if (f.startsWith(ROOT) && fs.existsSync(f) && fs.statSync(f).isFile()) return route.fulfill({ body: fs.readFileSync(f) });
      return route.fulfill({ status: 404, body: '' });
    }
    if (url.includes('@supabase/supabase-js')) return route.fulfill({ body: mockLib, contentType: 'application/javascript' });
    const ext = extRoute(url); if (ext) return route.fulfill(ext);
    return route.abort();
  });
  await page.goto('http://app.test/?uid=' + uid);
  await page.waitForFunction(() => window.currentTeacher && typeof syncAppStarted !== 'undefined' && syncAppStarted === true, null, { timeout: 15000 });
  return info;
}

const wait = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- 예시 자료(가짜) ----------
const OUT = path.join(ROOT, 'guide', 'school');
const today = new Date();
const ymd = (d) => d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
const dash = (d) => ymd(d).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
const addD = (n) => { const d = new Date(today); d.setDate(d.getDate() + n); return d; };
const NAMES = ['강하람', '김도윤', '김서연', '박지호', '서예린', '이준서', '정민재', '최유나', '한서준', '홍채원', '윤지안', '임하준'];
const STUDENTS = NAMES.map((n, i) => ({ grade: 2, class_no: 3, number: i + 1, name: n, student_phone: '010-0000-' + String(1001 + i), mother_phone: '010-0000-' + String(2001 + i), father_phone: '' }));
// 내 시간표: 칸 번호 = (요일-1)*7 + (교시-1), 값 = "과목\n교실"
const TT = Array(35).fill('');
[[1, 1, '화학Ⅰ', '2-3'], [1, 2, '화학Ⅰ', '2-5'], [1, 4, '통합과학', '1-2'], [2, 1, '화학Ⅰ', '2-1'], [2, 3, '통합과학', '1-4'], [2, 5, '화학Ⅰ', '2-3'],
 [3, 2, '통합과학', '1-2'], [3, 3, '화학Ⅰ', '2-5'], [3, 6, '창체', '2-3'], [4, 1, '통합과학', '1-4'], [4, 4, '화학Ⅰ', '2-1'], [4, 5, '화학Ⅰ', '2-3'],
 [5, 2, '화학Ⅰ', '2-5'], [5, 3, '통합과학', '1-2'], [5, 6, '화학Ⅰ', '2-1']].forEach(([d, p, s, r]) => { TT[(d - 1) * 7 + p - 1] = s + '\n' + r; });
const NOTICES = [
  { id: 3, created_at: new Date(Date.now() - 3600e3).toISOString(), msg: '오늘 7교시 후 교무회의가 있습니다(시청각실).', likes: 5, hearts: 1, author: '교무부' },
  { id: 2, created_at: new Date(Date.now() - 86400e3).toISOString(), msg: '2학년 담임 선생님들께: 교외체험학습 결과보고서 이번 주 금요일까지 받아 주세요.', likes: 3, hearts: 0, author: '2학년부' },
  { id: 1, created_at: new Date(Date.now() - 3 * 86400e3).toISOString(), msg: '도서관 신간 안내 — 선생님 대출도 됩니다.', likes: 2, hearts: 2, author: '도서부' },
];
// 교외체험학습 현황판 예시(2학년 3반)
const TRIPS = [[2, '2026-12-01', '2026-12-04', '가족 여행'], [4, '2026-12-07', '2026-12-11', '친척 방문'], [4, '2026-12-21', '2026-12-23', '가족 여행'], [5, '2026-12-01', '2026-12-11', '해외 체험'],
  [8, '2026-12-14', '2026-12-16', '진로 탐방'], [10, '2026-12-28', '2026-12-30', '가족 여행'], [11, '2027-02-01', '2027-02-02', '가족 여행']].map(([n, f, t, d], i) => ({ id: 'g' + i, grade: 2, class_no: 3, num: n, name: NAMES[n - 1], from_date: f, to_date: t, detail: d, written: null, proof: '교외체험학습 신청서', days: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }));
function extraTable(table, op, filters, single, maybe) {
  const fv = (c) => { const f = filters.find((x) => x.col === c); return f ? f.val : undefined; };
  if (op !== 'select') return null;
  if (table === 'timetable') return { data: [{ teacher_name: '홍길동', cells: TT }, { teacher_name: '김민지', cells: TT.map((v, i) => (i % 3 === 0 ? '국어\n2-' + (1 + (i % 7)) : '')) }], error: null };
  if (table === 'notices') return { data: NOTICES.map((n) => ({ ...n })), error: null };
  if (table === 'students') return { data: STUDENTS.filter((s) => (fv('grade') === undefined || String(s.grade) === String(fv('grade')))), error: null };
  if (table === 'app_settings') {
    const k = fv('key');
    if (k === 'class_structure') return { data: { value: { gradeCount: 3, classCounts: [8, 8, 7] } }, error: null };
    if (k === 'trip_board') return { data: { value: { grades: [2], periods: { 2: [{ from: '2026-12-01', to: '2026-12-11' }, { from: '2026-12-18', to: '2026-12-30' }, { from: '2027-02-01', to: '2027-02-02' }] }, start: { 2: '2026-11-23' } } }, error: null };
    return { data: single || maybe ? null : [], error: null };
  }
  if (table === 'trip_records') return { data: TRIPS.filter((r) => fv('grade') === undefined || String(r.grade) === String(fv('grade'))), error: null };
  if (['schedule_cell_changes', 'neis_timetable_snapshot', 'trip_prior', 'trip_holidays', 'duty_roster'].includes(table)) return { data: single || maybe ? null : [], error: null };
  return null;
}
const J = (o) => ({ contentType: 'application/json', body: JSON.stringify(o) });
function extRoute(url) {
  if (url.includes('mealServiceDietInfo')) return J({ mealServiceDietInfo: [{ head: [] }, { row: [{ MLSV_YMD: ymd(today), MMEAL_SC_NM: '중식', DDISH_NM: '잡곡밥<br/>소고기미역국<br/>닭갈비<br/>콩나물무침<br/>배추김치<br/>요구르트', CAL_INFO: '812.4 Kcal' }] }] });
  if (url.includes('SchoolSchedule')) return J({ SchoolSchedule: [{ head: [] }, { row: [
    { AA_YMD: ymd(addD(3)), EVENT_NM: '학부모 상담주간', ONE_GRADE_EVENT_YN: 'Y', TW_GRADE_EVENT_YN: 'Y', THREE_GRADE_EVENT_YN: 'Y' },
    { AA_YMD: ymd(addD(9)), EVENT_NM: '2학년 진로체험의 날', ONE_GRADE_EVENT_YN: 'N', TW_GRADE_EVENT_YN: 'Y', THREE_GRADE_EVENT_YN: 'N' },
    { AA_YMD: ymd(addD(16)), EVENT_NM: '2학기 기말고사', ONE_GRADE_EVENT_YN: 'Y', TW_GRADE_EVENT_YN: 'Y', THREE_GRADE_EVENT_YN: 'Y' }] }] });
  if (url.includes('open.neis.go.kr')) return J({ RESULT: { CODE: 'INFO-200', MESSAGE: '해당하는 데이터가 없습니다.' } });
  if (url.includes('air-quality')) return J({ current: { pm10: 22, pm2_5: 11 } });
  if (url.includes('api.open-meteo.com')) return J({ current_weather: { temperature: 9, weathercode: 1 }, daily: { temperature_2m_max: [13], temperature_2m_min: [3] }, hourly: { time: Array.from({ length: 24 }, (_, h) => dash(today) + 'T' + String(h).padStart(2, '0') + ':00'), temperature_2m: Array(24).fill(9), weathercode: Array(24).fill(1), precipitation_probability: Array(24).fill(10) } });
  if (url.includes('/functions/v1/news')) { const it = (t) => ({ title: t, link: '#', source: '뉴스', pubDate: new Date().toUTCString() }); return J({ categories: { '종합': [it('교육부, 2027학년도 고교학점제 안착 지원 방안 발표'), it('수능 이후 고3 교실 운영 내실화 방안 논의'), it('겨울철 학교 난방·안전 점검 시작')], '교육': [it('학교 디지털 교과서 활용 연수 확대'), it('교원 행정업무 경감 시범학교 운영')] } }); }
  if (url.includes('/functions/v1/school-events')) return J({ events: [], ok: [], failed: [] });
  return null;
}
const HL = 'outline: 3px solid #E8590C !important; outline-offset: 2px; border-radius: 10px;';
async function shot(page, name, opts = {}) {
  if (opts.hl) await page.evaluate(([sel, css]) => { document.querySelectorAll(sel).forEach((el) => { el.dataset.hlOld = el.getAttribute('style') || ''; el.setAttribute('style', el.dataset.hlOld + ';' + css); }); }, [opts.hl, HL]);
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(OUT, name + '.png'), clip: opts.clip });
  if (opts.hl) await page.evaluate((sel) => { document.querySelectorAll(sel).forEach((el) => { el.setAttribute('style', el.dataset.hlOld); }); }, opts.hl);
  console.log('  ' + name);
}
function seedUser() {
  seed(T1, {
    'bookmarks': JSON.stringify([{ name: '나이스', url: 'https://www.neis.go.kr' }, { name: '업무포털', url: 'https://example.com' }, { name: '학교 홈페이지', url: 'https://example.com' }, { name: '에듀넷', url: 'https://www.edunet.net' }]),
    // 캘린더 메모 키 = cal-memo-YYYYMMDD(이번 달 평일에)
    ...Object.fromEntries([[-7, '학년 협의회 15:30'], [-2, '수행평가 채점 마감'], [1, '2-3 상담 (박지호 어머니) 16:00'], [6, '동아리 발표회 준비']].map(([n, t]) => { const d = addD(n); while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1); return ['cal-memo-' + ymd(d), t]; })),
    'work-txt-1': '수행평가 채점 마감(금)', 'work-txt-2': '교외체험학습 결과보고서 확인', 'work-txt-3': '2학기 독서활동 입력', 'work-chk-3': 'true',
  });
}
async function bare(browser, uid, vw) {
  const ctx = await browser.newContext({ viewport: vw || { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const info = { page, ctx, name: 'B', uid }; pages.push(info);
  await page.exposeFunction('__db', (q) => handleDb(info, q));
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith('http://app.test/')) return url.includes('version.txt') ? route.fulfill({ body: BUILD_ID }) : route.fulfill({ body: html, contentType: 'text/html; charset=utf-8' });
    if (url.includes('@supabase/supabase-js')) return route.fulfill({ body: mockLib, contentType: 'application/javascript' });
    const ext = extRoute(url); if (ext) return route.fulfill(ext);
    return route.abort();
  });
  return { page, ctx };
}
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  seedUser();
  // 1) 로그인 창
  { const { page, ctx } = await bare(browser, null);
    await page.goto('http://app.test/'); await wait(1500);
    await page.fill('#login-name-input', '홍길동'); await page.fill('#login-pw-input', '123456');
    await page.evaluate((css) => { const b = document.querySelector('#login-gate-overlay .modal-box button.accent, #login-gate-overlay .modal-box button[type="submit"], #login-gate-overlay .modal-box button:last-of-type'); if (b) b.setAttribute('style', (b.getAttribute('style') || '') + ';' + css); }, HL);
    await page.locator('#login-gate-overlay .modal-box').screenshot({ path: path.join(OUT, 'login.png') }); console.log('  login');
    await ctx.close(); }
  // 2) 비밀번호 정하기
  { const { page, ctx } = await bare(browser, T2);
    await page.goto('http://app.test/?uid=' + T2); await wait(2000);
    await page.fill('#force-pw-input1', '482915'); await page.fill('#force-pw-input2', '482915');
    await page.locator('#force-password-overlay .modal-box').screenshot({ path: path.join(OUT, 'password.png') }); console.log('  password');
    await ctx.close(); }
  // 3) PC 홈과 기능 화면
  const pc = await openDevice(browser, 'PC', T1);
  const P = pc.page;
  P.on('pageerror', (e) => console.log('PAGEERR', String(e)));
  await wait(2500);
  await P.addStyleTag({ content: '#updateBar{display:none !important}' });
  await P.evaluate(() => { try { dismissNotice(); } catch (e) {} }); await wait(300);
  await shot(P, 'home');
  await shot(P, 'home-top-a', { clip: { x: 70, y: 0, width: 765, height: 122 } });
  await shot(P, 'home-top-b', { clip: { x: 835, y: 0, width: 765, height: 122 } });
  await shot(P, 'home-left', { clip: { x: 72, y: 125, width: 440, height: 185 } });
  await shot(P, 'home-tt', { clip: { x: 72, y: 305, width: 440, height: 690 } });
  await shot(P, 'home-right', { clip: { x: 945, y: 125, width: 655, height: 870 } });
  await P.evaluate(() => switchMainTab('cal')); await wait(500);
  await shot(P, 'home-cal', { clip: { x: 72, y: 305, width: 870, height: 690 } });
  await P.evaluate(() => switchMainTab('tt')); await wait(300);
  // 기능 화면
  const closeAlerts = async () => { for (let k = 0; k < 3; k++) { const v = await P.evaluate(() => { const o = document.getElementById('custom-alert-overlay'); return o && getComputedStyle(o).display !== 'none'; }); if (!v) break; console.log('  (알림: ' + (await P.evaluate(() => document.getElementById('custom-alert-msg').innerText)).slice(0, 60) + ')'); await P.click('#custom-alert-ok-btn').catch(() => {}); await wait(300); } };
  const open = async (btn, ms) => { await closeAlerts(); await P.click(btn); await wait(ms || 900); await closeAlerts(); };
  await open('#rail-roster-btn', 900); await shot(P, 'roster', { clip: { x: 60, y: 0, width: 440, height: 1000 } }); await P.keyboard.press('Escape'); await wait(300);
  await P.click('#rail-home-btn').catch(() => {}); await wait(400);
  await open('#rail-seatchart-btn', 1200); await P.evaluate(() => { const set = (id, v) => { const e = document.getElementById(id); if (e) e.value = v; }; set('sc-cfg-rows', 3); set('sc-cfg-groups', 3); set('sc-cfg-seats', 2); }); await P.click('#sc-build-btn').catch(() => {}); await wait(500); await closeAlerts(); await P.click('#sc-arr-seq').catch(() => {}); await wait(500); await closeAlerts(); await shot(P, 'seatchart');
  await open('#rail-persontt-btn', 1000); await shot(P, 'persontt');
  await open('#rail-absence-btn', 1200);
  await P.click('#ab-tabs [data-tab="trip"]').catch((e) => console.log('trip tab?', String(e).slice(0, 80))); await wait(1200); await closeAlerts(); await shot(P, 'trip');
  await open('#rail-leavepass-btn', 900); await shot(P, 'leavepass');
  await open('#rail-pa-btn', 1000); await shot(P, 'pa');
  await open('#rail-sgb-btn', 700); await shot(P, 'sgb');
  await open('#rail-forms-btn', 1000); await shot(P, 'forms');
  await open('#rail-monthly-btn', 1000); await shot(P, 'monthly');
  // 4) 휴대폰 화면
  const m = await openDevice(browser, 'M', T1, { mobile: true });
  await wait(2000); await m.page.addStyleTag({ content: '#updateBar{display:none !important}' }); await wait(200);
  await m.page.screenshot({ path: path.join(OUT, 'mobile.png') }); console.log('  mobile');
  // 5) 크롬·윈도우·휴대폰 흉내 그림
  const mp = await (await browser.newContext({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 2 })).newPage();
  await mp.goto('file://' + path.join(__dirname, 'mocks.html')); await wait(400);
  for (const id of await mp.evaluate(() => [...document.querySelectorAll('.shot')].map((e) => e.id))) { await mp.locator('#' + id).screenshot({ path: path.join(OUT, id.slice(2) + '.png') }); console.log('  ' + id.slice(2)); }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
