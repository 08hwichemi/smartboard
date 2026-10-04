// 좌석배치표 📂 저장한 배치 목록(담임 아닌 선생님이 수업 반 여러 개를 저장해 두고 골라 쓰기)·섞기 묶음 여러 개·
// 마지막 배치로 다시 열기·반 바꿀 때 앞 반 저장·디자인 테마 한 줄·넓은 화면 두 줄을 실제 index.html로 확인한다.
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
  if (table === 'students' && op === 'select') {
    const g = filters.find(f => f.col === 'grade'), c = filters.find(f => f.col === 'class_no');
    const out = [];
    for (let i = 1; i <= 6; i++) out.push({ grade: g.val, class_no: c.val, number: i, name: '학생' + g.val + c.val + '-' + i });
    return { data: out, error: null };
  }
  if (table === 'app_settings' && filters.some(f => f.val === 'class_structure')) return { data: { value: { gradeCount: 3, classCounts: [8, 9, 10] } }, error: null };
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


const deskNames = (P) => P.evaluate(() => [...document.querySelectorAll('.sc-desk .sc-desk-name')].map(d => d.innerText).filter(Boolean));
const savedOpts = (P) => P.evaluate(() => [...document.querySelectorAll('#sc-saved-select option')].map(o => o.textContent.replace(/ · \d+\/\d+$/, '')));
async function pickClass(P, g, c) {
  await P.selectOption('#sc-grade-select', String(g));
  await P.selectOption('#sc-class-select', String(c)); await wait(400);
}
async function build(P, groups, rows, seats) {
  await P.fill('#sc-cfg-groups', String(groups)); await P.fill('#sc-cfg-rows', String(rows)); await P.fill('#sc-cfg-seats', String(seats));
  await P.click('#sc-build-btn'); await wait(200);
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }).catch(() => chromium.launch());
  const pc = await openDevice(browser, 'PC', T1);
  const P = pc.page;
  await P.click('#rail-seatchart-btn'); await wait(600);
  check('담임 아니면 처음엔 아무 반도 안 고름·목록 숨김', await P.evaluate(() => getComputedStyle(document.getElementById('sc-saved-row')).display === 'none' && document.getElementById('sc-roster-status').innerText.includes('선택')));

  // 디자인 테마 한 줄 / 넓은 화면 두 줄
  const lay = await P.evaluate(() => {
    const tops = [...document.querySelectorAll('.sc-theme-btn')].map(b => Math.round(b.getBoundingClientRect().top));
    const R = id => document.getElementById(id).getBoundingClientRect();
    const r = R('sc-roster-section'), a = R('sc-arrange-section'), d = R('sc-design-section'), sp = R('sc-special-seat-row');
    return { n: tops.length, rows: new Set(tops).size, w: document.getElementById('sc-panel').offsetWidth,
      two: a.left > r.right - 1 && Math.abs(a.top - r.top) < 2 && d.left === a.left && d.top > a.bottom && sp.left < a.left,
      hole: Math.abs(R('sc-col-1').height - R('sc-col-2').height) };
  });
  check('종이 디자인 테마 12개 = 4개씩 3줄', lay.n === 12 && lay.rows === 3, lay);
  check('넓은 화면(1600)은 왼쪽 칸 넓게 두 줄(왼쪽 = 명단·구조·특수 좌석, 오른쪽 = 자리 채우기·디자인)', lay.w >= 560 && lay.two, lay);
  check('두 줄 높이 비슷(빈 곳 적음, 차이 200px 안)', lay.hole < 200, lay);
  check('원반/이동반 단추 둘 다 보이고 원반이 눌림', await P.evaluate(() => document.getElementById('sc-mode-class').classList.contains('sc-on') && !document.getElementById('sc-mode-mix').classList.contains('sc-on') && document.getElementById('sc-mode-mix').offsetWidth > 0 && document.getElementById('sc-mix-toggle').offsetWidth === 0));
  await P.click('#sc-theme-mint'); await wait(200);
  check('새 테마(민트) → 책상 색', await P.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--sc-desk-card-bg').trim() === '#ccfbf1' && document.getElementById('sc-theme-mint').classList.contains('sc-active')));
  await P.evaluate(() => scSetTheme('없는테마'));
  check('모르는 테마 이름은 기본으로', await P.evaluate(() => scCurrentPrintTheme === 'classic'));

  // 2학년 3반: 배치 → 자동 저장 → 목록
  await pickClass(P, 2, 3);
  await build(P, 3, 2, 1);
  await P.evaluate(() => scArrangeSeats('seq')); await wait(1500);
  const d23 = JSON.parse(await ls(pc, 'sc-data-2-3') || 'null');
  check('2-3 자동 저장', d23 && d23.seatData.some(x => x.name === '학생23-1'), d23 && d23.seatData.map(x => x.name));
  check('목록에 2학년 3반·지금 고른 것', JSON.stringify(await savedOpts(P)) === JSON.stringify(['📂 저장한 배치 1개 — 골라서 열기', '2학년 3반']) && await P.evaluate(() => document.getElementById('sc-saved-select').value === 'sc-data-2-3' && getComputedStyle(document.getElementById('sc-saved-row')).display !== 'none'), await savedOpts(P));

  // 저장 안 된 반으로: 앞 반 학생이 남지 않음·구조는 그대로
  await P.fill('#sc-exclude-nums', '2');
  await pickClass(P, 2, 5);
  const n25 = await deskNames(P);
  check('새 반은 자리 비움(앞 반 학생 안 남음)·구조 그대로·결석 칸 비움', n25.length === 0 && await P.evaluate(() => document.querySelectorAll('.sc-desk').length === 6 && document.getElementById('sc-exclude-nums').value === ''), n25);
  check('반 바꾸기 직전 고친 것(결석 2)은 앞 반(2-3)에 저장', JSON.parse(await ls(pc, 'sc-data-2-3')).excludeNums === '2');
  await P.evaluate(() => scArrangeSeats('seq')); await wait(1500);
  check('2-5 저장, 2-3은 그대로', JSON.parse(await ls(pc, 'sc-data-2-5') || '{}').seatData?.some(x => x.name === '학생25-1') && !JSON.parse(await ls(pc, 'sc-data-2-3')).seatData.some(x => /학생25/.test(x.name)));
  // 2-5에서 고치고 800ms 안에 반 바꾸기 → 2-5에 남고 2-3으로 새지 않음
  await P.fill('#sc-footer-2', '2-5 문구');
  await pickClass(P, 1, 1);
  check('바로 반을 바꿔도 고친 것은 그 반에(새 반 열쇠로 안 샘)', JSON.parse(await ls(pc, 'sc-data-2-5')).footerText2 === '2-5 문구' && !(await ls(pc, 'sc-data-1-1')));

  // 드롭다운으로 고르기
  await P.selectOption('#sc-saved-select', 'sc-data-2-3'); await wait(500);
  const s23 = await P.evaluate(() => ({ g: document.getElementById('sc-grade-select').value, c: document.getElementById('sc-class-select').value, n: [...document.querySelectorAll('.sc-desk-name')].map(d => d.innerText).filter(Boolean) }));
  check('목록에서 2학년 3반 → 그 배치·학년/반 칸', s23.g === '2' && s23.c === '3' && s23.n.includes('학생23-1') && !s23.n.some(x => /25/.test(x)), s23);
  check('목록 순서(학년·반)', JSON.stringify((await savedOpts(P)).slice(1)) === JSON.stringify(['2학년 3반', '2학년 5반']), await savedOpts(P));
  await P.selectOption('#sc-saved-select', 'sc-data-2-5'); await wait(500);
  check('마지막에 본 배치 기억(sc-last)', await ls(pc, 'sc-last') === 'sc-data-2-5');
  // 홈 → 다시 열기
  await P.click('#rail-seatchart-btn'); await wait(300);
  await P.click('#rail-seatchart-btn'); await wait(600);
  check('다시 열면 마지막 배치(2-5)', (await deskNames(P)).includes('학생25-1') && await P.evaluate(() => document.getElementById('sc-class-select').value === '5' && document.getElementById('sc-footer-2').value === '2-5 문구'));

  // 섞기 묶음 두 개
  await P.click('#sc-mode-mix'); await wait(400);
  check('🔀 이동반 누르면 새 이동반(이름 칸·자리 비움)·단추 눌림', await P.evaluate(() => document.getElementById('sc-mix-label').value === '' && document.getElementById('sc-mix-names').value === '' && ![...document.querySelectorAll('.sc-desk-name')].some(d => d.innerText) && document.getElementById('sc-mode-mix').classList.contains('sc-on')));
  await wait(1200);
  check('명단 넣기 전엔 빈 묶음 안 만듦', !(await ls(pc, 'sc-data-mix')));
  await P.fill('#sc-mix-label', '화학Ⅱ A'); await P.press('#sc-mix-label', 'Tab');
  check('묶음 이름 → 종이 제목', await P.evaluate(() => document.getElementById('sc-display-title').value) === '🏫 화학Ⅱ A 좌석배치표 ✨');
  await P.fill('#sc-mix-names', '김가\n나다\n박라');
  await P.click('#sc-mix-apply-btn'); await wait(200);
  await P.evaluate(() => scArrangeSeats('seq')); await wait(1500);
  const m1 = JSON.parse(await ls(pc, 'sc-data-mix') || 'null');
  check('첫 묶음 = sc-data-mix (예전 열쇠 그대로)', m1 && m1.mix && m1.mixLabel === '화학Ⅱ A' && m1.mixNames.includes('박라'), m1 && m1.mixLabel);
  await P.click('#sc-mix-new-btn'); await wait(300);
  check('＋ 새 이동반 → 빈 이동반', await P.evaluate(() => document.getElementById('sc-mix-label').value === '' && document.getElementById('sc-mix-names').value === '' && scStudents.length === 0));
  await P.fill('#sc-mix-label', '물리 B'); await P.press('#sc-mix-label', 'Tab');
  await P.fill('#sc-mix-names', '최하\n정마');
  await P.click('#sc-mix-apply-btn'); await wait(200);
  await P.evaluate(() => scArrangeSeats('seq')); await wait(1500);
  const mixKeys = await P.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('sc-data-mix')).sort());
  check('묶음 두 개 따로 저장', mixKeys.length === 2 && JSON.parse(await ls(pc, 'sc-data-mix')).mixLabel === '화학Ⅱ A', mixKeys);
  check('목록 = 반 → 묶음(이름순, 사람 수)', JSON.stringify((await savedOpts(P)).slice(1)) === JSON.stringify(['2학년 3반', '2학년 5반', '🔀 물리 B (2명)', '🔀 화학Ⅱ A (3명)']), await savedOpts(P));
  await P.selectOption('#sc-saved-select', 'sc-data-mix'); await wait(500);
  check('목록에서 화학Ⅱ A → 그 명단·배치', await P.evaluate(() => document.getElementById('sc-mix-label').value === '화학Ⅱ A' && scStudents.length === 3) && (await deskNames(P)).includes('박라'));
  // 섞기 중 목록에서 반 고르면 섞기 꺼짐
  await P.selectOption('#sc-saved-select', 'sc-data-2-3'); await wait(500);
  check('이동반 중 목록에서 반 고르면 원반으로·그 반', await P.evaluate(() => !scIsMix() && document.getElementById('sc-class-select').value === '3' && document.getElementById('sc-mode-class').classList.contains('sc-on')) && (await deskNames(P)).includes('학생23-1'));
  await P.click('#sc-mode-class'); await wait(300);
  check('이미 원반이면 원반 단추는 아무것도 안 함', await P.evaluate(() => document.getElementById('sc-class-select').value === '3') && (await deskNames(P)).includes('학생23-1'));
  check('화학Ⅱ A 묶음은 그대로', JSON.parse(await ls(pc, 'sc-data-mix')).mixNames.includes('김가'));
  // 섞기 다시 켜면 이 탭에서 마지막에 본 묶음
  await P.click('#sc-mode-mix'); await wait(500);
  check('섞기 다시 켜면 마지막에 본 묶음(화학Ⅱ A)', await P.evaluate(() => document.getElementById('sc-mix-label').value) === '화학Ⅱ A');

  // 다른 기기: 목록·마지막 배치
  await wait(2000);
  const pc2 = await openDevice(browser, 'PC2', T1);
  const Q = pc2.page;
  await Q.click('#rail-seatchart-btn'); await wait(800);
  check('다른 기기: 목록 4개', (await savedOpts(Q)).length === 5, await savedOpts(Q));
  check('다른 기기: 마지막 배치(화학Ⅱ A)로 열림', await Q.evaluate(() => scIsMix() && document.getElementById('sc-mix-label').value === '화학Ⅱ A'));

  // 지우기
  await P.selectOption('#sc-saved-select', mixKeys.find(k => k !== 'sc-data-mix')); await wait(500);
  await P.click('#sc-saved-del'); await wait(200);
  check('지우기 전에 물어봄(묶음 이름)', /물리 B/.test(await P.evaluate(() => document.getElementById('custom-confirm-msg').textContent)));
  await P.click('#custom-confirm-cancel-btn'); await wait(200);
  check('취소하면 그대로', (await savedOpts(P)).length === 5);
  await P.click('#sc-saved-del'); await wait(200);
  await P.click('#custom-confirm-ok-btn'); await wait(1200);
  const afterDel = await P.evaluate(() => ({ keys: Object.keys(localStorage).filter(k => k.startsWith('sc-data-mix')), mix: scIsMix(), status: document.getElementById('sc-roster-status').innerText, sel: document.getElementById('sc-saved-select').value }));
  check('지우면 목록에서 빠지고 빈 화면', afterDel.keys.length === 1 && !afterDel.mix && afterDel.status.includes('선택') && afterDel.sel === '' && (await savedOpts(P)).length === 4, afterDel);
  await wait(2500);
  check('서버에서도 지워짐', !serverVal(T1, mixKeys.find(k => k !== 'sc-data-mix')), serverVal(T1, mixKeys.find(k => k !== 'sc-data-mix')));
  check('지운 뒤 아무것도 안 고른 채 클릭해도 저장 안 됨', await (async () => { await P.click('#sc-panel'); await wait(1200); return (await P.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('sc-data-')).length)) === 3; })());

  // 좁은 화면(1366)은 예전처럼 한 줄
  await P.setViewportSize({ width: 1366, height: 768 }); await wait(300);
  const narrow = await P.evaluate(() => ({ w: document.getElementById('sc-panel').offsetWidth, tops: new Set([...document.querySelectorAll('.sc-theme-btn')].map(b => Math.round(b.getBoundingClientRect().top))).size,
    order: ['sc-roster-section', 'sc-special-seat-row', 'sc-arrange-section', 'sc-design-section'].map(id => document.getElementById(id).getBoundingClientRect().top).every((v, i, a) => !i || v > a[i - 1]) }));
  check('1366은 왼쪽 칸 320 한 줄(명단 → 특수 좌석 → 자리 채우기 → 디자인 순)·테마 4개씩 3줄', narrow.w === 320 && narrow.tops === 3 && narrow.order, narrow);
  const mixBtn = await P.evaluate(() => { const b = document.getElementById('sc-mode-mix'); return b.scrollWidth <= b.clientWidth + 1; });
  check('좁은 칸에서도 이동반 단추 글자 안 넘침', mixBtn);

  const errs = [...pc.errors, ...pc2.errors];
  check('페이지 오류 없음', errs.length === 0, errs);
  await P.setViewportSize({ width: 1600, height: 1000 }); await wait(300);
  await P.screenshot({ path: 'sclist.png' });
  console.log(failures ? ('실패 ' + failures + '건') : '모든 검사 통과');
  await browser.close();
  process.exit(failures ? 1 : 0);
})();
