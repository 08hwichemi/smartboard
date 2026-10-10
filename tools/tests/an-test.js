// 레일 "양식" → 📢 안내문: 탭 전환, 처음 예시(수행평가 안내), 줄 종류(1. 가. • - 본문 가운데 ※ 표 상자)와 번호·기호·들여쓰기,
// Enter·Tab·Backspace, 여러 줄 붙여 넣기(앞 기호로 나눔·탭이면 표), 표 칸 늘리기·엑셀 붙여 넣기, 틀 바꾸기, 끝맺음, 모양 고르기, 서버 저장,
// 한글 파일(XML 올바름·쪽 설정이 첫 문단·스타일 "안내문 …"·내어쓰기·표 칸 폭 합 = 표 폭·글).
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(process.env.HTML_PATH || path.join(ROOT, 'index.html'), 'utf8');
// 앱은 JSZip을 CDN에서 받지만 여기선 CDN이 막혀 있어 로컬 파일을 대신 준다(없으면 한글 파일 검사만 건너뜀).
const JSZIP_PATH = ['/opt/node-tools/node_modules/jszip/dist/jszip.min.js'].concat((process.env.NODE_PATH || '').split(':').map(p => path.join(p, 'jszip/dist/jszip.min.js'))).find(p => p && fs.existsSync(p));
const JSZIP_JS = JSZIP_PATH ? fs.readFileSync(JSZIP_PATH, 'utf8') : '';
// 엑셀 검사는 exceljs가 있을 때만(수업 변경 테스트와 같음 — npm i exceljs@4.4.0 후 NODE_PATH에 추가)
let EXCELJS_PATH = ''; try { EXCELJS_PATH = require.resolve('exceljs/dist/exceljs.min.js'); } catch (e) {}
// 단어 시험 엑셀 올리기 검사용 SheetJS(index.html이 CDN에서 받는 것과 같은 0.18.5 — 결석계 테스트와 같은 곳에 한 번 받아 둠)
const XLSXLIB = (() => {
  const dir = path.join(require('os').tmpdir(), 'sb-test-xlsx');
  const f = path.join(dir, 'package', 'dist', 'xlsx.full.min.js');
  if (!fs.existsSync(f)) {
    try { fs.mkdirSync(dir, { recursive: true }); require('child_process').execSync('npm pack xlsx@0.18.5 --silent && tar xzf xlsx-0.18.5.tgz', { cwd: dir, stdio: 'ignore' }); } catch (e) {}
  }
  return fs.existsSync(f) ? f : null;
})();

// ---------- 가짜 서버 ----------
const T1 = '11111111-1111-1111-1111-111111111111';
const T2 = '22222222-2222-2222-2222-222222222222';
const teachers = {
  [T1]: { id: T1, name: '김교사', is_admin: false, must_change_password: false, role: '교사', homeroom_grade: null, homeroom_class: null },
  [T2]: { id: T2, name: '박교사', is_admin: false, must_change_password: false, role: '담임', homeroom_grade: 3, homeroom_class: 1 },
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
    const g = filters.find(f => f.col === 'grade'), inF = filters.find(f => f.op === 'in' && f.col === 'class_no');
    studentSelects.push((g ? g.val : '?') + ':' + (inF ? inF.val.join(',') : '?'));
    if (failStudents) return { data: null, error: { message: 'Failed to fetch' } };
    const sizes = { 1: 5, 2: 30, 3: 45 };
    const out = [];
    (inF ? inF.val : []).forEach(k => { for (let i = 1; i <= (Number(g.val) === 3 ? (sizes[k] || 0) : 0); i++) out.push({ class_no: k, number: i, name: (k === 1 ? ['가나다', '라마바', '사아자', '차카타', '파하가'][i - 1] : '학생' + k + '-' + i) }); });
    return { data: out, error: null };
  }
  if (table === 'app_settings' && filters.some(f => f.val === 'class_structure')) return { data: { value: { gradeCount: 3, classCounts: [8, 9, 10] } }, error: null };
  if (op === 'select') return { data: single || maybe ? null : [], error: null };
  return { data: null, error: null };
}
const studentSelects = [];
let failStudents = false;

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
      gte: function(){ return b; }, lte: function(){ return b; }, in: function(c,v){ q.filters.push({op:'in',col:c,val:v}); return b; }, limit: function(){ return b; },
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
      const f = path.join(ROOT, decodeURIComponent(url.slice('http://app.test/'.length).split('?')[0]));
      if (f.startsWith(path.join(ROOT, 'forms')) && fs.existsSync(f)) return route.fulfill({ body: fs.readFileSync(f), contentType: 'application/octet-stream' });
      return route.fulfill({ status: 404, body: '' });
    }
    if (url.includes('@supabase/supabase-js')) return route.fulfill({ body: mockLib, contentType: 'application/javascript' });
    if (url.includes('/jszip') && JSZIP_JS) return route.fulfill({ body: JSZIP_JS, contentType: 'application/javascript' });
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
const cfgOf = async (d) => JSON.parse(await ls(d, 'fm-cfg') || '{}');
const sheetsOf = (P) => P.evaluate(() => [...document.querySelectorAll('#fm-pages .fm-sheet')].map(s => ({
  cls: s.dataset.cls, title: (s.querySelector('.fm-title') || {}).textContent || '', info: (s.querySelector('.fm-info') || {}).textContent || '',
  tables: [...s.querySelectorAll('table.fm-tbl')].map(t => t.rows.length),
  head: [...(s.querySelector('table.fm-tbl tr') || { cells: [] }).cells].map(c => c.textContent),
  fits: (() => { const r = s.getBoundingClientRect(); return [...s.querySelectorAll('table.fm-tbl')].every(t => t.getBoundingClientRect().bottom <= r.bottom - 15 * 3.78 * (r.width / (210 * 3.78)) + 1); })(),
})));
const setText = (P, sel, v) => P.evaluate(([sel, v]) => { const el = document.querySelector(sel); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, [sel, v]);

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }).catch(() => chromium.launch());
  const hr = await openDevice(browser, '박교사PC', T2);
  const P = hr.page;
  await P.click('#rail-forms-btn'); await P.waitForTimeout(600);
  await P.click('#fm-kind-switch [data-kind="an"]'); await P.waitForTimeout(400);
  const moreClosedAtStart = await P.evaluate(() => !document.getElementById('an-more').open); // 🎨 더 꾸미기는 처음엔 접혀 있음
  const vis = await P.evaluate(() => ({ an: getComputedStyle(document.getElementById('an-grid')).display !== 'none', pe: document.getElementById('pe-grid').style.display,
    xlsx: document.getElementById('fm-xlsx-btn').style.display, hwpx: document.getElementById('fm-hwpx-btn').style.display, kind: JSON.parse(localStorage.getItem('fm-cfg')).kind,
    tabs: [...document.querySelectorAll('#fm-kind-switch .tab-btn')].filter(b => b.style.display !== 'none').map(b => b.textContent.trim()).join() }));
  check('안내문 탭: 안내문 칸만, 한글 파일 버튼, 탭 = 시정표·이름표·명렬표 수합·학습지·수행평가·안내문', vis.an && vis.pe === 'none' && vis.xlsx === 'none' && vis.hwpx === '' && vis.kind === 'an' && vis.tabs === '시정표,이름표,명렬표 수합,학습지,수행평가,안내문', vis);
  const prev = () => P.evaluate(() => { const sh = [...document.querySelectorAll('#fm-pages .an-sheet')];
    return { n: sh.length, title: (document.querySelector('#fm-pages .an-title') || {}).textContent, sub: (document.querySelector('#fm-pages .an-sub') || {}).textContent,
      paras: [...document.querySelectorAll('#fm-pages .an-sheet > .an-p:not(.an-title):not(.an-sub)')].map(d => ({ t: d.textContent, pl: parseFloat(d.style.paddingLeft), ti: parseFloat(d.style.textIndent), fw: d.style.fontWeight })),
      tables: [...document.querySelectorAll('#fm-pages .an-tb')].map(t => ({ rows: t.rows.length, cols: t.rows[0].cells.length, head: t.rows[0].cells[0].style.background, ml: parseFloat(t.style.marginLeft), w: parseFloat(t.style.width), cw: [...t.querySelectorAll('col')].reduce((a, c) => a + parseFloat(c.style.width), 0) })),
      boxes: document.querySelectorAll('#fm-pages .an-box').length };
  });
  const d0 = await prev();
  const t0 = d0.paras.map(p => p.t);
  check('처음엔 수행평가 안내 예시: 제목·부제목, 1. 2. 3. 큰 항목, • 점, - 줄표, ※ 참고, 표 1개', d0.title === '2학기 화학Ⅱ 수행평가 안내' && d0.sub === '2학년 화학Ⅱ 수강생' &&
    t0[0] === '1. 평가 개요' && t0[1].startsWith('• 평가 기간') && t0.includes('2. 평가 기준') && t0.includes('3. 유의 사항') && t0.some(t => t.startsWith('- 인터넷')) && t0[t0.length - 1].startsWith('※ 문의') && d0.tables.length === 1, { title: d0.title, t0 });
  const h1 = d0.paras[0], b1 = d0.paras[1], dsh = d0.paras.find(p => p.t.startsWith('- '));
  check('들여쓰기: 큰 항목은 맨 앞(굵게), 점은 큰 항목 글 시작에, 줄표는 점 글 시작에, 줄이 넘어가면 기호 뒤에 맞춤(내어쓰기)',
    h1.pl + h1.ti < 0.01 && +h1.fw >= 700 && Math.abs((b1.pl + b1.ti) - h1.pl) < 0.01 && Math.abs((dsh.pl + dsh.ti) - b1.pl) < 0.01 && b1.ti < 0 && dsh.ti < 0, { h1, b1, dsh });
  const tb = d0.tables[0];
  check('표: 3줄×3칸, 첫 줄 회색, 큰 항목 글 시작에 맞춰 들여 놓고 칸 폭 합 = 표 폭', tb.rows === 3 && tb.cols === 3 && /238/.test(tb.head) && Math.abs(tb.ml - h1.pl) < 0.01 && Math.abs(tb.cw - tb.w) < 0.05, tb);

  // 줄 편집: 맨 끝 줄에서 Enter → 같은 종류(참고), Tab → 점, 글 → 미리보기
  const rowsN = () => P.evaluate(() => anCfg().rows.length);
  const n0 = await rowsN();
  const last = P.locator('#an-rows .an-row').last().locator('textarea.an-tx');
  await last.click(); await last.press('End'); await last.press('Shift+Enter'); await P.waitForTimeout(200);
  check('Shift+Enter → 아래에 같은 종류 줄(참고)', await rowsN() === n0 + 1 && await P.evaluate(() => anCfg().rows[anCfg().rows.length - 1].lv) === 'n');
  await P.keyboard.press('Tab'); await P.waitForTimeout(150);
  await P.keyboard.type('새 점 줄'); await P.waitForTimeout(250);
  const r1 = await P.evaluate(() => { const r = anCfg().rows; return r[r.length - 1]; });
  check('Tab → 참고 줄이 점으로, 글이 들어감', r1.lv === 'b' && r1.t === '새 점 줄', r1);
  check('미리보기에 "• 새 점 줄"', (await prev()).paras.some(p => p.t === '• 새 점 줄'));
  await P.keyboard.press('Shift+Tab'); await P.waitForTimeout(150);
  check('Shift+Tab → 한 단계 밖(작은 항목 가.)', (await prev()).paras.some(p => p.t === '가. 새 점 줄'));
  await P.keyboard.press('Shift+Tab'); await P.waitForTimeout(150);
  check('한 번 더 Shift+Tab → 큰 항목, 번호는 4.', (await prev()).paras.some(p => p.t === '4. 새 점 줄'));
  // 빈 줄 Backspace
  await P.keyboard.press('Shift+Enter'); await P.waitForTimeout(150);
  const n1 = await rowsN();
  await P.keyboard.press('Backspace'); await P.waitForTimeout(150);
  check('빈 칸에서 Backspace → 그 줄 지움', await rowsN() === n1 - 1);

  // 여러 줄 붙여 넣기 → 앞 기호로 나눔
  await P.click('[data-tpl="blank"]'); await P.waitForTimeout(200);
  await P.waitForSelector('#custom-confirm-overlay', { state: 'visible' }); await P.click('#custom-confirm-ok-btn'); await P.waitForTimeout(300);
  check('빈 안내문 틀 → 제목 비고 줄 3개(1. • •)', await P.evaluate(() => { const c = anCfg(); return c.title === '' && c.rows.map(r => r.lv).join() === 'h1,b,b'; }));
  await P.evaluate(() => {
    const inp = document.querySelector('#an-rows .an-row[data-i="0"] textarea.an-tx'); inp.focus();
    const dt = new DataTransfer(); dt.setData('text/plain', '1. 일시: 10월 20일\n가. 오전\n• 준비물\n- 필기구\n※ 문의: 교무실\n그냥 글');
    inp.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await P.waitForTimeout(300);
  const pr = await P.evaluate(() => anCfg().rows.slice(0, 6).map(r => r.lv + ':' + r.t).join('|'));
  check('여러 줄 붙여 넣기 → 1. 가. • - ※ 본문으로 나뉨(앞 기호는 떼어 냄)', pr === 'h1:일시: 10월 20일|h2:오전|b:준비물|d:필기구|n:문의: 교무실|p:그냥 글', pr);
  const d1 = await prev();
  check('작은 항목 가. 아래 점은 두 단계 안으로', (() => { const a = d1.paras.find(p => p.t === '가. 오전'), b = d1.paras.find(p => p.t === '• 준비물'); return a && b && b.pl + b.ti > a.pl + a.ti + 1; })(), d1.paras);
  // 탭으로 나뉜 여러 줄 → 표
  await P.evaluate(() => {
    const inp = document.querySelector('#an-rows .an-row[data-i="5"] textarea.an-tx'); inp.focus();
    const dt = new DataTransfer(); dt.setData('text/plain', '날짜\t행사\n10. 15.\t체육대회\n10. 28.\t진로 특강\n');
    inp.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await P.waitForTimeout(300);
  const tr = await P.evaluate(() => anCfg().rows.find(r => r.lv === 'tbl'));
  check('엑셀처럼 칸(탭)으로 나뉜 줄을 붙여 넣으면 표(3줄×2칸)', tr && tr.cells.length === 3 && tr.cells[0].join() === '날짜,행사' && tr.cells[2][1] === '진로 특강', tr);
  // 표 칸 더하기·빼기, 칸에 엑셀 붙여 넣기
  const ti = await P.evaluate(() => anCfg().rows.findIndex(r => r.lv === 'tbl'));
  await P.click('#an-rows .an-row[data-i="' + ti + '"] .an-tbl-tools button[title="칸 더하기"]'); await P.waitForTimeout(150);
  await P.click('#an-rows .an-row[data-i="' + ti + '"] .an-tbl-tools button[title="줄 더하기"]'); await P.waitForTimeout(150);
  check('＋칸·＋줄 → 4줄×3칸', await P.evaluate((i) => { const r = anCfg().rows[i]; return r.cells.length + 'x' + r.cells[0].length; }, ti) === '4x3');
  await P.evaluate((i) => {
    const inp = document.querySelector('#an-rows .an-row[data-i="' + i + '"] textarea[data-r="3"][data-k="0"]'); inp.focus();
    const dt = new DataTransfer(); dt.setData('text/plain', '11. 19.\t수능\t3학년\n12. 1.\t축제\t전교생');
    inp.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, ti);
  await P.waitForTimeout(300);
  const tr2 = await P.evaluate((i) => anCfg().rows[i].cells, ti);
  check('표 칸에 여러 칸 붙여 넣기 → 그 칸부터 채우고 모자란 줄은 늘림', tr2.length === 5 && tr2[3].join() === '11. 19.,수능,3학년' && tr2[4][2] === '전교생', tr2);
  // 줄 종류 바꾸기: 본문 → 상자
  // 줄 종류는 줄을 고른 뒤 위 도구(#an-cur)의 종류 단추로(줄에는 종류 상자 없음 — 종이처럼)
  await P.click('#an-rows .an-row[data-i="5"] textarea.an-tx'); await P.click('#an-cur [data-lv="box"]'); await P.waitForTimeout(200);
  check('줄을 고르고 도구의 "상자" → 미리보기에 상자, 줄에는 종류 상자(select) 없음', (await prev()).boxes === 1 && await P.evaluate(() => !document.querySelector('#an-rows select')));

  // 모양: 큰 항목 Ⅰ., 점 ○, 제목 꾸미기 상자 — 🎨 더 꾸미기(접힘)를 먼저 펼침
  await P.click('#an-more summary'); await P.waitForTimeout(150);
  await P.click('#an-n1 [data-v="Ⅰ."]'); await P.click('#an-bul [data-v="○"]'); await P.click('#an-deco [data-v="box"]'); await P.waitForTimeout(250);
  const d2 = await prev();
  check('모양: 큰 항목 Ⅰ., 점 ○', d2.paras.some(p => p.t === 'Ⅰ. 일시: 10월 20일') && d2.paras.some(p => p.t === '○ 준비물'), d2.paras.map(p => p.t));
  check('＋ 단추 이름도 바뀐 기호로', await P.evaluate(() => document.querySelector('#an-add [data-add="b"]').textContent) === '＋ ○ 점');
  // 끝맺음
  await P.click('#an-end'); await setText(P, '#an-end-from', '○○고등학교장'); await P.waitForTimeout(250);
  const endT = await P.evaluate(() => [...document.querySelectorAll('#fm-pages .an-sheet .an-p')].map(d => d.textContent).slice(-2));
  check('끝맺음: 날짜(비우면 오늘)·보낸 이', /^\d{4}\. \d{1,2}\. \d{1,2}\.$/.test(endT[0]) && endT[1] === '○○고등학교장', endT);
  await setText(P, '#an-title', '체육대회 안내'); await P.waitForTimeout(200);

  // 서버 저장
  await P.waitForTimeout(2500);
  const sv = JSON.parse(serverVal(T2, 'fm-an') || '{}');
  check('안내문 설정은 내 계정(fm-an)에 저장', sv.title === '체육대회 안내' && sv.n1 === 'Ⅰ.' && sv.end === true && Array.isArray(sv.rows) && sv.rows.some(r => r.lv === 'tbl'), sv);

  // 한글 파일
  if (JSZIP_JS) {
    const hz = await P.evaluate(async () => {
      const zip = await JSZip.loadAsync(await anBuildHwpx(anCfg())), names = Object.keys(zip.files);
      const sec = await zip.file('Contents/section0.xml').async('string'), head = await zip.file('Contents/header.xml').async('string');
      let ok = true; [sec, head].forEach(x => { if (new DOMParser().parseFromString(x, 'application/xml').getElementsByTagName('parsererror').length) ok = false; });
      const firstP = sec.match(/<hp:p [^>]*>[\s\S]*?<\/hp:p>/)[0];
      const tbls = [...sec.matchAll(/<hp:tbl [\s\S]*?<\/hp:tbl>/g)].map(m => m[0]);
      const sums = tbls.map(t => { const tw = +t.match(/<hp:sz width="(\d+)"/)[1], row0 = t.split('</hp:tr>')[0]; return [tw, [...row0.matchAll(/<hp:cellSz width="(\d+)"/g)].reduce((a, m) => a + +m[1], 0)]; });
      const styles = [...head.matchAll(/<hh:style id="\d+" type="PARA" name="(안내문[^"]*)"/g)].map(m => m[1]);
      // "○ 준비물" 문단의 문단 모양: 왼쪽 여백 > 0, 내어쓰기(intent < 0)
      const bp = sec.match(/<hp:p [^>]*paraPrIDRef="(\d+)"[^>]*>(?:(?!<\/hp:p>)[\s\S])*?<hp:t>○ 준비물<\/hp:t>/);
      const pp = bp && head.match(new RegExp('<hh:paraPr id="' + bp[1] + '"[\\s\\S]*?</hh:paraPr>'))[0];
      const iv = pp && +pp.match(/<hp:case[\s\S]*?<hc:intent value="(-?\d+)"/)[1], lv = pp && +pp.match(/<hp:case[\s\S]*?<hc:left value="(-?\d+)"/)[1];
      return { first: names[0], xml: ok, secInFirst: /<hp:secPr/.test(firstP) && (sec.match(/<hp:secPr/g) || []).length === 1, titleTbl: /체육대회 안내/.test(tbls[0] || ''),
        sums, styles, iv, lv, texts: ['체육대회 안내', 'Ⅰ. 일시: 10월 20일', '가. 오전', '○ 준비물', '- 필기구', '※ 문의: 교무실', '진로 특강', '○○고등학교장'].filter(t => !sec.includes('<hp:t>' + fmX(t) + '</hp:t>')),
        font: /face="HY헤드라인M"/.test(head) && /face="함초롬바탕"/.test(head), page: sec.match(/<hp:pagePr [^>]*>/)[0], margin: sec.match(/<hp:margin [^>]*>/)[0] };
    });
    check('한글 파일: mimetype 맨 앞, XML 올바름, 쪽 설정은 첫 문단에 하나', hz.first === 'mimetype' && hz.xml && hz.secInFirst, hz);
    check('한글 파일: 제목 상자는 표, 표마다 칸 폭 합 = 표 폭', hz.titleTbl && hz.sums.length >= 3 && hz.sums.every(s => s[0] === s[1]), hz.sums);
    check('한글 파일: 글이 다 들어감(번호·기호 포함)', hz.texts.length === 0, hz.texts);
    check('한글 파일: 스타일 안내문 제목·부제목·1.·가.·•·-·본문·가운데·※ (F6)', hz.styles.length === 9 && hz.styles.includes('안내문 1. 큰 항목') && hz.styles.includes('안내문 • 점'), hz.styles);
    check('한글 파일: 점 줄은 왼쪽 여백 + 내어쓰기(intent < 0)', hz.lv > 0 && hz.iv < 0, { lv: hz.lv, iv: hz.iv });
    check('한글 파일: A4 세로 · 여백 20mm · 글꼴', /width="59528"/.test(hz.page) && /left="5669"/.test(hz.margin) && hz.font, { page: hz.page, margin: hz.margin });
    if (process.env.AN_OUT) { const b64 = await P.evaluate(async () => { const u8 = new Uint8Array(await (await anBuildHwpx(anCfg())).arrayBuffer()); let t = ''; u8.forEach(x => t += String.fromCharCode(x)); return btoa(t); }); fs.writeFileSync(process.env.AN_OUT, Buffer.from(b64, 'base64')); }
  } else console.log('  ⚠️ JSZip이 없어 한글 파일 검사는 건너뜀');

  // ----- 줄 고르기 도구: 들여쓰기·정렬·순서, 줄마다 ＋, 끌어서 옮기기 -----
  await P.click('[data-tpl="pe"]'); await P.waitForSelector('#custom-confirm-overlay', { state: 'visible' }); await P.click('#custom-confirm-ok-btn'); await P.waitForTimeout(300);
  await P.evaluate(() => anSet({ n1: '1.', bul: '•', deco: 'line' }, true)); await P.waitForTimeout(200);
  const rowsLv = () => P.evaluate(() => anCfg().rows.map(r => r.lv + ':' + (r.t || '').slice(0, 6)));
  // 1번 큰 항목 줄의 ＋ → 바로 아래(2번째 줄)에 점
  await P.click('#an-rows .an-row[data-i="0"] .an-plus'); await P.waitForTimeout(200);
  const lv1 = await rowsLv();
  check('큰 항목 줄의 ＋ → 바로 아래에 점 줄(맨 아래 아님)', lv1[1] === 'b:' && lv1[2].startsWith('b:평가 기간'), lv1.slice(0, 4));
  await P.keyboard.type('맨 위 점'); await P.waitForTimeout(200);
  check('새 줄에 바로 글을 쓸 수 있음(커서가 거기에)', await P.evaluate(() => anCfg().rows[1].t) === '맨 위 점');
  // 줄을 누르면 고른 줄 표시 + 도구, 아래 ＋ 단추는 그 줄 아래에
  await P.click('#an-rows .an-row[data-i="4"] textarea.an-tx'); await P.waitForTimeout(150);
  const cur = await P.evaluate(() => ({ cls: [...document.querySelectorAll('#an-rows .an-row.cur')].map(e => e.dataset.i).join(), tool: document.getElementById('an-cur').textContent }));
  check('줄을 누르면 그 줄만 파랗게 + 도구에 "5번째 줄"', cur.cls === '4' && /5번째 줄/.test(cur.tool) && /들여쓰기/.test(cur.tool) && /양쪽/.test(cur.tool), cur);
  await P.click('#an-add [data-add="d"]'); await P.waitForTimeout(200);
  check('아래 ＋ 단추도 고른 줄 아래에(5번째 줄 다음)', (await rowsLv())[5] === 'd:', (await rowsLv()).slice(3, 7));
  await P.keyboard.type('세부'); await P.waitForTimeout(150);
  // 들여쓰기 ▶ 두 번 → 2글자, 미리보기 2 × 글자 폭만큼
  const pl = () => P.evaluate(() => { const d = [...document.querySelectorAll('#fm-pages .an-p')].find(x => x.textContent === '- 세부'); return d && parseFloat(d.style.paddingLeft); });
  const pl0 = await pl();
  await P.click('#an-cur button[title="한 글자 오른쪽으로"]'); await P.click('#an-cur button[title="한 글자 오른쪽으로"]'); await P.waitForTimeout(200);
  const pl1 = await pl(), bs = await P.evaluate(() => anCfg().bSize * FM_PT);
  check('들여쓰기 ▶▶ → 저장 ind 2, 미리보기가 2글자만큼 오른쪽으로, 도구에 +2', await P.evaluate(() => anCfg().rows[5].ind) === 2 && Math.abs(pl1 - pl0 - 2 * bs) < 0.05 && /\+2/.test(await P.evaluate(() => document.getElementById('an-cur').textContent)), { pl0, pl1, bs });
  // 정렬 가운데
  await P.click('#an-cur button[title="가운데 정렬"]'); await P.waitForTimeout(200);
  check('정렬 가운데 → 미리보기 가운데, 내어쓰기 없음', await P.evaluate(() => { const d = [...document.querySelectorAll('#fm-pages .an-p')].find(x => x.textContent === '- 세부'); return d.style.textAlign === 'center' && parseFloat(d.style.textIndent) === 0; }));
  // 순서 ↑
  await P.click('#an-cur button[title="순서: 이 줄을 한 줄 위로"]'); await P.waitForTimeout(200);
  check('순서 ↑ → 한 줄 위로, 고른 줄도 따라감', (await rowsLv())[4] === 'd:세부' && await P.evaluate(() => anFocus) === 4, (await rowsLv()).slice(3, 7));
  // 끌어서 옮기기: 4번째 줄(세부)을 맨 첫 줄 위로
  await P.evaluate(() => {
    const dt = new DataTransfer(), rows = () => document.querySelectorAll('#an-rows .an-row');
    rows()[4].querySelector('.an-drag').firstChild.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true })); // 글자(텍스트 노드)를 잡고 끌 때(예전 오류: e.target.closest is not a function)
    const r0 = rows()[0], rc = r0.getBoundingClientRect();
    r0.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true, clientY: rc.top + 2 }));
    r0.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true, clientY: rc.top + 2 }));
  });
  await P.waitForTimeout(250);
  check('⠿ 끌어서 첫 줄 위에 놓기 → 맨 위로', (await rowsLv())[0] === 'd:세부' && (await rowsLv())[1].startsWith('h1:평가 개요'), (await rowsLv()).slice(0, 3));
  // 한글 파일: 그 줄은 가운데 정렬, 모든 문단은 어절 단위 줄바꿈
  if (JSZIP_JS) {
    const kz = await P.evaluate(async () => {
      const zip = await JSZip.loadAsync(await anBuildHwpx(anCfg())), sec = await zip.file('Contents/section0.xml').async('string'), head = await zip.file('Contents/header.xml').async('string');
      const m = sec.match(/<hp:p [^>]*paraPrIDRef="(\d+)"[^>]*><hp:run[^>]*>(?:<hp:secPr[\s\S]*?<\/hp:run><hp:run[^>]*>)?<hp:t>- 세부<\/hp:t>/);
      const pp = m && head.match(new RegExp('<hh:paraPr id="' + m[1] + '"[\\s\\S]*?</hh:paraPr>'))[0];
      const ids = [...new Set([...sec.matchAll(/paraPrIDRef="(\d+)"/g)].map(x => x[1]))];
      const keep = ids.every(id => /breakNonLatinWord="KEEP_WORD"/.test(head.match(new RegExp('<hh:paraPr id="' + id + '"[\\s\\S]*?</hh:paraPr>'))[0]));
      return { center: !!pp && /horizontal="CENTER"/.test(pp), keep };
    });
    check('한글 파일: 가운데 정렬로 바꾼 줄은 CENTER, 모든 문단이 어절 단위 줄바꿈(KEEP_WORD)', kz.center && kz.keep, kz);
  }
  // 도구는 ② 제목 바로 아래(줄 목록 위)
  check('줄 도구는 줄 목록 위에', await P.evaluate(() => { const a = document.getElementById('an-cur'), b = document.getElementById('an-rows'); return a.nextElementSibling === b; }));
  // 표: 긴 글도 칸 안에서 줄이 바뀌어 다 보임, Shift+Enter = 칸 안 줄바꿈, 칸 글 정렬
  const tIdx = await P.evaluate(() => anCfg().rows.findIndex(r => r.lv === 'tbl'));
  const cell = P.locator('#an-rows .an-row[data-i="' + tIdx + '"] textarea[data-r="1"][data-k="2"]');
  await cell.click(); await P.keyboard.press('End'); await P.keyboard.press('Shift+Enter'); await P.keyboard.type('(사진 첨부 가능, 출처를 꼭 밝히고 그래프는 직접 그려서 붙임)'); await P.waitForTimeout(250);
  const cv = await P.evaluate((i) => { const t = document.querySelector('#an-rows .an-row[data-i="' + i + '"] textarea[data-r="1"][data-k="2"]'); return { v: anCfg().rows[i].cells[1][2], full: t.scrollHeight <= t.clientHeight + 3, h: t.clientHeight }; }, tIdx);
  check('표 칸: Shift+Enter로 칸 안 줄바꿈, 긴 글은 칸이 높아져 다 보임', /\n\(사진 첨부/.test(cv.v) && cv.full && cv.h > 30, cv);
  await P.click('#an-cur button[title="모든 칸 가운데"]'); await P.waitForTimeout(200);
  check('표 칸 글 정렬 "가운데" → 미리보기 모든 칸 가운데', await P.evaluate(() => [...document.querySelectorAll('#fm-pages .an-tb tr:nth-child(2) td')].every(td => td.style.textAlign === 'center')));
  if (JSZIP_JS) {
    const cz = await P.evaluate(async () => { const sec = await (await JSZip.loadAsync(await anBuildHwpx(anCfg()))).file('Contents/section0.xml').async('string');
      const tc = sec.match(/<hp:tc [^>]*>(?:(?!<\/hp:tc>)[\s\S])*?탐구 과정과 결과를[\s\S]*?<\/hp:tc>/)[0]; return (tc.match(/<hp:p /g) || []).length; });
    check('한글 파일: 칸 안 줄바꿈은 칸 안 문단 두 개', cz === 2, cz);
  }

  // 모양: 들여쓰기 2글자 고정, 내어쓰기 끔
  await P.click('#an-step [data-v="2"]'); await P.click('#an-hang [data-v="false"]'); await P.waitForTimeout(250);
  const st = await P.evaluate(() => { const bs = anCfg().bSize * FM_PT, d = [...document.querySelectorAll('#fm-pages .an-p')].find(x => x.textContent.startsWith('• 평가 기간')); return { pl: parseFloat(d.style.paddingLeft), ti: parseFloat(d.style.textIndent), bs }; });
  check('들여쓰기 "2글자" → 점 줄은 2글자 자리, 내어쓰기 끔 → 넘어간 줄도 기호 자리부터', Math.abs(st.pl - 2 * st.bs) < 0.05 && st.ti === 0, st);
  await P.click('#an-step [data-v="auto"]'); await P.click('#an-hang [data-v="true"]'); await P.waitForTimeout(200);
  // 단추 묶음: 하나만 다음 줄로 떨어지지 않음(한 줄 또는 고른 칸), 글자가 잘리지 않음
  const lay = await P.evaluate(() => {
    const tops = (els) => [...new Set([...els].map(e => Math.round(e.getBoundingClientRect().top)))];
    const rowsOk = [...document.querySelectorAll('#an-grid .an-chips')].every(g => tops(g.children).length === 1);
    const tplRows = tops(document.querySelectorAll('#an-tpls .nt-chip')), perRow = document.querySelectorAll('#an-tpls .nt-chip').length / tplRows.length;
    const cut = [...document.querySelectorAll('#an-grid .an-chips .nt-chip, #an-tpls .nt-chip')].filter(b => b.scrollWidth > b.clientWidth + 1).map(b => b.textContent);
    return { rowsOk, tplRows: tplRows.length, perRow, cut };
  });
  check('고르기 단추는 줄마다 한 줄, 틀 단추는 고르게(4개 한 줄 또는 2×2), 잘린 글자 없음', lay.rowsOk && Number.isInteger(lay.perRow) && lay.cut.length === 0, lay);
  // 좁은 화면으로 바꿔도 ② 내용 칸이 접히지 않음(예전 버그)
  await P.setViewportSize({ width: 1280, height: 800 }); await P.waitForTimeout(500);
  check('넓은 화면 → 좁은 화면으로 바꿔도 ② 내용 칸이 보임', await P.evaluate(() => document.getElementById('an-rows').offsetHeight > 100));
  await P.setViewportSize({ width: 1600, height: 1000 }); await P.waitForTimeout(300);

  // 한 열·종이 순서: 끝맺음은 ② 내용 상자 안 맨 아래, 모양·쪽·글꼴은 "🎨 더 꾸미기"(접힘) 안
  const lay2 = await P.evaluate(() => ({ endIn: !!document.querySelector('#an-rows-box > #an-end-box'), endLast: document.getElementById('an-rows-box').lastElementChild.id === 'an-end-box',
    lookIn: !!document.querySelector('#an-more #an-look-box') && !!document.querySelector('#an-more #an-font-box'),
    endBelowRows: document.getElementById('an-end-box').getBoundingClientRect().top > document.getElementById('an-rows').getBoundingClientRect().bottom,
    cols: new Set([...document.querySelectorAll('#an-grid > *')].map(e => Math.round(e.getBoundingClientRect().left))).size }));
  check('끝맺음은 ② 내용 상자 맨 아래(줄 목록 바로 밑), 모양·쪽·글꼴은 처음에 접힌 "더 꾸미기" 안, 왼쪽은 한 열', lay2.endIn && lay2.endLast && moreClosedAtStart && lay2.lookIn && lay2.endBelowRows && lay2.cols === 1, lay2);
  // 고른 줄을 다시 누르면(글 칸 바깥) 고르기 취소, Esc도
  await P.click('#an-rows .an-row[data-i="2"] textarea.an-tx'); await P.waitForTimeout(100);
  await P.click('#an-rows .an-row[data-i="2"] .an-sym'); await P.waitForTimeout(150);
  const un1 = await P.evaluate(() => ({ cur: document.querySelectorAll('#an-rows .an-row.cur').length, f: anFocus, tool: document.getElementById('an-cur').textContent }));
  await P.click('#an-rows .an-row[data-i="2"] textarea.an-tx'); await P.waitForTimeout(100);
  await P.click('#an-rows .an-row[data-i="2"] textarea.an-tx'); await P.waitForTimeout(100); // 글 칸을 다시 누르는 건 커서 옮기기 — 그대로 고른 채
  const un2 = await P.evaluate(() => document.querySelectorAll('#an-rows .an-row.cur').length);
  await P.keyboard.press('Escape'); await P.waitForTimeout(100);
  const un3 = await P.evaluate(() => document.querySelectorAll('#an-rows .an-row.cur').length);
  check('고른 줄의 기호를 다시 누르면 고르기 취소(도구는 안내 글), 글 칸을 다시 누르면 그대로, Esc로도 취소', un1.cur === 0 && un1.f === null && /줄을 누르면/.test(un1.tool) && un2 === 1 && un3 === 0, { un1, un2, un3 });
  // 끝맺음을 안 넣었으면 미리보기 맨 아래 흐린 안내 → 누르면 켜지고 보낸 이 칸으로(인쇄엔 안 나옴)
  await P.evaluate(() => anSet({ end: false }, true)); await P.waitForTimeout(200);
  const g0 = await P.evaluate(() => ({ n: document.querySelectorAll('#fm-pages .an-ghost').length, last: !!document.querySelector('#fm-pages .an-sheet:last-child .an-ghost') }));
  await P.click('#fm-pages .an-ghost'); await P.waitForTimeout(250);
  const g1 = await P.evaluate(() => ({ end: anCfg().end, n: document.querySelectorAll('#fm-pages .an-ghost').length, focus: document.activeElement && document.activeElement.id, chk: document.getElementById('an-end').checked }));
  await P.emulateMedia({ media: 'print' });
  const gPrint = await P.evaluate(() => { anSet({ end: false }, true); return getComputedStyle(document.querySelector('#fm-pages .an-ghost')).display; });
  await P.emulateMedia({ media: 'screen' }); await P.evaluate(() => anSet({ end: true }, true)); await P.waitForTimeout(150);
  check('끝맺음 없을 때 마지막 쪽에 흐린 "날짜 · 보내는 사람 넣기" 하나 → 누르면 끝맺음 켜짐·보낸 이 칸에 커서·안내 사라짐, 인쇄에선 안 보임', g0.n === 1 && g0.last && g1.end && g1.n === 0 && g1.focus === 'an-end-from' && g1.chk && gPrint === 'none', { g0, g1, gPrint });

  // 틀 단추는 ① 제목 상자의 제목 줄 오른쪽에. 올리면 미리보기에만 예시(내 글은 그대로), 떼면 돌아옴
  await P.evaluate(() => anSet({ title: '내 제목', rows: [{ lv: 'h1', t: '내 글' }] }, true)); await P.waitForTimeout(200);
  await P.hover('#an-tpls [data-tpl="home"]'); await P.waitForTimeout(250);
  const pk1 = await P.evaluate(() => ({ inTitle: !!document.querySelector('#an-title-box .nt-title #an-tpls'), prev: document.querySelector('#fm-pages .an-title').textContent, cfg: anCfg().title, form: document.getElementById('an-title').value, label: document.getElementById('fm-prev-label').textContent }));
  await P.mouse.move(5, 5); await P.waitForTimeout(250);
  const pk2 = await P.evaluate(() => ({ prev: document.querySelector('#fm-pages .an-title').textContent, label: document.getElementById('fm-prev-label').textContent }));
  check('틀 단추는 제목 줄 오른쪽. 올리면 미리보기만 예시(가정통신문 예시 제목)·라벨에 "틀 예시 미리 보기", 내 글·칸은 그대로, 떼면 내 글로', pk1.inTitle && pk1.prev === '2026학년도 3학년 ‘수업량 유연화’ 강좌신청 안내' && pk1.cfg === '내 제목' && pk1.form === '내 제목' && /틀 예시 미리 보기/.test(pk1.label) && pk2.prev === '내 제목' && !/틀 예시/.test(pk2.label), { pk1, pk2 });
  // 상자 줄을 고르면 ＋ 큰·작은 항목·점·줄표·본문·참고는 상자 안 커서 줄 아래에(표·가운데·상자는 밖에). Enter면 같은 기호로 이어지고 기호만 있는 줄에서 Enter면 기호가 지워짐
  await P.evaluate(() => anSet({ rows: [{ lv: 'h1', t: '안내' }, { lv: 'box', t: '첫 줄' }] }, true)); await P.waitForTimeout(200);
  await P.click('#an-rows .an-row[data-i="1"] textarea'); await P.waitForTimeout(150);
  const bm = await P.evaluate(() => ({ cls: document.getElementById('an-add').classList.contains('in-box'), lbl: getComputedStyle(document.getElementById('an-add'), '::before').content }));
  await P.click('#an-add [data-add="b"]'); await P.waitForTimeout(150); await P.keyboard.type('점 하나'); await P.keyboard.press('Enter'); await P.keyboard.type('점 둘');
  await P.keyboard.press('Enter'); await P.keyboard.press('Enter'); await P.keyboard.type('그냥 글'); await P.waitForTimeout(150);
  await P.click('#an-add [data-add="h1"]'); await P.keyboard.type('첫 항목'); await P.keyboard.press('Enter'); await P.keyboard.type('둘째 항목'); await P.waitForTimeout(150);
  await P.click('#an-add [data-add="tbl"]'); await P.waitForTimeout(200);
  const bx = await P.evaluate(() => ({ t: anCfg().rows[1].t, n: anCfg().rows.length, lv2: anCfg().rows[2] && anCfg().rows[2].lv, act: document.activeElement.tagName }));
  check('상자 안: "상자 안에" 표시, ＋ 점 → 상자 안에 "• 점 하나", Enter → "• 점 둘", 빈 점 줄 Enter → 기호 지움, ＋ 큰 항목 → "1." 다음 Enter "2.", ＋ 표는 상자 밖 새 줄',
    bm.cls && /상자 안에/.test(bm.lbl) && bx.t === '첫 줄\n• 점 하나\n• 점 둘\n그냥 글\n1. 첫 항목\n2. 둘째 항목' && bx.n === 3 && bx.lv2 === 'tbl', { bm, bx });
  await P.evaluate(() => anUnpick());
  check('상자 줄을 안 고르면 "상자 안에" 표시 없음', await P.evaluate(() => !document.getElementById('an-add').classList.contains('in-box')));
  // 상자 안 줄별 들여쓰기: 도구 ◀ ▶·Tab·Shift+Tab은 상자 전체가 아니라 커서가 있는 줄(앞의 탭 = 한 글자). 미리보기·한글 문단 왼쪽 여백에 반영
  await P.evaluate(() => anSet({ rows: [{ lv: 'h1', t: '안내' }, { lv: 'box', t: '첫 줄\n• 둘째 줄' }] }, true)); await P.waitForTimeout(200);
  await P.click('#an-rows .an-row[data-i="1"] textarea'); await P.evaluate(() => { const ta = anBoxTa(1); ta.setSelectionRange(ta.value.length, ta.value.length); }); await P.waitForTimeout(100);
  const boxPl = () => P.evaluate(() => [...document.querySelectorAll('#fm-pages .an-box .an-p')].map(d => parseFloat(d.style.paddingLeft) + parseFloat(d.style.textIndent)));
  const bp0 = await boxPl();
  await P.click('#an-cur button[title^="상자 안 커서가 있는 줄을 한 글자 오른쪽으로"]'); await P.waitForTimeout(150);
  const bi1 = await P.evaluate(() => ({ t: anCfg().rows[1].t, ind: anCfg().rows[1].ind || 0, lb: document.getElementById('an-cur').textContent.includes('들여쓰기(커서 줄)'), iv: document.querySelector('#an-cur .an-iv').textContent, act: document.activeElement.tagName }));
  const bp1 = await boxPl();
  await P.keyboard.press('Tab'); await P.waitForTimeout(100); const bi2 = await P.evaluate(() => anCfg().rows[1].t);
  await P.keyboard.press('Shift+Tab'); await P.waitForTimeout(100); const bi3 = await P.evaluate(() => anCfg().rows[1].t);
  await P.keyboard.press('Enter'); await P.keyboard.type('셋째'); await P.waitForTimeout(100); const bi4 = await P.evaluate(() => anCfg().rows[1].t);
  await P.click('#an-cur button[title^="상자 안 커서가 있는 줄을 한 글자 왼쪽으로"]'); await P.waitForTimeout(100); const bi5 = await P.evaluate(() => anCfg().rows[1].t);
  check('상자 커서 줄 ▶ → 그 줄 앞에 탭(상자 ind는 0), 도구 "들여쓰기(커서 줄)" +1, 미리보기 둘째 줄만 한 글자 들어감 · Tab 두 번째 · Shift+Tab 하나 · Enter 다음 줄도 같은 들여쓰기·같은 기호 · ◀ 뺌',
    bi1.t === '첫 줄\n\t• 둘째 줄' && bi1.ind === 0 && bi1.lb && bi1.iv === '+1' && bi1.act === 'TEXTAREA' && bp0[0] === bp1[0] && bp1[1] - bp0[1] > 3 && bi2 === '첫 줄\n\t\t• 둘째 줄' && bi3 === '첫 줄\n\t• 둘째 줄' && bi4 === '첫 줄\n\t• 둘째 줄\n\t• 셋째' && bi5 === '첫 줄\n\t• 둘째 줄\n• 셋째', { bi1, bp0, bp1, bi2, bi3, bi4, bi5 });
  if (JSZIP_JS) {
    const xmlBox = await P.evaluate(async () => { const z = await JSZip.loadAsync(await anBuildHwpx(anCfg())); const x = await z.file('Contents/section0.xml').async('string'); const h = await z.file('Contents/header.xml').async('string'); return { x, h }; });
    // 들여쓴 줄의 문단 모양은 left > 0 (header.xml의 paraPr 중 하나) — 느슨하게: "둘째 줄" 문단이 있고, 상자 줄 문단 모양 중 왼쪽 여백이 0이 아닌 것이 있음
    check('한글 파일: 상자 안 들여쓴 줄(둘째 줄)이 들어 있음', /둘째 줄/.test(xmlBox.x) && /셋째/.test(xmlBox.x), null);
  }
  await P.evaluate(() => anUnpick());
  // 내 안내문 보관함: 💾 보관(이름) → 단추 생김(서버 키 fm-an-saved), 올리면 미리보기, 글을 바꾼 뒤 눌러 불러오기(확인), 🗑 초기화해도 남음, ✕ 지우기
  await P.evaluate(() => anSet({ title: '보관할 제목', sub: '', rows: [{ lv: 'h1', t: '보관 글' }], deco: 'box' }, true)); await P.waitForTimeout(200);
  await P.click('#an-save-btn'); await P.waitForSelector('#custom-prompt-overlay', { state: 'visible' });
  const defName = await P.evaluate(() => document.getElementById('custom-prompt-input').value);
  await P.fill('#custom-prompt-input', '우리 반 안내'); await P.click('#custom-prompt-ok-btn'); await P.waitForTimeout(400);
  const sv1 = await P.evaluate(() => ({ chips: [...document.querySelectorAll('#an-saved [data-doc]')].map(b => b.textContent), stored: JSON.parse(localStorage.getItem('fm-an-saved')).map(x => x.name) }));
  await P.waitForTimeout(2200);
  const sv1s = serverVal(T2, 'fm-an-saved');
  check('💾 보관: 기본 이름 = 제목, 이름을 적으면 "내 안내문"에 단추, 서버에도 fm-an-saved로 올라감', defName === '보관할 제목' && sv1.chips.join() === '📄 우리 반 안내' && sv1.stored.join() === '우리 반 안내' && typeof sv1s === 'string' && /우리 반 안내/.test(sv1s), { defName, sv1, sv1s: String(sv1s).slice(0, 80) });
  await P.evaluate(() => anSet({ title: '다른 글', rows: [{ lv: 'b', t: '다른 내용' }], deco: 'line' }, true)); await P.waitForTimeout(200);
  await P.hover('#an-saved [data-doc]'); await P.waitForTimeout(250);
  const sv2 = await P.evaluate(() => ({ prev: document.querySelector('#fm-pages .an-title').textContent, cfg: anCfg().title, border: document.querySelector('#fm-pages .an-title').style.border }));
  await P.mouse.move(5, 5); await P.waitForTimeout(200);
  await P.click('#an-saved [data-doc]'); await P.waitForSelector('#custom-confirm-overlay', { state: 'visible' }); await P.click('#custom-confirm-ok-btn'); await P.waitForTimeout(300);
  const sv3 = await P.evaluate(() => ({ title: anCfg().title, rows: anCfg().rows.map(r => r.lv + ':' + r.t).join(), deco: anCfg().deco, form: document.getElementById('an-title').value }));
  check('보관한 글 단추: 올리면 미리보기에 그 글(모양까지 — 제목 상자), 내 글은 그대로 · 누르고 확인하면 제목·내용·모양이 보관한 대로', sv2.prev === '보관할 제목' && sv2.cfg === '다른 글' && !!sv2.border && sv3.title === '보관할 제목' && sv3.rows === 'h1:보관 글' && sv3.deco === 'box' && sv3.form === '보관할 제목', { sv2, sv3 });
  await P.click('#fm-reset-btn'); await P.waitForSelector('#custom-confirm-overlay', { state: 'visible' }); await P.click('#custom-confirm-ok-btn'); await P.waitForTimeout(300);
  const sv4 = await P.evaluate(() => ({ chips: document.querySelectorAll('#an-saved [data-doc]').length, title: anCfg().title }));
  await P.click('#an-saved .an-sv .ws-ol-x'); await P.waitForSelector('#custom-confirm-overlay', { state: 'visible' }); await P.click('#custom-confirm-ok-btn'); await P.waitForTimeout(300);
  const sv5 = await P.evaluate(() => ({ chips: document.querySelectorAll('#an-saved [data-doc]').length, empty: /보관한 글이 없어요/.test(document.getElementById('an-saved').textContent) }));
  check('🗑 초기화해도 보관함은 남음(글만 예시로), ✕로 지우면 비어 있다는 안내', sv4.chips === 1 && sv4.title === '2학기 화학Ⅱ 수행평가 안내' && sv5.chips === 0 && sv5.empty, { sv4, sv5 });

  // 빈 줄: ＋ ↵ 빈 줄 = 글 없는 본문 줄, 기호만 있는 빈 줄에서 Enter = 그 줄이 빈 줄로(한글처럼 Enter 두 번), 상자 안이면 빈 줄 하나
  await P.evaluate(() => anSet({ rows: [{ lv: 'h1', t: '안내' }, { lv: 'b', t: '점' }] }, true)); await P.waitForTimeout(200);
  await P.click('#an-rows .an-row[data-i="1"] textarea.an-tx'); await P.keyboard.press('End'); await P.keyboard.press('Shift+Enter'); await P.waitForTimeout(150);
  const bl1 = await P.evaluate(() => anCfg().rows.map(r => r.lv + ':' + r.t).join());
  await P.keyboard.press('Enter'); await P.waitForTimeout(150);
  const bl2 = await P.evaluate(() => anCfg().rows.map(r => r.lv + ':' + r.t).join());
  await P.click('#an-add [data-add="blank"]'); await P.waitForTimeout(150);
  const bl3 = await P.evaluate(() => ({ rows: anCfg().rows.map(r => r.lv + ':' + r.t).join(), blank: [...document.querySelectorAll('#fm-pages .an-sheet > .an-p.an-p')].filter(d => d.innerHTML === '&nbsp;').length }));
  await P.evaluate(() => { anUnpick(); anSet({ rows: [{ lv: 'box', t: '첫 줄\n둘째' }] }, true); }); await P.waitForTimeout(150); // 커서가 줄 안에 있으면 줄 목록을 다시 안 그리므로 먼저 고르기 취소
  await P.click('#an-rows .an-row[data-i="0"] textarea'); await P.evaluate(() => { const ta = anBoxTa(0); ta.setSelectionRange(2, 2); }); await P.click('#an-add [data-add="blank"]'); await P.waitForTimeout(150);
  const bl4 = await P.evaluate(() => anCfg().rows[0].t);
  check('점 줄 Shift+Enter → 새 점 줄, 빈 점 줄에서 Enter → 빈 줄(본문), ＋ ↵ 빈 줄 → 빈 줄 하나 더(미리보기에 빈 줄 2개), 상자 안이면 커서 줄 아래 빈 줄', bl1 === 'h1:안내,b:점,b:' && bl2 === 'h1:안내,b:점,p:' && bl3.rows === 'h1:안내,b:점,p:,p:' && bl3.blank === 2 && bl4 === '첫 줄\n\n둘째', { bl1, bl2, bl3, bl4 });

  // 긴 글은 칸이 저절로 높아져 다 보임(한 줄 입력칸이 아니라 textarea)
  await P.evaluate(() => { anUnpick(); anSet({ rows: [{ lv: 'p', t: '짧은 글' }, { lv: 'p', t: '아주 긴 글 '.repeat(40) }] }, true); }); await P.waitForTimeout(200);
  const txh = await P.evaluate(() => [...document.querySelectorAll('#an-rows textarea.an-tx')].map(t => ({ h: t.offsetHeight, sh: t.scrollHeight, cut: t.scrollHeight > t.offsetHeight + 1 })));
  check('긴 글 줄은 칸이 높아져 잘리지 않음(짧은 글은 한 줄 높이)', txh.length === 2 && txh[0].h < 36 && txh[1].h > txh[0].h * 2 && !txh[1].cut, txh);
  await P.setViewportSize({ width: 1200, height: 800 }); await P.waitForTimeout(400);
  const txh2 = await P.evaluate(() => [...document.querySelectorAll('#an-rows textarea.an-tx')].map(t => ({ h: t.offsetHeight, cut: t.scrollHeight > t.offsetHeight + 1 })));
  await P.setViewportSize({ width: 1600, height: 1000 }); await P.waitForTimeout(300);
  check('창을 좁혀 줄 수가 늘어도 칸 높이가 따라감', txh2[1].h > txh[1].h && !txh2[1].cut, { txh, txh2 });

  // 표 칸 폭: 긴 칸이 있어도 짧은 제목 칸(연번·학년·인원)은 글이 한 줄에 들어갈 폭을 지킴(한글에서 "연/번"으로 꺾이던 것)
  await P.evaluate(() => { anUnpick(); anSet({ rows: [{ lv: 'tbl', head: true, cells: [['연번', '학년', '주제 또는 제목', '융합교과', '수업장소', '인원'], ['1', '3', '아주 긴 주제 '.repeat(8), '국어+영어+영상제작', '3-3, 3-5, 교내 및 학교 인근', '45']] }] }, true); }); await P.waitForTimeout(250);
  const tw = await P.evaluate(() => { const t = document.querySelector('#fm-pages .an-tb'); const w = [...t.querySelectorAll('col')].map(c => parseFloat(c.style.width)); const h = [...t.rows[0].cells].map(td => td.getBoundingClientRect().height); return { w, sameH: Math.max(...h) - Math.min(...h) < 1, total: w.reduce((a, b) => a + b, 0), W: parseFloat(t.style.width) }; });
  check('짧은 칸(연번·학년·인원)은 12mm 이상(글이 안 꺾임), 긴 칸이 나머지를 나눔, 폭 합 = 표 폭', tw.w[0] >= 11.9 && tw.w[1] >= 11.9 && tw.w[5] >= 11.9 && tw.w[2] > tw.w[0] * 3 && Math.abs(tw.total - tw.W) < 0.05, tw);

  // 점 기호 ☑는 선택지에서 뺌 → 저장돼 있던 ☑는 •로(모양은 틀 공통 설정이라 수행평가 틀에서도 •)
  const bulFix = await P.evaluate(() => { const v = JSON.parse(localStorage.getItem('fm-an') || '{}'); v.bul = '☑'; localStorage.setItem('fm-an', JSON.stringify(v)); anFillForm(); return { bul: anCfg().bul, chip: !!document.querySelector('#an-bul [data-v="☑"]'), add: document.querySelector('#an-add [data-add="b"]').textContent }; });
  check('저장된 점 기호 ☑ → •로 돌아감, 선택지에 ☑ 없음, ＋ 단추도 •', bulFix.bul === '•' && !bulFix.chip && bulFix.add === '＋ • 점', bulFix);

  // Enter = 줄 안 줄바꿈(미리보기 두 줄, 한글 파일 lineBreak), 도구의 빈 줄 ▲ ▼ = 고른 줄 위·아래에 빈 줄, 도구는 두 줄
  await P.evaluate(() => { anUnpick(); anSet({ rows: [{ lv: 'h1', t: '안내' }, { lv: 'b', t: '첫째' }] }, true); }); await P.waitForTimeout(200);
  await P.click('#an-rows .an-row[data-i="1"] textarea.an-tx'); await P.keyboard.press('End'); await P.keyboard.press('Enter'); await P.keyboard.type('둘째 줄'); await P.waitForTimeout(200);
  const lb = await P.evaluate(() => ({ t: anCfg().rows[1].t, n: anCfg().rows.length, prevH: document.querySelector('#fm-pages .an-b').getBoundingClientRect().height, lh: document.querySelector('#fm-pages .an-h1').getBoundingClientRect().height }));
  await P.click('#an-cur button[title="이 줄 위에 빈 줄"]'); await P.waitForTimeout(150);
  const lb2 = await P.evaluate(() => anCfg().rows.map(r => r.lv + ':' + r.t.replace(/\n/g, '/')).join());
  await P.evaluate(() => anPick(2)); await P.click('#an-cur button[title="이 줄 아래에 빈 줄"]'); await P.waitForTimeout(150);
  const lb3 = await P.evaluate(() => ({ rows: anCfg().rows.map(r => r.lv + ':' + r.t.replace(/\n/g, '/')).join(), lines: [...document.querySelectorAll('#an-cur .an-cl')].map(l => { const t = [...l.querySelectorAll('button')].map(b => b.getBoundingClientRect().top); return Math.max(...t) - Math.min(...t) < 4 ? 1 : 2; }) }));
  check('Enter → 같은 줄 안 줄바꿈(줄 수 그대로, 미리보기 두 줄 높이), 빈 줄 ▲ → 위에 빈 줄, ▼ → 아래에 빈 줄, 도구 각 줄은 한 줄', lb.t === '첫째\n둘째 줄' && lb.n === 2 && lb.prevH > lb.lh * 1.8 && lb2 === 'h1:안내,p:,b:첫째/둘째 줄' && lb3.rows === 'h1:안내,p:,b:첫째/둘째 줄,p:' && lb3.lines.every(n => n === 1), { lb, lb2, lb3 });
  if (JSZIP_JS) {
    const lbx = await P.evaluate(async () => { const z = await JSZip.loadAsync(await anBuildHwpx(anCfg())); const sec = await z.file('Contents/section0.xml').async('string'); return /<hp:t>• 첫째<hp:lineBreak\/>둘째 줄<\/hp:t>/.test(sec); });
    check('한글 파일: 줄 안 줄바꿈은 같은 문단의 lineBreak', lbx);
  }

  // 🎨 더 꾸미기 바는 내용이 길어도 왼쪽 화면 맨 아래에 늘 보임(접혀 있을 때)
  await P.evaluate(() => anSet({ rows: Array.from({ length: 40 }, (_, i) => ({ lv: 'b', t: '긴 내용 ' + (i + 1) })) }, true)); await P.waitForTimeout(200);
  await P.setViewportSize({ width: 1280, height: 720 }); await P.waitForTimeout(400);
  await P.evaluate(() => { document.getElementById('an-more').open = false; document.getElementById('fm-left').scrollTop = 0; }); await P.waitForTimeout(150);
  const stk = await P.evaluate(() => { const r = document.getElementById('an-more').getBoundingClientRect(), L = document.getElementById('fm-left').getBoundingClientRect(); return { top: r.top, bottom: r.bottom, lb: L.bottom, vis: r.top >= L.top && r.bottom <= L.bottom + 1, closed: !document.getElementById('an-more').open, scrollH: document.getElementById('fm-left').scrollHeight, clientH: document.getElementById('fm-left').clientHeight }; });
  check('줄 40개로 왼쪽이 길어져도(스크롤 맨 위) 🎨 더 꾸미기 바가 왼쪽 화면 안 맨 아래에 보임', stk.vis && stk.closed && stk.scrollH > stk.clientH && stk.lb - stk.bottom <= 16, stk); // 바닥 여백(#fm-left padding 14px)만큼 위
  await P.setViewportSize({ width: 1600, height: 1000 }); await P.waitForTimeout(300);

  // 🏫 가정통신문 틀 = 우리 학교 양식: 학교 머리 켜짐(부서·발행일 칸), 미리보기에 머리 그림 + 부서·발행일 상자(종이 기준 위치), 경기천년 글꼴·쪽 여백, 맨 아래 발행일 날짜 + 부광고등학교장
  await P.mouse.move(5, 5);
  await P.click('#an-tpls [data-tpl="home"]'); await P.waitForTimeout(200);
  if (await P.$('#custom-confirm-overlay:visible')) { await P.click('#custom-confirm-ok-btn'); await P.waitForTimeout(300); }
  await P.mouse.move(5, 5); await P.waitForTimeout(150);
  await setText(P, '#an-issue', '2026. 6. 24.'); await P.waitForTimeout(250);
  const sc = await P.evaluate(() => { const c = anCfg(), img = document.querySelector('#fm-pages .an-head img'), bx = [...document.querySelectorAll('#fm-pages .an-hbox')];
    const sh = document.querySelector('#fm-pages .an-sheet').getBoundingClientRect(), mm = sh.width / 210;
    const ps = [...document.querySelectorAll('#fm-pages .an-sheet .an-p')].map(d => d.textContent);
    return { school: c.school, dept: c.dept, chk: document.getElementById('an-school').checked, deptOn: !document.getElementById('an-dept').disabled, endRow: document.querySelector('#an-end-box .an-end-row').style.display, fixed: document.getElementById('an-end-fixed').style.display,
      img: img ? { src: img.getAttribute('src'), w: Math.round(img.getBoundingClientRect().width / mm), loaded: img.complete && img.naturalWidth > 0 } : null,
      boxes: bx.map(b => { const r = b.getBoundingClientRect(); return { t: b.textContent, x: Math.round((r.left - sh.left) / mm), y: Math.round((r.top - sh.top) / mm) }; }),
      tFont: c.tFont, bFont: c.bFont, bul: c.bul, mL: c.mL, mR: c.mR, last2: ps.slice(-2), title: ps[0] }; });
  check('🏫 가정통신문 틀: 학교 머리 켜짐(부서 교육과정부, 칸 활성, 끝맺음 칸 대신 고정 안내), 미리보기 머리 그림 177mm(파일 받아짐) + 부서(17,41mm)·발행일(164,41mm) 상자, 경기천년 글꼴·점 •·여백 16/18, 맨 아래 "2026년  6월  24일"·"부 광 고 등 학 교 장"',
    sc.school && sc.dept === '교육과정부' && sc.chk && sc.deptOn && sc.endRow === 'none' && sc.fixed === '' && sc.img && /가정통신문-머리\.jpg$/.test(sc.img.src) && Math.abs(sc.img.w - 177) <= 1 && sc.img.loaded &&
    sc.boxes.length === 2 && sc.boxes[0].t === '교육과정부' && Math.abs(sc.boxes[0].x - 17) <= 1 && Math.abs(sc.boxes[0].y - 41) <= 1 && sc.boxes[1].t === '2026. 6. 24.' && Math.abs(sc.boxes[1].x - 164) <= 1 &&
    sc.tFont === '경기천년제목 Medium' && sc.bFont === '경기천년바탕 Regular' && sc.bul === '•' && sc.mL === 16 && sc.mR === 18 && sc.last2[0] === '2026년  6월  24일' && sc.last2[1] === '부 광 고 등 학 교 장', sc);
  if (JSZIP_JS) {
    const sx = await P.evaluate(async () => { const z = await JSZip.loadAsync(await anBuildHwpx(anCfg())); const sec = await z.file('Contents/section0.xml').async('string'); const h = await z.file('Contents/header.xml').async('string'); const hpf = await z.file('Contents/content.hpf').async('string'); const img = z.file('BinData/image1.jpg');
      return { img: img ? (await img.async('uint8array')).length : 0, manifest: /<opf:item id="image1" href="BinData\/image1.jpg"/.test(hpf), pic: /<hp:pic [^>]*textWrap="BEHIND_TEXT"[\s\S]*?binaryItemIDRef="image1"/.test(sec),
        rects: (sec.match(/<hp:rect /g) || []).length, deptRect: /<hp:rect [^>]*>[\s\S]*?<hp:t>교육과정부<\/hp:t>[\s\S]*?horzOffset="4893"/.test(sec), issueRect: /<hp:t>2026\. 6\. 24\.<\/hp:t>[\s\S]*?horzOffset="46473"/.test(sec),
        secFirst: sec.indexOf('<hp:secPr') < sec.indexOf('<hp:pic'), spacer: (() => { const m = sec.match(/<\/hp:rect><hp:tbl [^>]*rowCnt="1" colCnt="1"[^>]*><hp:sz width="\d+" widthRelTo="ABSOLUTE" height="(\d+)"/); return m ? Math.round(+m[1] / 283.46) : 0; })(), fonts: /경기천년제목 Medium/.test(h) && /경기천년바탕 Regular/.test(h), from: /부 광 고 등 학 교 장/.test(sec), date: /2026년  6월  24일/.test(sec), margin: /<hp:margin header="0" footer="0" gutter="0" left="4535" right="5102" top="4252" bottom="3969"\/>|left="4535"/.test(sec) }; });
    check('한글 파일: BinData/image1.jpg(231KB) + 목록, 글 뒤 그림 문단(쪽 설정 다음), 글상자 2개(부서 4893·발행일 46473 위치), 자리 비우는 표 38.5mm, 경기천년 글꼴, 발행일 날짜·학교장, 왼쪽 여백 16mm', sx.img > 200000 && sx.manifest && sx.pic && sx.rects === 2 && sx.deptRect && sx.issueRect && sx.secFirst && Math.abs(sx.spacer - 38.5) <= 1 && sx.fonts && sx.from && sx.date && sx.margin, sx);
  }
  if (JSZIP_JS) { // 제목 꾸밈 없음 → 한글 제목 문단은 가운데(예전엔 문단 모양 번호가 틀려 양쪽 정렬) · 큰 항목 위 "한 줄" → 둘째 큰 항목 앞에 빈 문단
    const tx = await P.evaluate(async () => { const z = await JSZip.loadAsync(await anBuildHwpx(anCfg())); const sec = await z.file('Contents/section0.xml').async('string'); const h = await z.file('Contents/header.xml').async('string');
      const i = sec.indexOf('강좌신청 안내'), j = sec.lastIndexOf('<hp:p ', i), pp = sec.slice(j, i).match(/paraPrIDRef="(\d+)"/)[1];
      const al = (h.match(new RegExp('<hh:paraPr id="' + pp + '"[^>]*>[\\s\\S]*?<hh:align horizontal="(\\w+)"')) || [])[1];
      const k = sec.indexOf('<hp:t>2. 신청방법'), prevP = sec.slice(0, k).split('<hp:p ').slice(-2)[0]; // 바로 앞 문단
      const t2 = sec.slice(i); const nextP = t2.slice(t2.indexOf('</hp:p>') + 7); const gapP = nextP.slice(0, nextP.indexOf('</hp:p>') + 7); const gcp = (gapP.match(/charPrIDRef="(\d+)"/) || [])[1]; const gsz = gcp && (h.match(new RegExp('<hh:charPr id="' + gcp + '" height="(\\d+)"')) || [])[1];
      return { titleGapBlank: /<hp:t\/>/.test(gapP) && !/<hp:t>[^<]/.test(gapP), titleGapPt: gsz ? +gsz / 100 : 0, noNext: !/<hc:next value="[1-9]/.test(h), al, gap: anCfg().gap, blankBefore: /<hp:t\/>/.test(prevP) && !/<hp:t>[^<]/.test(prevP), prevMm: (() => { const d = [...document.querySelectorAll('#fm-pages .an-p')].find(x => x.textContent.startsWith('2. 신청방법')); return d ? parseFloat(d.style.marginTop) : -1; })() }; });
    check('한글 파일: 제목(꾸밈 없음) 가운데 정렬 + 그 아래 간격은 17pt 빈 문단(문단 위·아래 간격은 안 씀), 큰 항목 위 "한 줄" = 2. 앞에 빈 문단(미리보기도 한 줄 높이 띄움)', tx.al === 'CENTER' && tx.gap === 'line' && tx.blankBefore && tx.prevMm > 5 && tx.titleGapBlank && Math.abs(tx.titleGapPt - 17) <= 0.6, tx);
  }
  await P.click('#an-school'); await P.waitForTimeout(250);
  const sc2 = await P.evaluate(() => ({ school: anCfg().school, img: !!document.querySelector('#fm-pages .an-head'), boxes: document.querySelectorAll('#fm-pages .an-hbox').length, endRow: document.querySelector('#an-end-box .an-end-row').style.display, deptOn: !document.getElementById('an-dept').disabled }));
  check('학교 머리를 끄면 그림·상자 없고 끝맺음 칸이 다시 보임, 부서 칸 비활성', !sc2.school && !sc2.img && sc2.boxes === 0 && sc2.endRow === '' && !sc2.deptOn, sc2);
  if (JSZIP_JS) {
    const sx2 = await P.evaluate(async () => { const z = await JSZip.loadAsync(await anBuildHwpx(anCfg())); const hpf = await z.file('Contents/content.hpf').async('string'); return { img: !!z.file('BinData/image1.jpg'), manifest: /image1/.test(hpf) }; });
    check('학교 머리를 끄면 한글 파일에 그림 없음', !sx2.img && !sx2.manifest, sx2);
  }

  // 초기화 → 처음 예시로, 다른 양식은 그대로
  await P.click('#fm-reset-btn'); await P.waitForSelector('#custom-confirm-overlay', { state: 'visible' }); await P.click('#custom-confirm-ok-btn'); await P.waitForTimeout(300);
  check('🗑 초기화 → 수행평가 안내 예시로', await P.evaluate(() => anCfg().title === '2학기 화학Ⅱ 수행평가 안내' && anCfg().n1 === '1.'));
  if (process.env.SHOT) await P.screenshot({ path: process.env.SHOT, fullPage: false });

  const allErrors = pages.flatMap(p => (p.errors || []).map(e => p.name + ': ' + e));
  check('전체 페이지 오류 없음', allErrors.length === 0, allErrors);
  console.log(failures === 0 ? '\n모든 검사 통과' : '\n실패 ' + failures + '건');
  await browser.close();
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
