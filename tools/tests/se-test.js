// 레일 "생기부" → 🗂 자율·진로 편집기: 생기부 패널 둘째 탭에서 전체 화면, 학년별 바이트 한도(입시 연도), 자료 입력(영역 추가·이름·여러 칸 붙여 넣기),
// 편집(체크해 합치기·바이트·기재 불가 점검·📊 최종에 넣기·메모), 최종 표(자율/진로/전체·남은 바이트), 고정 머리(자율/진로 버튼 같은 자리), 엑셀 가져오기·내려받기, 칸을 벗어날 때만 저장·업로드, 내 계정에만, 초기화, 열고 닫기.
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


// ---------- 서버 쓰기 횟수(입력 중엔 안 올라가야 함) ----------
const upserts = [];
const _handleDb = handleDb;
handleDb = async function(pageInfo, req) {
  if (req.table === 'user_data_items' && req.op === 'upsert') upserts.push(req.rows.map(r => r.key));
  return _handleDb(pageInfo, req);
};

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }).catch(() => chromium.launch());
  const pc = await openDevice(browser, 'PC', T1);
  const P = pc.page;
  await P.evaluate(() => { window.__clip = null; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => { window.__clip = t; } } }); });
  const shown = () => P.evaluate(() => document.getElementById('se-page').style.display === 'flex');
  const panelShown = () => P.evaluate(() => { const pg = document.getElementById('se-page'); return pg.style.display === 'flex' && pg.classList.contains('sgbp-check'); }); // 생기부 화면의 문장 점검·길라잡이 탭
  const areas = (k) => P.evaluate((k) => seAreas(k), k);

  // ---- 한도 표 ----
  const lim = await P.evaluate(() => ({
    y3: sgbAdmissionYear(3, 2026), y1: sgbAdmissionYear(1, 2026), old: sgbAdmissionYear(3, 2025),
    g3: sgbLimitsFor(3, 2026), g1: sgbLimitsFor(1, 2026), g3old: sgbLimitsFor(3, 2025), far: sgbLimitsFor(1, 2040)
  }));
  check('입시 연도: 2026학년도 고3 = 2027, 고1 = 2029, 2025학년도 고3 = 2026', lim.y3 === 2027 && lim.y1 === 2029 && lim.old === 2026, lim);
  check('한도: 2027·2028~ 입시 자율 500·진로 500·봉사 50·행특 300, 2026 입시 진로 700·봉사 250·행특 500', lim.g3.p === 500 && lim.g3.behav === 300 && lim.g3.vol === 50 && lim.g1.p === 500 && lim.g3old.p === 700 && lim.g3old.vol === 250 && lim.g3old.behav === 500 && lim.far.p === 500, lim);

  // ---- 생기부 화면 탭 → 편집기 ----
  await P.click('#rail-sgb-btn'); await wait(300);
  const tabs = await P.evaluate(() => [...document.querySelectorAll('#sgb-tabs .tab-btn')].map(b => b.dataset.tab));
  check('생기부 화면 탭: 문장 점검·길라잡이 · 자율·진로·행발 편집기', tabs.join(',') === 'check,edit' && await panelShown(), tabs);
  const note = await P.evaluate(() => document.getElementById('sgb-note').textContent);
  check('문장 점검 안내에 담임 학년 기준(고3 = 2027 입시)', /고3 = 2027 입시/.test(note), note);
  await P.click('#sgb-tabs [data-tab="edit"]'); await wait(600);
  check('편집기 탭 → 같은 화면에서 편집기(문장 점검 탭 꺼짐), 레일 생기부 버튼 켜짐', await shown() && !(await panelShown()) && await P.evaluate(() => document.getElementById('rail-sgb-btn').classList.contains('active') && document.getElementById('main-dashboard').style.display === 'none'));
  const head = await P.evaluate(() => ({ g: document.getElementById('se-grade').value, c: document.getElementById('se-class').value, note: document.getElementById('se-limit-note').textContent, tab: seTab() }));
  check('담임 반(3-1)으로 시작, 한도 안내 자율·진로 각 500자 · 행발 300자(고3 = 2027 입시)', head.g === '3' && head.c === '1' && /자율·진로 각 500자 · 행발 300자/.test(head.note) && head.tab === 'src', head);
  check('자율/진로/행발 단추에 바이트 한도(1,500 · 1,500 · 900)', (await P.evaluate(() => [...document.querySelectorAll('#se-kind .top-btn')].map(b => b.textContent.trim()).join('|'))) === '자율 (1,500바이트)|진로 (1,500바이트)|행발 (900바이트)');
  const rows = await P.evaluate(() => [...document.querySelectorAll('#se-src-list tbody tr')].map(r => r.dataset.num));
  check('자료 입력 표에 명렬표 학생 5명', rows.join(',') === '1,2,3,4,5', rows);
  check('기본 영역: 자율 "1인 1역할" 1개 (아직 저장 안 됨)', (await areas('a')).map(a => a.name).join() === '1인 1역할' && (await ls(pc, 'se-areas-3-1')) === null);
  check('탭 = 단계 번호(수행평가처럼): ① 자료 입력 · ② 편집 · ③ 최종', (await P.evaluate(() => [...document.querySelectorAll('#se-tabs .top-btn')].map(b => b.textContent.trim()).join())) === '① 자료 입력,② 편집,③ 최종');
  const nx0 = await P.evaluate(() => ({ msg: document.querySelector('#se-next .pa-next-msg').textContent, glow: !!document.querySelector('#se-export-btn.pa-glow'), next: [...document.querySelectorAll('#se-tabs .pa-step-next')].map(b => b.dataset.tab).join() }));
  check('다음 할 일(처음): 받은 자율 문장을 넣으라고 + 엑셀 내려받기 반짝임, 다음 단계 = ①', /자율<\/?b?>? ?문장을 넣으세요|자율 문장을 넣으세요/.test(nx0.msg) && nx0.glow && nx0.next === 'src', nx0);

  // ---- 🔍 화면 크기(수행평가와 같은 방식) — 생기부 문장 점검기 글씨 크기와 따로 ----
  const zf = () => P.evaluate(() => ({ cell: getComputedStyle(document.querySelector('#se-src-list textarea.se-cell')).fontSize, main: getComputedStyle(document.getElementById('se-main')).zoom,
    head: getComputedStyle(document.getElementById('se-page-header')).zoom, text: document.getElementById('se-zoom-text').textContent, key: localStorage.getItem('zoom-se') }));
  check('편집기 탭 머리엔 A-/A+ 대신 🔍 − 100% +(A-/A+는 문장 점검 탭에서만 보임)', await P.evaluate(() => !!document.getElementById('se-zoom-group') && document.getElementById('se-zoom-group').offsetParent !== null && ![...document.querySelectorAll('#se-page-header button')].some(b => /^A[-+]$/.test(b.textContent.trim()) && b.offsetParent !== null)));
  await P.evaluate(() => changeFontSize('sgb', 3));
  const z0 = await zf();
  check('생기부 문장 점검기 글씨를 키워도(16px) 편집기 글씨는 13px 그대로', z0.cell === '13px' && z0.text === '100%' && (await P.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--fz-sgb').trim())) === '16px', z0);
  await P.evaluate(() => changeFontSize('sgb', -3));
  await P.click('#se-zoom-group button[title="크게"]'); await P.click('#se-zoom-group button[title="크게"]'); await wait(200);
  const z1 = await zf();
  check('크게 두 번 → 125%: 본문만 1.25배(머리 줄은 그대로), 계정에 기억(zoom-se)', z1.text === '125%' && z1.main === '1.25' && z1.head === '1' && z1.key === '125', z1);
  for (let i = 0; i < 4; i++) await P.click('#se-zoom-group button[title="크게"]');
  check('최대 150%', (await zf()).text === '150%');
  await P.click('#se-zoom-text'); await wait(150);
  const z2 = await zf();
  check('% 글자를 누르면 100%(기억도 지움)', z2.text === '100%' && z2.main === '1' && z2.key === null, z2);

  // ---- 고정된 머리: 자율/진로 버튼은 세 탭 모두 같은 자리 ----
  const kindPos = async () => P.evaluate(() => { const r = document.querySelector('#se-kind [data-kind="a"]').getBoundingClientRect(); return Math.round(r.left) + ',' + Math.round(r.top); });
  const pos = {};
  for (const t of ['src', 'edit', 'final']) { await P.click('#se-tabs [data-tab="' + t + '"]'); await wait(200); pos[t] = await kindPos(); }
  const kb = await P.evaluate(() => [...document.querySelectorAll('#se-kind .top-btn')].map(b => b.dataset.kind).join());
  await P.click('#se-tabs [data-tab="src"]'); await wait(200);
  const kbSrc = await P.evaluate(() => [...document.querySelectorAll('#se-kind .top-btn')].map(b => b.dataset.kind).join());
  check('자율/진로/행발 버튼은 자료 입력·편집·최종 모두 같은 자리, "전체"는 최종 탭에만', pos.src === pos.edit && pos.edit === pos.final && kb === 'a,p,b,all' && kbSrc === 'a,p,b', { pos, kb, kbSrc });
  // 영역 1개여도 표 폭은 영역 3개일 때처럼(한 칸이 화면 끝까지 늘어나지 않게)
  const w1 = await P.evaluate(() => { const l = document.getElementById('se-src-list'), t = l.querySelector('table'); return { cell: l.querySelector('textarea.se-cell').getBoundingClientRect().width, list: document.getElementById('se-pane-src').clientWidth, box: l.getBoundingClientRect().width, table: t.getBoundingClientRect().width }; });
  check('영역 1개: 칸 폭 ≈ (화면 − 번호·이름·추가 열) / 3', Math.abs(w1.cell - (w1.list - 234) / 3) < 16, w1);
  check('흰 상자도 표 폭에 맞춰 줄어듦(오른쪽에 빈 흰 칸 없음)', w1.box < w1.list - 100 && Math.abs(w1.box - w1.table) < 4, w1);

  // ---- 영역 추가·이름 바꾸기(표 머리에서) ----
  await P.click('#se-add-area'); await wait(200);
  check('영역 추가 창에 설명·예시', /한 열\(칸\)이 돼요/.test(await P.evaluate(() => document.getElementById('custom-prompt-msg').textContent)));
  await P.fill('#custom-prompt-input', '학급 자치');
  await P.click('#custom-prompt-overlay button:has-text("확인")'); await wait(300);
  check('영역 추가 → 표 머리에 2개(+ 추가 열), 계정에 저장', (await areas('a')).map(a => a.name).join() === '1인 1역할,학급 자치' && await P.evaluate(() => document.querySelectorAll('#se-src-list thead th.se-area').length === 2 && !!document.querySelector('#se-src-list thead th.se-addcol')) && !!(await ls(pc, 'se-areas-3-1')));
  const w2 = await P.evaluate(() => [...document.querySelectorAll('#se-src-list tr[data-num="1"] textarea.se-cell')].map(t => Math.round(t.getBoundingClientRect().width)));
  check('영역 2개: 두 칸 폭이 같고 1개일 때와 같음', Math.abs(w2[0] - w2[1]) < 3 && Math.abs(w2[0] - w1.cell) < 3, { w2, w1 });
  await P.click('#se-src-list thead th[data-area="' + (await areas('a'))[1].id + '"] .se-aname'); await wait(200);
  await P.fill('#custom-prompt-input', '자치 활동');
  await P.click('#custom-prompt-overlay button:has-text("확인")'); await wait(300);
  check('영역 이름 바꾸기(머리 이름 누르기)', (await areas('a')).map(a => a.name).join() === '1인 1역할,자치 활동');

  // ---- 칸 입력: 치는 동안은 안 올라가고, 벗어나면 저장·업로드 ----
  const a1 = (await areas('a'))[0].id;
  const cellSel = '#se-src-list textarea[data-num="1"][data-area="' + a1 + '"]';
  await wait(2500); upserts.length = 0;   // 영역 저장분이 올라가길 기다린 뒤 센다
  await P.click(cellSel);
  await P.keyboard.type('교실 문단속을 맡아 성실히 수행함.'); await wait(2500);
  const typing = await P.evaluate(() => ({ st: document.getElementById('se-save-state').textContent, saved: localStorage.getItem('se-src-3-1-1-' + seAreas('a')[0].id) }));
  check('입력 중: 화면에 "입력 중" 표시, 아직 저장·업로드 안 됨', /입력 중/.test(typing.st) && typing.saved === null && upserts.length === 0, { typing, upserts });
  const srcBytes = await P.evaluate((s) => [!!document.querySelector(s).nextElementSibling, /바이트/.test(document.querySelector('#se-src-list tbody').innerText)], cellSel);
  check('자료 입력 표에는 바이트 표시 없음(바이트는 편집 탭에서)', !srcBytes[0] && !srcBytes[1], srcBytes);
  await P.keyboard.press('Tab'); await wait(2500);
  const saved = await P.evaluate(() => localStorage.getItem('se-src-3-1-1-' + seAreas('a')[0].id));
  check('칸을 벗어나면 저장(학생·영역 단위 항목) → 서버에 그 항목만 올라감', saved === '교실 문단속을 맡아 성실히 수행함.' && serverVal(T1, 'se-src-3-1-1-' + a1) === saved && upserts.length === 1 && upserts[0].length === 1 && upserts[0][0] === 'se-src-3-1-1-' + a1, { saved, upserts });
  check('저장 표시', /저장됨/.test(await P.evaluate(() => document.getElementById('se-save-state').textContent)));
  await wait(100);
  const nx1 = await P.evaluate(() => ({ msg: document.querySelector('#se-next .pa-next-msg').textContent, btn: (document.querySelector('#se-next .top-btn') || {}).textContent || '', okSrc: !!document.querySelector('#se-tabs [data-tab="src"] .pa-st-ok'), nextTab: [...document.querySelectorAll('#se-tabs .pa-step-next')].map(b => b.dataset.tab).join(), focus: document.activeElement && document.activeElement.classList.contains('se-cell') }));
  check('첫 문장이 들어오면: ① ✓ · 다음 = ② 편집 "1번 … 체크하세요" + "② 편집(으)로 가기", Tab으로 옮긴 칸에 커서 그대로', nx1.okSrc && nx1.nextTab === 'edit' && /1번/.test(nx1.msg) && /체크/.test(nx1.msg) && /② 편집/.test(nx1.btn) && nx1.focus, nx1);

  // ---- 여러 칸 붙여 넣기(엑셀 복사: 탭·줄바꿈, 줄바꿈 든 칸은 따옴표) ----
  const paste = (sel, text) => P.evaluate(([sel, text]) => {
    const ta = document.querySelector(sel);
    const dt = new DataTransfer(); dt.setData('text', text);
    ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, [sel, text]);
  await paste('#se-src-list textarea[data-num="2"][data-area="' + a1 + '"]', '2번 문장\t"2번 자치\n둘째 줄"\n3번 문장\t3번 자치\n');
  await wait(300);
  const a2 = (await areas('a'))[1].id;
  const pasted = await P.evaluate(([a1, a2]) => [1, 2, 3].map(n => [localStorage.getItem('se-src-3-1-' + n + '-' + a1), localStorage.getItem('se-src-3-1-' + n + '-' + a2)]), [a1, a2]);
  check('붙여 넣기: 2번부터 아래·오른쪽으로 채움, 따옴표 속 줄바꿈 유지, 1번은 그대로', pasted[0][0] === '교실 문단속을 맡아 성실히 수행함.' && pasted[1][0] === '2번 문장' && pasted[1][1] === '2번 자치\n둘째 줄' && pasted[2][0] === '3번 문장' && pasted[2][1] === '3번 자치', pasted);
  check('붙여 넣기 안내', /4칸을 채웠어요/.test(await P.evaluate(() => document.getElementById('se-src-msg').textContent)));
  // 영역보다 열이 많으면 → 새 영역을 만들지 묻고, 취소하면 넘친 칸은 안 넣음
  await paste('#se-src-list textarea[data-num="4"][data-area="' + a2 + '"]', '4번 자치\t4번 새것\n');
  await wait(300);
  check('열이 모자라면 새 영역 만들지 물어봄', /새 영역 1개를 만들어/.test(await P.evaluate(() => document.getElementById('custom-confirm-msg').textContent)) && await P.evaluate(() => document.getElementById('custom-confirm-overlay').style.display === 'flex'));
  await P.click('#custom-confirm-cancel-btn'); await wait(300);
  check('취소 → 영역 그대로, 들어갈 칸만 채움·못 넣은 칸 안내', (await areas('a')).length === 2 && (await ls(pc, 'se-src-3-1-4-' + a2)) === '4번 자치' && /못 넣은 칸 1개/.test(await P.evaluate(() => document.getElementById('se-src-msg').textContent)));
  await paste('#se-src-list textarea[data-num="5"][data-area="' + a2 + '"]', '5번 자치\t5번 새것\n');
  await wait(300);
  await P.click('#custom-confirm-ok-btn'); await wait(400);
  const auto = await areas('a');
  check('확인 → "새 영역 3" 만들고 채움(이름은 머리에서 바꾸면 됨)', auto.length === 3 && auto[2].name === '새 영역 3' && (await ls(pc, 'se-src-3-1-5-' + auto[2].id)) === '5번 새것' && await P.evaluate(() => document.querySelectorAll('#se-src-list thead th.se-area').length === 3), auto);
  // 영역 지우기(머리 ✕) — 적힌 내용도 함께
  await P.click('#se-src-list thead th[data-area="' + auto[2].id + '"] .se-adel'); await wait(200);
  await P.click('#custom-confirm-ok-btn'); await wait(300);
  check('머리 ✕ → 영역과 그 내용 지움', (await areas('a')).length === 2 && (await ls(pc, 'se-src-3-1-5-' + auto[2].id)) === null);
  await setLs(pc, 'se-src-3-1-4-' + a2, ''); await setLs(pc, 'se-src-3-1-5-' + a2, '');
  await P.evaluate(() => { localStorage.removeItem('se-src-3-1-4-' + seAreas('a')[1].id); localStorage.removeItem('se-src-3-1-5-' + seAreas('a')[1].id); seRenderAll(); });
  const parsed = await P.evaluate(() => seParseTsv('a\tb\r\nc\t"d""e"\r\n\r\n'));
  check('TSV 해석: CRLF, 따옴표 두 번 → 하나, 끝 빈 줄 제거', JSON.stringify(parsed) === JSON.stringify([['a', 'b'], ['c', 'd"e']]), parsed);

  // ---- 진로 영역 ----
  await P.click('#se-kind [data-kind="p"]'); await wait(200);
  check('진로로 바꾸면 기본 영역 "진로 독서"', (await areas('p')).map(a => a.name).join() === '진로 독서' && await P.evaluate(() => seKind() === 'p'));
  const p1 = (await areas('p'))[0].id;
  await setLs(pc, 'se-src-3-1-1-' + p1, '진로독서 프로젝트로 책을 읽고 토론함.');

  // ---- 편집 탭 ----
  await P.click('#se-tabs [data-tab="edit"]'); await wait(300);
  check('편집 탭에서도 진로가 그대로 골라져 있음', await P.evaluate(() => document.querySelector('#se-kind [data-kind="p"]').classList.contains('theme-active') && document.getElementById('se-draft').dataset.kind === 'p'));
  await P.click('#se-kind [data-kind="a"]'); await wait(200);
  const ed = await P.evaluate(() => ({
    n: document.querySelectorAll('#se-students .se-stu').length, sel: document.querySelector('#se-students .se-stu.sel').dataset.num,
    head: document.querySelector('#se-edit-head div').textContent, cards: [...document.querySelectorAll('.se-card')].map(c => [c.dataset.area, c.classList.contains('none'), c.querySelector('input').disabled]),
    prevDisabled: document.querySelector('#se-edit-head button').disabled, copy: !!document.getElementById('se-copy-btn')
  }));
  check('편집: 학생 5명 목록, 1번 선택, 카드 2개(빈 영역은 체크 못 함), 이전 버튼 비활성', ed.n === 5 && ed.sel === '1' && /1번 가나다/.test(ed.head) && ed.cards.length === 2 && ed.cards[0][1] === false && ed.cards[1][1] === true && ed.cards[1][2] === true && ed.prevDisabled === true, ed);
  check('편집 칸 아래 버튼 3개: 지우기 · 📋 복사 · 📊 최종에 넣기', await P.evaluate(() => [...document.getElementById('se-put-btn').parentElement.children].map(b => b.textContent.trim()).join('|') === '지우기|📋 복사|📊 최종에 넣기'));
  const sum0 = await P.evaluate(() => { const e = document.getElementById('se-sum'); return [e.className, e.textContent, e.closest('.se-sec-title') && e.closest('.se-sec-title').textContent.startsWith('📥 받은 내용'), parseFloat(getComputedStyle(e).fontSize), getComputedStyle(e).borderTopWidth]; });
  check('합친 바이트: 제목 바로 옆 테두리 상자(14px), 체크 전엔 회색 0', /empty/.test(sum0[0]) && /체크한 0개 합치면 0 \/ 1,500바이트/.test(sum0[1]) && sum0[2] && sum0[3] >= 14 && sum0[4] === '2px', sum0);
  check('합치기 버튼은 체크 전엔 비활성', await P.evaluate(() => [...document.querySelectorAll('#se-editor button')].find(b => /합쳐서/.test(b.textContent)).disabled));
  await P.click('.se-card[data-area="' + a1 + '"] input'); await wait(200);
  const st1 = await P.evaluate(() => JSON.parse(localStorage.getItem('se-st-3-1-1')));
  const sum1 = await P.evaluate(() => [document.getElementById('se-sum').className, document.getElementById('se-sum').textContent]);
  const b1 = sgbBytesOf('교실 문단속을 맡아 성실히 수행함.');
  check('체크하면 합친 바이트 초록·남은 바이트', /ok/.test(sum1[0]) && sum1[1] === '체크한 1개 합치면 ' + b1 + ' / 1,500바이트 · ' + (1500 - b1).toLocaleString('ko-KR') + ' 남음', sum1);
  check('체크 → 학생 상태 항목(se-st-)에 영역 id 저장, 카드 강조', st1.sel.a.length === 1 && st1.sel.a[0] === a1 && await P.evaluate((a) => document.querySelector('.se-card[data-area="' + a + '"]').classList.contains('on'), a1), st1);
  await P.evaluate(() => [...document.querySelectorAll('#se-editor button')].find(b => /합쳐서/.test(b.textContent)).click()); await wait(300);
  const fin1 = await P.evaluate(() => ({ v: document.getElementById('se-draft').value, drf: localStorage.getItem('se-drf-3-1-1-a'), fin: localStorage.getItem('se-fin-3-1-1-a'), cnt: document.getElementById('se-count').textContent, dot: document.querySelector('#se-students .se-stu[data-num="1"] .se-dot').className, put: document.getElementById('se-put-state').textContent }));
  check('합치기 → 편집 칸(se-drf-…-a)에만, 최종은 아직 비어 있음, "최종에 아직 안 넣었어요", 점 초록+주황 테두리', fin1.v === '교실 문단속을 맡아 성실히 수행함.' && fin1.drf === fin1.v && fin1.fin === null && /\/ 1,500바이트\(500자\)/.test(fin1.cnt) && /ok/.test(fin1.dot) && /draft/.test(fin1.dot) && /최종에 아직 안 넣었어요/.test(fin1.put), fin1);
  // 📊 최종에 넣기
  await P.click('#se-put-btn'); await wait(300);
  const put1 = await P.evaluate(() => ({ drf: localStorage.getItem('se-drf-3-1-1-a'), fin: localStorage.getItem('se-fin-3-1-1-a'), put: document.getElementById('se-put-state').textContent, btn: document.getElementById('se-put-btn').textContent, dot: document.querySelector('#se-students .se-stu[data-num="1"] .se-dot').className }));
  check('📊 최종에 넣기 → se-fin에 들어가고 se-drf는 지움(같은 글 두 번 저장 안 함), "최종과 같아요"', put1.fin === '교실 문단속을 맡아 성실히 수행함.' && put1.drf === null && /최종에 들어 있는 글과 같아요/.test(put1.put) && /최종에 넣었어요/.test(put1.btn) && !/draft/.test(put1.dot), put1);

  // 편집 칸: 치는 동안 점검(기재 불가), 벗어나면 편집만 저장(최종은 그대로)
  await wait(2500); upserts.length = 0;
  await P.click('#se-draft');
  await P.keyboard.press('End');
  await P.keyboard.type(' 토익 시험을 봄.'); await wait(2000);
  const live = await P.evaluate(() => ({ res: document.getElementById('se-result').textContent, drf: localStorage.getItem('se-drf-3-1-1-a'), put: document.getElementById('se-put-state').textContent }));
  check('편집 칸 치는 동안: 기재 불가(공인어학시험) 바로 표시, "최종과 달라요", 아직 저장·업로드 안 됨', /기재 불가 · 공인어학시험/.test(live.res) && /최종과 달라요/.test(live.put) && live.drf === null && upserts.length === 0, { live, upserts });
  await P.click('#se-memo'); await wait(2500);
  const after = await P.evaluate(() => ({ drf: localStorage.getItem('se-drf-3-1-1-a'), fin: localStorage.getItem('se-fin-3-1-1-a') }));
  check('벗어나면 편집 칸만 저장·업로드(그 항목만), 최종은 그대로', after.drf === '교실 문단속을 맡아 성실히 수행함. 토익 시험을 봄.' && after.fin === '교실 문단속을 맡아 성실히 수행함.' && upserts.length === 1 && upserts[0].join() === 'se-drf-3-1-1-a', { after, upserts });
  // 최종 탭에 "최종에 안 넣은 편집 있음" 표시
  await P.click('#se-tabs [data-tab="final"]'); await wait(300);
  check('최종 탭: 최종엔 예전 글, "최종에 안 넣은 편집 있음" 표시', await P.evaluate(() => /최종에 안 넣은 편집 있음/.test(document.querySelector('#se-final-list tr[data-num="1"]').textContent) && document.querySelector('#se-final-list tr[data-num="1"] td.se-txt').firstChild.textContent === '교실 문단속을 맡아 성실히 수행함.'));
  await P.click('#se-final-list tr[data-num="1"] .se-drafttag'); await wait(300);
  check('그 표시 누르면 편집 탭 그 학생·그 영역', await P.evaluate(() => seTab() === 'edit' && seSelNum === 1 && seKind() === 'a' && document.getElementById('se-draft').value === '교실 문단속을 맡아 성실히 수행함. 토익 시험을 봄.'));
  // 한도 초과 → 빨강, 최종에 넣을 때 확인
  await P.click('#se-draft');
  await P.evaluate(() => { const ta = document.getElementById('se-draft'); ta.value = '가'.repeat(501); ta.dispatchEvent(new Event('input')); });
  const over = await P.evaluate(() => ({ cls: document.getElementById('se-count').className, bar: document.getElementById('se-bar').className, txt: document.getElementById('se-count').textContent }));
  check('1,503바이트 → 넘음 표시(빨강, 3바이트 넘음)', /over/.test(over.cls) && /over/.test(over.bar) && /3바이트 넘음/.test(over.txt), over);
  await P.click('#se-memo'); await wait(300);
  check('초과 상태는 학생 목록 점이 빨강', /over/.test(await P.evaluate(() => document.querySelector('#se-students .se-stu[data-num="1"] .se-dot').className)));
  await P.click('#se-put-btn'); await wait(200);
  check('넘은 채로 최종에 넣으면 확인', /3바이트 넘어요/.test(await P.evaluate(() => document.getElementById('custom-confirm-msg').textContent)));
  await P.click('#custom-confirm-ok-btn'); await wait(300);
  check('확인 → 최종에 들어감', (await ls(pc, 'se-fin-3-1-1-a')) === '가'.repeat(501) && (await ls(pc, 'se-drf-3-1-1-a')) === null);
  await P.click('#se-copy-btn'); await wait(200);
  check('📋 복사 → 편집 칸 글 그대로', await P.evaluate(() => window.__clip === document.getElementById('se-draft').value && /복사했어요/.test(document.getElementById('se-copy-btn').textContent)));
  await P.fill('#se-memo', '진로독서 줄이고, 큐리어톤'); await P.keyboard.press('Tab'); await wait(200);
  check('메모 저장', (await P.evaluate(() => JSON.parse(localStorage.getItem('se-st-3-1-1')).memo)) === '진로독서 줄이고, 큐리어톤');

  // ---- 받은 내용을 체크해도 스크롤 그대로(예전엔 체크할 때마다 맨 위로 올라감) ----
  await P.setViewportSize({ width: 1600, height: 560 }); await wait(200);
  const scr = await P.evaluate(async () => {
    const el = document.getElementById('se-edit-scroll'), max = el.scrollHeight - el.clientHeight;
    el.scrollTop = Math.min(120, max); const before = el.scrollTop;
    const box = () => document.querySelector('#se-box-src .se-card:not(.none) input');
    box().click(); await new Promise(r => setTimeout(r, 200));
    const after = document.getElementById('se-edit-scroll').scrollTop, on = box().checked;
    box().click(); await new Promise(r => setTimeout(r, 200));
    return { max, before, after, on, again: document.getElementById('se-edit-scroll').scrollTop, back: box().checked };
  });
  check('받은 내용 체크·풀기: 오른쪽 스크롤 자리 그대로', scr.before > 0 && scr.after === scr.before && scr.again === scr.before && scr.on !== scr.back, scr);
  await P.setViewportSize({ width: 1600, height: 1000 }); await wait(200);

  // ---- 진로 희망 분야: 나이스에선 따로 적지만 진로 한도를 같이 씀 → 진로 바이트 = 희망 분야 + 특기사항(합쳐서 1,500과 견줌, 화면 숫자도 합친 것) ----
  check('자율에선 진로 희망 분야 칸 없음', await P.evaluate(() => !document.getElementById('se-career')));
  await P.click('#se-kind [data-kind="p"]'); await wait(200);
  const cb = sgbBytesOf('데이터 과학자');
  const car0 = await P.evaluate(() => { const i = document.getElementById('se-career'); return { has: !!i, inHead: !!document.querySelector('#se-edit-head #se-career'), ac: i && i.getAttribute('autocomplete'), note: document.getElementById('se-career-bytes').textContent }; });
  check('진로: 이름 줄에 "진로 희망 분야" 칸(브라우저 자동 완성 목록 안 뜸) + "특기사항과 합쳐 1,500바이트까지"', car0.has && car0.inHead && car0.ac === 'off' && /특기사항과 합쳐 1,500바이트까지/.test(car0.note), car0);
  await P.fill('#se-career', '데이터 과학자');
  check('적는 대로 희망 분야 바이트', new RegExp('^' + cb + '바이트 · 특기사항과 합쳐 1,500바이트까지').test(await P.innerText('#se-career-bytes')), await P.innerText('#se-career-bytes'));
  await P.press('#se-career', 'Enter'); await wait(300);
  if (process.env.SE_SHOTS) await P.screenshot({ path: path.join(process.env.SE_SHOTS, 'se-career.png') });
  const car1 = await P.evaluate(() => ({ st: JSON.parse(localStorage.getItem('se-st-3-1-1')), cnt: document.getElementById('se-count').textContent, sum: document.getElementById('se-sum').textContent, val: document.getElementById('se-career').value }));
  check('Enter(칸 벗어남) → 학생 상태에 저장(메모 그대로), 편집 칸 아래 = 합친 바이트 / 1,500 + (희망 분야 n + 특기사항 0), 합친 바이트 상자도 희망 분야 포함', car1.st.career === '데이터 과학자' && car1.st.memo === '진로독서 줄이고, 큐리어톤' && car1.val === '데이터 과학자' &&
    car1.cnt.includes(cb + '바이트 / 1,500바이트(500자)') && car1.cnt.includes('(진로 희망 분야 ' + cb + ' + 특기사항 0바이트)') && car1.sum.includes('합치면(희망 분야 ' + cb + ' 포함) ' + cb + ' / 1,500바이트'), car1);
  const nOver = Math.floor((1500 - cb) / 3) + 1, tb = nOver * 3;   // 특기사항만으론 안 넘지만 희망 분야와 합치면 넘음
  await P.evaluate((n) => { seSet(seFinKey(1, 'p'), '가'.repeat(n)); seRenderAll(); }, nOver);
  const car2 = await P.evaluate(() => { const d = document.querySelector('#se-students .se-stu[data-num="1"] .se-dot[data-kind="p"]'); return { cls: d.className, text: d.textContent, cnt: document.getElementById('se-count').textContent }; });
  check('학생 목록 진로 점 = 희망 분야 + 특기사항 합친 바이트, 넘으면 빨강', /over/.test(car2.cls) && car2.text === (tb + cb).toLocaleString('ko-KR') && car2.cnt.includes((tb + cb).toLocaleString('ko-KR') + '바이트 / 1,500') && car2.cnt.includes('넘음') && car2.cnt.includes('특기사항 ' + tb.toLocaleString('ko-KR') + '바이트'), { car2, tb, cb });
  await P.click('#se-tabs [data-tab="final"]'); await P.click('#se-kind [data-kind="p"]'); await wait(300);
  const car3 = await P.evaluate(() => { const td = document.querySelector('#se-final-list tbody tr[data-num="1"] td.se-txt'); return { tag: td.querySelector('.se-career-tag') && td.querySelector('.se-career-tag').textContent, b: td.nextElementSibling.textContent, over: td.nextElementSibling.classList.contains('over') }; });
  check('③ 최종 진로: 글 위에 "희망 분야: 데이터 과학자 n바이트", 바이트 칸 = 합친 바이트 / 1,500, 넘음 빨강', car3.tag === '희망 분야: 데이터 과학자 ' + cb + '바이트' && car3.b.startsWith((tb + cb).toLocaleString('ko-KR') + ' / 1,500') && car3.over, car3);
  await P.evaluate(() => { seSet(seFinKey(1, 'p'), ''); seSetSt(1, { career: '' }); seSetCfg({ kind: 'a', finAll: true }); seSetTab('edit'); });
  check('희망 분야를 비우면 학생 상태에서 빠짐', await P.evaluate(() => !('career' in JSON.parse(localStorage.getItem('se-st-3-1-1')))));
  // 다음 학생·진로 전환
  await P.click('#se-edit-head button:has-text("다음")'); await wait(200);
  check('다음 ▶ → 2번', await P.evaluate(() => seSelNum === 2 && document.querySelector('#se-students .se-stu.sel').dataset.num === '2' && document.getElementById('se-draft').value === ''));
  await P.click('#se-students .se-stu[data-num="1"]'); await wait(200);
  await P.click('#se-kind [data-kind="p"]'); await wait(200);
  const pk = await P.evaluate(() => ({ cards: document.querySelectorAll('.se-card').length, fin: document.getElementById('se-draft').value, kind: document.getElementById('se-draft').dataset.kind }));
  check('진로로 바꾸면 진로 카드·빈 편집 칸', pk.cards === 1 && pk.fin === '' && pk.kind === 'p', pk);
  await P.click('.se-card[data-area="' + p1 + '"] input'); await wait(150);
  await P.evaluate(() => [...document.querySelectorAll('#se-editor button')].find(b => /합쳐서/.test(b.textContent)).click()); await wait(300);
  await P.click('#se-put-btn'); await wait(300);
  check('진로 합치기 → 최종에 넣기 → se-fin-…-p', (await ls(pc, 'se-fin-3-1-1-p')) === '진로독서 프로젝트로 책을 읽고 토론함.');
  // 지우기 → 편집 칸만 비움(최종은 그대로), 비운 채 최종에 넣기 → 확인 후 최종에서 지움
  await P.click('#se-editor button:has-text("지우기")'); await wait(200);
  check('지우기 → 편집 칸만 비움, 최종은 그대로', (await ls(pc, 'se-fin-3-1-1-p')) === '진로독서 프로젝트로 책을 읽고 토론함.' && await P.evaluate(() => document.getElementById('se-draft').value === '' && /최종과 달라요/.test(document.getElementById('se-put-state').textContent)));
  await P.click('#se-put-btn'); await wait(200);
  await P.click('#custom-confirm-ok-btn'); await wait(300);
  check('빈 편집 칸으로 최종에 넣기 → 확인 후 최종에서 지움', (await ls(pc, 'se-fin-3-1-1-p')) === null);
  await P.evaluate(() => [...document.querySelectorAll('#se-editor button')].find(b => /합쳐서/.test(b.textContent)).click()); await wait(300);
  await P.click('#se-put-btn'); await wait(300);

  // ---- 최종 탭 ----
  await P.click('#se-tabs [data-tab="final"]'); await wait(300);
  check('최종 탭은 처음엔 "전체"(자율·진로 나란히) — 편집 탭에서 자율/진로를 바꿔도 그대로', await P.evaluate(() => document.querySelector('#se-kind [data-kind="all"]').classList.contains('theme-active') && /자율 최종/.test(document.querySelector('#se-final-list thead').textContent) && /진로 최종/.test(document.querySelector('#se-final-list thead').textContent)));
  check('전체 = 자율·진로·행발 세 가지 나란히', await P.evaluate(() => /행발 최종/.test(document.querySelector('#se-final-list thead').textContent) && document.querySelectorAll('#se-final-list tbody tr[data-num="1"] td.se-txt').length === 3));
  await P.click('#se-kind [data-kind="p"]'); await wait(300);
  const wP = await P.evaluate(() => ({ w: document.querySelector('#se-final-list tbody tr[data-num="1"] td.se-txt').getBoundingClientRect().width, pane: document.getElementById('se-pane-final').clientWidth }));
  check('진로만: 진로 열만, 글 칸 폭은 두 가지 나란히 볼 때만큼(한 줄이 너무 길지 않게)', await P.evaluate(() => document.querySelectorAll('#se-final-list thead th').length === 6 && /진로 최종/.test(document.querySelector('#se-final-list thead').textContent) && !/자율 최종/.test(document.querySelector('#se-final-list thead').textContent)) &&
    Math.abs(wP.w - (wP.pane - 416) / 2) < 6, wP);
  const fb = await P.evaluate(() => { const l = document.getElementById('se-final-list'); return { box: l.getBoundingClientRect().width, table: l.querySelector('table').getBoundingClientRect().width, pane: document.getElementById('se-pane-final').clientWidth }; });
  check('진로만: 흰 상자도 표 폭에 맞춰 줄어듦(오른쪽 빈 흰 칸 없음)', fb.box < fb.pane - 100 && Math.abs(fb.box - fb.table) < 4, fb);
  const pOnly = await P.evaluate(() => [...document.querySelectorAll('#se-final-list tbody tr[data-num="1"] td')].map(t => t.textContent.trim()));
  const pb = sgbBytesOf('진로독서 프로젝트로 책을 읽고 토론함.');
  check('바이트 칸에 쓴 바이트 / 한도 + 남은 바이트', pOnly[2] === '진로독서 프로젝트로 책을 읽고 토론함.' && pOnly[3] === pb + ' / 1,500' + (1500 - pb).toLocaleString('ko-KR') + ' 남음', pOnly);
  await P.click('#se-kind [data-kind="all"]'); await wait(300);
  const fin = await P.evaluate(() => ({
    rows: document.querySelectorAll('#se-final-list tbody tr').length, r1: [...document.querySelectorAll('#se-final-list tbody tr[data-num="1"] td')].map(t => t.textContent.trim()),
    note: document.getElementById('se-final-note').textContent, b: [...document.querySelectorAll('#se-final-list tbody tr[data-num="1"] td.se-bcell')].map(d => d.className)
  }));
  check('전체: 5명, 1번 자율(초과, 3 넘음)·진로 최종과 바이트(남음), 요약', fin.rows === 5 && fin.r1[2] === '가'.repeat(501) && fin.r1[3] === '1,503 / 1,5003 넘음' && fin.r1[5] === '진로독서 프로젝트로 책을 읽고 토론함.' && /over/.test(fin.b[0]) && !/over/.test(fin.b[1]) && /자율 최종 1명\(초과 1\) · 진로 최종 1명/.test(fin.note), fin);
  await P.click('#se-tabs [data-tab="src"]'); await wait(200);
  check('전체를 골라도 자료 입력 탭은 마지막에 고른 진로', await P.evaluate(() => document.querySelector('#se-kind [data-kind="p"]').classList.contains('theme-active') && !document.querySelector('#se-kind [data-kind="all"]')));
  await P.click('#se-tabs [data-tab="final"]'); await wait(200);
  check('최종 탭으로 돌아오면 전체 그대로', await P.evaluate(() => document.querySelector('#se-kind [data-kind="all"]').classList.contains('theme-active')));
  await P.click('#se-final-list tbody tr[data-num="1"] td:nth-child(8) button'); await wait(200);
  check('최종 표 📋 → 진로 최종 복사', await P.evaluate(() => window.__clip === '진로독서 프로젝트로 책을 읽고 토론함.'));
  await P.click('#se-final-list tbody tr[data-num="3"] button:has-text("✎")'); await wait(300);
  check('✎ → 편집 탭 그 학생', await P.evaluate(() => seTab() === 'edit' && seSelNum === 3));

  // ---- 엑셀 가져오기 / 내려받기 ----
  if (XLSXLIB) {
    const X = require(XLSXLIB);
    const data = [[], [], []]; data[0][3] = '자율'; data[0][11] = '진로';
    data[1] = ['', '번호', '이름', '1인 1역할', '좌우명', '', '', '', '', '', '', '진로 독서', '큐리어톤'];
    data[2] = ['', 1, '가나다', '엑셀 1번 역할(덮어쓰면 안 됨)', '엑셀 1번 좌우명', '', '', '', '', '', '', '엑셀 1번 독서', '엑셀 1번 큐리어톤'];
    data[3] = ['', 4, '차카타', '엑셀 4번 역할', '', '', '', '', '', '', '', '', '엑셀 4번 큐리어톤'];
    const finS = [['번호', '이름', '자율', '한글', 'Byte', '바이트', '진로', '한글', 'Byte', '바이트'], [1, '가나다', '엑셀 최종 자율(덮어쓰면 안 됨)', 0, 0, 0, '엑셀 최종 진로', 0, 0, 0], [4, '차카타', '4번 최종 자율', 0, 0, 0, '', 0, 0, 0]];
    const wb = X.utils.book_new();
    X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(data), '데이터');
    X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(finS), '최종');
    const xfile = path.join(require('os').tmpdir(), 'se-import-test.xlsx');
    fs.writeFileSync(xfile, X.write(wb, { type: 'buffer', bookType: 'xlsx' }));
    await P.setInputFiles('#se-import-input', xfile); await wait(800);
    try { fs.unlinkSync(xfile); } catch (e) {}
    const msg = await P.evaluate(() => document.getElementById('custom-alert-msg') ? document.getElementById('custom-alert-msg').innerText : document.body.innerText);
    await P.click('#custom-alert-overlay button'); await wait(200);
    const imp = await P.evaluate(() => {
      const A = seAllAreas(); const id = (k, n) => (A[k].find(a => a.name === n) || {}).id;
      return { a: A.a.map(a => a.name), p: A.p.map(a => a.name),
        r1: localStorage.getItem('se-src-3-1-1-' + id('a', '1인 1역할')), m1: localStorage.getItem('se-src-3-1-1-' + id('a', '좌우명')), c1: localStorage.getItem('se-src-3-1-1-' + id('p', '큐리어톤')),
        r4: localStorage.getItem('se-src-3-1-4-' + id('a', '1인 1역할')), c4: localStorage.getItem('se-src-3-1-4-' + id('p', '큐리어톤')),
        f1a: localStorage.getItem('se-fin-3-1-1-a'), f1p: localStorage.getItem('se-fin-3-1-1-p'), f4a: localStorage.getItem('se-fin-3-1-4-a') };
    });
    check('엑셀 가져오기: 같은 이름 영역은 그대로 쓰고 새 영역(좌우명·큐리어톤) 추가', imp.a.join() === '1인 1역할,자치 활동,좌우명' && imp.p.join() === '진로 독서,큐리어톤', imp);
    check('엑셀 가져오기: 빈 칸만 채우고 이미 적힌 칸(1번 역할·1번 완성본)은 그대로', imp.r1 === '교실 문단속을 맡아 성실히 수행함.' && imp.m1 === '엑셀 1번 좌우명' && imp.c1 === '엑셀 1번 큐리어톤' && imp.r4 === '엑셀 4번 역할' && imp.c4 === '엑셀 4번 큐리어톤' && imp.f1a === '가'.repeat(501) && imp.f1p === '진로독서 프로젝트로 책을 읽고 토론함.' && imp.f4a === '4번 최종 자율', imp);
    check('가져오기 안내문', /자율 2개, 진로 2개/.test(msg) && /받은 내용 4칸, 완성본 1칸/.test(msg) && /이미 적힌 칸 4개/.test(msg), msg);
    // 내려받기(ExcelJS): 데이터·최종 시트 구조 + 서식(칸 너비·줄바꿈·필터·틀 고정·바이트 식·넘으면 빨강)
    if (EXCELJS_PATH) {
      const got = await P.evaluate(() => new Promise((res) => {
        const orig = window.fmSaveNow;
        window.fmSaveNow = async (blob, name) => { window.fmSaveNow = orig; const b = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode.apply(null, b.subarray(i, i + 8192)); res({ name, b64: btoa(s) }); };
        seExportExcel();
      }));
      const buf = Buffer.from(got.b64, 'base64');
      const xb = X.read(buf, { type: 'buffer' });
      const rows = (n) => X.utils.sheet_to_json(xb.Sheets[n], { header: 1, defval: '' });
      const sa = rows('자율 입력'), sp = rows('진로 입력'), ff = X.utils.sheet_to_json(xb.Sheets['최종'], { header: 1 });
      check('엑셀 내려받기: 자율 입력·진로 입력 시트 따로(1행 번호·이름·영역 이름) + 행발 관찰 + 최종(번호·이름·자율·바이트·진로·바이트·행발·바이트)', /^자율진로행발_3-1_\d{4}-\d{2}-\d{2}\.xlsx$/.test(got.name) && xb.SheetNames.join() === '자율 입력,진로 입력,행발 관찰,최종' &&
        sa[0].join() === '번호,이름,1인 1역할,자치 활동,좌우명' && sa[1][0] === 1 && sa[1][1] === '가나다' && sa[1][2] === '교실 문단속을 맡아 성실히 수행함.' && sa[1][4] === '엑셀 1번 좌우명' &&
        sp[0].join() === '번호,이름,진로 독서,큐리어톤' && sp[1][3] === '엑셀 1번 큐리어톤' && sa.length === 6 && sp.length === 6 &&
        ff[0].join() === '번호,이름,자율,바이트,진로 희망 분야,진로,바이트,행발,바이트' && ff[1][3] === 1503 && ff[1][5] === '진로독서 프로젝트로 책을 읽고 토론함.' && ff.length === 6, { name: got.name, sheets: xb.SheetNames, a: sa.slice(0, 2), p: sp.slice(0, 2), f: ff.slice(0, 2) });
      const EJ = require(path.join(path.dirname(EXCELJS_PATH), '..'));
      const ew = new EJ.Workbook(); await ew.xlsx.load(buf);
      const ed = ew.getWorksheet('자율 입력'), ep = ew.getWorksheet('진로 입력'), ef = ew.getWorksheet('최종');
      const fmt = {
        dW: ed.getColumn(3).width, pW: ep.getColumn(3).width, fW: [ef.getColumn(3).width, ef.getColumn(4).width], wrapD: ed.getCell('C2').alignment && ed.getCell('C2').alignment.wrapText, wrapF: ef.getCell('C2').alignment && ef.getCell('C2').alignment.wrapText,
        top: ef.getCell('C2').alignment && ef.getCell('C2').alignment.vertical, filterD: ed.autoFilter, filterP: ep.autoFilter, filterF: ef.autoFilter, viewF: ef.views && ef.views[0], viewD: ed.views && ed.views[0], viewP: ep.views && ep.views[0],
        bold: ef.getCell('A1').font && ef.getCell('A1').font.bold, border: !!(ef.getCell('C2').border && ef.getCell('C2').border.top),
        formula: ef.getCell('D2').formula, result: ef.getCell('D2').result, cf: (ef.conditionalFormattings || []).map(c => c.ref + ':' + c.rules[0].formulae[0]).join('|'),
        h2: ef.getRow(2).height, h3: ef.getRow(3).height, landscape: ef.pageSetup.orientation, fit: ef.pageSetup.fitToWidth, active: ew.views && ew.views[0] && ew.views[0].activeTab
      };
      check('엑셀 서식: 칸 너비(영역 40·최종 70), 줄바꿈·위 맞춤, 머리 굵게·테두리', fmt.dW === 40 && fmt.pW === 40 && fmt.fW[0] === 70 && fmt.fW[1] === 10 && fmt.wrapD && fmt.wrapF && fmt.top === 'top' && fmt.bold && fmt.border, fmt);
      check('엑셀 서식: 세 시트 모두 필터·틀 고정(번호·이름 2열·머리 1행), 열면 최종 시트', fmt.filterD && fmt.filterP && fmt.filterF && [fmt.viewF, fmt.viewD, fmt.viewP].every(v => v && v.state === 'frozen' && v.ySplit === 1 && v.xSplit === 2) && fmt.active === 3 && fmt.filterF === 'A1:I6', fmt);
      check('엑셀 서식: 바이트 = 사용자 엑셀과 같은 식(LENB), 계산값 1503, 한도 넘으면 빨강(조건부 서식 1500), 긴 글 줄은 높게, A4 가로 폭 맞춤', /LENB\(C2\)/.test(fmt.formula) && fmt.result === 1503 && fmt.cf === 'D2:D6:1500|G2:G6:1500|I2:I6:900' && fmt.h2 > fmt.h3 && fmt.landscape === 'landscape' && fmt.fit === 1, fmt);
      // 내려받은 파일을 다시 가져오면 다 이미 적힌 칸이라 아무것도 안 바뀜(왕복)
      const rt = path.join(require('os').tmpdir(), 'se-roundtrip.xlsx');
      fs.writeFileSync(rt, buf);
      const beforeRt = await P.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('se-')).sort().map(k => k + '=' + localStorage.getItem(k)).join('\n'));
      // 진로 칸 하나를 지워 두고 가져오면 그 칸만 다시 채워져야 함(새 "진로 입력" 시트를 실제로 읽는지)
      await P.evaluate(() => localStorage.removeItem('se-src-3-1-1-' + seAreas('p').find(a => a.name === '큐리어톤').id));
      await P.setInputFiles('#se-import-input', rt); await wait(800);
      try { fs.unlinkSync(rt); } catch (e) {}
      const rtMsg = await P.evaluate(() => document.getElementById('custom-alert-msg').innerText);
      await P.click('#custom-alert-overlay button'); await wait(200);
      const afterRt = await P.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('se-')).sort().map(k => k + '=' + localStorage.getItem(k)).join('\n'));
      check('내려받은 파일 다시 가져오기: 지운 진로 칸 하나만 다시 채움, 나머지 영역·내용 그대로(왕복)', /자율 3개, 진로 2개/.test(rtMsg) && /받은 내용 1칸, 완성본 0칸/.test(rtMsg) && beforeRt === afterRt, rtMsg);
    } else console.log('  ⚠️ exceljs가 없어 엑셀 내려받기 검사를 건너뜀 (npm i exceljs@4.4.0 후 NODE_PATH에 추가)');
  } else console.log('  ⚠️ 엑셀 검사 건너뜀(xlsx 라이브러리 없음)');

  // ---- 📖 설명서 ----
  await P.evaluate(() => { seSetCfg({ kind: 'p', finAll: false }); seSetTab('final'); });
  const snapSe = () => P.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('se-')).sort().map(k => k + '=' + localStorage.getItem(k)).join('\n'));
  await wait(2500);
  const beforeTour = await snapSe(), srvBefore = [...items.keys()].filter(k => k.includes('|se-')).map(k => k + '=' + items.get(k).value).join('\n');
  const rosterBefore = await P.evaluate(() => seRoster.map(s => s.num + s.name).join());
  upserts.length = 0;
  await P.click('#se-tour-btn'); await wait(400);
  check('설명서 첫 화면: 예시 반(가짜 학생 5명·영역 3개) + "저장 안 돼요" 표시', await P.evaluate(() => !!seDemo && seRoster.map(s => s.name).join() === '김하늘,이바다,박구름,최별,정나래' &&
    document.querySelectorAll('#se-src-list th.se-area').length === 3 && /학급 환경 도우미/.test(document.getElementById('se-src-list').querySelector('textarea').value) &&
    /예시 화면/.test(document.getElementById('se-save-state').textContent)));
  const seen = [], demoChk = {};
  for (let k = 0; k < 30; k++) {
    const st = await P.evaluate(() => ({ title: document.getElementById('tour-card-title').innerText, prog: document.getElementById('tour-card-progress').innerText, tab: seTab(), sp: document.getElementById('tour-spotlight').getBoundingClientRect().width, btn: document.getElementById('tour-next-btn').innerText }));
    seen.push(st);
    if (/받은 내용/.test(st.title)) demoChk.edit = await P.evaluate(() => ({ cards: document.querySelectorAll('#se-box-src .se-card.on').length, sum: document.getElementById('se-sum').className, draft: document.getElementById('se-draft').value.length, orange: !!document.querySelector('#se-students .se-stu[data-num="2"] .se-dot.draft') }));
    if (/최종 — 확인하고/.test(st.title)) demoChk.fin = await P.evaluate(() => ({ txt: document.querySelectorAll('#se-final-list td.se-txt:not(:has(.se-empty))').length, draftTag: document.querySelectorAll('#se-final-list .se-drafttag').length }));
    if (/행발 ① 관찰 기록/.test(st.title)) demoChk.obs = await P.evaluate(() => ({ tab: document.querySelector('#se-tabs [data-tab="src"]').textContent, items: document.querySelectorAll('#se-src-list .se-obs-item').length, rows: document.querySelectorAll('#se-src-list .se-obs-table tbody tr').length, on: document.querySelectorAll('#se-src-list tr[data-num="1"] .se-obs-cov .se-vtag.on').length }));
    if (/행발 ② /.test(st.title)) demoChk.obsEdit = await P.evaluate(() => ({ items: document.querySelectorAll('#se-box-obs .se-obs-item').length, src: !!document.getElementById('se-box-src'), draft: document.getElementById('se-draft').dataset.kind, fin: document.getElementById('se-draft').value.length }));
    if (/편집 칸 — 다듬기/.test(st.title)) {   // 예시 화면에서 고쳐도 선생님 자료·서버엔 안 들어감
      await P.fill('#se-draft', '예시에서 고친 글'); await P.evaluate(() => document.getElementById('se-draft').blur()); await wait(100);
    }
    if (/완료/.test(st.btn)) break;
    await P.click('#tour-next-btn'); await wait(300);
  }
  check('설명서 예시: 편집 탭에 체크한 카드·합친 바이트·편집 글, 2번 학생 주황 테두리 / 최종 탭에 완성본·"최종에 안 넣은 편집"', demoChk.edit && demoChk.edit.cards === 2 && /ok/.test(demoChk.edit.sum) && demoChk.edit.draft > 50 && demoChk.edit.orange &&
    demoChk.fin && demoChk.fin.txt >= 5 && demoChk.fin.draftTag === 2, demoChk);   // 2번 학생 + 위에서 예시 편집 칸을 고친 1번 학생
  check('설명서 예시 행발: ① 관찰 기록 표(5명, 기록 6개, 1번 덕목 6개 표시) · ② 관찰 기록 보며 쓰기(1번 기록 3개, 받은 내용 상자 없음, 행발 최종 글)',
    demoChk.obs && /관찰 기록/.test(demoChk.obs.tab) && demoChk.obs.rows === 5 && demoChk.obs.items === 6 && demoChk.obs.on === 6 &&
    demoChk.obsEdit && demoChk.obsEdit.items === 3 && !demoChk.obsEdit.src && demoChk.obsEdit.draft === 'b' && demoChk.obsEdit.fin > 100, demoChk);
  const nSteps = await P.evaluate(() => SE_TOUR_STEPS.length);
  check('설명서: 모든 단계를 다 보여줌(건너뛴 것 없음), 칸마다 빛 비춤', seen.length === nSteps && seen.every(x => x.sp > 0) && seen[seen.length - 1].prog === nSteps + ' / ' + nSteps, seen.map(x => x.prog + ' ' + x.title));
  check('설명서: 전체 흐름(세 단계) → 넣는 방법 두 가지(엑셀 양식/직접) → 편집(최종에 넣기) → 최종 순서, 탭도 따라 바뀜',
    /환영/.test(seen[0].title) && seen.some(x => /넣는 방법은 두 가지/.test(x.title) && x.tab === 'src') && seen.some(x => /엑셀 내려받기 = 입력용 양식/.test(x.title)) &&
    seen.some(x => /최종에 넣기/.test(x.title) && x.tab === 'edit') && seen.some(x => /최종 — 확인하고 나이스로/.test(x.title) && x.tab === 'final'), seen.map(x => x.tab + ' ' + x.title));
  await P.click('#tour-next-btn'); await wait(300);
  await wait(2500);
  check('설명서 닫으면 보던 탭(최종)·진로·반·학생으로 돌아가고 자료(localStorage·서버)는 그대로, 올린 것 없음', await P.evaluate((r) => document.getElementById('tour-overlay').style.display === 'none' && !seDemo && seTab() === 'final' && seKind() === 'p' && !seFinAll() &&
    seRoster.map(s => s.num + s.name).join() === r && document.getElementById('se-grade').value === '3' && document.getElementById('se-class').value === '1' && !/예시/.test(document.getElementById('se-save-state').textContent), rosterBefore) &&
    (await snapSe()) === beforeTour && [...items.keys()].filter(k => k.includes('|se-')).map(k => k + '=' + items.get(k).value).join('\n') === srvBefore && upserts.length === 0, upserts);
  // 설명서 도중에 바깥(어두운 곳)을 눌러 닫아도 예시 자료는 치워지고 원래 화면
  await P.click('#se-tour-btn'); await wait(300);
  await P.mouse.click(5, 300); await wait(300);
  check('설명서 도중 바깥을 눌러 닫아도 예시 끝·원래 화면', await P.evaluate(() => document.getElementById('tour-overlay').style.display === 'none' && !seDemo && seRoster[0].name !== '김하늘') && (await snapSe()) === beforeTour);
  await P.evaluate(() => { seSetCfg({ kind: 'a', finAll: true }); seSetTab('edit'); });

  // ---- 다른 기기(같은 선생님)에서 보임, 다른 선생님은 못 봄 ----
  await wait(2500);
  const pc2 = await openDevice(browser, 'PC2', T1);
  await pc2.page.click('#rail-sgb-btn'); await wait(200);
  await pc2.page.click('#sgb-tabs [data-tab="edit"]'); await wait(800);
  const other = await pc2.page.evaluate(() => ({ g: seCfg().g, c: seCfg().c, fin: localStorage.getItem('se-fin-3-1-1-a'), areas: seAreas('a').map(a => a.name).join(), tab: seTab() }));
  check('다른 기기: 같은 반·영역·완성본·탭이 그대로', other.g === 3 && other.c === 1 && other.fin === '가'.repeat(501) && /1인 1역할,자치 활동/.test(other.areas) && other.tab === 'edit', other);
  const t2 = await openDevice(browser, '박교사', T2);
  const t2keys = await t2.page.evaluate(() => Object.keys(localStorage).filter(k => k.indexOf('se-') === 0));
  check('다른 선생님에겐 자료 없음', t2keys.length === 0 && [...items.keys()].every(k => !(k.startsWith(T2) && k.includes('|se-'))), t2keys);

  // ---- 열고 닫기(생기부 = 한 화면, 탭 두 개) ----
  await P.click('#sgb-tabs [data-tab="check"]'); await wait(300);
  check('편집기 → 문장 점검·길라잡이 탭: 같은 화면에서 바뀜·레일 버튼 켜짐', await panelShown() && await P.evaluate(() => document.getElementById('se-body').offsetParent === null && document.getElementById('rail-sgb-btn').classList.contains('active')));
  check('문장 점검 탭에서는 편집기를 다시 그리지 않음(seIsOpen 거짓)', await P.evaluate(() => !seIsOpen()));
  await P.click('#sgb-tabs [data-tab="edit"]'); await wait(400);
  check('다시 편집기 탭 → 쓰던 반·탭 그대로', await shown() && await P.evaluate(() => seIsOpen() && seCfg().g === 3 && seCfg().c === 1));
  await P.click('#rail-sgb-btn'); await wait(300);
  check('열려 있을 때 레일 생기부 한 번 더 → 홈으로', await P.evaluate(() => document.getElementById('se-page').style.display === 'none' && document.getElementById('main-dashboard').style.display !== 'none'));
  await P.click('#rail-sgb-btn'); await wait(500);
  check('다시 누르면 마지막 탭(편집기)으로', await shown() && !(await panelShown()));
  await P.click('#se-page-header button:has-text("← 홈으로")'); await wait(300);
  check('← 홈으로 → 닫힘', await P.evaluate(() => document.getElementById('se-page').style.display === 'none'));
  await P.click('#rail-sgb-btn'); await wait(400);
  await P.click('#rail-absence-btn'); await wait(400);
  check('결석계 누르면 편집기 닫힘', !(await shown()) && await P.evaluate(() => document.getElementById('absence-page').style.display === 'flex' && !document.getElementById('rail-sgb-btn').classList.contains('active')));
  await P.click('#rail-sgb-btn'); await wait(200); await P.click('#sgb-tabs [data-tab="edit"]'); await wait(400);
  check('결석계에서 편집기 열면 결석계 닫힘', await shown() && await P.evaluate(() => document.getElementById('absence-page').style.display === 'none'));
  await P.click('#rail-home-btn'); await wait(300);
  check('홈 → 닫힘', !(await shown()) && await P.evaluate(() => document.getElementById('main-dashboard').style.display === 'grid'));

  // ---- 반 바꾸기·초기화 ----
  await P.click('#rail-sgb-btn'); await wait(200); await P.click('#sgb-tabs [data-tab="edit"]'); await wait(400);
  // 체크한 것 합치면 한도를 넘을 때: 빨간 테두리 상자에 넘은 바이트(바로 뒤 초기화가 지움)
  await P.click('#se-tabs [data-tab="edit"]'); await wait(300);
  await P.click('#se-kind [data-kind="a"]'); await wait(200);
  await P.evaluate(() => { const a = seAreas('a'); seSet(seSrcKey(1, a[0].id), '가'.repeat(400)); seSet(seSrcKey(1, a[1].id), '나'.repeat(200)); const st = seSt(1); st.sel.a = [a[0].id, a[1].id]; seSetSt(1, { sel: st.sel }); seSelectStudent(1); });
  await wait(300);
  const sumOver = await P.evaluate(() => [document.getElementById('se-sum').className, document.getElementById('se-sum').textContent]);
  check('합치면 한도 넘음: 빨강·넘은 바이트', /over/.test(sumOver[0]) && sumOver[1] === '체크한 2개 합치면 1,801 / 1,500바이트 · 301 넘음', sumOver);
  await P.screenshot({ path: 'se-edit-sum.png' });
  await P.click('#se-tabs [data-tab="src"]'); await wait(300);
  await P.screenshot({ path: 'se-src-nobytes.png' });
  await P.selectOption('#se-class', '2'); await wait(500);
  const cls2 = await P.evaluate(() => ({ n: seRoster.length, areas: seAreas('a').map(a => a.name).join(), fin: localStorage.getItem('se-fin-3-2-1-a') }));
  check('3-2로 바꾸면 그 반 명렬표 28명·기본 영역·빈 자료', cls2.n === 28 && cls2.areas === '1인 1역할' && cls2.fin === null, cls2);
  // 빈 반엔 단계 안내 — 첫 칸을 적고 바로 표 머리 단추를 눌러도(안내가 사라지며 표가 올라가도) 단추가 먹힘
  check('빈 반(3-2): 다음 할 일 = 문장 넣기', /문장을 넣으세요/.test(await P.innerText('#se-next')));
  await P.click('#se-src-list tr[data-num="1"] textarea.se-cell'); await P.keyboard.type('첫 문장');
  await P.click('#se-add-area'); await wait(300);
  const promptUp = await P.isVisible('#custom-prompt-overlay');
  if (promptUp) { await P.click('#custom-prompt-overlay button:has-text("취소")'); await wait(200); }
  check('첫 칸 적고 바로 "＋ 영역 추가" → 창이 뜸(다음 할 일이 바뀌어도 클릭 안 빗나감) + 안내 바뀜 + 글 저장', promptUp && !/문장을 넣으세요/.test(await P.innerText('#se-next')) && await P.evaluate(() => localStorage.getItem('se-src-3-2-1-' + seAreas('a')[0].id) === '첫 문장'));
  // 다음 할 일 따라가기: ② 편집으로 → 카드 체크(반짝임) → 합치기(반짝임) → 최종에 넣기(반짝임) → 자율 완료 → 진로로
  await P.click('#se-next .top-btn'); await wait(250);
  const g = () => P.evaluate(() => { const e = document.querySelector('#se-page .pa-glow'); return e ? (e.id || e.className) : ''; });
  const f1 = { tab: await P.evaluate(() => seTab() + ':' + seSelNum), glow: await g() };
  await P.click('#se-box-src .se-card:not(.none) input[type=checkbox]'); await wait(200);
  const f2 = await g();
  await P.click('#se-combine-btn'); await wait(200);
  const f3 = await g();
  await P.click('#se-put-btn'); await wait(300);
  const f4 = await P.evaluate(() => ({ done: !!document.querySelector('#se-next .pa-next.done'), btn: (document.querySelector('#se-next .top-btn') || {}).textContent, ok: [...document.querySelectorAll('#se-tabs .pa-st-ok')].length }));
  check('다음 할 일 따라가기: ② 편집 1번 → 카드 반짝임 → 합치기 반짝임 → 최종에 넣기 반짝임 → "완료" + ①②③ ✓ + "진로로 →"', f1.tab === 'edit:1' && /se-card/.test(f1.glow) && f2 === 'se-combine-btn' && f3 === 'se-put-btn' && f4.done && f4.btn === '진로로 →' && f4.ok === 3, { f1, f2, f3, f4 });
  const lst = await P.evaluate(async () => {
    const l = document.getElementById('se-students'); l.scrollTop = 300; const before = l.scrollTop;
    document.querySelector('#se-students .se-stu[data-num="20"]').click(); await new Promise(r => setTimeout(r, 200));
    const r = { max: l.scrollHeight - l.clientHeight, before, after: document.getElementById('se-students').scrollTop, sel: seSelNum };
    seSelectStudent(1); return r;
  });
  check('학생 목록에서 아래쪽 학생(20번)을 눌러도 목록 스크롤 그대로', lst.before > 0 && lst.after === lst.before && lst.sel === 20, lst);
  await P.click('#se-next .top-btn'); await wait(250);
  check('"진로로 →" → 진로로 바뀌고 다음 할 일 = 진로 문장 넣기', (await P.evaluate(() => seKind())) === 'p' && /진로<\/b> 문장을 넣으세요|진로 문장을 넣으세요/.test(await P.innerText('#se-next')));
  await P.evaluate(() => { seSetCfg({ kind: 'a' }); seRenderAll(); });
  await P.selectOption('#se-class', '1'); await wait(500);

  // ---- 👀 행발: ① 관찰 기록(반 전체 표 · Enter로 쌓기 · 덕목 표시 · 고치기·지우기) → ② 기록 보며 쓰기 → 최종·엑셀 ----
  await P.click('#se-tabs [data-tab="src"]'); await wait(200);
  await P.click('#se-kind [data-kind="b"]'); await wait(2500);   // 앞에서 고친 것이 다 올라간 뒤부터 셈
  const hb0 = await P.evaluate(() => ({ table: !!document.querySelector('#se-src-list .se-obs-table'), rows: document.querySelectorAll('#se-src-list .se-obs-table tbody tr').length, srcTable: !!document.querySelector('#se-src-list .se-src-table'),
    tab: document.querySelector('#se-tabs [data-tab="src"]').textContent, msg: document.querySelector('#se-next .pa-next-msg').textContent, glow: !!document.querySelector('#se-src-list tr[data-num="1"] .se-obs-input.pa-glow'),
    cov: document.querySelectorAll('#se-src-list tr[data-num="1"] .se-obs-cov .se-vtag.miss').length, hint: document.getElementById('se-kind-hint').textContent }));
  check('행발 고르면 ① 탭이 "관찰 기록" 표(학생 5명, 영역 표 아님) + 다음 할 일 = 한 줄씩 적기·첫 칸 반짝임 + 덕목 8개 모두 흐림', hb0.table && hb0.rows === 5 && !hb0.srcTable && /^① 관찰 기록/.test(hb0.tab) && /한 줄씩/.test(hb0.msg) && hb0.glow && hb0.cov === 8 && /아직 못 본 면/.test(hb0.hint), hb0);
  upserts.length = 0;
  const obsIn = (n) => '#se-src-list tr[data-num="' + n + '"] .se-obs-input';
  await P.click(obsIn(1)); await P.keyboard.type('청소 시간에 교실 뒤를 스스로 정리함');
  const picksShown = await P.isVisible('#se-src-list tr[data-num="1"] .se-obs-picks');
  await P.click('#se-src-list tr[data-num="1"] .se-obs-add .se-vchip[data-v="성실"]');
  await P.click('#se-src-list tr[data-num="1"] .se-obs-add .se-vchip[data-v="책임"]');
  const stillFocus = await P.evaluate(() => document.activeElement && document.activeElement.matches('tr[data-num="1"] .se-obs-input') && document.activeElement.value.length > 0);
  await P.keyboard.press('Enter'); await wait(200);
  const hb1 = await P.evaluate(() => ({ obs: JSON.parse(localStorage.getItem('se-obs-3-1-1') || '[]'), focus: document.activeElement && document.activeElement.matches('tr[data-num="1"] .se-obs-input'), val: document.activeElement && document.activeElement.value,
    items: document.querySelectorAll('#se-src-list tr[data-num="1"] .se-obs-item').length, on: [...document.querySelectorAll('#se-src-list tr[data-num="1"] .se-obs-cov .se-vtag.on')].map(e => e.textContent).join(), cnt: document.querySelector('#se-src-list tr[data-num="1"] .se-obs-cnt').textContent, today: seToday() }));
  check('관찰 기록: 칸을 누르면 덕목 단추가 펼쳐지고, 눌러도 커서는 칸에 그대로', picksShown && stillFocus);
  check('관찰 기록: Enter → 오늘 날짜·글·덕목(성실·책임)으로 쌓이고, 커서는 그 칸에 그대로(빈 칸) · 덕목 모아 보기에 진하게 · "기록 1개"', hb1.obs.length === 1 && hb1.obs[0].t === '청소 시간에 교실 뒤를 스스로 정리함' && hb1.obs[0].d === hb1.today && hb1.obs[0].v.join() === '성실,책임' &&
    hb1.focus && hb1.val === '' && hb1.items === 1 && hb1.on === '성실,책임' && hb1.cnt === '기록 1개', hb1);
  await P.keyboard.type('모둠 발표 때 친구 역할을 먼저 물어봄');
  await P.click(obsIn(2)); await wait(300);
  const hb2 = await P.evaluate(() => ({ n: JSON.parse(localStorage.getItem('se-obs-3-1-1') || '[]').length, focus: document.activeElement && document.activeElement.matches('tr[data-num="2"] .se-obs-input'), items: document.querySelectorAll('#se-src-list tr[data-num="1"] .se-obs-item').length }));
  if (process.env.SE_SHOTS) { await P.click(obsIn(2)); await P.screenshot({ path: path.join(process.env.SE_SHOTS, 'se-behav-obs.png') }); }
  check('관찰 기록: 적다가 다른 학생 칸을 누르면(칸을 벗어나면) 저장되고, 누른 칸으로 커서가 감(클릭 안 빗나감)', hb2.n === 2 && hb2.focus && hb2.items === 2, hb2);
  await wait(2500);
  check('관찰 기록: 학생 한 명 = 서버 항목 하나(se-obs-3-1-1)만 올라감', (serverVal(T1, 'se-obs-3-1-1') || '').includes('모둠 발표') && upserts.flat().every(k => k === 'se-obs-3-1-1' || k === 'se-yr-3-1' || k === 'se-cfg'), upserts);
  // ✎ 고치기(글·덕목) · ✕ 지우기
  await P.hover('#se-src-list tr[data-num="1"] .se-obs-item:nth-child(2)');
  await P.click('#se-src-list tr[data-num="1"] .se-obs-item:nth-child(2) .se-obs-btns button[title^="고치기"]'); await wait(200);
  await P.fill('#se-src-list .se-obs-edit', '모둠 발표 때 말이 적은 친구에게 먼저 역할을 물어봄');
  await P.click('#se-src-list .se-obs-item.editing .se-vchip[data-v="배려"]');
  await P.press('#se-src-list .se-obs-edit', 'Enter'); await wait(200);
  const hb3 = await P.evaluate(() => JSON.parse(localStorage.getItem('se-obs-3-1-1'))[1]);
  check('✎ 고치기: 글·덕목(배려) 바뀜, Enter로 저장', hb3.t === '모둠 발표 때 말이 적은 친구에게 먼저 역할을 물어봄' && hb3.v.join() === '배려' && !(await P.isVisible('#se-src-list .se-obs-edit')), hb3);
  await P.evaluate(() => { const l = JSON.parse(localStorage.getItem('se-obs-3-1-1')); l.push({ id: 'x1', d: '2026-03-05', t: '지울 기록', v: [] }); localStorage.setItem('se-obs-3-1-1', JSON.stringify(l)); seRenderAll(); });
  check('날짜 순으로 보임(3/5 기록이 맨 위)', (await P.evaluate(() => document.querySelector('#se-src-list tr[data-num="1"] .se-obs-item .se-obs-date').textContent)) === '3/5');
  await P.click('#se-src-list tr[data-num="1"] .se-obs-item[data-id="x1"] .se-obs-btns button[title*="지우기"]'); await wait(200);
  await P.click('#custom-confirm-overlay button:has-text("확인")'); await wait(200);
  check('✕ 지우기(확인) → 그 기록만 빠짐', await P.evaluate(() => JSON.parse(localStorage.getItem('se-obs-3-1-1')).map(o => o.id).indexOf('x1') === -1 && JSON.parse(localStorage.getItem('se-obs-3-1-1')).length === 2));
  // 덕목 바꾸기
  await P.click('#se-virtue-edit'); await wait(200);
  await P.fill('#custom-prompt-input', '성실, 책임, 나눔'); await P.click('#custom-prompt-ok-btn'); await wait(300);
  const vv = await P.evaluate(() => ({ cfg: seCfg().virtues, cov: [...document.querySelectorAll('#se-src-list tr[data-num="1"] .se-obs-cov .se-vtag')].map(e => e.textContent + (e.classList.contains('on') ? '+' : '')).join(), tags: [...document.querySelectorAll('#se-src-list tr[data-num="1"] .se-obs-item .se-vtag')].map(e => e.textContent).join() }));
  check('✎ 덕목 바꾸기: 성실·책임·나눔으로 — 덕목 모아 보기도 바뀌고, 기록의 예전 덕목 표시(배려)는 그대로', vv.cfg.join() === '성실,책임,나눔' && vv.cov === '성실+,책임+,나눔' && /배려/.test(vv.tags), vv);
  await P.click('#se-virtue-edit'); await wait(200);
  await P.fill('#custom-prompt-input', ''); await P.click('#custom-prompt-ok-btn'); await wait(300);
  check('덕목 칸을 비우면 처음 목록(8개)으로', await P.evaluate(() => seVirtues().length === 8 && document.querySelectorAll('#se-src-list tr[data-num="1"] .se-obs-cov .se-vtag').length === 8));
  const hb4 = await P.evaluate(() => ({ tab: document.querySelector('#se-tabs [data-tab="src"]').textContent, msg: document.querySelector('#se-next .pa-next-msg').textContent, next: [...document.querySelectorAll('#se-tabs .pa-step-next')].map(b => b.dataset.tab).join() }));
  check('다음 할 일(기록이 생긴 뒤): ② 편집에서 1번 행발 쓰기 + ① 탭 "1/5명"', /1\/5명/.test(hb4.tab) && /1번/.test(hb4.msg) && /관찰 기록 2개를 보면서/.test(hb4.msg) && /관찰 기록 없는 학생 4명/.test(hb4.msg) && hb4.next === 'edit', hb4);
  // ② 편집: 받은 내용 대신 관찰 기록 + 거기서 더 적기 + 편집 칸·최종
  await P.click('#se-next .top-btn'); await wait(300);
  const he1 = await P.evaluate(() => ({ tab: seTab(), sel: seSelNum, obs: !!document.getElementById('se-box-obs'), src: !!document.getElementById('se-box-src'), items: document.querySelectorAll('#se-box-obs .se-obs-item').length, kind: document.getElementById('se-draft').dataset.kind,
    head: document.querySelector('#se-box-obs .se-obs-cnt').textContent, glow: !!document.querySelector('#se-draft.pa-glow'), dots: document.querySelectorAll('#se-students .se-stu[data-num="1"] .se-dot').length, cur: document.querySelector('#se-students .se-stu[data-num="1"] .se-dot.cur').dataset.kind,
    ph: document.getElementById('se-draft').placeholder, limit: document.getElementById('se-count').textContent }));
  check('② 편집(행발): 받은 내용 대신 "관찰 기록 — 보면서 쓰기"(기록 2개), 편집 칸 반짝임, 학생 목록 점 3개(행발 테두리), 한도 900바이트', he1.tab === 'edit' && he1.sel === 1 && he1.obs && !he1.src && he1.items === 2 && he1.kind === 'b' && he1.head === '기록 2개' && he1.glow && he1.dots === 3 && he1.cur === 'b' && /관찰 기록을 보면서/.test(he1.ph) && /900바이트\(300자\)/.test(he1.limit), he1);
  check('② 편집의 관찰 기록은 보기만(새 기록 칸·✎·✕ 없음 — 적기·고치기는 ①에서)', await P.evaluate(() => !document.querySelector('#se-box-obs .se-obs-input') && !document.querySelector('#se-box-obs .se-obs-btns') && document.querySelectorAll('#se-box-obs .se-obs-item').length === 2));
  await P.evaluate(() => { window.__clip = null; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => { window.__clip = t; } } }); });
  const tdl = await P.evaluate(() => { const d = new Date(); return (d.getMonth() + 1) + '/' + d.getDate(); });
  await P.click('#se-obs-copy'); await wait(200);
  const hcp = await P.evaluate(() => ({ clip: window.__clip, btn: document.getElementById('se-obs-copy').textContent }));
  check('📋 관찰 기록 복사: 한 줄에 하나씩 "날짜 글 (덕목, 덕목)"', hcp.clip === tdl + ' 청소 시간에 교실 뒤를 스스로 정리함 (성실, 책임)\n' + tdl + ' 모둠 발표 때 말이 적은 친구에게 먼저 역할을 물어봄 (배려)' && /2개 복사했어요/.test(hcp.btn), hcp);
  // ①에서 더 적으면 ②에 보임
  await P.evaluate(() => { const l = JSON.parse(localStorage.getItem('se-obs-3-1-1')); l.push({ id: 'x2', d: seToday(), t: '쓰다가 떠오른 기록', v: [] }); localStorage.setItem('se-obs-3-1-1', JSON.stringify(l)); seRenderAll(); });
  check('기록이 늘면 ② 머리 "기록 3개"', await P.evaluate(() => document.querySelector('#se-box-obs .se-obs-cnt').textContent === '기록 3개' && document.querySelectorAll('#se-box-obs .se-obs-item').length === 3));
  await P.click('#se-students .se-stu[data-num="2"]'); await wait(200);
  check('기록 없는 학생: ②에 "① 관찰 기록 탭에서 적어 두면" 안내, 복사 단추 꺼짐', await P.evaluate(() => /① 관찰 기록/.test(document.getElementById('se-box-obs').textContent) && document.getElementById('se-obs-copy').disabled));
  await P.click('#se-students .se-stu[data-num="1"]'); await wait(200);
  if (process.env.SE_SHOTS) await P.screenshot({ path: path.join(process.env.SE_SHOTS, 'se-behav-edit.png') });
  await P.fill('#se-draft', '맡은 일을 끝까지 해내는 성실한 학생임.'); await P.evaluate(() => document.getElementById('se-draft').blur()); await wait(100);
  await P.click('#se-put-btn'); await wait(300);
  check('📊 최종에 넣기 → se-fin-3-1-1-b, se-drf 없음', await P.evaluate(() => localStorage.getItem('se-fin-3-1-1-b') === '맡은 일을 끝까지 해내는 성실한 학생임.' && localStorage.getItem('se-drf-3-1-1-b') === null && /ok/.test(document.querySelector('#se-students .se-stu[data-num="1"] .se-dot[data-kind="b"]').className)));
  const he2 = await P.evaluate(() => ({ msg: document.querySelector('#se-next .pa-next-msg').textContent, btn: (document.querySelector('#se-next .top-btn') || {}).textContent }));
  check('다음 할 일: 다음 학생(2번) 행발 — 관찰 기록 없으면 그렇다고', /2번/.test(he2.msg) && /관찰 기록이 없어요/.test(he2.msg) && he2.btn === '2번으로 →', he2);
  await P.evaluate(() => { [2, 3, 4, 5].forEach(n => seSet(seFinKey(n, 'b'), n + '번 행발')); seRenderAll(); });
  const he3 = await P.evaluate(() => ({ done: !!document.querySelector('#se-next .pa-next.done'), msg: document.querySelector('#se-next .pa-next-msg').textContent, ok: [...document.querySelectorAll('#se-tabs .pa-st-ok')].map(e => e.parentNode.dataset.tab).join() }));
  check('행발 모두 최종 → "완료"(행발 5명), ②③ ✓(① 관찰 기록은 모든 학생에게 있어야 ✓)', he3.done && /행발<\/?b?>? ?최종을 모두 넣었어요\(5명\)|행발 최종을 모두 넣었어요\(5명\)/.test(he3.msg) && he3.ok === 'edit,final', he3);
  await P.click('#se-tabs [data-tab="final"]'); await P.click('#se-kind [data-kind="all"]'); await wait(300);
  check('③ 최종 전체에 행발 열(1번 글·바이트 / 900)', await P.evaluate(() => { const td = document.querySelector('#se-final-list tbody tr[data-num="1"] td.se-txt[data-kind="b"]'); return !!td && td.textContent === '맡은 일을 끝까지 해내는 성실한 학생임.' && / \/ 900/.test(td.nextElementSibling.textContent); }));
  // 엑셀 왕복: 행발 관찰 시트(기록 한 줄씩, 기록 없는 학생도 한 줄) → 1번 기록을 지우고 가져오면 그대로 되살아남 · 최종 행발 칸도
  if (XLSXLIB && EXCELJS_PATH) {
    const X = require(XLSXLIB);
    await P.evaluate(() => seSetSt(1, { career: '데이터 과학자' }));
    const got = await P.evaluate(() => new Promise((res) => {
      const orig = window.fmSaveNow;
      window.fmSaveNow = async (blob, name) => { window.fmSaveNow = orig; const b = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode.apply(null, b.subarray(i, i + 8192)); res({ name, b64: btoa(s) }); };
      seExportExcel();
    }));
    const buf = Buffer.from(got.b64, 'base64');
    const xb = X.read(buf, { type: 'buffer' });
    const ob = X.utils.sheet_to_json(xb.Sheets['행발 관찰'], { header: 1, defval: '' });
    const ff = X.utils.sheet_to_json(xb.Sheets['최종'], { header: 1, defval: '' });
    const before1 = await P.evaluate(() => localStorage.getItem('se-obs-3-1-1'));
    check('엑셀 행발 관찰 시트: 머리(번호·이름·날짜·덕목·관찰 기록) + 1번 기록 3줄 + 2~5번 빈 줄 하나씩, 최종 시트 행발·바이트', ob[0].join() === '번호,이름,날짜,덕목,관찰 기록' && ob.length === 1 + 3 + 4 &&
      ob[1][0] === 1 && /^\d{4}-\d{2}-\d{2}$/.test(ob[1][2]) && ob.slice(1).some(r => r[3] === '배려' && /말이 적은 친구/.test(r[4])) && ob.slice(1).some(r => r[3] === '성실, 책임') && ob[4][0] === 2 && ob[4][4] === '' &&
      ff[1][7] === '맡은 일을 끝까지 해내는 성실한 학생임.' && ff[1][8] === sgbBytesOf('맡은 일을 끝까지 해내는 성실한 학생임.') &&
      ff[1][4] === '데이터 과학자' && ff[1][6] === sgbBytesOf(ff[1][5]) + sgbBytesOf('데이터 과학자'), { ob, f: ff[1] });   // 진로 바이트 = 진로 + 희망 분야
    const rt = path.join(require('os').tmpdir(), 'se-obs-roundtrip.xlsx');
    fs.writeFileSync(rt, buf);
    await P.evaluate(() => { localStorage.removeItem('se-obs-3-1-1'); localStorage.removeItem('se-fin-3-1-1-b'); seSetSt(1, { career: '' }); seRenderAll(); });
    await P.setInputFiles('#se-import-input', rt); await wait(800);
    try { fs.unlinkSync(rt); } catch (e) {}
    const imMsg = await P.evaluate(() => document.getElementById('custom-alert-msg').innerText);
    await P.click('#custom-alert-overlay button'); await wait(200);
    const after1 = await P.evaluate(() => ({ obs: JSON.parse(localStorage.getItem('se-obs-3-1-1') || '[]'), fin: localStorage.getItem('se-fin-3-1-1-b'), career: seSt(1).career }));
    const strip = (l) => JSON.stringify(JSON.parse(l || '[]').map(o => [o.d, o.t, o.v]));
    check('엑셀 가져오기: 지운 1번 관찰 기록 3개(날짜·덕목 그대로)와 행발 최종이 되살아남, 안내에 "행발 관찰 기록 3개"', strip(JSON.stringify(after1.obs)) === strip(before1) && after1.fin === '맡은 일을 끝까지 해내는 성실한 학생임.' && /행발 관찰 기록 3개/.test(imMsg) && after1.career === '데이터 과학자' && /진로 희망 분야 1명/.test(imMsg), { imMsg, after1 });
    await P.setInputFiles('#se-import-input', (() => { fs.writeFileSync(rt, buf); return rt; })()); await wait(800);
    try { fs.unlinkSync(rt); } catch (e) {}
    const imMsg2 = await P.evaluate(() => document.getElementById('custom-alert-msg').innerText);
    await P.click('#custom-alert-overlay button'); await wait(200);
    check('같은 파일을 또 가져오면 관찰 기록이 겹쳐 들어가지 않음(0개)', /행발 관찰 기록 0개/.test(imMsg2) && (await P.evaluate(() => JSON.parse(localStorage.getItem('se-obs-3-1-1')).length)) === 3, imMsg2);
    check('날짜 읽기: 엑셀 날짜 칸·2026.4.12·4/12(학년도 안)', await P.evaluate(() => { const y = seSchoolYear(); return seObsParseDate(46124) === '2026-04-12' && seObsParseDate('2026.4.12') === '2026-04-12' && seObsParseDate('4/12') === y + '-04-12' && seObsParseDate('1/5') === (y + 1) + '-01-05' && seObsParseDate('아무거나') === ''; }));
  }
  if (process.env.SE_SHOTS) await P.screenshot({ path: path.join(process.env.SE_SHOTS, 'se-behav-final.png') });
  await P.evaluate(() => { seSetCfg({ kind: 'a', finAll: true }); seSetTab('src'); });

  const before = await P.evaluate(() => Object.keys(localStorage).filter(k => k.indexOf('se-') === 0 && k !== 'se-cfg').length);
  await P.click('#se-page-header button:has-text("초기화")'); await wait(200);
  await P.click('#custom-confirm-overlay button:has-text("확인")'); await wait(200);
  await P.click('#custom-confirm-overlay button:has-text("취소")'); await wait(200);
  check('초기화: 두 번째 확인에서 취소하면 그대로', before > 5 && await P.evaluate((b) => Object.keys(localStorage).filter(k => k.indexOf('se-') === 0 && k !== 'se-cfg').length === b, before));
  await P.click('#se-page-header button:has-text("초기화")'); await wait(200);
  await P.click('#custom-confirm-overlay button:has-text("확인")'); await wait(200);
  await P.click('#custom-confirm-overlay button:has-text("확인")'); await wait(2500);
  const afterReset = await P.evaluate(() => ({ n: Object.keys(localStorage).filter(k => k.indexOf('se-') === 0 && k !== 'se-cfg' && k.indexOf('-3-2-') === -1 && !/-3-2$/.test(k)), rows: seRoster.length, other: localStorage.getItem('se-src-3-2-1-' + 'ad0') }));
  check('초기화: 이 반 자료 모두 지움(학년도 표시 포함, 서버에도 전달, 다른 반 3-2 것은 그대로), 학생 목록은 그대로', afterReset.n.length === 0 && afterReset.other === '첫 문장' && afterReset.rows === 5 && serverVal(T1, 'se-fin-3-1-1-a') === null, afterReset);

  // ---- 📅 학년도 정리: 키에 학년도가 없어 내년에 같은 반을 맡으면 지난해 글이 섞여 보임 → 반마다 처음 쓴 학년도를 적고, 새 학년도엔 엑셀로 받은 뒤 지우게 ----
  const yr = await P.evaluate(() => ({ now: seSchoolYear(), y32: localStorage.getItem('se-yr-3-2'), banner: document.getElementById('se-oldyear').textContent }));
  check('자료를 쓰면 그 반에 올해 학년도가 적힘(se-yr-3-2, 서버에도), 지난 학년도 안내 없음', yr.y32 === String(yr.now) && !yr.banner && serverVal(T1, 'se-yr-3-2') === String(yr.now), yr);
  // 학년도가 바뀐 것처럼: 3-2 자료를 지난 학년도로, 그해 명단 사본은 다른 이름
  await P.evaluate((y) => { localStorage.setItem('se-yr-3-2', String(y - 1)); localStorage.setItem('se-roster-3-2', JSON.stringify([{ num: 1, name: '작년학생' }, { num: 2, name: '작년둘' }])); seRenderAll(); }, yr.now);
  await wait(200);
  const ob = await P.evaluate(() => ({ text: document.getElementById('se-oldyear').innerText, cls: [...document.querySelectorAll('#se-oldyear .se-oldcls')].map(e => e.dataset.ck).join() }));
  check('새 학년도: 맨 위에 "지난 학년도 … 3학년 2반 📊 엑셀로 받기 · 🗑 지우기" 안내', ob.cls === '3-2' && new RegExp((yr.now - 1) + '학년도 3학년 2반').test(ob.text) && /엑셀로 받기/.test(ob.text), ob);
  await P.evaluate(() => { window.__seExp = null; window.seExportExcel = async function() { window.__seExp = { ck: seClassKey(), names: seRoster.map(s => s.name).join() }; }; });
  await P.click('#se-oldyear .se-oldcls[data-ck="3-2"] button:has-text("엑셀로 받기")'); await wait(500);
  const exp = await P.evaluate(() => window.__seExp);
  check('📊 엑셀로 받기 → 그 반으로 바꿔서 내려받음, 학생은 그해 명단 사본(지금 명렬표의 새 학생 아님)', exp && exp.ck === '3-2' && exp.names === '작년학생,작년둘' && (await P.inputValue('#se-class')) === '2', exp);
  await P.click('#se-oldyear .se-oldcls[data-ck="3-2"] button:has-text("지우기")'); await wait(200);
  await P.click('#custom-confirm-overlay button:has-text("확인")'); await wait(200);
  await P.click('#custom-confirm-overlay button:has-text("확인")'); await wait(2500);
  const od = await P.evaluate(() => ({ left: Object.keys(localStorage).filter(k => /^se-.*-3-2(-|$)/.test(k)), banner: document.getElementById('se-oldyear').textContent, rows: seRoster.length }));
  check('🗑 지우기(두 번 확인) → 그 반 자료·학년도·명단 사본 모두 지움(서버에도), 안내 사라짐, 지금 명렬표 학생으로', od.left.length === 0 && !od.banner && od.rows === 28 && serverVal(T1, 'se-src-3-2-1-ad0') === null && serverVal(T1, 'se-yr-3-2') === null, od);

  const errs = [...pc.errors, ...pc2.errors, ...t2.errors];
  check('페이지 오류 없음', errs.length === 0, errs);
  console.log(failures ? ('실패 ' + failures + '건') : '모든 검사 통과');
  await browser.close();
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

function sgbBytesOf(t) { let b = 0; for (const ch of t) { const c = ch.codePointAt(0); b += c <= 0x7F ? 1 : c <= 0x7FF ? 2 : c <= 0xFFFF ? 3 : 4; } return b; }
