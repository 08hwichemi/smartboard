// 레일 "양식" → 🔔 시정표: 탭 전환, 평상시(관리자 일과 시간에서 교시 시간 + 조회·중식·청소·자기주도학습 줄, 고친 칸만 따로), 단축 수업(교시마다 직접, 평상시와 따로),
// 시험 기간(준비 중), 시간 순 정렬·분 계산, 디자인(테마·줄 색·제목 모양·선·번갈아 색·시간 표기·분 칸·표 폭), 글씨 크기·모두 크게, 줄 높이(꽉 채우기/직접), 한글 파일.
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
  check('시정표 탭: 시정표 칸만 보이고 엑셀 버튼 숨김, 탭 네 개', vis.bs && vis.pe === 'none' && vis.ws === 'none' && vis.fm === 'none' && vis.xlsx === 'none' && vis.kind === 'bs' && vis.tabs === '명렬표 수합,학습지,수행평가,시정표', vis);
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
  await P.click('#bs-np [data-np="6"]'); await P.waitForTimeout(150);
  check('교시 수 6 → 7교시 줄 빠짐', !(await prev()).rows.some(r => r.startsWith('7교시')));
  await P.click('#bs-np [data-np="7"]'); await P.waitForTimeout(150);

  // 디자인
  await P.setInputFiles; await setText(P, '#bs-title', '부광고등학교 시정표(2학기)'); await setText(P, '#bs-sub', '2026학년도 2학기'); await P.waitForTimeout(150);
  await P.click('#bs-themes [data-theme="navy"]'); await P.click('#bs-tstyle [data-ts="band"]'); await P.click('#bs-zebra'); await P.waitForTimeout(250);
  const d4 = await prev();
  check('남색 테마 + 표에 붙이기 + 번갈아 색 + 부제: 표 하나(첫 줄이 제목), 제목 남색, 부제, 교시 줄 번갈아', d4.tables === 1 && d4.rows[0] === '부광고등학교 시정표(2학기)' && d4.titleBg === 'rgb(31, 56, 100)' && d4.sub === '2026학년도 2학기' &&
    d4.bg[3] !== d4.bg[4] && d4.bottom >= 15, [d4.tables, d4.rows[0], d4.titleBg, d4.bg.slice(2, 6)]);
  await P.click('#bs-colors [data-ck="lunch"]'); await P.click('#bs-colors [data-color="#DEEBF7"]'); await P.waitForTimeout(200);
  check('줄 색: 중식만 하늘색으로', (await prev()).bg[7] === 'rgb(222, 235, 247)' && await P.evaluate(() => bsCfg().colors.lunch === '#DEEBF7'));
  await P.click('#bs-themes [data-theme="classic"]'); await P.waitForTimeout(150);
  check('테마를 다시 고르면 줄 색 고친 것은 지움', await P.evaluate(() => JSON.stringify(bsCfg().colors) === '{}'));
  // 표 짜임: 가로선만 / 구분 강조 / 타일 / 기본 표
  const look = () => P.evaluate(() => { const t = document.querySelector('#fm-pages table.bs-main'), rows = [...t.rows], cs = getComputedStyle;
    const hr = rows.find(r => r.dataset.k === 'head'), pr = rows.find(r => r.dataset.k === 'p');
    return { coll: cs(t).borderCollapse, spacing: cs(t).borderSpacing, vline: cs(pr.cells[0]).borderRightStyle, hline: cs(pr.cells[0]).borderBottomStyle, timeV: cs(pr.cells[1]).borderLeftStyle,
      nameBg: cs(pr.cells[0]).backgroundColor, nameColor: cs(pr.cells[0]).color, timeBg: cs(pr.cells[1]).backgroundColor, headBg: cs(hr.cells[0]).backgroundColor, headColor: cs(hr.cells[0]).color,
      headBot: cs(hr.cells[0]).borderBottomColor, sheet: document.querySelector('#fm-pages .bs-sheet').dataset.style }; });
  await P.click('#bs-styles [data-style="minimal"]'); await P.waitForTimeout(200);
  const st1 = await look();
  check('☰ 가로선만: 세로선 없음·가로선 있음, 머리 줄은 바탕 없이 강조색 글자·강조색 밑줄', st1.sheet === 'minimal' && st1.vline === 'none' && st1.timeV === 'none' && st1.hline === 'solid' && st1.headBg === 'rgba(0, 0, 0, 0)' &&
    st1.headColor === 'rgb(47, 85, 151)' && st1.headBot === 'rgb(47, 85, 151)', st1);
  await P.click('#bs-styles [data-style="badge"]'); await P.waitForTimeout(200);
  const st2 = await look();
  check('▌ 구분 강조: 교시 구분 칸은 강조색 바탕 + 흰 글씨, 시간 칸은 흰 바탕', st2.nameBg === 'rgb(47, 85, 151)' && st2.nameColor === 'rgb(255, 255, 255)' && st2.timeBg === 'rgba(0, 0, 0, 0)', st2);
  await P.click('#bs-styles [data-style="tiles"]'); await P.waitForTimeout(200);
  const st3 = await look();
  check('▩ 타일: 칸 사이를 띄우고(border-spacing) 선 없음, 머리 줄 강조색·흰 글씨, 교시 구분 칸 연두·나머지 연회색', st3.coll === 'separate' && st3.spacing !== '0px' && st3.vline === 'none' && st3.hline === 'none' &&
    st3.headBg === 'rgb(47, 85, 151)' && st3.headColor === 'rgb(255, 255, 255)' && st3.nameBg === 'rgb(226, 239, 218)' && st3.timeBg === 'rgb(245, 245, 245)' && !(await prev()).fit, st3);
  if (JSZIP_JS) {
    const tz = await P.evaluate(async () => { const sec = await (await JSZip.loadAsync(await bsBuildHwpx(bsCfg()))).file('Contents/section0.xml').async('string');
      const main = sec.match(/<hp:tbl [\s\S]*?<\/hp:tbl>/g).pop(), sp = +main.match(/cellSpacing="(\d+)"/)[1], W = +main.match(/<hp:sz width="(\d+)"/)[1], Hh = +main.match(/<hp:sz width="\d+" widthRelTo="ABSOLUTE" height="(\d+)"/)[1];
      const trs = main.match(/<hp:tr>[\s\S]*?<\/hp:tr>/g), row = trs[trs.length - 1], ws = [...row.matchAll(/<hp:cellSz width="(\d+)" height="(\d+)"/g)];
      return { sp, w: ws.reduce((a, m) => a + +m[1], 0) + sp * (ws.length + 1) === W, h: trs.reduce((a, r) => a + +r.match(/<hp:cellSz width="\d+" height="(\d+)"/)[1], 0) + sp * (trs.length + 1) === Hh }; });
    check('타일 한글 파일: 칸 사이(cellSpacing) + 칸 폭·높이 합 = 표 크기', tz.sp > 0 && tz.w && tz.h, tz);
  }
  await P.click('#bs-styles [data-style="grid"]'); await P.waitForTimeout(150);
  // 직접 색: 제목 바탕을 색 고르기로
  await P.click('#bs-colors [data-ck="title"]'); await P.waitForTimeout(100);
  await P.evaluate(() => { const el = document.getElementById('bs-color-in'); el.value = '#ff6600'; el.dispatchEvent(new Event('change')); }); await P.waitForTimeout(200);
  check('🎨 직접 색: 제목 바탕을 아무 색(#FF6600)으로, 고친 색은 • 표시', (await prev()).titleBg === 'rgb(255, 102, 0)' && await P.evaluate(() => bsCfg().colors.title === '#FF6600' && !!document.querySelector('#bs-colors [data-ck="title"] .bs-mod')));
  await P.click('#bs-colors [data-ck="tTxt"]'); await P.waitForTimeout(100);
  check('글자·선 색에는 "없음" 칸이 없음', await P.evaluate(() => !document.querySelector('#bs-colors .fm-sw[data-color=""]')));
  await P.click('#bs-colors [data-color="#FFFFFF"]'); await P.waitForTimeout(150);
  check('제목 글자 흰색', await P.evaluate(() => getComputedStyle(document.querySelector('#fm-pages .bs-title')).color === 'rgb(255, 255, 255)'));
  // 머리 줄 글·빼기, 바깥 이중선, 칸 너비
  await setText(P, '#bs-hN', '교시'); await P.waitForTimeout(150);
  check('머리 줄 글 바꾸기: "구분" → "교시"', (await prev()).rows.find(r => /\|시간\|분$/.test(r)).startsWith('교시|'));
  await P.click('#bs-showhead'); await P.waitForTimeout(150);
  const nh = await prev();
  check('머리 줄 빼기: 머리 줄 없이 바로 줄들(남는 높이는 줄에)', !nh.rows.some(r => /\|시간\|분$/.test(r)) && nh.bottom >= 15 && nh.bottom < 23, nh.rows.slice(0, 2));
  await P.click('#bs-showhead'); await setText(P, '#bs-hN', ''); await P.click('#bs-outer'); await P.waitForTimeout(150);
  check('바깥 이중선', await P.evaluate(() => getComputedStyle(document.querySelector('#fm-pages table.bs-main tr[data-k="p"] td')).borderLeftStyle === 'double'));
  await P.click('#bs-outer');
  const wIn = '#bs-widths input[data-wk="n"]';
  await P.fill(wIn, '70'); await P.dispatchEvent(wIn, 'input'); await P.waitForTimeout(200);
  const cw1 = await P.evaluate(() => { const cols = [...document.querySelectorAll('#fm-pages table.bs-main col')].map(x => parseFloat(x.style.width)); return cols; });
  check('칸 너비: 구분 70mm로 적으면 70mm, 나머지 두 칸이 남은 폭(110mm)을 나눔', cw1[0] === 70 && Math.abs(cw1[1] + cw1[2] - 110) < 0.2, cw1);
  await P.click('#bs-w-auto'); await P.waitForTimeout(150);
  check('칸 너비 자동으로', await P.evaluate(() => JSON.stringify(bsCfg().colW) === '{}' && document.querySelector('#bs-widths input[data-wk="n"]').value === ''));
  await P.click('#bs-themes [data-theme="classic"]'); await P.waitForTimeout(150);
  await P.click('#bs-tstyle [data-ts="text"]'); await P.click('#bs-time [data-sep="~"]'); await P.click('#bs-time [data-pad="0"]'); await P.click('#bs-showmin'); await P.click('#bs-cols [data-tw="80"]'); await P.waitForTimeout(250);
  const d5 = await prev();
  check('글씨만 제목, "8:40 ~ 8:50"(앞 0 빼기), 분 칸 빼기(두 칸), 표 폭 80%', d5.rows[1] === '조회|8:40 ~ 8:50' && d5.rows[0] === '구분|시간' && Math.abs(d5.tw - 144) <= 1 && d5.titleBg === 'rgba(0, 0, 0, 0)', [d5.rows.slice(0, 2), d5.tw]);
  await P.click('#bs-showmin'); await P.click('#bs-cols [data-tw="100"]'); await P.click('#bs-time [data-sep="-"]'); await P.click('#bs-time [data-pad="0"]'); await P.click('#bs-tstyle [data-ts="box"]');
  // 글씨 크기·모두 크게·굵게
  await P.fill('#bs-tmSize', '30'); await P.dispatchEvent('#bs-tmSize', 'input'); await P.waitForTimeout(150);
  const fs1 = (await prev()).fs;
  await P.click('#bs-bigger'); await P.waitForTimeout(150);
  const s2 = await P.evaluate(() => { const c = bsCfg(); return [c.tSize, c.hSize, c.nSize, c.tmSize, c.mSize].join(); });
  check('시간 글씨 30pt, A+ 모두 크게 → 모두 1pt씩', fs1[1] === '40px' && s2 === '31,23,25,31,23', [fs1, s2]);
  await P.click('#bs-smaller'); await P.click('#bs-bold'); await P.waitForTimeout(150);
  check('표 글씨 굵게 끄기', await P.evaluate(() => getComputedStyle(document.querySelector('#fm-pages table.bs-tbl:last-child tr:last-child td')).fontWeight === '400'));
  await P.click('#bs-bold');
  // 줄 높이: 직접 → 그 높이, 너무 낮으면 글씨에 맞춤, 너무 크면 한 장 넘는다는 안내
  await P.click('#bs-rowh [data-fill="0"]'); await P.fill('#bs-rowh-in', '17'); await P.dispatchEvent('#bs-rowh-in', 'input'); await P.waitForTimeout(200);
  const d6 = await prev();
  await P.fill('#bs-rowh-in', '40'); await P.dispatchEvent('#bs-rowh-in', 'input'); await P.waitForTimeout(200);
  const d7 = await prev();
  await P.fill('#bs-rowh-in', '8'); await P.dispatchEvent('#bs-rowh-in', 'input'); await P.waitForTimeout(200);
  const d6b = await prev();
  check('줄 높이 직접 17mm → 17mm, 8mm는 글씨보다 낮아 글씨에 맞춤(안내), 40mm면 한 장 넘는다고 안내', d6.hs[2] === 17 && d6b.hs[2] > 8 && /글씨에 맞췄어요/.test(d6b.info) && !d6.fit && /한 장을 넘어요/.test(d7.fit) && /한 장을 넘어요/.test(d7.info), [d6.hs[2], d6.fit, d6b.hs[2], d6b.info, d7.fit, d7.info]);
  await P.click('#bs-rowh [data-fill="1"]'); await P.click('#bs-paper [data-paper="B4"]'); await P.waitForTimeout(200);
  const d8 = await prev();
  check('B4: 257mm 폭, 다시 꽉 채우기', d8.w === '257mm' && d8.bottom >= 15 && d8.bottom < 23 && !d8.fit, [d8.w, d8.bottom]);
  await P.click('#bs-paper [data-land="1"]'); await P.waitForTimeout(150);
  check('가로로 두면 큰 글씨는 한 장을 넘는다고 안내', /한 장을 넘어요/.test((await prev()).fit));
  await P.click('#bs-paper [data-paper="A4"]'); await P.click('#bs-paper [data-land="0"]'); await P.waitForTimeout(150);

  // 단축 수업: 처음엔 평상시 줄·시간을 옮겨 놓고, 고치면 단축만
  await P.click('#bs-modes [data-mode="short"]'); await P.waitForTimeout(250);
  const s0 = await prev();
  check('⏱️ 단축 수업: 처음엔 평상시 줄·시간 그대로(제목 "… 단축 수업 시정표"), 교시 시간도 입력칸에 바로', s0.title === '부광고등학교 단축 수업 시정표(2학기)' && s0.rows[2] === '1교시|08:50 - 09:40|50분' &&
    await P.evaluate(() => document.querySelector('#bs-rows .bs-row[data-id="p0"] .bs-t[data-f="s"]').value === '08:50' && !!document.getElementById('bs-copy-normal')), [s0.title, s0.rows.slice(0, 3)]);
  const sh = (i, f, v) => P.evaluate(([i, f, v]) => { const el = document.querySelector('#bs-rows .bs-row[data-id="p' + i + '"] .bs-t[data-f="' + f + '"]'); el.value = v; el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); }, [i, f, v]);
  const short = [['08:50', '09:30'], ['09:40', '10:20'], ['10:30', '11:10'], ['11:20', '12:00'], ['12:50', '13:30'], ['13:40', '14:20'], ['14:30', '15:10']];
  for (let i = 0; i < 7; i++) { await sh(i, 's', short[i][0]); await sh(i, 'e', short[i][1]); }
  await setText(P, '#bs-title', '부광고등학교 단축 수업 시정표'); await P.waitForTimeout(250);
  const s1 = await prev();
  check('단축 수업 교시마다 40분으로 적으면 표에 그대로, 비워 둔 중식·청소는 단축 교시에 맞춰 옮겨 감, 평상시는 일과 시간 그대로(따로 기억)', s1.rows.includes('1교시|08:50 - 09:30|40분') && s1.rows.includes('7교시|14:30 - 15:10|40분') &&
    s1.rows.includes('중식|12:00 - 12:50|50분') && s1.rows.includes('청소|14:20 - 14:30|10분') && s1.rows.indexOf('중식|12:00 - 12:50|50분') === s1.rows.indexOf('4교시|11:20 - 12:00|40분') + 1 &&
    await P.evaluate(() => bsRows(bsCfg(), 'normal').find(r => r.n === '1교시').e === '09:40' && bsCfg().normal.title === '부광고등학교 시정표(2학기)'), s1.rows);
  await P.click('#bs-modes [data-mode="normal"]'); await P.waitForTimeout(200);
  check('평상시로 돌아오면 평상시 제목·시간', (await prev()).title === '부광고등학교 시정표(2학기)' && (await prev()).rows[2] === '1교시|08:50 - 09:40|50분');
  await P.click('#bs-modes [data-mode="exam"]'); await P.waitForTimeout(200);
  await P.evaluate(() => { window.__alerts = []; window.customAlert = async (m) => { window.__alerts.push(m); }; });
  const ex = await prev(); await P.click('#fm-hwpx-btn'); await P.waitForTimeout(150);
  check('📝 시험 기간(준비 중): 미리보기 안내·입력칸 숨김, 한글 파일 누르면 안내', /시험 기간 시정표는/.test(ex.none || '') && await P.evaluate(() => document.getElementById('bs-rows-box').style.display === 'none' && window.__alerts.some(m => /시험 기간/.test(m))), ex);
  await P.click('#bs-modes [data-mode="normal"]'); await P.waitForTimeout(200);
  // 서버 저장
  await P.waitForTimeout(2500);
  const sv = JSON.parse(serverVal(T2, 'fm-bs') || '{}');
  check('시정표 설정은 내 계정(fm-bs)에 저장 — 평상시·단축 따로', sv.normal && sv.short && sv.short.periods[0].e === '09:30' && sv.normal.title === '부광고등학교 시정표(2학기)' && sv.theme === 'classic', { n: !!sv.normal, s: !!sv.short });
  // 한글 파일
  if (JSZIP_JS) {
    for (const ts of ['box', 'band', 'text']) {
      await P.click('#bs-tstyle [data-ts="' + ts + '"]'); await P.waitForTimeout(150);
      const hz = await P.evaluate(async () => { const c = bsCfg(), L = bsLayout(c), zip = await JSZip.loadAsync(await bsBuildHwpx(c)), names = Object.keys(zip.files);
        const sec = await zip.file('Contents/section0.xml').async('string'), head = await zip.file('Contents/header.xml').async('string');
        let ok = true; try { if (new DOMParser().parseFromString(sec, 'application/xml').getElementsByTagName('parsererror').length || new DOMParser().parseFromString(head, 'application/xml').getElementsByTagName('parsererror').length) ok = false; } catch (e) { ok = false; }
        const tbls = sec.match(/<hp:tbl [\s\S]*?<\/hp:tbl>/g) || [], main = tbls[tbls.length - 1];
        const sumW = (row) => [...row.matchAll(/<hp:cellSz width="(\d+)"/g)].reduce((a, m) => a + +m[1], 0);
        const rowsH = main.match(/<hp:tr>[\s\S]*?<\/hp:tr>/g).reduce((a, r) => a + +r.match(/<hp:cellSz width="\d+" height="(\d+)"/)[1], 0);
        return { first: names[0], xml: ok, tables: tbls.length, rc: main.match(/rowCnt="(\d+)" colCnt="(\d+)"/).slice(1).join(), rows: L.rows.length,
          w: main.match(/<hp:tr>[\s\S]*?<\/hp:tr>/g).every(r => sumW(r) === +main.match(/<hp:sz width="(\d+)"/)[1]), h: rowsH === +main.match(/<hp:sz width="\d+" widthRelTo="ABSOLUTE" height="(\d+)"/)[1],
          secPr: (sec.match(/<hp:secPr/g) || []).length, texts: ['부광고등학교 시정표(2학기)', '2026학년도 2학기', '구분', '조회', '08:40 - 08:50', '10분', '자기주도학습2', '18:50 - 20:00', '70분'].filter(t => !sec.includes('<hp:t>' + fmX(t) + '</hp:t>')),
          fills: [bsCfg().tStyle === 'text' ? '' : '#DAE3F3', '#E2EFDA', '#FCE4D6', '#FFF2CC'].filter(f => f && !head.includes('faceColor="' + f + '"')), font: /face="HY헤드라인M"/.test(head) && /face="HY견고딕"/.test(head),
          a4: /width="59528" height="84189"/.test(sec), margin: /left="4252" right="4252" top="4252" bottom="4252"/.test(sec) }; });
      const tN = ts === 'band' ? 1 : ts === 'text' ? 1 : 2, rN = (ts === 'band' ? 1 : 0) + 1 + hz.rows;
      check('시정표 한글 파일(제목 ' + ts + '): mimetype 맨 앞·XML 올바름, 표 ' + tN + '개, 큰 표 ' + rN + '줄×3칸, 칸 폭 합 = 표 폭, 표 높이 = 줄 높이 합, 쪽 설정 하나, 글·바탕색·글꼴, A4·여백 15',
        hz.first === 'mimetype' && hz.xml && hz.tables === tN && hz.rc === rN + ',3' && hz.w && hz.h && hz.secPr === 1 && !hz.texts.length && !hz.fills.length && hz.font && hz.a4 && hz.margin, hz);
    }
    if (process.env.BS_OUT) { const b64 = await P.evaluate(async () => { const u8 = new Uint8Array(await (await bsBuildHwpx(bsCfg())).arrayBuffer()); let t = ''; u8.forEach(x => t += String.fromCharCode(x)); return btoa(t); }); fs.writeFileSync(process.env.BS_OUT, Buffer.from(b64, 'base64')); }
    await P.click('#bs-tstyle [data-ts="box"]');
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
  const allErrors = pages.flatMap(p => (p.errors || []).map(e => p.name + ': ' + e));
  check('전체 페이지 오류 없음', allErrors.length === 0, allErrors);
  console.log(failures === 0 ? '\n모든 검사 통과' : '\n실패 ' + failures + '건');
  await browser.close();
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
