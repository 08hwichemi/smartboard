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
  const last = P.locator('#an-rows .an-row').last().locator('input[type="text"]');
  await last.click(); await last.press('End'); await last.press('Enter'); await P.waitForTimeout(200);
  check('Enter → 아래에 같은 종류 줄(참고)', await rowsN() === n0 + 1 && await P.evaluate(() => anCfg().rows[anCfg().rows.length - 1].lv) === 'n');
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
  await P.keyboard.press('Enter'); await P.waitForTimeout(150);
  const n1 = await rowsN();
  await P.keyboard.press('Backspace'); await P.waitForTimeout(150);
  check('빈 칸에서 Backspace → 그 줄 지움', await rowsN() === n1 - 1);

  // 여러 줄 붙여 넣기 → 앞 기호로 나눔
  await P.click('[data-tpl="blank"]'); await P.waitForTimeout(200);
  await P.waitForSelector('#custom-confirm-overlay', { state: 'visible' }); await P.click('#custom-confirm-ok-btn'); await P.waitForTimeout(300);
  check('빈 안내문 틀 → 제목 비고 줄 3개(1. • •)', await P.evaluate(() => { const c = anCfg(); return c.title === '' && c.rows.map(r => r.lv).join() === 'h1,b,b'; }));
  await P.evaluate(() => {
    const inp = document.querySelector('#an-rows .an-row[data-i="0"] input[type="text"]'); inp.focus();
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
    const inp = document.querySelector('#an-rows .an-row[data-i="5"] input[type="text"]'); inp.focus();
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
    const inp = document.querySelector('#an-rows .an-row[data-i="' + i + '"] input[data-r="3"][data-k="0"]'); inp.focus();
    const dt = new DataTransfer(); dt.setData('text/plain', '11. 19.\t수능\t3학년\n12. 1.\t축제\t전교생');
    inp.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, ti);
  await P.waitForTimeout(300);
  const tr2 = await P.evaluate((i) => anCfg().rows[i].cells, ti);
  check('표 칸에 여러 칸 붙여 넣기 → 그 칸부터 채우고 모자란 줄은 늘림', tr2.length === 5 && tr2[3].join() === '11. 19.,수능,3학년' && tr2[4][2] === '전교생', tr2);
  // 줄 종류 바꾸기: 본문 → 상자
  await P.selectOption('#an-rows .an-row[data-i="5"] select.an-lv', 'box'); await P.waitForTimeout(200);
  check('줄 종류를 상자로 → 미리보기에 상자', (await prev()).boxes === 1);

  // 모양: 큰 항목 Ⅰ., 점 ○, 제목 꾸미기 상자
  await P.click('#an-n1 [data-v="Ⅰ."]'); await P.click('#an-bul [data-v="○"]'); await P.click('#an-deco [data-v="box"]'); await P.waitForTimeout(250);
  const d2 = await prev();
  check('모양: 큰 항목 Ⅰ., 점 ○', d2.paras.some(p => p.t === 'Ⅰ. 일시: 10월 20일') && d2.paras.some(p => p.t === '○ 준비물'), d2.paras.map(p => p.t));
  check('＋ 단추 이름도 바뀐 기호로', await P.evaluate(() => document.querySelector('#an-add [data-add="b"]').textContent) === '○ 점');
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
