// 레일 "양식" → 🔔 시정표: 탭 전환, 평상시(관리자 일과 시간에서 교시 시간 + 조회·중식·청소·자기주도학습 줄, 고친 칸만 따로), 단축 수업(교시마다 직접, 평상시와 따로),
// 시험 기간(정기고사 시정표 + 일차별 시간표 — 예비·준비 저절로, 같은 교시 두 과목, 일차 더하기, 넣을 쪽·글씨·용지, 한글 파일), 시간 순 정렬·분 계산, 디자인(완성 세트 8개 — 작은 그림), 세부 설정(시간 표기·머리 줄·칸 너비·표 폭·글씨 크기·줄 높이), 한글 파일.
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
  if (table === 'app_settings' && filters.some(f => f.val === 'class_times')) return { data: { value: [{ s: '08:50', e: '09:40' }, { s: '09:50', e: '10:40' }, { s: '10:50', e: '11:40' }, { s: '11:50', e: '12:40' }, { s: '13:30', e: '14:20' }, { s: '14:30', e: '15:20' }, { s: '15:40', e: '16:30' }] }, error: null };
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
  await P.click('#fm-kind-switch [data-kind="bs"]'); await P.waitForTimeout(800);
  const vis = await P.evaluate(() => ({ bs: getComputedStyle(document.getElementById('bs-grid')).display !== 'none', pe: document.getElementById('pe-grid').style.display, ws: document.getElementById('ws-grid').style.display,
    fm: document.getElementById('fm-grid').style.display, xlsx: document.getElementById('fm-xlsx-btn').style.display, kind: JSON.parse(localStorage.getItem('fm-cfg')).kind, tabs: [...document.querySelectorAll('#fm-kind-switch .tab-btn')].map(b => b.textContent).join() }));
  check('시정표 탭: 시정표 칸만 보이고 엑셀 버튼 숨김, 탭 다섯 개(시정표가 맨 앞·이름표 맨 뒤)', vis.bs && vis.pe === 'none' && vis.ws === 'none' && vis.fm === 'none' && vis.xlsx === 'none' && vis.kind === 'bs' && vis.tabs === '시정표,명렬표 수합,학습지,수행평가,이름표', vis);
  const prev = () => P.evaluate(() => { const sh = document.querySelector('#fm-pages .bs-sheet'); if (!sh) return { none: document.getElementById('fm-pages').textContent };
    const tbls = [...sh.querySelectorAll('table.bs-tbl')], main = tbls[tbls.length - 1], r = sh.getBoundingClientRect(), k = r.width / sh.offsetWidth;
    return { w: sh.style.width, tables: tbls.length, title: sh.querySelector('.bs-title').textContent, sub: (sh.querySelector('.bs-sub') || {}).textContent || '',
      rows: [...main.rows].map(tr => [...tr.cells].map(c => c.textContent).join('|')), kinds: [...main.rows].map(tr => tr.dataset.k || ''),
      bg: [...main.rows].map(tr => getComputedStyle(tr.cells[0]).backgroundColor), hs: [...main.rows].map(tr => Math.round(tr.getBoundingClientRect().height / k / 3.78 * 10) / 10),
      fs: [...main.rows].slice(-1)[0] ? [...[...main.rows].slice(-1)[0].cells].map(c => getComputedStyle(c).fontSize) : [], tw: Math.round(main.getBoundingClientRect().width / k / 3.78),
      bottom: Math.round((r.bottom - main.getBoundingClientRect().bottom) / k / 3.78 * 10) / 10, titleBg: getComputedStyle(sh.querySelector('.bs-title')).backgroundColor,
      info: document.getElementById('bs-info').textContent, fit: document.getElementById('fm-fit-info').textContent }; });
  const d0 = await prev();
  const R0 = ['구분|시간|분', '조회|08:40 - 08:50|10분', '1교시|08:50 - 09:40|50분', '2교시|09:50 - 10:40|50분', '3교시|10:50 - 11:40|50분', '4교시|11:50 - 12:40|50분', '중식|12:40 - 13:30|50분',
    '5교시|13:30 - 14:20|50분', '6교시|14:30 - 15:20|50분', '청소|15:20 - 15:40|20분', '7교시|15:40 - 16:30|50분', '자기주도학습1|17:30 - 18:40|70분', '자기주도학습2|18:50 - 20:00|70분'];
  check('처음: 사용자 엑셀과 같은 시정표 — 제목 "부광고등학교 시정표", 교시 시간은 관리자 일과 시간, 조회·중식(4~5교시 사이)·청소(6~7교시 사이)·자기주도학습 1·2, 분 계산',
    d0.title === '부광고등학교 시정표' && d0.tables === 2 && JSON.stringify(d0.rows) === JSON.stringify(R0), d0.rows);
  check('엑셀처럼 색: 제목 하늘·머리 줄 연두·중식 살구·청소 노랑, 교시 줄 흰색', d0.titleBg === 'rgb(218, 227, 243)' && d0.bg[0] === 'rgb(226, 239, 218)' && d0.bg[6] === 'rgb(252, 228, 214)' && d0.bg[9] === 'rgb(255, 242, 204)' && d0.bg[2] === 'rgba(0, 0, 0, 0)', d0.bg);
  check('한 장에 꽉 채우기: A4 폭 180mm 표, 줄 높이 모두 같고 쪽 아래 여백 안(남는 곳 5mm 안쪽)', d0.w === '210mm' && Math.abs(d0.tw - 180) <= 1 && new Set(d0.hs.slice(1)).size === 1 && d0.hs[1] > 15 && d0.bottom >= 15 && d0.bottom < 15 + 3 + 5 && !d0.fit, [d0.hs, d0.bottom, d0.tw, d0.fit]);
  // ⏱️ 분으로 계산(기본): 시작 시각 + 줄마다 분·앞 쉬는 시간 → 시각이 저절로
  const cl = () => P.evaluate(() => ({ on: !!document.querySelector('#bs-calc [data-calc="1"].on'), start: document.getElementById('bs-start').value, brk: document.getElementById('bs-brk').value,
    rows: [...document.querySelectorAll('#bs-rows .bs-crow')].map(r => [r.dataset.id, (r.querySelector('input[data-c="g"]') || {}).value, (r.querySelector('input[data-c="g"]') || {}).disabled, r.querySelector('input[data-c="d"]').value, r.querySelector('.bs-ct').textContent].join('/')),
    times: bsRows(bsCfg()).map(r => r.n + ' ' + r.s + '-' + r.e) }));
  const c0 = await cl();
  const lefts = (sel) => P.evaluate((sel) => new Set([...document.querySelectorAll('#bs-rows .bs-row')].map(r => r.querySelector(sel)).filter(Boolean).map(e => Math.round(e.getBoundingClientRect().left))).size, sel);
  check('칸 줄 맞춤: 교시 줄·특별 줄의 쉬는·분·시간 칸이 같은 자리(사용자: 표 정렬이 안 맞음)', (await lefts('.bs-gap')) === 1 && (await lefts('.bs-min')) === 1 && (await lefts('.bs-ct')) === 1);
  check('글꼴 고르기는 세부 설정 밖(바로 보임)', await P.evaluate(() => document.getElementById('bs-tfont').checkVisibility() && !document.getElementById('bs-tfont').closest('#bs-more')));
  check('⏱️ 분으로 계산이 기본: 시작 08:40, 교시 사이 쉬는 시간 10분, 줄마다 쉬는·분·시간(첫 줄 쉬는 칸은 막힘), 교시→교시 10분·4교시→중식 0분', c0.on && c0.start === '08:40' && c0.brk === '10' &&
    c0.rows[0] === 'x0//true/10/08:40 ~ 08:50' && c0.rows[1] === 'p0/0/false/50/08:50 ~ 09:40' && c0.rows[2] === 'p1/10/false/50/09:50 ~ 10:40' && c0.rows[5] === 'x1/0/false/50/12:40 ~ 13:30' && c0.rows[11] === 'x4/10/false/70/18:50 ~ 20:00', c0.rows);
  const cset = async (sel, v) => { await P.fill(sel, v); await P.dispatchEvent(sel, 'input'); await P.dispatchEvent(sel, 'change'); await P.waitForTimeout(150); };
  await cset('#bs-rows .bs-row[data-id="p0"] input[data-c="d"]', '45');
  const c1 = await cl();
  check('1교시를 45분으로 → 뒤 시간이 모두 5분 당겨짐(2교시 09:45, 중식 12:35, 자기주도학습1 17:25)', c1.times[1] === '1교시 08:50-09:35' && c1.times[2] === '2교시 09:45-10:35' && c1.times[5] === '중식 12:35-13:25' && c1.times[10] === '자기주도학습1 17:25-18:35' &&
    (await prev()).rows[2] === '1교시|08:50 - 09:35|45분', c1.times);
  await cset('#bs-brk', '5');
  const c2 = await cl();
  check('교시 사이 쉬는 시간 5분 → 교시→교시만 5분(중식·청소 앞은 그대로 0), 자기주도학습 사이도 5분', c2.times[2] === '2교시 09:40-10:30' && c2.times[5] === '중식 12:20-13:10' && c2.times[6] === '5교시 13:10-14:00' && c2.times[7] === '6교시 14:05-14:55' &&
    c2.times[11] === '자기주도학습2 18:20-19:30' && c2.rows[11].startsWith('x4/5/'), c2.times);
  await cset('#bs-rows .bs-row[data-id="x3"] input[data-c="g"]', '50');
  check('그 줄 앞 쉬는 시간만 바꾸기: 자기주도학습1 앞 50분 → 7교시 끝 16:05 + 50 = 16:55', (await cl()).times[10] === '자기주도학습1 16:55-18:05');
  await cset('#bs-start', '0830');
  const c3 = await cl();
  check('시작 "0830" → 08:30으로, 모두 10분 당겨짐', c3.start === '08:30' && c3.times[0] === '조회 08:30-08:40' && c3.times[1] === '1교시 08:40-09:25', c3.times.slice(0, 2));
  // 처음 상태로 돌리고(설정 지움), 아래는 🕘 시각 직접으로
  await P.evaluate(() => document.activeElement.blur()); await P.waitForTimeout(300); // 시작 칸을 빠져나온 뒤(사라지면서 "바뀜"이 늦게 와 다시 계산되지 않게)
  await P.evaluate(() => { localStorage.setItem('fm-bs', '{}'); scheduleBackupWrite(); bsFillForm(); fmRender(); }); await P.waitForTimeout(200);
  await P.click('#bs-calc [data-calc="0"]'); await P.waitForTimeout(200);
  check('🕘 시각 직접에서도 시작·끝 칸 줄 맞춤', (await lefts('.bs-t[data-f="s"]')) === 1 && (await lefts('.bs-t[data-f="e"]')) === 1);
  check('🕘 시각 직접: 줄마다 시작·끝 칸', await P.evaluate(() => document.querySelectorAll('#bs-rows .bs-t').length === 24 && !document.getElementById('bs-start') && bsCfg().normal.calc === false));
  const ed = await P.evaluate(() => [...document.querySelectorAll('#bs-rows .bs-row')].map(r => [r.dataset.k, (r.querySelector('.bs-pn') || r.querySelector('.bs-n')).textContent || r.querySelector('.bs-n').value, [...r.querySelectorAll('.bs-t')].map(x => x.value + '/' + x.placeholder).join(' ')]));
  check('시간 칸: 표와 같은 순서, 교시는 빈칸 + 회색 일과 시간(placeholder), 조회·중식·청소도 빈칸 + 교시에 맞춘 회색 시간, 자기주도학습은 적은 시간', ed.length === 12 && ed[1][0] === 'p' && ed[1][2] === '/08:50 /09:40' && ed[0][1] === '조회' && ed[0][2] === '/08:40 /08:50' && ed[5][1] === '중식' && ed[5][2] === '/12:40 /13:30' && ed[10][2] === '17:30/시작 18:40/끝', ed.slice(0, 11));

  // 교시 시간 고치기(이 시정표만) → 정렬·분, ↺ 일과 시간대로
  const t1 = '#bs-rows .bs-row[data-id="p0"] .bs-t[data-f="e"]';
  await P.fill(t1, '935'); await P.dispatchEvent(t1, 'input'); await P.dispatchEvent(t1, 'change'); await P.waitForTimeout(250);
  const d1 = await prev();
  check('1교시 끝을 "935"로 → 09:35로 맞추고 45분, 다른 교시·관리자 일과 시간은 그대로', d1.rows[2] === '1교시|08:50 - 09:35|45분' && d1.rows[3] === '2교시|09:50 - 10:40|50분' &&
    await P.evaluate(() => document.querySelector('#bs-rows .bs-row[data-id="p0"] .bs-t[data-f="e"]').value === '09:35' && window.classTimes[0].e === '09:40'), d1.rows.slice(1, 4));
  await P.click('#bs-reset-times'); await P.waitForTimeout(200);
  check('↺ 일과 시간대로: 고친 교시 시간 지움', (await prev()).rows[2] === '1교시|08:50 - 09:40|50분');
  // 특별 줄: 종례 더하기(마지막 교시 끝 + 10분), 이름·종류·지우기, 시간 바꾸면 자리 이동
  await P.click('#bs-add [data-add="종례"]'); await P.waitForTimeout(200);
  const d2 = await prev();
  check('＋ 종례: 비워 둔 시간이 7교시 끝 + 5분(16:30~16:35, 저절로)이라 7교시 바로 뒤, 더한 단추는 목록에서 빠짐', d2.rows[11] === '종례|16:30 - 16:35|5분' && !(await P.$('#bs-add [data-add="종례"]')), d2.rows.slice(10, 13));
  const sj = '#bs-rows .bs-row[data-id="x5"]';
  await P.fill(sj + ' .bs-t[data-f="s"]', '07:30'); await P.dispatchEvent(sj + ' .bs-t[data-f="s"]', 'input'); await P.fill(sj + ' .bs-t[data-f="e"]', '08:00'); await P.dispatchEvent(sj + ' .bs-t[data-f="e"]', 'input');
  await P.fill(sj + ' .bs-n', '아침 독서'); await P.dispatchEvent(sj + ' .bs-n', 'input'); await P.selectOption(sj + ' select', 'etc'); await P.waitForTimeout(250);
  const d3 = await prev();
  check('종례 줄 이름·시간·종류 바꾸기: 07:30이면 맨 위로, 기타 색(회색)', d3.rows[1] === '아침 독서|07:30 - 08:00|30분' && d3.bg[1] === 'rgb(237, 237, 237)', [d3.rows[1], d3.bg[1]]);
  await P.click('#bs-rows .bs-row[data-id="x5"] .ws-ol-x'); await P.waitForTimeout(200);
  check('✕ 지우기 → 종례 단추가 다시 생김', (await prev()).rows.length === 13 && !!(await P.$('#bs-add [data-add="종례"]')), (await prev()).rows);
  // ✕를 잇달아 두 번(자기주도학습1·2) — 예전엔 ✕ 단추에 초점이 남아 목록이 안 바뀌어 둘째가 안 지워지고 남았음(사용자 제보)
  await P.click('#bs-rows .bs-row[data-id="x3"] .ws-ol-x'); await P.waitForTimeout(200);
  const afterOne = await P.evaluate(() => [...document.querySelectorAll('#bs-rows .bs-row')].map(r => r.dataset.id + ':' + ((r.querySelector('.bs-n') || {}).value || '')).filter(x => x[0] === 'x').join());
  await P.click('#bs-rows .bs-row[data-id="x3"] .ws-ol-x'); await P.waitForTimeout(200);
  const d2b = await prev();
  check('자기주도학습 두 줄을 ✕로 잇달아 지우면 둘 다 바로 사라지고(목록도 바로 새로), 줄 더하기에 다시 생김', afterOne === 'x0:조회,x1:중식,x2:청소,x3:자기주도학습2' && !d2b.rows.some(r => /자기주도/.test(r)) &&
    await P.evaluate(() => !!document.querySelector('#bs-add [data-add="자기주도학습1"]') && !!document.querySelector('#bs-add [data-add="자기주도학습2"]') && ![...document.querySelectorAll('#bs-rows .bs-n')].some(x => /자기주도/.test(x.value))), [afterOne, d2b.rows]);
  await P.click('#bs-add [data-add="자기주도학습1"]'); await P.click('#bs-add [data-add="자기주도학습2"]'); await P.waitForTimeout(200);
  for (const [j, s, e] of [[3, '17:30', '18:40'], [4, '18:50', '20:00']]) for (const [f, v] of [['s', s], ['e', e]]) { const q = '#bs-rows .bs-row[data-id="x' + j + '"] .bs-t[data-f="' + f + '"]'; await P.fill(q, v); await P.dispatchEvent(q, 'input'); await P.dispatchEvent(q, 'change'); }
  await P.waitForTimeout(200);
  check('다시 더한 자기주도학습 1·2(시간 적기)', (await prev()).rows.slice(-2).join() === '자기주도학습1|17:30 - 18:40|70분,자기주도학습2|18:50 - 20:00|70분', (await prev()).rows.slice(-2));
  await P.click('#bs-add [data-add=""]'); await P.waitForTimeout(200);
  const dd = await P.evaluate(() => ({ focus: document.activeElement.classList.contains('bs-n'), info: document.getElementById('bs-info').textContent }));
  check('＋ 직접: 이름 칸에 바로 커서, 시간이 빈 줄은 안내("시간을 확인해 주세요")', dd.focus && /시간을 확인해 주세요/.test(dd.info), dd);
  await P.click('#bs-rows .bs-row[data-id="x5"] .ws-ol-x'); await P.waitForTimeout(150);
  const npOne = () => P.evaluate(() => { const r = document.getElementById('bs-np'), chips = [...r.querySelectorAll('.nt-chip')]; return chips.every(x => Math.abs(x.getBoundingClientRect().top - chips[0].getBoundingClientRect().top) < 2) && !r.querySelector('#bs-reset-times, #bs-copy-normal'); });
  check('교시 수 줄은 한 줄(되돌리기 단추는 상자 제목 오른쪽)', await npOne() && await P.evaluate(() => !!document.querySelector('#bs-tools #bs-reset-times')));
  await P.click('#bs-np [data-np="6"]'); await P.waitForTimeout(150);
  check('교시 수 6 → 7교시 줄 빠짐', !(await prev()).rows.some(r => r.startsWith('7교시')));
  await P.click('#bs-np [data-np="7"]'); await P.waitForTimeout(150);

  // ③ 디자인: 완성 세트 8개(작은 그림) — 누르면 짜임·제목 모양·선·색이 한 번에(10/2 사용자: 따로 고르면 색이 안 맞고 복잡하다)
  await setText(P, '#bs-title', '부광고등학교 시정표(2학기)'); await setText(P, '#bs-sub', '2026학년도 2학기'); await P.waitForTimeout(150);
  const cards = await P.evaluate(() => [...document.querySelectorAll('#bs-designs .bs-dcard')].map(b => [b.dataset.design, b.classList.contains('on'), !!b.querySelector('.bs-thumb table')]));
  check('디자인 8개를 작은 그림으로, 처음은 클래식 — 짜임·테마·줄 색·가로형·용지 가로를 따로 고르는 칸은 없음', cards.length === 8 && cards[0][0] === 'classic' && cards[0][1] && cards.every(x => x[2]) &&
    await P.evaluate(() => !document.querySelector('#bs-styles, #bs-themes, #bs-colors, #bs-orient, #bs-line, #bs-tstyle, #bs-grid [data-land]')), cards);
  const look = () => P.evaluate(() => { const t = document.querySelector('#fm-pages table.bs-main'), rows = [...t.rows], cs = getComputedStyle;
    const hr = rows.find(r => r.dataset.k === 'head'), pr = rows.find(r => r.dataset.k === 'p'), tt = document.querySelector('#fm-pages .bs-title');
    return { tables: document.querySelectorAll('#fm-pages table.bs-tbl').length, coll: cs(t).borderCollapse, spacing: cs(t).borderSpacing, vline: cs(pr.cells[0]).borderRightStyle, hline: cs(pr.cells[0]).borderBottomStyle,
      nameBg: cs(pr.cells[0]).backgroundColor, nameColor: cs(pr.cells[0]).color, timeBg: cs(pr.cells[1]).backgroundColor, headBg: cs(hr.cells[0]).backgroundColor, headColor: cs(hr.cells[0]).color,
      titleBg: cs(tt).backgroundColor, titleColor: cs(tt).color, titleBot: cs(tt).borderBottomStyle, sheet: document.querySelector('#fm-pages .bs-sheet').dataset.style }; });
  await P.click('#bs-designs [data-design="navy"]'); await P.waitForTimeout(200);
  const st1 = await look(), d4 = await prev();
  check('네이비: 가로선만(세로선 없음), 제목은 표 첫 줄(남색·흰 글씨), 머리 줄은 바탕 없이 남색 글자, 부제', st1.sheet === 'minimal' && st1.tables === 1 && st1.vline === 'none' && st1.hline === 'solid' &&
    st1.titleBg === 'rgb(31, 56, 100)' && st1.titleColor === 'rgb(255, 255, 255)' && st1.headBg === 'rgba(0, 0, 0, 0)' && st1.headColor === 'rgb(31, 56, 100)' && d4.sub === '2026학년도 2학기' && d4.rows[0] === '부광고등학교 시정표(2학기)', st1);
  await P.click('#bs-designs [data-design="green"]'); await P.waitForTimeout(200);
  const st2 = await look();
  check('그린 포인트: 교시 구분 칸은 초록 바탕·흰 글씨, 시간 칸은 흰 바탕, 제목 상자 초록', st2.sheet === 'badge' && st2.nameBg === 'rgb(46, 125, 107)' && st2.nameColor === 'rgb(255, 255, 255)' && st2.timeBg === 'rgba(0, 0, 0, 0)' && st2.titleBg === 'rgb(46, 125, 107)', st2);
  await P.click('#bs-designs [data-design="pastel"]'); await P.waitForTimeout(200);
  const st3 = await look();
  check('파스텔 타일: 칸 사이를 띄우고(border-spacing) 선 없음', st3.sheet === 'tiles' && st3.coll === 'separate' && st3.spacing !== '0px' && st3.vline === 'none' && st3.hline === 'none', st3);
  if (JSZIP_JS) {
    const tz = await P.evaluate(async () => { const sec = await (await JSZip.loadAsync(await bsBuildHwpx(bsCfg()))).file('Contents/section0.xml').async('string');
      const main = sec.match(/<hp:tbl [\s\S]*?<\/hp:tbl>/g).pop(), sp = +main.match(/cellSpacing="(\d+)"/)[1], W = +main.match(/<hp:sz width="(\d+)"/)[1], Hh = +main.match(/<hp:sz width="\d+" widthRelTo="ABSOLUTE" height="(\d+)"/)[1];
      const trs = main.match(/<hp:tr>[\s\S]*?<\/hp:tr>/g), row = trs[trs.length - 1], ws = [...row.matchAll(/<hp:cellSz width="(\d+)" height="(\d+)"/g)];
      const L = bsLayout(bsCfg()), mm = x => Math.round(x * 7200 / 25.4), bfId = row.match(/borderFillIDRef="(\d+)"/)[1];
      const hd = await (await JSZip.loadAsync(await bsBuildHwpx(bsCfg()))).file('Contents/header.xml').async('string'), bf = hd.match(new RegExp('<hh:borderFill id="' + bfId + '"[\\s\\S]*?</hh:borderFill>'))[0];
      return { sp, gap: L.sp, white: (bf.match(/Border type="SOLID" width="1.5 mm" color="#FFFFFF"/g) || []).length, w: ws.reduce((a, m) => a + +m[1], 0) === W && W === mm(L.tw),
        h: trs.reduce((a, r) => a + +r.match(/<hp:cellSz width="\d+" height="(\d+)"/)[1], 0) === Hh && Math.abs(Hh - mm(L.tRows.reduce((a, r) => a + r.h, 0) + L.sp * (L.tRows.length + 1))) <= trs.length }; });
    check('타일 한글 파일: 칸 사이(cellSpacing)는 쓰지 않고(한글에서 표가 길어져 다음 쪽으로 넘어감) 칸 사이 굵기의 흰 테두리로, 칸 폭·높이 합 = 표 크기 = 미리보기', tz.sp === 0 && tz.gap === 1.5 && tz.white === 4 && tz.w && tz.h, tz);
  }
  await P.click('#bs-designs [data-design="mono"]'); await P.waitForTimeout(200);
  const st4 = await look();
  check('흑백: 제목은 바탕 없이 밑줄, 특별 줄은 연회색', st4.titleBg === 'rgba(0, 0, 0, 0)' && st4.titleBot === 'solid' && (await prev()).bg[6] === 'rgb(242, 242, 242)', st4);
  const fits = [];
  for (const d of ['classic', 'mono', 'navy', 'green', 'pastel', 'blue', 'coral', 'bold']) { await P.click('#bs-designs [data-design="' + d + '"]'); await P.waitForTimeout(120); const x = await prev(); fits.push(d + ':' + (!x.fit && x.bottom >= 15 && x.bottom < 23)); }
  check('디자인 8개 모두 한 장에 꽉 차게(아래 여백 안)', fits.every(x => x.endsWith('true')), fits);
  // 교시 9개 + 부제: 파스텔만 칸 사이 때문에 혼자 한 장을 넘던 것(사용자) — 칸 사이가 여유를 대신하고, 그래도 넘치면 칸 사이를 좁힘
  const sub0 = await P.evaluate(() => document.getElementById('bs-sub').value), np0 = await P.evaluate(() => bsCfg()[bsCfg().mode].nP);
  await P.click('#bs-np [data-np="9"]'); await setText(P, '#bs-sub', '2026학년도 2학기'); await P.waitForTimeout(200);
  const fits9 = [];
  for (const d of ['classic', 'mono', 'navy', 'green', 'pastel', 'blue', 'coral', 'bold']) { await P.click('#bs-designs [data-design="' + d + '"]'); await P.waitForTimeout(120); const x = await prev(); fits9.push(d + ':' + (!x.fit && x.bottom >= 15)); }
  check('교시 9개 + 부제: 디자인 8개 모두 한 장에(파스텔도)', fits9.every(x => x.endsWith('true')), fits9);
  // 글씨를 키워 가며: 다른 디자인(네이비)이 들어가는 크기면 파스텔도 들어감(넘칠 때는 칸 사이를 좁혀서)
  const sizes = await P.evaluate(() => { const c0 = bsCfg(), d = k => BS_DESIGNS.find(x => x.k === k), out = [];
    for (let s = 20; s <= 32; s++) { const c = Object.assign({}, c0, { hSize: s, nSize: s, tmSize: s, mSize: s }), nv = bsLayout(Object.assign({}, c, { style: d('navy').style, tStyle: d('navy').tStyle })), ps = bsLayout(Object.assign({}, c, { style: 'tiles', tStyle: d('pastel').tStyle }));
      out.push({ s, navy: !nv.over, pastel: !ps.over, sp: ps.sp }); }
    return out; });
  check('글씨 크기 20~32pt: 네이비가 한 장에 들어가면 파스텔도(칸 사이를 좁혀서라도), 좁힌 경우도 있음', sizes.every(x => !x.navy || x.pastel) && sizes.some(x => x.pastel && x.sp < 1.5), sizes);
  await P.click('#bs-np [data-np="' + np0 + '"]'); await setText(P, '#bs-sub', sub0); await P.waitForTimeout(200);
  await P.click('#bs-designs [data-design="classic"]'); await P.waitForTimeout(150);
  check('고른 디자인은 내 설정에 저장(design)', await P.evaluate(() => JSON.parse(localStorage.getItem('fm-bs')).design === 'classic' && document.querySelector('#bs-designs .on').dataset.design === 'classic'));

  // ④ 글씨·종이: A−/A+·용지·분 칸만 보이고, 나머지는 "세부 설정"을 펼쳐야
  { const mo = await P.evaluate(() => [document.getElementById('bs-more').open, !document.getElementById('bs-widths').checkVisibility()]); check('세부 설정은 처음엔 접혀 있음', mo[0] === false && mo[1], mo); }
  await P.click('#bs-more summary'); await P.waitForTimeout(150);
  await setText(P, '#bs-hN', '교시'); await P.waitForTimeout(150);
  check('머리 줄 글 바꾸기: "구분" → "교시"', (await prev()).rows.find(r => /\|시간\|분$/.test(r)).startsWith('교시|'));
  await P.click('#bs-showhead'); await P.waitForTimeout(150);
  const nh = await prev();
  check('머리 줄 빼기: 머리 줄 없이 바로 줄들(남는 높이는 줄에)', !nh.rows.some(r => /\|시간\|분$/.test(r)) && nh.bottom >= 15 && nh.bottom < 23, nh.rows.slice(0, 2));
  await P.click('#bs-showhead'); await setText(P, '#bs-hN', ''); await P.waitForTimeout(150);
  const wIn = '#bs-widths input[data-wk="n"]';
  await P.fill(wIn, '70'); await P.dispatchEvent(wIn, 'input'); await P.waitForTimeout(200);
  const cw1 = await P.evaluate(() => [...document.querySelectorAll('#fm-pages table.bs-main col')].map(x => parseFloat(x.style.width)));
  check('칸 너비: 구분 70mm로 적으면 70mm, 나머지 두 칸이 남은 폭(110mm)을 나눔', cw1[0] === 70 && Math.abs(cw1[1] + cw1[2] - 110) < 0.2, cw1);
  await P.click('#bs-w-auto'); await P.waitForTimeout(150);
  check('칸 너비 자동으로', await P.evaluate(() => JSON.stringify(bsCfg().colW) === '{}' && document.querySelector('#bs-widths input[data-wk="n"]').value === ''));
  await P.click('#bs-time [data-sep="~"]'); await P.click('#bs-time [data-pad="0"]'); await P.click('#bs-showmin'); await P.click('#bs-tblw [data-tw="80"]'); await P.waitForTimeout(250);
  const d5 = await prev();
  check('"8:40 ~ 8:50"(앞 0 빼기), 분 칸 빼기(두 칸), 표 폭 80%', d5.rows[1] === '조회|8:40 ~ 8:50' && d5.rows[0] === '구분|시간' && Math.abs(d5.tw - 144) <= 1, [d5.rows.slice(0, 2), d5.tw]);
  await P.click('#bs-showmin'); await P.click('#bs-tblw [data-tw="100"]'); await P.click('#bs-time [data-sep="-"]'); await P.click('#bs-time [data-pad="0"]');
  // 글씨 크기·A+·굵게
  await P.fill('#bs-tmSize', '30'); await P.dispatchEvent('#bs-tmSize', 'input'); await P.waitForTimeout(150);
  const fs1 = (await prev()).fs;
  await P.click('#bs-bigger'); await P.waitForTimeout(150);
  const s2 = await P.evaluate(() => { const c = bsCfg(); return [c.tSize, c.hSize, c.nSize, c.tmSize, c.mSize].join(); });
  check('시간 글씨 30pt, 시간 글씨 A+ → 표 글씨(머리 줄·구분·시간·분)만 1pt씩, 제목은 그대로(지금 크기 안내도)', fs1[1] === '40px' && s2 === '30,23,25,31,23' && (await P.textContent('#bs-size-now')) === '31pt', [fs1, s2]);
  await P.click('#bs-t-bigger'); await P.click('#bs-t-bigger'); await P.waitForTimeout(150);
  const s3 = await P.evaluate(() => { const c = bsCfg(); return [c.tSize, c.hSize, c.nSize, c.tmSize, c.mSize].join(); });
  check('제목 글씨 A+ 두 번 → 제목만 32pt(표 글씨는 그대로)', s3 === '32,23,25,31,23' && (await P.textContent('#bs-t-now')) === '32pt' && await P.evaluate(() => Math.abs(parseFloat(getComputedStyle(document.querySelector('#fm-pages .bs-title')).fontSize) - 32 * 4 / 3) < 0.1), [s3, await P.evaluate(() => getComputedStyle(document.querySelector('#fm-pages .bs-title')).fontSize)]);
  await P.click('#bs-t-smaller'); await P.click('#bs-t-smaller');
  await P.click('#bs-smaller'); await P.click('#bs-bold'); await P.waitForTimeout(150);
  check('표 글씨 굵게 끄기', await P.evaluate(() => getComputedStyle(document.querySelector('#fm-pages table.bs-main tr:last-child td')).fontWeight === '400'));
  await P.click('#bs-bold');
  // 줄 높이: 직접 → 그 높이, 너무 낮으면 글씨에 맞춤, 너무 크면 한 장 넘는다는 안내
  await P.click('#bs-rowh [data-fill="0"]'); await P.fill('#bs-rowh-in', '17'); await P.dispatchEvent('#bs-rowh-in', 'input'); await P.waitForTimeout(200);
  const d6 = await prev();
  await P.fill('#bs-rowh-in', '8'); await P.dispatchEvent('#bs-rowh-in', 'input'); await P.waitForTimeout(200);
  const d6b = await prev();
  await P.fill('#bs-rowh-in', '40'); await P.dispatchEvent('#bs-rowh-in', 'input'); await P.waitForTimeout(200);
  const d7 = await prev();
  check('줄 높이 직접 17mm → 17mm, 8mm는 글씨보다 낮아 글씨에 맞춤(안내), 40mm면 한 장 넘는다고 안내', d6.hs[2] === 17 && d6b.hs[2] > 8 && /글씨에 맞췄어요/.test(d6b.info) &&
    !d6.fit && /한 장을 넘어요/.test(d7.fit) && /한 장을 넘어요/.test(d7.info), [d6.hs[2], d6.fit, d6b.hs[2], d6b.info, d7.fit]);
  await P.click('#bs-rowh [data-fill="1"]'); await P.click('#bs-paper [data-paper="B4"]'); await P.waitForTimeout(200);
  const d8 = await prev();
  check('B4: 257mm 폭, 다시 꽉 채우기, 종이는 늘 세로', d8.w === '257mm' && d8.bottom >= 15 && d8.bottom < 23 && !d8.fit && await P.evaluate(() => bsCfg().land === false), [d8.w, d8.bottom]);
  await P.click('#bs-paper [data-paper="A4"]'); await P.waitForTimeout(150);

  // 단축 수업: 처음엔 평상시 줄·시간을 옮겨 놓고, 고치면 단축만
  await P.click('#bs-modes [data-mode="short"]'); await P.waitForTimeout(250);
  const s0 = await prev();
  check('단축 수업에서도 교시 수 줄은 한 줄("평상시에서 가져오기"는 제목 오른쪽)', await npOne() && await P.evaluate(() => !!document.querySelector('#bs-tools #bs-copy-normal')));
  check('⏱️ 단축 수업: 처음엔 평상시 줄·시간 그대로(제목 "… 단축 수업 시정표"), 분으로 계산(교시 50분)', s0.title === '부광고등학교 단축 수업 시정표(2학기)' && s0.rows[2] === '1교시|08:50 - 09:40|50분' &&
    await P.evaluate(() => !!document.querySelector('#bs-calc [data-calc="1"].on') && document.querySelector('#bs-rows .bs-row[data-id="p0"] input[data-c="d"]').value === '50' && !!document.getElementById('bs-copy-normal')), [s0.title, s0.rows.slice(0, 3)]);
  for (let i = 0; i < 7; i++) await cset('#bs-rows .bs-row[data-id="p' + i + '"] input[data-c="d"]', '40');
  await setText(P, '#bs-title', '부광고등학교 단축 수업 시정표'); await P.waitForTimeout(250);
  const s1 = await prev();
  check('단축 수업: 교시 분만 40으로 바꾸면 중식·청소·자기주도학습까지 뒤 시간이 모두 따라옴, 평상시는 일과 시간 그대로(따로 기억)', s1.rows.includes('1교시|08:50 - 09:30|40분') && s1.rows.includes('2교시|09:40 - 10:20|40분') &&
    s1.rows.includes('중식|12:00 - 12:50|50분') && s1.rows.includes('5교시|12:50 - 13:30|40분') && s1.rows.includes('청소|14:20 - 14:40|20분') && s1.rows.includes('7교시|14:40 - 15:20|40분') &&
    await P.evaluate(() => bsRows(bsCfg(), 'normal').find(r => r.n === '1교시').e === '09:40' && bsCfg().normal.title === '부광고등학교 시정표(2학기)'), s1.rows);
  await P.click('#bs-modes [data-mode="normal"]'); await P.waitForTimeout(200);
  check('평상시로 돌아오면 평상시 제목·시간', (await prev()).title === '부광고등학교 시정표(2학기)' && (await prev()).rows[2] === '1교시|08:50 - 09:40|50분');
  // 📝 시험 기간: 정기고사 시정표(본령만 적으면 예비령 10분 전·준비령 5분 전) + 일차별 시간표(같은 교시 두 과목은 칸 나누기) — 사용자 한글 양식 그대로
  await P.click('#bs-modes [data-mode="exam"]'); await P.waitForTimeout(250);
  const exPg = await P.evaluate(() => ({ c: [bsCfg().exam.paper, bsCfg().exam.margin], w: document.querySelector('#fm-pages .bs-ex-sheet').style.width, on: document.querySelector('#bs-ex-paper .on').dataset.paper, mg: document.getElementById('bs-ex-margin').value }));
  check('시험 기간 처음 = A3·여백 10mm(사용자)', exPg.c.join() === 'A3,10' && exPg.w === '297mm' && exPg.on === 'A3' && exPg.mg === '10', exPg);
  await P.click('#bs-ex-paper [data-paper="A4"]'); await P.fill('#bs-ex-margin', '5'); await P.dispatchEvent('#bs-ex-margin', 'input'); await P.waitForTimeout(200); // 아래 검사는 원본 양식(A4·5mm)과 견줌
  const exv = () => P.evaluate(() => [...document.querySelectorAll('#fm-pages .bs-ex-sheet')].map(sh => {
    const t = sh.querySelector('table'), r = sh.getBoundingClientRect(), k = r.width / sh.offsetWidth, tr = t.getBoundingClientRect();
    return { kind: sh.dataset.kind, rows: [...t.rows].map(row => [...row.cells].map(c => c.innerText.trim().replace(/\n+/g, '/')).join('|')), cols: t.querySelectorAll('col').length,
      red: [...t.querySelectorAll('span')].map(x => x.textContent), redTd: [...t.querySelectorAll('td')].filter(td => /∼/.test(td.textContent)).map(td => getComputedStyle(td.querySelector('span') || td).color),
      fs: [...t.querySelectorAll('td')].map(td => parseFloat(td.style.fontSize)), top: Math.round((tr.top - r.top) / k / 3.78 * 10) / 10, bottom: Math.round((r.bottom - tr.bottom) / k / 3.78 * 10) / 10,
      over: [...t.querySelectorAll('.bs-ex-ln')].filter(d => d.scrollWidth > d.clientWidth + 1).map(d => d.textContent), font: getComputedStyle(t).fontFamily };
  }));
  const exForm = await P.evaluate(() => ({ show: ['bs-ex-bell-box', 'bs-ex-days-box', 'bs-ex-opt-box', 'bs-title-row'].every(id => document.getElementById(id).style.display !== 'none'),
    hide: ['bs-rows-box', 'bs-design-box', 'bs-font-box', 'bs-sub-row'].every(id => document.getElementById(id).style.display === 'none'), title: document.getElementById('bs-title').value,
    guide: document.getElementById('bs-guide').textContent, np: document.querySelector('#bs-ex-np .on').textContent, calc: [...document.querySelectorAll('#bs-ex-periods .bs-ex-calc')].map(x => x.textContent) }));
  check('📝 시험 기간 입력칸: ②시험 시간·③일차별 시간표·④글씨·종이만(평상시 시간·디자인 칸 숨김), 제목 "정기고사 시정표", 교시 3, 예비·준비 저절로',
    exForm.show && exForm.hide && exForm.title === '정기고사 시정표' && /본령 시간/.test(exForm.guide) && exForm.np === '3' && exForm.calc[0] === '예비 09:00 · 준비 09:05' && exForm.calc[2] === '예비 11:20 · 준비 11:25', exForm);
  const e0 = await exv();
  const BELL0 = ['정기고사 시정표', '', '교시|타종 및 시간', '1|예비|09:00|준비|09:05', '본령|09:10∼10:00', '2|예비|10:10|준비|10:15', '본령|10:20∼11:10', '3|예비|11:20|준비|11:25', '본령|11:30∼12:20'];
  check('정기고사 시정표: 원본과 같은 칸(교시 | 예비 시각 · 준비 시각 / 본령 시작∼끝 빨강), A4 여백 5mm에 꽉 차게, 글씨가 칸을 안 넘침',
    e0.length === 2 && e0[0].kind === 'bell' && JSON.stringify(e0[0].rows) === JSON.stringify(BELL0) && e0[0].cols === 5 && e0[0].redTd.every(c => c === 'rgb(255, 0, 0)') && e0[0].redTd.length === 3 &&
    e0[0].top === 5 && e0[0].bottom >= 6 && e0[0].bottom <= 9 && !e0[0].over.length, e0[0]);
  check('글씨는 칸에 들어가는 가장 크게(본령 시각 60pt 넘게, 예비 시각 50pt 넘게)', Math.max(...e0[0].fs) >= 60 && e0[0].fs[6] >= 50, e0[0].fs);
  check('일차별 시간표(처음 1일차): 제목 "1차시험 1일차 시간표"(1일차 빨강), 일자 | 교시 | 과목, 교시 3줄', e0[1].kind === 'day' && e0[1].rows[0] === '1차시험 1일차 시간표' && e0[1].red.join() === '1일차' &&
    e0[1].rows[2] === '일자|교시|과목' && e0[1].rows.length === 6, e0[1].rows);
  // 시간 고치기: "900" → 09:00, 끝도 50분 그대로 따라감, 예비·준비 다시 계산
  const pin = (i, f) => '#bs-ex-periods .bs-ex-row[data-p="' + i + '"] input[data-f="' + f + '"]';
  await P.click(pin(0, 's')); await P.fill(pin(0, 's'), '900'); await P.dispatchEvent(pin(0, 's'), 'input'); await P.dispatchEvent(pin(0, 's'), 'change'); await P.waitForTimeout(200);
  await P.click(pin(1, 'e')); await P.fill(pin(1, 'e'), '11:05'); await P.dispatchEvent(pin(1, 'e'), 'input'); await P.dispatchEvent(pin(1, 'e'), 'change'); await P.waitForTimeout(200);
  await P.click('#bs-ex-np [data-np="4"]'); await P.waitForTimeout(200);
  const e1 = await exv();
  check('1교시 시작 900 → 09:00∼09:50(시험 시간 그대로), 예비 08:50·준비 08:55 / 2교시 끝만 11:05 / 4교시 더하면 앞 교시 끝 + 20분부터(12:40∼13:30)',
    e1[0].rows[3] === '1|예비|08:50|준비|08:55' && e1[0].rows[4] === '본령|09:00∼09:50' && e1[0].rows[6] === '본령|10:20∼11:05' && e1[0].rows[10] === '본령|12:40∼13:30' &&
    await P.evaluate(() => document.querySelector('#bs-ex-periods .bs-ex-row[data-p="0"] input[data-f="s"]').value === '09:00') && !e1[0].over.length && e1[0].bottom >= 6 && e1[0].bottom <= 9, e1[0].rows);
  await P.fill('#bs-ex-pre-in', '15'); await P.dispatchEvent('#bs-ex-pre-in', 'input'); await P.waitForTimeout(150);
  check('예비령 15분 전으로 바꾸면 예비 08:45', (await exv())[0].rows[3] === '1|예비|08:45|준비|08:55');
  await P.fill('#bs-ex-pre-in', '10'); await P.dispatchEvent('#bs-ex-pre-in', 'input'); await P.click('#bs-ex-np [data-np="3"]'); await P.waitForTimeout(150);
  // 일차: 날짜(요일 저절로)·과목·같은 교시 두 과목
  const exSj = (d, i, k) => '#bs-ex-days .bs-ex-day[data-day="' + d + '"] .bs-ex-p[data-p="' + i + '"] .bs-ex-sj[data-s="' + k + '"]';
  await P.fill('#bs-ex-days .bs-ex-day[data-day="0"] .bs-ex-date', '2026-04-28'); await P.dispatchEvent('#bs-ex-days .bs-ex-day[data-day="0"] .bs-ex-date', 'change'); await P.waitForTimeout(150);
  for (const [i, v] of [[0, '동아시아사'], [1, '경제수학'], [2, '통합수학']]) await setText(P, exSj(0, i, 0), v);
  await P.click('#bs-ex-days .bs-ex-day[data-day="0"] .bs-ex-p[data-p="2"] .bs-ex-plus'); await P.waitForTimeout(150);
  const focusNew = await P.evaluate(() => document.activeElement.matches('.bs-ex-p[data-p="2"] .bs-ex-sj[data-s="1"]'));
  await P.keyboard.type('미적분'); await P.waitForTimeout(200);
  await setText(P, '#bs-ex-name', '1학기 1차 지필평가'); await P.waitForTimeout(150);
  const e2 = await exv();
  check('일차별 시간표: 날짜 → "4월/28일/(화)", 과목, 3교시 ＋로 두 과목(통합수학 | 미적분 — 과목 칸을 옆으로 나눔, 2칸), 새 칸에 바로 입력, 시험 이름이 제목에',
    e2[1].rows[0] === '1학기 1차 지필평가 1일차 시간표' && e2[1].rows[3] === '4월/28일/(화)|1|동아시아사' && e2[1].rows[4] === '2|경제수학' && /^3\|통합\/?수학\|미적분$/.test(e2[1].rows[5]) &&
    e2[1].cols === 4 && focusNew && !e2[1].over.length && await P.evaluate(() => document.querySelector('#bs-ex-days .bs-ex-wd').textContent === '(화)'), e2[1]);
  // 일차 더하기: 다음 평일(금요일 다음은 월요일)
  await P.click('#bs-ex-add-day'); await P.waitForTimeout(150);
  await P.keyboard.type('자습'); await P.waitForTimeout(100);
  await P.fill('#bs-ex-days .bs-ex-day[data-day="1"] .bs-ex-date', '2026-05-01'); await P.dispatchEvent('#bs-ex-days .bs-ex-day[data-day="1"] .bs-ex-date', 'change'); await P.waitForTimeout(150);
  await P.click('#bs-ex-add-day'); await P.waitForTimeout(150);
  const e3 = await exv(), days = await P.evaluate(() => bsCfg().exam.days.map(d => d.d + ':' + d.sj[0][0]));
  check('＋ 일차 더하기: 다음 평일 날짜(4/28 → 4/29, 금 5/1 → 월 5/4), 새 일차 첫 과목 칸에 바로 입력, 쪽 = 시정표 1 + 일차 3', days.join() === '2026-04-28:동아시아사,2026-05-01:자습,2026-05-04:' &&
    e3.length === 4 && e3[3].rows[0] === '1학기 1차 지필평가 3일차 시간표' && e3[3].rows[3] === '5월/4일/(월)|1|', { days, n: e3.length });
  await P.evaluate(() => { window.customConfirm = async () => true; });
  await P.click('#bs-ex-days .bs-ex-day[data-day="2"] .ws-ol-x'); await P.waitForTimeout(150);
  await P.click('#bs-ex-days .bs-ex-day[data-day="0"] .bs-ex-p[data-p="2"] .ws-ol-x'); await P.waitForTimeout(150);
  const e4 = await exv();
  check('일차 ✕·과목 ✕: 3일차 지움, 미적분 지우면 과목 칸 하나로', e4.length === 3 && e4[1].cols === 3 && e4[1].rows[5] === '3|통합수학', e4.map(x => x.rows[5]));
  await P.click('#bs-ex-days .bs-ex-day[data-day="0"] .bs-ex-p[data-p="2"] .bs-ex-plus'); await P.keyboard.type('미적분'); await P.waitForTimeout(150);
  // 긴 과목 이름: 칸에 맞게 줄을 나누고 글씨를 줄임(넘치지 않게)
  await setText(P, exSj(0, 1, 0), '영어독해와 작문'); await setText(P, exSj(1, 1, 0), '고급 생명과학 실험 및 탐구'); await P.waitForTimeout(150);
  const e5 = await exv();
  check('긴 과목 이름은 띄어쓰기에서 줄을 나눠 칸 안에(영어독해와/작문), 아주 긴 이름도 넘치지 않음', e5[1].rows[4] === '2|영어독해와/작문' && !e5.some(x => x.over.length) && e5.every(x => x.bottom >= 6 && x.bottom <= 9), e5.map(x => [x.rows[4], x.over, x.bottom]));
  // 넣을 쪽·글씨
  const fs0 = (await exv())[0].fs[6];
  await P.click('#bs-ex-smaller'); await P.click('#bs-ex-smaller'); await P.waitForTimeout(150);
  const e6 = await exv();
  check('글씨 A− 두 번 = 90%(모든 글씨가 작아짐)', await P.evaluate(() => document.getElementById('bs-ex-scale').textContent === '90%') && e6[0].fs[6] < fs0 && await P.evaluate(() => document.getElementById('bs-ex-bigger').disabled === false), [fs0, e6[0].fs[6]]);
  await P.click('#bs-ex-bigger'); await P.click('#bs-ex-bigger'); await P.waitForTimeout(100);
  check('A+는 100%까지', await P.evaluate(() => document.getElementById('bs-ex-scale').textContent === '100%' && document.getElementById('bs-ex-bigger').disabled));
  await P.click('#bs-ex-bell-on'); await P.waitForTimeout(150);
  const e7 = await exv();
  await P.click('#bs-ex-day-on'); await P.waitForTimeout(150);
  await P.evaluate(() => { window.__alerts = []; window.customAlert = async (m) => { window.__alerts.push(m); }; });
  const none = await P.evaluate(() => document.getElementById('fm-pages').textContent); await P.click('#fm-hwpx-btn'); await P.waitForTimeout(150);
  check('넣을 쪽: 시정표 끄면 일차별만, 둘 다 끄면 안내(한글 파일도 안내)', e7.length === 2 && e7.every(x => x.kind === 'day') && /넣을 쪽/.test(none) && await P.evaluate(() => window.__alerts.some(m => /넣을 쪽/.test(m))), [e7.length, none]);
  await P.click('#bs-ex-bell-on'); await P.click('#bs-ex-day-on'); await P.waitForTimeout(150);
  // 용지 B4: 꽉 차게 + 글씨도 커짐
  await P.click('#bs-ex-paper [data-paper="B4"]'); await P.waitForTimeout(150);
  const e8 = await exv();
  check('B4: 표가 꽉 차고 글씨도 커짐, 넘침 없음', e8[0].bottom >= 6 && e8[0].bottom <= 9 && e8[0].fs[6] > fs0 && !e8.some(x => x.over.length), [e8[0].bottom, e8[0].fs[6]]);
  await P.click('#bs-ex-paper [data-paper="A4"]'); await P.waitForTimeout(150);
  // 한글 파일
  if (JSZIP_JS) {
    const hx = await P.evaluate(async () => { const c = bsCfg(), L = bsExLayout(c), zip = await JSZip.loadAsync(await bsExBuildHwpx(c)), names = Object.keys(zip.files);
      const sec = await zip.file('Contents/section0.xml').async('string'), head = await zip.file('Contents/header.xml').async('string');
      let ok = true; try { if (new DOMParser().parseFromString(sec, 'application/xml').getElementsByTagName('parsererror').length || new DOMParser().parseFromString(head, 'application/xml').getElementsByTagName('parsererror').length) ok = false; } catch (e) { ok = false; }
      const tbls = sec.match(/<hp:tbl [\s\S]*?<\/hp:tbl>/g) || [];
      const shape = tbls.map(t => { const rc = t.match(/rowCnt="(\d+)" colCnt="(\d+)"/).slice(1).map(Number), W = +t.match(/<hp:sz width="(\d+)"/)[1], Ht = +t.match(/<hp:sz width="\d+" widthRelTo="ABSOLUTE" height="(\d+)"/)[1];
        // 칸 자리(colAddr·colSpan·rowAddr·rowSpan)로 격자를 채워 빈칸·겹침이 없는지, 첫 칸 줄의 폭 합 = 표 폭
        const grid = Array.from({ length: rc[0] }, () => Array(rc[1]).fill(0)); let wSum = 0, hSum = 0;
        [...t.matchAll(/<hp:cellAddr colAddr="(\d+)" rowAddr="(\d+)"\/><hp:cellSpan colSpan="(\d+)" rowSpan="(\d+)"\/><hp:cellSz width="(\d+)" height="(\d+)"/g)].forEach(m => {
          const [c, r, cs, rs, w, h] = m.slice(1).map(Number);
          for (let i = r; i < r + rs; i++) for (let j = c; j < c + cs; j++) if (grid[i]) grid[i][j]++;
          if (r === 0) wSum += w; if (c === 0) hSum += h; });
        return { rc: rc.join('x'), full: grid.every(row => row.every(v => v === 1)), w: wSum === W, h: hSum === Ht }; });
      return { first: names[0], xml: ok, n: tbls.length, pages: L.pages.length, brk: (sec.match(/pageBreak="1"/g) || []).length, shape: shape, secPr: (sec.match(/<hp:secPr/g) || []).length,
        texts: ['정기고사 시정표', '교시', '타종 및 시간', '예비', '08:50', '준비', '08:55', '본령', '09:00∼09:50', '1학기 1차 지필평가 ', '1일차', ' 시간표', '4월', '28일', '(화)', '동아시아사', '미적분', '영어독해와', '작문', '자습'].filter(t => !sec.includes('<hp:t>' + fmX(t) + '</hp:t>')),
        squeeze: /lineWrap="SQUEEZE"/.test(head) && !/<hp:subList [^>]*lineWrap="BREAK"/.test(sec), red: /textColor="#FF0000"/.test(head), gray: /faceColor="#F2F2F2"/.test(head), dbl: /type="DOUBLE_SLIM" width="0.5 mm"/.test(head), font: /face="경기천년제목 Bold"/.test(head),
        a4: /width="59528" height="84189"/.test(sec), margin: /left="1417" right="1417" top="1417" bottom="1417"/.test(sec) }; });
    check('시험 기간 한글 파일: mimetype 맨 앞·XML 올바름, 쪽마다 표 하나(둘째 쪽부터 쪽 나누기), 칸 자리 빈틈·겹침 없음(합친 칸 포함), 폭·높이 합 = 표 크기, 글·빨강·회색 바탕·이중선·"한 줄로 입력"·경기천년제목 Bold, A4·여백 5mm',
      hx.first === 'mimetype' && hx.xml && hx.n === 3 && hx.pages === 3 && hx.brk === 2 && hx.secPr === 1 && hx.shape.map(x => x.rc).join() === '9x5,6x4,6x3' && hx.shape.every(x => x.full && x.w && x.h) &&
      !hx.texts.length && hx.squeeze && hx.red && hx.gray && hx.dbl && hx.font && hx.a4 && hx.margin, hx);
    if (process.env.BS_EX_OUT) { const b64 = await P.evaluate(async () => { const u8 = new Uint8Array(await (await bsExBuildHwpx(bsCfg())).arrayBuffer()); let t = ''; u8.forEach(x => t += String.fromCharCode(x)); return btoa(t); }); fs.writeFileSync(process.env.BS_EX_OUT, Buffer.from(b64, 'base64')); }
  } else console.log('  ⚠️ JSZip 없음 — 시험 기간 한글 파일 검사 건너뜀');
  await P.screenshot({ path: 'bs-exam.png' });
  const prE = await P.evaluate(() => { let got = ''; const op = window.print; window.print = () => { got = document.getElementById('fm-page-style').textContent; }; fmPrint(); window.print = op; return got; });
  check('시험 기간 인쇄: A4 세로 쪽 크기', /size: 210mm 297mm/.test(prE), prE);
  await P.click('#bs-modes [data-mode="normal"]'); await P.waitForTimeout(200);
  // 서버 저장
  await P.waitForTimeout(2500);
  const sv = JSON.parse(serverVal(T2, 'fm-bs') || '{}');
  check('시정표 설정은 내 계정(fm-bs)에 저장 — 평상시·단축·시험 기간 따로', sv.normal && sv.short && sv.short.periods[0].e === '09:30' && sv.short.calc !== false && sv.normal.title === '부광고등학교 시정표(2학기)' && sv.design === 'classic' && sv.exam && sv.exam.name === '1학기 1차 지필평가' && sv.exam.days[0].sj[2].join() === '통합수학,미적분', { n: !!sv.normal, s: !!sv.short, e: sv.exam && sv.exam.days });
  // 한글 파일
  if (JSZIP_JS) {
    for (const [dz, ts] of [['classic', 'box'], ['navy', 'band'], ['mono', 'line']]) {
      await P.click('#bs-designs [data-design="' + dz + '"]'); await P.waitForTimeout(150);
      const hz = await P.evaluate(async () => { const c = bsCfg(), L = bsLayout(c), zip = await JSZip.loadAsync(await bsBuildHwpx(c)), names = Object.keys(zip.files);
        const sec = await zip.file('Contents/section0.xml').async('string'), head = await zip.file('Contents/header.xml').async('string');
        let ok = true; try { if (new DOMParser().parseFromString(sec, 'application/xml').getElementsByTagName('parsererror').length || new DOMParser().parseFromString(head, 'application/xml').getElementsByTagName('parsererror').length) ok = false; } catch (e) { ok = false; }
        const tbls = sec.match(/<hp:tbl [\s\S]*?<\/hp:tbl>/g) || [], main = tbls[tbls.length - 1];
        const sumW = (row) => [...row.matchAll(/<hp:cellSz width="(\d+)"/g)].reduce((a, m) => a + +m[1], 0);
        const rowsH = main.match(/<hp:tr>[\s\S]*?<\/hp:tr>/g).reduce((a, r) => a + +r.match(/<hp:cellSz width="\d+" height="(\d+)"/)[1], 0);
        return { first: names[0], xml: ok, tables: tbls.length, rc: main.match(/rowCnt="(\d+)" colCnt="(\d+)"/).slice(1).join(), rows: L.rows.length,
          w: main.match(/<hp:tr>[\s\S]*?<\/hp:tr>/g).every(r => sumW(r) === +main.match(/<hp:sz width="(\d+)"/)[1]), h: rowsH === +main.match(/<hp:sz width="\d+" widthRelTo="ABSOLUTE" height="(\d+)"/)[1],
          secPr: (sec.match(/<hp:secPr/g) || []).length, texts: ['부광고등학교 시정표(2학기)', '2026학년도 2학기', '구분', '조회', '08:40 - 08:50', '10분', '자기주도학습2', '18:50 - 20:00', '70분'].filter(t => !sec.includes('<hp:t>' + fmX(t) + '</hp:t>')),
          fills: Object.values(bsDesign(bsCfg()).c).filter((f, i, a) => f && a.indexOf(f) === i && ['title', 'head', 'lunch', 'clean'].some(k => bsDesign(bsCfg()).c[k] === f)).filter(f => !head.includes('faceColor="' + f + '"')), font: /face="HY헤드라인M"/.test(head) && /face="HY견고딕"/.test(head),
          a4: /width="59528" height="84189"/.test(sec), margin: /left="4252" right="4252" top="4252" bottom="4252"/.test(sec) }; });
      const tN = ts === 'band' ? 1 : 2, rN = (ts === 'band' ? 1 : 0) + 1 + hz.rows;
      check('시정표 한글 파일(' + dz + ' — 제목 ' + ts + '): mimetype 맨 앞·XML 올바름, 표 ' + tN + '개, 큰 표 ' + rN + '줄×3칸, 칸 폭 합 = 표 폭, 표 높이 = 줄 높이 합, 쪽 설정 하나, 글·바탕색·글꼴, A4·여백 15',
        hz.first === 'mimetype' && hz.xml && hz.tables === tN && hz.rc === rN + ',3' && hz.w && hz.h && hz.secPr === 1 && !hz.texts.length && !hz.fills.length && hz.font && hz.a4 && hz.margin, hz);
    }
    if (process.env.BS_OUT) { const b64 = await P.evaluate(async () => { const u8 = new Uint8Array(await (await bsBuildHwpx(bsCfg())).arrayBuffer()); let t = ''; u8.forEach(x => t += String.fromCharCode(x)); return btoa(t); }); fs.writeFileSync(process.env.BS_OUT, Buffer.from(b64, 'base64')); }
    await P.click('#bs-designs [data-design="classic"]');
  } else console.log('  ⚠️ JSZip 없음 — 한글 파일 검사 건너뜀');
  await P.screenshot({ path: 'bs.png' });
  // 인쇄: 쪽 크기
  const pr = await P.evaluate(() => { let got = ''; const op = window.print; window.print = () => { got = document.getElementById('fm-page-style').textContent; }; fmPrint(); window.print = op; return got; });
  check('인쇄: A4 세로 쪽 크기', /size: 210mm 297mm/.test(pr), pr);
  // 초기화: 시정표만
  const peBefore = await ls(hr, 'fm-pe');
  await P.evaluate(() => { window.customConfirm = async (m) => { window.__cm = m; return true; }; });
  await P.click('#fm-reset-btn'); await P.waitForTimeout(300);
  const rs = await P.evaluate(() => ({ m: window.__cm, t: bsCfg().normal.title, k: fmCfg().kind, s: bsCfg().short.periods[0].e }));
  check('초기화: 시정표만 처음 상태(제목·단축 시간), 탭 그대로, 수행평가 설정은 그대로', /시정표 설정/.test(rs.m) && rs.t === '부광고등학교 시정표' && rs.k === 'bs' && rs.s === '09:40' && (await ls(hr, 'fm-pe')) === peBefore, rs);
  await P.setViewportSize({ width: 1366, height: 768 }); await P.waitForTimeout(300);
  const over = await P.evaluate(() => { const l = document.getElementById('fm-left'); return [...document.querySelectorAll('#bs-grid .nt-box, #bs-rows .bs-row')].filter(b => b.getBoundingClientRect().right > l.getBoundingClientRect().right + 1 || b.scrollWidth > b.clientWidth + 1).map(b => b.id || b.dataset.id); });
  check('1366×768에서 시정표 칸이 왼쪽 칸 밖으로 안 넘침', over.length === 0, over);
  await P.screenshot({ path: 'bs-1366.png' });
  await P.click('#bs-modes [data-mode="exam"]'); await P.waitForTimeout(300);
  const overE = await P.evaluate(() => { const l = document.getElementById('fm-left'); return [...document.querySelectorAll('#bs-grid .nt-box, .bs-ex-row, .bs-ex-p, .bs-ex-dh, .bs-ex-calc')].filter(b => b.offsetParent && (b.getBoundingClientRect().right > l.getBoundingClientRect().right + 1 || b.scrollWidth > b.clientWidth + 1)).map(b => b.id || b.className); });
  check('1366×768에서 시험 기간 칸도 왼쪽 칸 밖으로 안 넘침(예비·준비 시각 안 잘림)', overE.length === 0, overE);
  await P.screenshot({ path: 'bs-exam-1366.png' });
  const allErrors = pages.flatMap(p => (p.errors || []).map(e => p.name + ': ' + e));
  check('전체 페이지 오류 없음', allErrors.length === 0, allErrors);
  console.log(failures === 0 ? '\n모든 검사 통과' : '\n실패 ' + failures + '건');
  await browser.close();
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
