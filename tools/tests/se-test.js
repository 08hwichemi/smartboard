// 레일 "생기부" → 🗂 자율·진로 편집기: 생기부 패널 둘째 탭에서 전체 화면, 학년별 바이트 한도(입시 연도), 자료 입력(영역 추가·이름·여러 칸 붙여 넣기),
// 편집(체크해 합치기·바이트·기재 불가 점검·복사·메모), 최종 표, 엑셀 가져오기·내려받기, 칸을 벗어날 때만 저장·업로드, 내 계정에만, 초기화, 열고 닫기.
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
  const panelShown = () => P.evaluate(() => document.getElementById('sgb-overlay').style.display === 'flex');
  const areas = (k) => P.evaluate((k) => seAreas(k), k);

  // ---- 한도 표 ----
  const lim = await P.evaluate(() => ({
    y3: sgbAdmissionYear(3, 2026), y1: sgbAdmissionYear(1, 2026), old: sgbAdmissionYear(3, 2025),
    g3: sgbLimitsFor(3, 2026), g1: sgbLimitsFor(1, 2026), g3old: sgbLimitsFor(3, 2025), far: sgbLimitsFor(1, 2040)
  }));
  check('입시 연도: 2026학년도 고3 = 2027, 고1 = 2029, 2025학년도 고3 = 2026', lim.y3 === 2027 && lim.y1 === 2029 && lim.old === 2026, lim);
  check('한도: 2027·2028~ 입시 자율 500·진로 500·봉사 50·행특 300, 2026 입시 진로 700·봉사 250·행특 500', lim.g3.p === 500 && lim.g3.behav === 300 && lim.g3.vol === 50 && lim.g1.p === 500 && lim.g3old.p === 700 && lim.g3old.vol === 250 && lim.g3old.behav === 500 && lim.far.p === 500, lim);

  // ---- 생기부 패널 탭 → 편집기 ----
  await P.click('#rail-sgb-btn'); await wait(300);
  const tabs = await P.evaluate(() => [...document.querySelectorAll('#sgb-tabs .top-btn')].map(b => b.dataset.tab));
  check('생기부 패널 탭 순서: 문장 점검 · 자율·진로 편집기 · 길라잡이 찾기', tabs.join(',') === 'check,edit,find', tabs);
  const note = await P.evaluate(() => document.getElementById('sgb-note').textContent);
  check('문장 점검 안내에 담임 학년 기준(고3 = 2027 입시)', /고3 = 2027 입시/.test(note), note);
  await P.click('#sgb-tabs [data-tab="edit"]'); await wait(600);
  check('편집기 탭 → 전체 화면 열리고 패널 닫힘, 레일 생기부 버튼 켜짐', await shown() && !(await panelShown()) && await P.evaluate(() => document.getElementById('rail-sgb-btn').classList.contains('active') && document.getElementById('main-dashboard').style.display === 'none'));
  const head = await P.evaluate(() => ({ g: document.getElementById('se-grade').value, c: document.getElementById('se-class').value, note: document.getElementById('se-limit-note').textContent, tab: seTab() }));
  check('담임 반(3-1)으로 시작, 한도 안내 자율 1,500·진로 1,500', head.g === '3' && head.c === '1' && /자율 500자\(1500바이트\) · 진로 500자\(1500바이트\)/.test(head.note) && head.tab === 'src', head);
  const rows = await P.evaluate(() => [...document.querySelectorAll('#se-src-list tbody tr')].map(r => r.dataset.num));
  check('자료 입력 표에 명렬표 학생 5명', rows.join(',') === '1,2,3,4,5', rows);
  check('기본 영역: 자율 "1인 1역할" 1개 (아직 저장 안 됨)', (await areas('a')).map(a => a.name).join() === '1인 1역할' && (await ls(pc, 'se-areas-3-1')) === null);

  // ---- 영역 추가·이름 바꾸기 ----
  await P.click('#se-area-chips button:has-text("영역 추가")'); await wait(200);
  await P.fill('#custom-prompt-input', '학급 자치');
  await P.click('#custom-prompt-overlay button:has-text("확인")'); await wait(300);
  check('영역 추가 → 표 머리에 2개, 계정에 저장', (await areas('a')).map(a => a.name).join() === '1인 1역할,학급 자치' && await P.evaluate(() => document.querySelectorAll('#se-src-list thead th').length === 4) && !!(await ls(pc, 'se-areas-3-1')));
  await P.click('#se-area-chips .se-chip[data-area="' + (await areas('a'))[1].id + '"] .se-chip-name'); await wait(200);
  await P.fill('#custom-prompt-input', '자치 활동');
  await P.click('#custom-prompt-overlay button:has-text("확인")'); await wait(300);
  check('영역 이름 바꾸기', (await areas('a')).map(a => a.name).join() === '1인 1역할,자치 활동');

  // ---- 칸 입력: 치는 동안은 안 올라가고, 벗어나면 저장·업로드 ----
  const a1 = (await areas('a'))[0].id;
  const cellSel = '#se-src-list textarea[data-num="1"][data-area="' + a1 + '"]';
  await wait(2500); upserts.length = 0;   // 영역 저장분이 올라가길 기다린 뒤 센다
  await P.click(cellSel);
  await P.keyboard.type('교실 문단속을 맡아 성실히 수행함.'); await wait(2500);
  const typing = await P.evaluate(() => ({ st: document.getElementById('se-save-state').textContent, saved: localStorage.getItem('se-src-3-1-1-' + seAreas('a')[0].id) }));
  check('입력 중: 화면에 "입력 중" 표시, 아직 저장·업로드 안 됨', /입력 중/.test(typing.st) && typing.saved === null && upserts.length === 0, { typing, upserts });
  const bytesShown = await P.evaluate((s) => document.querySelector(s).nextElementSibling.textContent, cellSel);
  check('치는 동안 칸 아래 바이트가 바로 바뀜(한글 3·공백 1)', bytesShown === sgbBytesOf('교실 문단속을 맡아 성실히 수행함.') + '바이트', bytesShown);
  await P.keyboard.press('Tab'); await wait(2500);
  const saved = await P.evaluate(() => localStorage.getItem('se-src-3-1-1-' + seAreas('a')[0].id));
  check('칸을 벗어나면 저장(학생·영역 단위 항목) → 서버에 그 항목만 올라감', saved === '교실 문단속을 맡아 성실히 수행함.' && serverVal(T1, 'se-src-3-1-1-' + a1) === saved && upserts.length === 1 && upserts[0].length === 1 && upserts[0][0] === 'se-src-3-1-1-' + a1, { saved, upserts });
  check('저장 표시', /저장됨/.test(await P.evaluate(() => document.getElementById('se-save-state').textContent)));

  // ---- 여러 칸 붙여 넣기(엑셀 복사: 탭·줄바꿈, 줄바꿈 든 칸은 따옴표) ----
  const tsv = '2번 문장\t"2번 자치\n둘째 줄"\n3번 문장\t3번 자치\n';
  await P.evaluate(([sel, text]) => {
    const ta = document.querySelector(sel);
    const dt = new DataTransfer(); dt.setData('text', text);
    ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, ['#se-src-list textarea[data-num="2"][data-area="' + a1 + '"]', tsv]);
  await wait(300);
  const a2 = (await areas('a'))[1].id;
  const pasted = await P.evaluate(([a1, a2]) => [1, 2, 3].map(n => [localStorage.getItem('se-src-3-1-' + n + '-' + a1), localStorage.getItem('se-src-3-1-' + n + '-' + a2)]), [a1, a2]);
  check('붙여 넣기: 2번부터 아래·오른쪽으로 채움, 따옴표 속 줄바꿈 유지, 1번은 그대로', pasted[0][0] === '교실 문단속을 맡아 성실히 수행함.' && pasted[1][0] === '2번 문장' && pasted[1][1] === '2번 자치\n둘째 줄' && pasted[2][0] === '3번 문장' && pasted[2][1] === '3번 자치', pasted);
  check('붙여 넣기 안내', /4칸을 채웠어요/.test(await P.evaluate(() => document.getElementById('se-src-msg').textContent)));
  const parsed = await P.evaluate(() => seParseTsv('a\tb\r\nc\t"d""e"\r\n\r\n'));
  check('TSV 해석: CRLF, 따옴표 두 번 → 하나, 끝 빈 줄 제거', JSON.stringify(parsed) === JSON.stringify([['a', 'b'], ['c', 'd"e']]), parsed);

  // ---- 진로 영역 ----
  await P.click('#se-kind-src [data-kind="p"]'); await wait(200);
  check('진로로 바꾸면 기본 영역 "진로 독서"', (await areas('p')).map(a => a.name).join() === '진로 독서' && await P.evaluate(() => seKind() === 'p'));
  const p1 = (await areas('p'))[0].id;
  await setLs(pc, 'se-src-3-1-1-' + p1, '진로독서 프로젝트로 책을 읽고 토론함.');

  // ---- 편집 탭 ----
  await P.click('#se-tabs [data-tab="edit"]'); await wait(300);
  await P.click('#se-kind-edit [data-kind="a"]'); await wait(200);
  const ed = await P.evaluate(() => ({
    n: document.querySelectorAll('#se-students .se-stu').length, sel: document.querySelector('#se-students .se-stu.sel').dataset.num,
    head: document.querySelector('#se-edit-head div').textContent, cards: [...document.querySelectorAll('.se-card')].map(c => [c.dataset.area, c.classList.contains('none'), c.querySelector('input').disabled]),
    prevDisabled: document.querySelector('#se-edit-head button').disabled
  }));
  check('편집: 학생 5명 목록, 1번 선택, 카드 2개(빈 영역은 체크 못 함), 이전 버튼 비활성', ed.n === 5 && ed.sel === '1' && /1번 가나다/.test(ed.head) && ed.cards.length === 2 && ed.cards[0][1] === false && ed.cards[1][1] === true && ed.cards[1][2] === true && ed.prevDisabled === true, ed);
  check('합치기 버튼은 체크 전엔 비활성', await P.evaluate(() => [...document.querySelectorAll('#se-editor button')].find(b => /합쳐서/.test(b.textContent)).disabled));
  await P.click('.se-card[data-area="' + a1 + '"] input'); await wait(200);
  const st1 = await P.evaluate(() => JSON.parse(localStorage.getItem('se-st-3-1-1')));
  check('체크 → 학생 상태 항목(se-st-)에 영역 id 저장, 카드 강조', st1.sel.a.length === 1 && st1.sel.a[0] === a1 && await P.evaluate((a) => document.querySelector('.se-card[data-area="' + a + '"]').classList.contains('on'), a1), st1);
  await P.evaluate(() => [...document.querySelectorAll('#se-editor button')].find(b => /합쳐서/.test(b.textContent)).click()); await wait(300);
  const fin1 = await P.evaluate(() => ({ v: document.getElementById('se-fin').value, ls: localStorage.getItem('se-fin-3-1-1-a'), cnt: document.getElementById('se-count').textContent, dot: document.querySelector('#se-students .se-stu[data-num="1"] .se-dot').className }));
  check('합치기 → 편집 칸·저장(se-fin-…-a), 바이트 표시, 학생 목록 점 초록', fin1.v === '교실 문단속을 맡아 성실히 수행함.' && fin1.ls === fin1.v && /\/ 1,500바이트\(500자\)/.test(fin1.cnt) && /ok/.test(fin1.dot), fin1);

  // 편집 칸: 치는 동안 점검(기재 불가), 벗어나면 저장
  await wait(2500); upserts.length = 0;
  await P.click('#se-fin');
  await P.keyboard.press('End');
  await P.keyboard.type(' 토익 시험을 봄.'); await wait(2000);
  const live = await P.evaluate(() => ({ res: document.getElementById('se-result').textContent, ls: localStorage.getItem('se-fin-3-1-1-a'), st: document.getElementById('se-save-state').textContent }));
  check('편집 칸 치는 동안: 기재 불가(공인어학시험) 바로 표시, 아직 저장·업로드 안 됨', /기재 불가 · 공인어학시험/.test(live.res) && live.ls === '교실 문단속을 맡아 성실히 수행함.' && upserts.length === 0, { live, upserts });
  await P.click('#se-memo'); await wait(2500);
  const after = await P.evaluate(() => localStorage.getItem('se-fin-3-1-1-a'));
  check('벗어나면 완성본 저장·업로드(그 항목만)', after === '교실 문단속을 맡아 성실히 수행함. 토익 시험을 봄.' && upserts.length === 1 && upserts[0].join() === 'se-fin-3-1-1-a', { after, upserts });
  // 한도 초과 → 빨강
  await P.click('#se-fin');
  await P.evaluate(() => { const ta = document.getElementById('se-fin'); ta.value = '가'.repeat(501); ta.dispatchEvent(new Event('input')); });
  const over = await P.evaluate(() => ({ cls: document.getElementById('se-count').className, bar: document.getElementById('se-bar').className, txt: document.getElementById('se-count').textContent }));
  check('1,503바이트 → 넘음 표시(빨강, 3바이트 넘음)', /over/.test(over.cls) && /over/.test(over.bar) && /3바이트 넘음/.test(over.txt), over);
  await P.click('#se-memo'); await wait(300);
  check('초과 상태는 학생 목록 점이 빨강', /over/.test(await P.evaluate(() => document.querySelector('#se-students .se-stu[data-num="1"] .se-dot').className)));
  await P.fill('#se-memo', '진로독서 줄이고, 큐리어톤'); await P.keyboard.press('Tab'); await wait(200);
  check('메모 저장', (await P.evaluate(() => JSON.parse(localStorage.getItem('se-st-3-1-1')).memo)) === '진로독서 줄이고, 큐리어톤');
  // 복사
  await P.click('#se-copy-btn'); await wait(200);
  check('📋 복사 → 완성본 그대로', await P.evaluate(() => window.__clip === document.getElementById('se-fin').value && /복사했어요/.test(document.getElementById('se-copy-btn').textContent)));
  // 다음 학생·진로 전환
  await P.click('#se-edit-head button:has-text("다음")'); await wait(200);
  check('다음 ▶ → 2번', await P.evaluate(() => seSelNum === 2 && document.querySelector('#se-students .se-stu.sel').dataset.num === '2' && document.getElementById('se-fin').value === ''));
  await P.click('#se-students .se-stu[data-num="1"]'); await wait(200);
  await P.click('#se-kind-edit [data-kind="p"]'); await wait(200);
  const pk = await P.evaluate(() => ({ cards: document.querySelectorAll('.se-card').length, fin: document.getElementById('se-fin').value, kind: document.getElementById('se-fin').dataset.kind }));
  check('진로로 바꾸면 진로 카드·빈 완성본', pk.cards === 1 && pk.fin === '' && pk.kind === 'p', pk);
  await P.click('.se-card[data-area="' + p1 + '"] input'); await wait(150);
  await P.evaluate(() => [...document.querySelectorAll('#se-editor button')].find(b => /합쳐서/.test(b.textContent)).click()); await wait(300);
  check('진로 합치기 → se-fin-…-p', (await ls(pc, 'se-fin-3-1-1-p')) === '진로독서 프로젝트로 책을 읽고 토론함.');
  // 지우기
  await P.click('#se-editor button:has-text("지우기")'); await wait(200);
  check('지우기 → 항목 삭제', (await ls(pc, 'se-fin-3-1-1-p')) === null && await P.evaluate(() => document.getElementById('se-fin').value === ''));
  await P.evaluate(() => [...document.querySelectorAll('#se-editor button')].find(b => /합쳐서/.test(b.textContent)).click()); await wait(300);

  // ---- 최종 탭 ----
  await P.click('#se-tabs [data-tab="final"]'); await wait(300);
  const fin = await P.evaluate(() => ({
    rows: document.querySelectorAll('#se-final-list tbody tr').length, r1: [...document.querySelectorAll('#se-final-list tbody tr[data-num="1"] td')].map(t => t.textContent.trim()),
    note: document.getElementById('se-final-note').textContent, dots: [...document.querySelectorAll('#se-final-list tbody tr[data-num="1"] .se-dot')].map(d => d.className)
  }));
  check('최종: 5명, 1번 자율(초과)·진로 완성본과 바이트, 요약', fin.rows === 5 && fin.r1[2] === '가'.repeat(501) && fin.r1[4] === '진로독서 프로젝트로 책을 읽고 토론함.' && /over/.test(fin.dots[0]) && /ok/.test(fin.dots[1]) && /자율 완성 1명\(초과 1\) · 진로 완성 1명/.test(fin.note), fin);
  await P.click('#se-final-list tbody tr[data-num="1"] td:nth-child(6) button'); await wait(200);
  check('최종 표 📋 → 진로 완성본 복사', await P.evaluate(() => window.__clip === '진로독서 프로젝트로 책을 읽고 토론함.'));
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
    // 내려받기: 데이터·최종 시트 구조
    const dl = await P.evaluate(() => new Promise((res) => {
      const orig = XLSX.writeFile; XLSX.writeFile = (wb, name) => { XLSX.writeFile = orig; const d = XLSX.utils.sheet_to_json(wb.Sheets['데이터'], { header: 1 }), f = XLSX.utils.sheet_to_json(wb.Sheets['최종'], { header: 1 }); res({ name, d, f, sheets: wb.SheetNames }); };
      seExportExcel();
    }));
    check('엑셀 내려받기: 데이터(1행 자율 D·진로 L, 2행 영역 이름, 번호·이름) + 최종(번호·이름·자율·바이트·진로·바이트)', /^자율진로_3-1_\d{4}-\d{2}-\d{2}\.xlsx$/.test(dl.name) && dl.sheets.join() === '데이터,최종' && dl.d[0][3] === '자율' && dl.d[0][11] === '진로' && dl.d[1][1] === '번호' && dl.d[1][3] === '1인 1역할' && dl.d[1][11] === '진로 독서' && dl.d[1][12] === '큐리어톤' && dl.d[2][1] === 1 && dl.d[2][3] === '교실 문단속을 맡아 성실히 수행함.' && dl.f[0].join() === '번호,이름,자율,바이트,진로,바이트' && dl.f[1][3] === 1503 && dl.f[1][4] === '진로독서 프로젝트로 책을 읽고 토론함.' && dl.f.length === 6, { name: dl.name, d: dl.d.slice(0, 3), f: dl.f.slice(0, 2) });
  } else console.log('  ⚠️ 엑셀 검사 건너뜀(xlsx 라이브러리 없음)');

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

  // ---- 열고 닫기 ----
  await P.click('#rail-sgb-btn'); await wait(300);
  check('편집기 위에서 레일 생기부 → 패널이 위에 열리고 편집기는 그대로', await shown() && await panelShown());
  await P.click('#sgb-overlay button:has-text("닫기")'); await wait(200);
  check('패널 닫아도 편집기 그대로·레일 버튼 켜짐', await shown() && !(await panelShown()) && await P.evaluate(() => document.getElementById('rail-sgb-btn').classList.contains('active')));
  await P.click('#se-page-header button:has-text("← 생기부")'); await wait(300);
  check('← 생기부 → 편집기 닫고 패널 열림', !(await shown()) && await panelShown());
  await P.click('#sgb-tabs [data-tab="edit"]'); await wait(400);
  await P.click('#rail-absence-btn'); await wait(400);
  check('결석계 누르면 편집기 닫힘', !(await shown()) && await P.evaluate(() => document.getElementById('absence-page').style.display === 'flex' && !document.getElementById('rail-sgb-btn').classList.contains('active')));
  await P.click('#rail-sgb-btn'); await wait(200); await P.click('#sgb-tabs [data-tab="edit"]'); await wait(400);
  check('결석계에서 편집기 열면 결석계 닫힘', await shown() && await P.evaluate(() => document.getElementById('absence-page').style.display === 'none'));
  await P.click('#rail-home-btn'); await wait(300);
  check('홈 → 닫힘', !(await shown()) && await P.evaluate(() => document.getElementById('main-dashboard').style.display === 'grid'));

  // ---- 반 바꾸기·초기화 ----
  await P.click('#rail-sgb-btn'); await wait(200); await P.click('#sgb-tabs [data-tab="edit"]'); await wait(400);
  await P.selectOption('#se-class', '2'); await wait(500);
  const cls2 = await P.evaluate(() => ({ n: seRoster.length, areas: seAreas('a').map(a => a.name).join(), fin: localStorage.getItem('se-fin-3-2-1-a') }));
  check('3-2로 바꾸면 그 반 명렬표 28명·기본 영역·빈 자료', cls2.n === 28 && cls2.areas === '1인 1역할' && cls2.fin === null, cls2);
  await P.selectOption('#se-class', '1'); await wait(500);
  const before = await P.evaluate(() => Object.keys(localStorage).filter(k => k.indexOf('se-') === 0 && k !== 'se-cfg').length);
  await P.click('#se-page-header button:has-text("초기화")'); await wait(200);
  await P.click('#custom-confirm-overlay button:has-text("확인")'); await wait(200);
  await P.click('#custom-confirm-overlay button:has-text("취소")'); await wait(200);
  check('초기화: 두 번째 확인에서 취소하면 그대로', before > 5 && await P.evaluate((b) => Object.keys(localStorage).filter(k => k.indexOf('se-') === 0 && k !== 'se-cfg').length === b, before));
  await P.click('#se-page-header button:has-text("초기화")'); await wait(200);
  await P.click('#custom-confirm-overlay button:has-text("확인")'); await wait(200);
  await P.click('#custom-confirm-overlay button:has-text("확인")'); await wait(2500);
  const afterReset = await P.evaluate(() => ({ n: Object.keys(localStorage).filter(k => k.indexOf('se-') === 0 && k !== 'se-cfg').length, rows: seRoster.length }));
  check('초기화: 이 반 자료 모두 지움(서버에도 전달), 학생 목록은 그대로', afterReset.n === 0 && afterReset.rows === 5 && serverVal(T1, 'se-fin-3-1-1-a') === null, afterReset);

  const errs = [...pc.errors, ...pc2.errors, ...t2.errors];
  check('페이지 오류 없음', errs.length === 0, errs);
  console.log(failures ? ('실패 ' + failures + '건') : '모든 검사 통과');
  await browser.close();
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

function sgbBytesOf(t) { let b = 0; for (const ch of t) { const c = ch.codePointAt(0); b += c <= 0x7F ? 1 : c <= 0x7FF ? 2 : c <= 0xFFFF ? 3 : 4; } return b; }
