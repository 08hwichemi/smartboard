// 레일 "양식" → 🎫 수험표 탭(관리자만, 10/6): 모의고사 수험표(앞면)·가채점표(뒷면) — A4 한 장에 4명, 앞면 종이 → 같은 4명의 뒷면 종이 순서(양면 인쇄),
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
  const ctx = opts.context || await browser.newContext(opts.mobile ? { viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true } : { viewport: opts.viewport || { width: 1600, height: 1000 } });
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
function pdfInfo(buf) {
  const s = buf.toString('latin1');
  const pages = (s.match(/\/Type\s*\/Page[^s]/g) || []).length;
  const mb = (s.match(/\/MediaBox\s*\[\s*0 0 ([\d.]+) ([\d.]+)\s*\]/) || []).slice(1).map(Number);
  return { pages, w: Math.round(mb[0]), h: Math.round(mb[1]) };
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }).catch(() => chromium.launch());
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'et-'));
  const pc = await openDevice(browser, 'PC', TA, { viewport: { width: 1600, height: 1000 } });
  const P = pc.page;
  const stus = () => P.evaluate(() => etCfg().students.map(s => ({ no: s.no, name: s.name, birth: s.birth, kor: s.kor, math: s.math, inq1: s.inq1, inq2: s.inq2, photo: s.photo ? s.photo.length : 0 })));
  const sheetKinds = () => P.evaluate(() => [...document.querySelectorAll('#fm-pages .fm-sheet')].map(s => (s.classList.contains('et-front') ? 'F' : 'B') + s.querySelectorAll('.et-card').length));
  const cardText = (sheet, card) => P.evaluate(([a, b]) => document.querySelectorAll('#fm-pages .fm-sheet')[a].querySelectorAll('.et-card')[b].innerText.replace(/\s+/g, ' '), [sheet, card]);
  const shown = (sel) => P.evaluate((s) => { const el = document.querySelector(s); return !!el && getComputedStyle(el).display !== 'none'; }, sel);

  console.log('\n[1] 수험표 탭은 관리자만');
  await P.click('#rail-forms-btn'); await wait(400);
  check('관리자: 양식 탭 줄에 "수험표" 보임', await shown('#fm-tab-et'));
  const t1 = await openDevice(browser, 'T1', T1);
  await t1.page.click('#rail-forms-btn'); await wait(400);
  check('일반 교사: 수험표 탭 숨김', !(await t1.page.evaluate(() => getComputedStyle(document.getElementById('fm-tab-et')).display !== 'none')));
  await t1.page.evaluate(() => { localStorage.setItem('fm-cfg', JSON.stringify({ kind: 'et' })); fmFillForm(); fmRender(); });
  check('일반 교사: 저장된 탭이 et여도 명렬표 수합으로', await t1.page.evaluate(() => fmCfg().kind === 'roster' && document.getElementById('et-grid').style.display === 'none' && document.getElementById('fm-grid').style.display !== 'none'));
  await t1.ctx.close();

  console.log('\n[2] 탭 열기 · 기본값');
  await P.click('#fm-kind-switch [data-kind="et"]'); await wait(300);
  await P.waitForFunction(() => etState.loaded, null, { timeout: 5000 });
  await wait(200);
  check('수험표 탭: 수험표 칸만 보이고 한글 파일·엑셀 단추 숨김, 인쇄 안내는 양면', await P.evaluate(() => document.getElementById('et-grid').style.display !== 'none' && document.getElementById('nt-grid').style.display === 'none' && document.getElementById('fm-grid').style.display === 'none' &&
    document.getElementById('fm-hwpx-btn').style.display === 'none' && document.getElementById('fm-xlsx-btn').style.display === 'none' && /양면/.test(document.getElementById('fm-out-note').textContent) && document.querySelector('#fm-kind-switch .tab-btn.active').dataset.kind === 'et'));
  const cfg0 = await P.evaluate(() => etCfg().cfg);
  check('기본 시험 정보: 7월 전국연합학력평가 · 부광고 · 14115 · 3학년 1반 · 시간표 5줄 · 올해 학년도', cfg0.exam === '7월 전국연합학력평가' && cfg0.school === '부광고등학교' && cfg0.schoolNo === '14115' && cfg0.grade === 3 && cfg0.cls === 1 && cfg0.times.split('\n').length === 5 && /^20\d\d$/.test(cfg0.year), cfg0);
  check('입력칸에 기본값이 채워짐', await P.evaluate(() => document.querySelector('#et-grid [data-k="exam"]').value === '7월 전국연합학력평가' && document.getElementById('et-grade').value === '3' && document.getElementById('et-cls').value === '1' && document.querySelectorAll('#et-times tbody tr').length === 5 && document.querySelector('#et-times input[data-r="0"][data-f="time"]').value === '08:40~10:00' && document.querySelector('#et-time-presets .nt-chip.on').dataset.preset === 'now'));
  check('빈 명단이면 안내 글', await P.evaluate(() => /학생 명단/.test(document.querySelector('#fm-pages .fm-empty').textContent)));
  await P.evaluate(() => { window.customAlert = async (m) => { window.__alert = m; }; });
  await P.click('#fm-print-btn'); await wait(200);
  check('명단 없이 인쇄 → 안내만', await P.evaluate(() => /학생 명단/.test(window.__alert || '')));

  console.log('\n[3] 엑셀 붙여 넣기');
  const paste = ['반\t번호\t학번\t이름\t생년월일\t국어\t수학\t탐구1\t탐구2',
    '1\t1\t30101\t고다윤\t080710\t화법과작문\t미적분\t생활과윤리\t사회문화',
    '1\t2\t30102\t김민건\t080819\t화법과작문\t미적분\t생활과윤리\t사회문화',
    '1\t3\t30103\t김민찬\t080329\t언어와매체\t확률과통계\t생활과윤리\t사회문화',
    '1\t4\t30104\t김서진\t080130\t언어와매체\t미적분\t물리학1\t지구과학1',
    '1\t5\t30105\t김서한\t080407\t화법과작문\t미적분\t사회문화\t지구과학1',
    '30106 김찬혁 2008-04-30 언어와매체 확률과통계 생활과윤리 사회문화'].join('\n');
  await P.click('#et-paste-box summary'); await wait(200);
  await P.fill('#et-paste', paste); await P.click('#et-paste-btn'); await wait(500);
  let st = await stus();
  check('6명 읽음(머리 줄 빼고, 학번·반·날짜 형식도)', st.length === 6 && st[0].no === '1' && st[0].name === '고다윤' && st[0].birth === '080710' && st[0].kor === '화법과작문' && st[0].inq2 === '사회문화' && st[5].no === '6' && st[5].birth === '080430' && st[5].math === '확률과통계', st);
  check('표에 6줄 · 인원 글', await P.evaluate(() => document.querySelectorAll('#et-table tbody tr').length === 6 && document.getElementById('et-count').textContent === '6명 · 사진 0장' && document.getElementById('et-paste').value === ''));
  check('미리보기: 6명 → 앞(4)·뒤(4)·앞(2)·뒤(2) 4쪽, 글 "종이 2장"', JSON.stringify(await sheetKinds()) === '["F4","B4","F2","B2"]' && await P.evaluate(() => /학생 6명 · 종이 2장/.test(document.getElementById('fm-prev-label').textContent)), await sheetKinds());
  let t = await cardText(0, 0);
  check('앞면 첫 카드: 제목·학번 30101·반 1·번호 1·이름·생년월일·국어-화법과작문·수학-미적분·제1선택·시험장소', /학년도 7월 전국연합학력평가/.test(t) && /30101/.test(t) && /고다윤/.test(t) && /080710/.test(t) && /국어-화법과작문/.test(t) && /수학-미적분/.test(t) && /영어/.test(t) && /한국사, 탐구/.test(t) && /생활과윤리/.test(t) && /사회문화/.test(t) && /시험장소 : 부광고등학교/.test(t) && /08:40~10:00/.test(t) && /\(80분\)/.test(t) && /입실/.test(t), t);
  check('앞면 4교시 칸은 한국사·탐구 두 줄에 걸쳐 합쳐짐(rowspan 4)', await P.evaluate(() => [...document.querySelectorAll('#fm-pages .et-front .et-card')[0].querySelectorAll('td.et-tt')].some(td => td.textContent === '4' && td.rowSpan === 4)));
  t = await cardText(1, 0);
  check('뒷면 첫 카드: 가채점표 제목·3학년 1반 1번 고다윤·학교번호·국어(화법과작문)·수학(미적분)·탐구1(생활과윤리)·탐구2(사회문화)·문항 범위', /가채점표/.test(t) && /3학년 1반 1번 고다윤/.test(t) && /학교번호 14115/.test(t) && /부광고등학교/.test(t) && /국어\(화법과작문\)/.test(t) && /수학\(미적분\)/.test(t) && /탐구1\(생활과윤리\)/.test(t) && /탐구2\(사회문화\)/.test(t) && /제2외국어/.test(t) && /41-45/.test(t) && /31-34/.test(t) && /23-27/.test(t) && /공 통/.test(t) && /★/.test(t), t);
  check('뒷면 표는 굵은 선으로 사방이 닫힘(한국사 26-30 아래·★ 안내 아래도), 카드가 표의 바깥선을 자르지 않음', await P.evaluate(() => { const tb = document.querySelector('#fm-pages .et-back .et-tbl'), cs = getComputedStyle(tb), last = tb.rows[tb.rows.length - 1]; const mm = v => parseFloat(v) / 96 * 25.4; return mm(cs.borderBottomWidth) > 0.3 && mm(cs.borderTopWidth) > 0.3 && mm(cs.borderLeftWidth) > 0.3 && mm(cs.borderRightWidth) > 0.3 && [...last.cells].filter(td => /et-rg|et-ans/.test(td.className)).every(td => mm(getComputedStyle(td).borderBottomWidth) > 0.3) && getComputedStyle(tb.closest('.et-card')).overflow === 'visible' && getComputedStyle(document.querySelector('#fm-pages .et-front .et-card')).overflow === 'visible'; }));
  check('뒷면 2번 카드 = 김민건(앞면 2번과 같은 학생)', /김민건/.test(await cardText(1, 1)) && /김민건/.test(await cardText(0, 1)));
  check('가채점표 수학 단답형: 16·17 번호 칸과 2칸짜리 답 칸', await P.evaluate(() => { const tds = [...document.querySelectorAll('#fm-pages .et-back .et-card')[0].querySelectorAll('td.et-rg')]; const i = tds.findIndex(x => x.textContent === '16'); return i >= 0 && tds[i].nextElementSibling.colSpan === 2 && tds[i].nextElementSibling.nextElementSibling.textContent === '17'; }));
  check('가채점표 국어 45번 줄: 답 칸 1개 + 빈칸 4칸', await P.evaluate(() => { const tds = [...document.querySelectorAll('#fm-pages .et-back .et-card')[0].querySelectorAll('td.et-rg')]; const x = tds.find(e => e.textContent === '45'); return !!x && x.nextElementSibling.classList.contains('et-ans') && x.nextElementSibling.nextElementSibling.colSpan === 4; }));
  // 앞뒤 자리 맞춤 — 양면 인쇄의 핵심: 앞면 종이의 카드 n과 뒷면 종이의 카드 n이 같은 위치·크기
  const geo = await P.evaluate(() => [...document.querySelectorAll('#fm-pages .fm-sheet')].slice(0, 2).map(s => { const r = s.getBoundingClientRect(); return [...s.querySelectorAll('.et-card')].map(c => { const q = c.getBoundingClientRect(); return [q.top - r.top, q.height, q.left - r.left, q.width, r.height, r.width]; }); }));
  const near = (a, b) => Math.abs(a - b) < 0.6;
  check('앞면·뒷면 카드 4개의 위치·크기가 같음(양면 인쇄 자리 맞춤)', geo[0].length === 4 && geo[0].every((c, i) => c.every((v, k) => near(v, geo[1][i][k]))), geo);
  check('카드 높이 = 종이의 68.72/297, 너비 = 174.2/210, 위 여백 11mm, 4장 = 274.9mm', geo[0].every(c => near(c[1] / c[4] * 297, 68.72) && near(c[3] / c[5] * 210, 174.2)) && near(geo[0][0][0] / geo[0][0][4] * 297, 11) && near(geo[0][3][0] / geo[0][3][4] * 297, 11 + 68.72 * 3), geo[0].map(c => [c[1] / c[4] * 297, c[3] / c[5] * 210, c[0] / c[4] * 297]));
  check('앞면 오른쪽 안내 칸이 표 오른쪽 끝까지(값 칸 24mm) · 표 = 카드 크기', await P.evaluate(() => { const tb = document.querySelector('#fm-pages .et-front .et-tbl'), sh = tb.closest('.fm-sheet'); const r = sh.getBoundingClientRect(), q = tb.getBoundingClientRect(), cd = tb.closest('.et-card').getBoundingClientRect(); const v = [...tb.querySelectorAll('td.et-info')].filter(x => x.colSpan === 4)[0].getBoundingClientRect(); return Math.abs(v.right - q.right) < 2 && Math.abs(q.width - cd.width) < 1.5 && Math.abs(q.height - cd.height) < 1.5 && Math.abs(v.width / r.width * 210 - 24.05) < 1.5; }));
  check('카드 안 표도 68.72mm·174.2mm(줄 높이 4.48 × 14 + 6)', await P.evaluate(() => { const tb = document.querySelector('#fm-pages .et-front .et-tbl'), sh = tb.closest('.fm-sheet'); const q = tb.getBoundingClientRect(), r = sh.getBoundingClientRect(); return Math.abs(q.height / r.height * 297 - 68.72) < 0.5 && Math.abs(q.width / r.width * 210 - 174.2) < 0.5 && tb.rows.length === 15; }));

  console.log('\n[4] 표에서 고치기 · 명렬표 가져오기 · 줄 더하기');
  await P.fill('#et-table tbody tr:nth-child(1) input.et-kor', '언어와매체'); await wait(400);
  check('표에서 국어를 고치면 저장되고 미리보기도 바뀜', (await stus())[0].kor === '언어와매체' && /국어-언어와매체/.test(await cardText(0, 0)));
  await P.click('#et-roster-btn'); await wait(600);
  st = await stus();
  check('명렬표(3-1, 5명)에서 번호·이름 가져오기: 이름은 명렬표대로, 적어 둔 생년월일·과목·6번은 그대로', st.length === 6 && st[0].name === '가나다' && st[0].birth === '080710' && st[0].kor === '언어와매체' && st[4].name === '파하가' && st[5].name === '김찬혁' && /가져왔어요/.test(await P.evaluate(() => document.getElementById('et-list-msg').textContent)), st);
  await P.click('#et-add-btn'); await wait(300);
  check('＋ 줄 더하기 → 7번 빈 줄, 이름 칸에 커서', await P.evaluate(() => etCfg().students.length === 7 && etCfg().students[6].no === '7' && document.activeElement === document.querySelector('#et-table tbody tr:nth-child(7) input.et-name')));
  check('이름 없는 빈 줄은 종이에 안 나옴(6명 그대로)', JSON.stringify(await sheetKinds()) === '["F4","B4","F2","B2"]');
  await P.click('#et-table tbody tr:nth-child(7) .et-x'); await wait(300);
  check('✕ → 줄 지움', (await stus()).length === 6);
  await P.fill('#et-table tbody tr:nth-child(2) input.et-no', '1'); await wait(200);
  check('번호가 겹치면 빨간 표시', await P.evaluate(() => document.querySelectorAll('#et-table tbody tr.et-dup').length === 2));
  await P.fill('#et-table tbody tr:nth-child(2) input.et-no', '2'); await wait(200);
  check('고치면 표시 사라짐', await P.evaluate(() => document.querySelectorAll('#et-table tbody tr.et-dup').length === 0));

  console.log('\n[5] 사진 — 파일 이름으로 학생 찾기, 줄여서 저장');
  const dataUrl = await P.evaluate(() => { const cv = document.createElement('canvas'); cv.width = 600; cv.height = 800; const x = cv.getContext('2d'); x.fillStyle = '#4a7fc8'; x.fillRect(0, 0, 600, 800); x.fillStyle = '#fff'; x.fillRect(200, 250, 200, 300); return cv.toDataURL('image/jpeg', 0.9); });
  const jpg = Buffer.from(dataUrl.split(',')[1], 'base64');
  const names = ['가나다(1).jpg', '30102.jpg', '사아자.jpg', '99.jpg', 'zzz.jpg'];
  const files = names.map(n => ({ name: n, mimeType: 'image/jpeg', buffer: jpg })); // 한글 파일 이름은 버퍼로 넘겨야 그대로 전달됨
  await P.setInputFiles('#et-photos-input', files); await wait(1500);
  st = await stus();
  check('이름(번호)·학번·이름으로 3장 연결, 2장은 안 됨 안내', st[0].photo > 0 && st[1].photo > 0 && st[2].photo > 0 && !st[3].photo && await P.evaluate(() => /3장을 명단에/.test(document.getElementById('et-photo-msg').textContent) && /연결 안 됨 2장: 99.jpg, zzz.jpg/.test(document.getElementById('et-photo-msg').textContent)), st.map(s => s.photo));
  check('사진은 작게 줄여 저장(600×800 → 360×480 JPEG, 60KB 안)', await P.evaluate(() => new Promise(res => { const im = new Image(); im.onload = () => res(im.naturalWidth === 360 && im.naturalHeight === 480 && etCfg().students[0].photo.indexOf('data:image/jpeg') === 0 && etCfg().students[0].photo.length < 60000); im.onerror = () => res(false); im.src = etCfg().students[0].photo; })));
  check('표에 사진 3장 작게 · 인원 글 · 미리보기 1번 카드에 사진, 4번은 빈 사진 칸', await P.evaluate(() => document.querySelectorAll('#et-table img.et-thumb').length === 3 && document.getElementById('et-count').textContent === '6명 · 사진 3장' && document.getElementById('et-photo-count').textContent === '사진 3 / 6명' &&
    !!document.querySelectorAll('#fm-pages .et-front .et-card')[0].querySelector('.et-photo img') && !!document.querySelectorAll('#fm-pages .et-front .et-card')[3].querySelector('.et-photo.empty')));
  await P.setInputFiles('#et-table tbody tr:nth-child(4) input[type=file]', files[3]); await wait(800);
  check('표의 📷로 한 명 올리기(파일 이름 상관없음)', (await stus())[3].photo > 0 && await P.evaluate(() => !!document.querySelectorAll('#fm-pages .et-front .et-card')[3].querySelector('.et-photo img')));
  check('사진 칸 크기 27×36mm(3:4 증명사진)', await P.evaluate(() => { const ph = document.querySelector('#fm-pages .et-photo'), sh = ph.closest('.fm-sheet'); const q = ph.getBoundingClientRect(), r = sh.getBoundingClientRect(); return Math.abs(q.width / r.width * 210 - 27) < 0.4 && Math.abs(q.height / r.height * 297 - 36) < 0.4; }));

  console.log('\n[6] 저장 위치 — 이 컴퓨터(IndexedDB)에만, 서버·localStorage엔 없음');
  await wait(600); // 저장 모아 쓰기(400ms) 기다림
  check('localStorage에 수험표 자료 없음', await P.evaluate(() => Object.keys(localStorage).every(k => k.indexOf('et-') !== 0 && (localStorage.getItem(k) || '').indexOf('data:image/jpeg') < 0)));
  check('서버(user_data_items)에도 없음 — fm-cfg.kind만 et', ![...items.keys()].some(k => /\|et-/.test(k)) && ![...items.values()].some(r => /data:image/.test(r.value)) && JSON.parse(serverVal(TA, 'fm-cfg') || '{}').kind === 'et');
  check('IndexedDB smartboard-local에 저장됨', await P.evaluate(() => new Promise(res => { const r = indexedDB.open('smartboard-local', 1); r.onsuccess = () => { const q = r.result.transaction('kv').objectStore('kv').get('et-data'); q.onsuccess = () => res(!!q.result && q.result.students.length === 6 && q.result.students.filter(s => s.photo).length === 4 && q.result.cfg.exam === '7월 전국연합학력평가'); }; r.onerror = () => res(false); })));
  await P.reload(); await P.waitForFunction(() => window.currentTeacher && typeof syncAppStarted !== 'undefined' && syncAppStarted === true, null, { timeout: 15000 });
  await P.click('#rail-forms-btn'); await wait(400);
  await P.waitForFunction(() => etState.loaded, null, { timeout: 5000 }); await wait(300);
  st = await stus();
  check('새로 열면 마지막 탭(수험표)으로, 명단 6명·사진 4장 그대로', await P.evaluate(() => fmCfg().kind === 'et' && document.getElementById('et-grid').style.display !== 'none') && st.length === 6 && st.filter(s => s.photo).length === 4 && st[0].name === '가나다' && JSON.stringify(await sheetKinds()) === '["F4","B4","F2","B2"]', st);
  const pc2 = await openDevice(browser, 'PC2', TA);
  await pc2.page.click('#rail-forms-btn'); await wait(400);
  await pc2.page.waitForFunction(() => etState.loaded, null, { timeout: 5000 }); await wait(200);
  check('다른 컴퓨터(같은 계정): 탭은 수험표지만 명단은 비어 있음(서버에 안 올라감)', await pc2.page.evaluate(() => fmCfg().kind === 'et' && etCfg().students.length === 0 && /학생 명단/.test(document.querySelector('#fm-pages .fm-empty').textContent)));
  await pc2.ctx.close();

  console.log('\n[7] 💾 백업 파일 저장 → 🗑 초기화 → 📂 불러오기');
  await P.evaluate(() => { window.showSaveFilePicker = undefined; window.customConfirm = async () => true; window.customAlert = async (m) => { window.__alert = m; }; const oc = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function() { window.__dl = this.download; return oc.call(this); }; });
  const [dl] = await Promise.all([P.waitForEvent('download'), P.click('#et-backup-btn')]);
  const dlName = await P.evaluate(() => window.__dl); // 헤드리스 크롬은 한글 파일 이름을 'download'로 알려 줘서 a.download로 확인
  const dlPath = path.join(tmp, 'backup.json'); await dl.saveAs(dlPath);
  const bk = JSON.parse(fs.readFileSync(dlPath, 'utf8'));
  check('백업 파일: 이름 수험표_3-1_7월전국연합학력평가_날짜.json, type exam-ticket, 6명·사진 4장·시험 정보', /^수험표_3-1_7월전국연합학력평가_\d{8}\.json$/.test(dlName) && bk.type === 'exam-ticket' && bk.data.students.length === 6 && bk.data.students.filter(s => s.photo).length === 4 && bk.data.cfg.schoolNo === '14115' && /저장했어요/.test(await P.evaluate(() => document.getElementById('et-store-msg').textContent)), dlName);
  await P.click('#fm-reset-btn'); await wait(700);
  check('🗑 초기화 → 명단·사진 비움, 기본 시험 정보로, 미리보기 안내', (await stus()).length === 0 && await P.evaluate(() => /학생 명단/.test(document.querySelector('#fm-pages .fm-empty').textContent) && document.querySelectorAll('#et-table tbody tr').length === 0));
  check('초기화는 IndexedDB에도 반영', await P.evaluate(() => new Promise(res => { const r = indexedDB.open('smartboard-local', 1); r.onsuccess = () => { const q = r.result.transaction('kv').objectStore('kv').get('et-data'); q.onsuccess = () => res(!!q.result && q.result.students.length === 0); }; })));
  fs.writeFileSync(path.join(tmp, 'bad.json'), JSON.stringify({ hello: 1 }));
  await P.setInputFiles('#et-restore-input', path.join(tmp, 'bad.json')); await wait(500);
  check('다른 JSON 파일이면 안내만', /백업 파일이 아니에요/.test(await P.evaluate(() => window.__alert || '')) && (await stus()).length === 0);
  await P.setInputFiles('#et-restore-input', dlPath); await wait(900);
  st = await stus();
  check('📂 불러오기 → 6명·사진 4장·시험 정보 복원, 미리보기 4쪽', st.length === 6 && st.filter(s => s.photo).length === 4 && st[0].name === '가나다' && JSON.stringify(await sheetKinds()) === '["F4","B4","F2","B2"]' && /불러왔어요/.test(await P.evaluate(() => document.getElementById('et-store-msg').textContent)));

  console.log('\n[8] 인쇄: A4 세로, 앞뒤 번갈아 4쪽');
  await P.evaluate(() => { window.print = function() { window.__printed = (window.__printed || 0) + 1; }; });
  await P.click('#fm-print-btn'); await wait(300);
  check('🖨️ 인쇄/PDF → 인쇄 창', await P.evaluate(() => window.__printed === 1 && /210mm 297mm/.test(document.getElementById('fm-page-style').textContent)));
  const pdf = pdfInfo(await P.pdf({ preferCSSPageSize: true, printBackground: true }));
  check('PDF: A4 세로 4쪽(앞·뒤·앞·뒤)', pdf.pages === 4 && pdf.w === 595 && pdf.h === 842, pdf);
  await P.evaluate(() => window.dispatchEvent(new Event('afterprint')));

  console.log('\n[8-1] 🖨️ 뒷면 위치 맞추기(10/7 사용자: 양면 인쇄하면 뒷면이 0.1~0.2mm 내려가 보임)');
  // 카드 위치(mm, 그 쪽 종이 왼쪽 위에서) — 앞면 첫 장·뒷면 첫 장의 첫 카드
  const cardPos = () => P.evaluate(() => { const mm = 96 / 25.4; return [...document.querySelectorAll('.et-sheet')].slice(0, 2).map(sh => { const a = sh.getBoundingClientRect(), b = sh.querySelector('.et-card').getBoundingClientRect(), z = a.width / (210 * mm); return [+((b.left - a.left) / z / mm).toFixed(2), +((b.top - a.top) / z / mm).toFixed(2), +((a.bottom - sh.querySelectorAll('.et-card')[sh.querySelectorAll('.et-card').length - 1].getBoundingClientRect().bottom) / z / mm).toFixed(2)]; }); });
  const p0 = await cardPos();
  check('처음엔 앞뒤 같은 자리(왼쪽 17.9 · 위 11mm), "0 (그대로)"', p0[0][0] === 17.9 && p0[0][1] === 11 && p0[1][0] === 17.9 && p0[1][1] === 11 && await P.evaluate(() => document.getElementById('et-shift-y').textContent === '0 (그대로)'), p0);
  await P.click('#et-shift-box button[onclick="etShiftBy(0, -0.1)"]'); await P.click('#et-shift-box button[onclick="etShiftBy(0, -0.1)"]'); await wait(200);
  await P.click('#et-shift-box button[onclick="etShiftBy(0.1, 0)"]'); await wait(200);
  const p1 = await cardPos();
  const sh1 = await P.evaluate(() => ({ y: document.getElementById('et-shift-y').textContent, x: document.getElementById('et-shift-x').textContent, ls: localStorage.getItem('device-et-back-shift'), dirty: localStorage.getItem('sync-dirty-keys') || '' }));
  check('▲ 두 번 → 뒷면만 0.2mm 위로(앞면은 그대로), 글 "뒷면 0.2mm 위로"', p1[0][1] === 11 && p1[1][1] === 10.8 && sh1.y === '뒷면 0.2mm 위로', [p1, sh1]);
  check('▶ 오른쪽으로(앞에서 비춰 볼 때) → 뒷면 종이 위에서는 0.1mm 왼쪽(긴 쪽 넘김이라 좌우가 뒤집혀 보임)', p1[0][0] === 17.9 && p1[1][0] === 17.8 && sh1.x === '뒷면 0.1mm 오른쪽으로', [p1, sh1]);
  check('카드만 옮겨지고 쪽 크기는 그대로(카드 아래 ~ 종이 끝: 앞 11 · 뒤 11.2mm)', Math.abs(p1[0][2] - p1[1][2] + 0.2) < 0.02, p1);
  check('이 컴퓨터에만 기억(device-et-back-shift) — 서버로 올릴 목록(sync-dirty-keys)엔 안 들어감', sh1.ls === '{"x":0.1,"y":-0.2}' && sh1.dirty.indexOf('device-') < 0, sh1);
  const pdf2 = pdfInfo(await P.pdf({ preferCSSPageSize: true, printBackground: true }));
  check('옮겨도 PDF는 그대로 A4 4쪽(넘쳐서 쪽이 늘지 않음)', pdf2.pages === 4, pdf2);
  await P.reload(); await wait(1500);
  await P.click('#rail-forms-btn'); await wait(800); // 고른 양식(수험표)은 계정에 기억돼 그대로 열림
  check('새로 열어도 기억(뒷면 0.2mm 위로)', await P.evaluate(() => document.getElementById('et-shift-y').textContent) === '뒷면 0.2mm 위로' && (await cardPos())[1][1] === 10.8, await cardPos());
  await P.click('#et-shift-reset'); await wait(200);
  const p2 = await cardPos();
  check('↺ 처음대로 → 뒷면도 17.9 · 11mm, 기억 지움', p2[1][0] === 17.9 && p2[1][1] === 11 && await P.evaluate(() => localStorage.getItem('device-et-back-shift') === null), p2);
  await P.evaluate(() => { etState.data.students = etState.data.students.concat(Array.from({ length: 19 }, (_, i) => Object.assign(etNewStu(7 + i), { name: '학생' + (7 + i) }))); etSave(); etFillForm(); fmRender(); });
  await wait(300);
  check('25명 → 종이 7장 = 14쪽, 마지막 앞·뒤에 1명', (await sheetKinds()).length === 14 && JSON.stringify((await sheetKinds()).slice(-2)) === '["F1","B1"]' && await P.evaluate(() => /학생 25명 · 종이 7장/.test(document.getElementById('fm-prev-label').textContent)));
  await P.screenshot({ path: 'et-preview.png' });

  console.log('\n[9] 시험 정보·시간표 고치기');
  await P.fill('#et-grid [data-k="exam"]', '9월 모의평가'); await P.fill('#et-grid [data-k="place"]', '제3고사장'); await wait(400);
  check('시험명·시험장소를 고치면 앞뒤 종이에 바로', /9월 모의평가/.test(await cardText(0, 0)) && /시험장소 : 제3고사장/.test(await cardText(0, 0)) && /9월 모의평가 가채점표/.test(await cardText(1, 0)));
  await P.selectOption('#et-cls', '2'); await wait(400);
  check('반을 2반으로 → 학번 30201·뒷면 "3학년 2반"', /30201/.test(await cardText(0, 0)) && /3학년 2반 1번/.test(await cardText(1, 0)) && (await P.evaluate(() => etCfg().cfg.cls)) === 2);
  await P.click('#et-times tbody tr:nth-child(5) .et-x'); await wait(200); await P.click('#et-times tbody tr:nth-child(4) .et-x'); await wait(200);
  await P.fill('#et-times input[data-r="0"][data-f="time"]', '09:00~10:20'); await wait(400);
  check('시간표 표: ✕로 두 줄 지우고 시간 칸을 고치면 cfg.times 3줄·기본값 단추 꺼짐·＋ 줄 보임', await P.evaluate(() => etCfg().cfg.times === '1 | 09:00~10:20 | 국어 | 80분\n2 | 10:30~12:10 | 수학 | 100분\n3 | 13:10~14:20 | 영어 | 70분' && !document.querySelector('#et-time-presets .nt-chip.on') && document.getElementById('et-time-add').style.display === ''));
  check('시간표 3줄로 → 교시 셋·시간 바뀜·오른쪽 안내도 3교시까지, 표는 그대로 15줄', await P.evaluate(() => { const c = document.querySelectorAll('#fm-pages .et-front .et-card')[0]; const t = c.innerText.replace(/\s+/g, ' '); return /09:00~10:20/.test(t) && !/한국사/.test(t) && /3교시 : 영어/.test(t) && c.querySelector('.et-tbl').rows.length === 15 && [...c.querySelectorAll('td.et-tt')].filter(x => x.textContent).length === 6; }));
  await P.click('#et-time-add'); await wait(200);
  check('＋ 줄 더하기 → 4줄, 교시 칸에 커서, 종이는 15줄 그대로', await P.evaluate(() => document.querySelectorAll('#et-times tbody tr').length === 4 && document.activeElement === document.querySelector('#et-times input[data-r="3"][data-f="p"]') && document.querySelector('#fm-pages .et-front .et-tbl').rows.length === 15));
  await P.click('#et-time-presets [data-preset="2028"]'); await wait(400);
  check('2028학년도 수능(통합형) 단추 → 6줄(사회·직업탐구 15:35~16:15 · 과학탐구 16:30~17:10, 40분)·단추 켜짐·＋ 줄 숨김·종이에도', await P.evaluate(() => etCfg().cfg.times === ET_TIMES_2028 && document.querySelectorAll('#et-times tbody tr').length === 6 && document.querySelector('#et-time-presets .nt-chip.on').dataset.preset === '2028' && document.getElementById('et-time-add').style.display === 'none') && /15:35~16:15/.test(await cardText(0, 0)) && /16:30~17:10/.test(await cardText(0, 0)) && /과학탐구/.test(await cardText(0, 0)));
  check('6줄이면 표는 그대로 15줄, 4교시 칸은 세 줄에 걸쳐(rowspan 6), 입실 안내는 오른쪽 안내 칸 아래로, 오른쪽 "4교시 : 한국사, 탐구"(탐구 한 번만)', await P.evaluate(() => { const c = document.querySelectorAll('#fm-pages .et-front .et-card')[0], tb = c.querySelector('.et-tbl'); const t = c.innerText.replace(/\s+/g, ' '); return tb.rows.length === 15 && [...tb.querySelectorAll('td.et-tt')].some(td => td.textContent === '4' && td.rowSpan === 6) && !tb.querySelector('td.et-tn') && !!tb.querySelector('td.et-tn2') && tb.querySelector('td.et-tn2').parentElement.rowIndex === 11 && /입실을 완료/.test(tb.querySelector('td.et-tn2').textContent) && /4교시 : 한국사, 탐구 /.test(t) && !/탐구, 탐구/.test(t); }));
  check('6줄이면 15줄 높이가 모두 같아 1~4교시 줄·왼쪽 성명·생년월일 쌍이 같은 높이', await P.evaluate(() => { const tb = document.querySelector('#fm-pages .et-front .et-tbl'); const hs = [...tb.rows].map(r => r.getBoundingClientRect().height); const pr = [...tb.querySelectorAll('td.et-tt')].filter(x => /^\d$/.test(x.textContent)).map(x => x.getBoundingClientRect().height); return tb.classList.contains('et-even') && Math.max(...hs) - Math.min(...hs) < 1 && Math.abs(pr[0] - pr[1]) < 1 && Math.abs(pr[2] * 3 - pr[3]) < 2 && Math.abs(tb.querySelector('td.et-lv').getBoundingClientRect().height - pr[0]) < 1; }));
  check('2028 기본값 → 가채점표도 통합형: 국어 공통/선택 없이 41-45까지, 수학 객관/단답(21 한 칸·22|23…30), 사회탐구 25·과학탐구 25, 앞면엔 제1·제2선택 없음, 표의 선택 과목 칸 숨김', await P.evaluate(() => etCfg().cfg.back === '2028' && document.querySelector('#et-back-row .nt-chip.on').dataset.back === '2028' && document.getElementById('et-table').classList.contains('et-no-sel') && getComputedStyle(document.querySelector('#et-table th.et-c-sel')).display === 'none') && await (async () => { const b = await cardText(1, 0), f = await cardText(0, 0); return /사회탐구/.test(b) && /과학탐구/.test(b) && !/공 통/.test(b) && /객 관/.test(b) && /단 답/.test(b) && /41-45/.test(b) && /21-25/.test(b) && !/탐구1/.test(b) && /답안지 과목코드/.test(b) && !/제1선택/.test(f) && !/국어-/.test(f) && !/수학-/.test(f) && /1교시 : 국어 /.test(f); })() && await P.evaluate(() => document.getElementById('et-sel-note').style.display === '' && /칸을 숨겼어요/.test(document.getElementById('et-sel-note').textContent)) && await P.evaluate(() => { const tds = [...document.querySelectorAll('#fm-pages .et-back .et-card')[0].querySelectorAll('td.et-rg')]; const i = tds.findIndex(x => x.textContent === '22'); const one = tds.find(x => x.textContent === '21'); return i >= 0 && tds[i].nextElementSibling.colSpan === 2 && tds[i].nextElementSibling.nextElementSibling.textContent === '23' && !!tds.find(x => x.textContent === '30') && !!one && one.nextElementSibling.classList.contains('et-ans') && one.nextElementSibling.nextElementSibling.colSpan === 4 && document.querySelectorAll('#fm-pages .et-back .et-card')[0].querySelectorAll('td.et-lb').length === 2; }));
  await P.click('#et-back-row [data-back="now"]'); await wait(300);
  check('가채점표 칸만 선택과목형으로 따로 바꾸기(시간표는 6줄 그대로) → 선택 과목 칸·안내 다시, 앞면에 국어-화법과작문', await P.evaluate(() => etCfg().cfg.back === 'now' && etCfg().cfg.times === ET_TIMES_2028 && !document.getElementById('et-table').classList.contains('et-no-sel') && document.getElementById('et-sel-note').style.display === 'none') && /탐구1/.test(await cardText(1, 0)) && /제1선택/.test(await cardText(0, 0)) && /국어-언어와매체/.test(await cardText(0, 0)));
  check('6줄이어도 앞뒤 카드 크기·자리 그대로', await P.evaluate(() => { const sh = [...document.querySelectorAll('#fm-pages .fm-sheet')].slice(0, 2).map(s => { const r = s.getBoundingClientRect(); return [...s.querySelectorAll('.et-card')].map(c => { const q = c.getBoundingClientRect(); return [q.top - r.top, q.height]; }); }); const tb = document.querySelector('#fm-pages .et-front .et-tbl').getBoundingClientRect(), cd = document.querySelector('#fm-pages .et-front .et-card').getBoundingClientRect(); return sh[0].every((c, i) => Math.abs(c[0] - sh[1][i][0]) < 0.6 && Math.abs(c[1] - sh[1][i][1]) < 0.6) && Math.abs(tb.height - cd.height) < 1.5; }));
  await P.click('#et-time-presets [data-preset="now"]'); await wait(300);
  check('수능(~2027학년도) 단추 → 시간표·가채점표 칸 원래대로, 15줄 높이도 엑셀대로(맨 아래 6mm)', await P.evaluate(() => etCfg().cfg.times === ET_TIMES_DEFAULT && etCfg().cfg.back === 'now' && document.querySelector('#et-time-presets .nt-chip.on').dataset.preset === 'now' && !document.querySelector('#fm-pages .et-front .et-tbl').classList.contains('et-even')));

  console.log('\n[9b] 표 칸에 붙여 넣기 · 📂 엑셀 파일');
  await P.evaluate(() => { etMutate(d => { d.students = [Object.assign(etNewStu(1), { name: '고다윤', kor: '화법과작문' }), Object.assign(etNewStu(2), { name: '김민건' })]; }); etFillForm(); fmRender(); });
  const pasteAt = (sel, text) => P.evaluate(([sel, text]) => { const el = document.querySelector(sel); el.focus(); const dt = new DataTransfer(); dt.setData('text/plain', text); el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); }, [sel, text]);
  await pasteAt('#et-table tbody tr:nth-child(1) input.et-birth', '080710\t화법과작문\t미적분\n080819\t언어와매체\t확률과통계\n080329\t화법과작문\t기하'); await wait(400);
  st = await stus();
  check('생년월일 칸에 3줄×3칸 붙여 넣기 → 그 칸부터 오른쪽·아래로, 모자란 셋째 줄은 새로 생김(번호 없음)', st.length === 3 && st[0].birth === '080710' && st[0].math === '미적분' && st[0].name === '고다윤' && st[1].birth === '080819' && st[1].kor === '언어와매체' && st[1].math === '확률과통계' && st[2].birth === '080329' && st[2].math === '기하' && st[2].no === '' && st[2].name === '', st);
  await pasteAt('#et-table tbody tr:nth-child(3) input.et-no', '번호\t이름\t생년월일\t국어\t수학\t탐구1\t탐구2\n3\t김민찬\t080329\t언어와매체\t확률과통계\t생활과윤리\t사회문화\n30104\t김서진\t080130\t언어와매체\t미적분\t물리학1\t지구과학1'); await wait(400);
  st = await stus();
  check('번호 칸에 머리 줄 포함 붙여 넣기 → 머리 줄 빼고 똑똑하게(학번도) 셋째 줄부터', st.length === 4 && st[2].no === '3' && st[2].name === '김민찬' && st[2].inq2 === '사회문화' && st[3].no === '4' && st[3].name === '김서진' && st[3].inq1 === '물리학1' && /2줄을 3번째 줄부터/.test(await P.evaluate(() => document.getElementById('et-list-msg').textContent)), st);
  check('한 칸짜리 붙여 넣기는 그대로(막지 않음)', await P.evaluate(() => { const el = document.querySelector('#et-table tbody tr:nth-child(1) input.et-inq1'); el.focus(); const dt = new DataTransfer(); dt.setData('text/plain', '세계지리'); const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }); el.dispatchEvent(ev); return !ev.defaultPrevented; }));
  if (XLSXLIB) {
    const X = require(XLSXLIB);
    const wbx = X.utils.book_new();
    const data = [['', '', '', '', '', '학년도', '2027학년도', '학교', '테스트고등학교', '', '시험명', '6월 모의평가'], ['', '', '', '', '', '학교번호', '77777', '학생수', '3'], [], ['반', '번호', '학번', '이름', '생년월일', '국어', '수학', '탐구1', '탐구2'],
      [2, 1, 20301, '엑셀일', '090101', '화법과작문', '미적분', '생활과윤리', '사회문화'], [2, 2, 20302, '엑셀이', '090202', '언어와매체', '기하', '물리학1', '화학1'], [2, 5, 20305, '엑셀오', '090505', '화법과작문', '확률과통계', '세계지리', '경제'], [2, 6, 20306]];
    X.utils.book_append_sheet(wbx, X.utils.aoa_to_sheet([['메모만 있는 시트']]), '안내');
    X.utils.book_append_sheet(wbx, X.utils.aoa_to_sheet(data), '데이터');
    await P.evaluate(() => { etMutate(d => { d.students = [Object.assign(etNewStu(1), { name: '고다윤', photo: 'data:image/jpeg;base64,/9j/' })]; }); etFillForm(); fmRender(); });
    await P.setInputFiles('#et-file-input', { name: '수험표.xlsm', mimeType: 'application/vnd.ms-excel.sheet.macroEnabled.12', buffer: Buffer.from(X.write(wbx, { type: 'buffer', bookType: 'xlsx' })) }); await wait(800);
    st = await stus(); const cf = await P.evaluate(() => etCfg().cfg);
    check('📂 엑셀 파일: 머리 줄 있는 "데이터" 시트에서 3명(이름 없는 줄 빼고), 1번은 명렬표 이름으로 고치고 사진 유지, 학년도·학교·시험명·학교번호·학년·반까지', st.length === 3 && st[0].no === '1' && st[0].name === '엑셀일' && st[0].photo > 0 && st[0].birth === '090101' && st[1].name === '엑셀이' && st[1].math === '기하' && st[2].no === '5' && st[2].inq2 === '경제' && cf.year === '2027' && cf.school === '테스트고등학교' && cf.exam === '6월 모의평가' && cf.schoolNo === '77777' && cf.grade === 2 && cf.cls === 3 && /3명을 읽었어요/.test(await P.evaluate(() => document.getElementById('et-list-msg').textContent)), [st, cf]);
    check('시트에서 읽은 시험 정보가 입력칸·종이에', await P.evaluate(() => document.querySelector('#et-grid [data-k="exam"]').value === '6월 모의평가' && document.getElementById('et-cls').value === '3') && /2027학년도 6월 모의평가/.test(await cardText(0, 0)) && /20301/.test(await cardText(0, 0)) && /학교번호 77777/.test(await cardText(1, 0)));
    await P.evaluate(() => { etMutate(d => { d.cfg = Object.assign(d.cfg, { year: '2026', school: '부광고등학교', exam: '7월 전국연합학력평가', schoolNo: '14115', grade: 3, cls: 2 }); }); etFillForm(); fmRender(); });
  } else console.log('  (xlsx 라이브러리를 못 찾아 엑셀 파일 검사는 건너뜀)');

  console.log('\n[10] 화면 배치');
  check('1600: ① 시험 정보 | ② 시간표 두 열, ③ 명단은 한 줄 전체', await P.evaluate(() => { const a = document.getElementById('et-exam-box').getBoundingClientRect(), b = document.getElementById('et-time-box').getBoundingClientRect(), l = document.getElementById('et-list-box').getBoundingClientRect(); return Math.abs(a.top - b.top) < 2 && b.left > a.right && l.width > a.width * 1.8; }));
  await P.setViewportSize({ width: 1366, height: 768 }); await wait(400);
  check('1366: 두 열 그대로, 미리보기 종이 보임, 표가 왼쪽 칸 안', await P.evaluate(() => { const a = document.getElementById('et-exam-box').getBoundingClientRect(), b = document.getElementById('et-time-box').getBoundingClientRect(), s = document.querySelector('#fm-pages .fm-sheet').getBoundingClientRect(), L = document.getElementById('fm-left').getBoundingClientRect(); return Math.abs(a.top - b.top) < 2 && s.width > 400 && document.getElementById('et-table').getBoundingClientRect().right <= L.right + 1; }));
  check('페이지 오류 없음', pc.errors.length === 0, pc.errors);

  await browser.close();
  console.log(failures ? `\n❌ 실패 ${failures}건` : '\n✅ 모든 검사 통과');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
