// 레일 "양식" → 명렬표 수합: 담임 반으로 시작, 여러 반(반마다 한 장), 체크 칸·학번·비고·번갈아 색, 다단(1~3단),
// 줄 높이(자동 = 한 장에 맞춤), 큰 반은 다음 쪽으로(제목 없이 표만), 글꼴·크기, 계정에 저장,
// 한글 파일(.hwpx): mimetype 맨 앞·압축 안 함, XML이 올바른지, 표 줄·칸 수, 다단·쪽/단 나누기, 글꼴이 header에 들어가는지.
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
  check('레일 "양식"(이름표 아래) → 양식 만들기 화면', await P.isVisible('#form-page') && await P.evaluate(() => document.getElementById('rail-nametag-btn').nextElementSibling.id === 'rail-forms-btn'));
  let sh = await sheetsOf(P);
  check('담임은 담임 반(3학년 1반)으로 시작 — 5명, 한 장', (await P.inputValue('#fm-grade')) === '3' && sh.length === 1 && sh[0].tables.join() === '6' && sh[0].info === '3학년 1반 (5명)', sh);
  check('기본 칸: 번호·이름·제출·비고, 제목 "제출 확인"', sh[0].head.join('|') === '번호|이름|제출|비고' && sh[0].title === '제출 확인', sh[0]);
  check('명렬표는 번호·이름만 요청(한 번)', studentSelects.join(' ') === '3:1', studentSelects);
  const names = await P.evaluate(() => [...document.querySelectorAll('#fm-pages table.fm-tbl tr')].slice(1, 3).map(tr => tr.cells[0].textContent + tr.cells[1].textContent));
  check('번호 순서대로 이름', names.join(',') === '1가나다,2라마바', names);
  console.log('    (왼쪽 설정 칸 높이 ' + await P.evaluate(() => document.getElementById('fm-left').scrollHeight) + 'px)');
  await P.screenshot({ path: 'fm-left.png', clip: { x: 60, y: 60, width: 1540, height: 940 } });
  await P.evaluate(() => document.getElementById('fm-left').scrollTop = 9999); await P.screenshot({ path: 'fm-left2.png', clip: { x: 60, y: 60, width: 1540, height: 940 } });
  await P.evaluate(() => document.getElementById('fm-left').scrollTop = 0);
  const lay = await P.evaluate(() => {
    const top = (id) => Math.round(document.getElementById(id).getBoundingClientRect().top);
    const opts = [...document.querySelectorAll('#fm-cols-box .fm-opts label')];
    const al = [...document.querySelectorAll('#fm-aligns > span:not(.top-btn-cluster)')];
    return { h: document.getElementById('fm-left').scrollHeight, fontsInText: !!document.querySelector('#fm-text-box #fm-tfont') && !!document.querySelector('#fm-text-box #fm-bsize') && !document.getElementById('fm-font-box'),
      order: top('fm-title') < top('fm-tfont') && top('fm-tfont') < top('fm-note') && top('fm-note') < top('fm-bfont'),
      optRows: new Set(opts.map(l => Math.round(l.getBoundingClientRect().top))).size, opts: opts.length,
      alRows: new Set(al.map(x => Math.round(x.getBoundingClientRect().top))).size, alLabels: al.map(x => x.textContent).join('|'),
      rowhOne: new Set([...document.querySelectorAll('#fm-rowh .nt-chip'), document.getElementById('fm-rowh-input')].map(x => Math.round(x.getBoundingClientRect().top + x.getBoundingClientRect().height / 2))).size };
  });
  check('글꼴은 제목 칸 바로 아래·내용 글꼴은 안내 칸 바로 아래(따로 글꼴 상자 없음)', lay.fontsInText && lay.order, lay);
  check('학번·비고·번갈아 회색은 한 줄, 정렬 6개는 두 개씩 세 줄, 줄 높이 버튼·직접 입력 한 줄', lay.opts === 3 && lay.optRows === 1 && lay.alRows === 3 && lay.alLabels === '제목|반·인원|안내|표 위치|표 제목칸|표 내용' && lay.rowhOne === 1, lay);
  const colsAt = async (w, h) => { await P.setViewportSize({ width: w, height: h }); await P.waitForTimeout(300);
    return P.evaluate(() => { const l = document.getElementById('fm-left'), sh = document.querySelector('#fm-pages .fm-sheet');
      const R = (id) => document.getElementById(id).getBoundingClientRect();
      const pairs = [['fm-class-box', 'fm-layout-box'], ['fm-text-box', 'fm-width-box'], ['fm-cols-box', 'fm-align-box']];
      const two = Math.round(R('fm-class-box').top) === Math.round(R('fm-layout-box').top);
      return { left: l.clientWidth, cols: two ? 2 : 1,
        even: !two || pairs.every(p => Math.abs(R(p[0]).top - R(p[1]).top) < 1 && Math.abs(R(p[0]).bottom - R(p[1]).bottom) < 1),
        over: l.scrollWidth - l.clientWidth, sheet: Math.round(sh.getBoundingClientRect().width), h: l.scrollHeight }; }); };
  const at1600 = await colsAt(1600, 1000), at1536 = await colsAt(1536, 730), at1366 = await colsAt(1366, 657);
  console.log('    1600px', JSON.stringify(at1600), '1536px', JSON.stringify(at1536), '1366px', JSON.stringify(at1366));
  check('넓은 화면은 설정 상자를 두 열로(1600·1536px), 노트북(1366px)은 한 열 — 미리보기 A4는 거의 제 크기(700px 넘게)', at1600.cols === 2 && at1536.cols === 2 && at1366.cols === 1 &&
    [at1600, at1536, at1366].every(x => x.over <= 0 && x.sheet >= 700), [at1600, at1536, at1366]);
  check('두 열일 때 옆 상자끼리 위·아래 선이 맞음(명단↔배치, 제목·안내↔칸 너비, 체크 칸↔정렬)', at1600.even && at1536.even, [at1600, at1536]);
  const at1920 = await colsAt(1920, 950);
  await P.screenshot({ path: 'fm-1920.png' });
  await P.evaluate(() => document.getElementById('fm-left').scrollTop = 9999); await P.screenshot({ path: 'fm-1920b.png', clip: { x: 60, y: 400, width: 740, height: 550 } });
  await P.evaluate(() => document.getElementById('fm-left').scrollTop = 0);
  const ch1920 = await P.evaluate(() => document.getElementById('fm-left').clientHeight);
  check('1920px: 두 열·상자 줄 맞음·왼쪽 칸이 거의 한 화면(넘쳐도 60px 이내 — 여기선 글꼴 없음 안내가 더 있음)', at1920.cols === 2 && at1920.even && at1920.h <= ch1920 + 60, [at1920, ch1920]);
  await P.setViewportSize({ width: 1024, height: 700 }); await P.waitForTimeout(300);
  const nar = await P.evaluate(() => { const l = document.getElementById('fm-left'); return { over: l.scrollWidth - l.clientWidth, w: l.clientWidth,
    boxes: [...l.querySelectorAll('.nt-box')].filter(b => b.scrollWidth > b.clientWidth + 1).map(b => b.id) }; });
  await P.evaluate(() => document.getElementById('fm-align-box').scrollIntoView()); await P.screenshot({ path: 'fm-left-1024.png', clip: { x: 60, y: 0, width: 360, height: 700 } });
  check('좁은 화면(1024px)에서도 왼쪽 설정 칸이 옆으로 안 넘침', nar.over <= 0 && !nar.boxes.length, nar);
  await P.setViewportSize({ width: 1600, height: 1000 }); await P.waitForTimeout(300);
  await P.evaluate(() => document.getElementById('fm-left').scrollTop = 0);

  // 반 여러 개
  await P.click('#fm-classes [data-c="2"]'); await P.waitForTimeout(500);
  sh = await sheetsOf(P);
  check('2반도 고르면 반마다 한 장(1반 5명 · 2반 30명)', sh.length === 2 && sh[1].cls === '2' && sh[1].tables.join() === '31' && sh[1].info === '3학년 2반 (30명)', sh.map(s => [s.cls, s.tables]));
  check('30명 반도 한 장에 들어감(줄 높이 자동)', sh.every(s => s.fits), sh.map(s => s.fits));
  check('반을 바꿀 때만 다시 요청', studentSelects.join(' ') === '3:1 3:1,2', studentSelects);

  // 제목·안내·칸
  await setText(P, '#fm-title', '현장체험학습 동의서');
  await setText(P, '#fm-note', '10월 10일(금)까지 제출\n부모님 서명 꼭 받기');
  await setText(P, '#fm-cols', '동의서\n회비\n\n');
  await P.check('#fm-showid'); await P.waitForTimeout(300);
  sh = await sheetsOf(P);
  const notes = await P.evaluate(() => [...document.querySelectorAll('#fm-pages .fm-sheet')[0].querySelectorAll('.fm-note')].map(n => n.textContent));
  check('제목·안내 두 줄·체크 칸(빈 줄 무시)·학번', sh[0].title === '현장체험학습 동의서' && notes.join('|') === '10월 10일(금)까지 제출|부모님 서명 꼭 받기' && sh[0].head.join('|') === '번호|학번|이름|동의서|회비|비고', [sh[0], notes]);
  const sid = await P.evaluate(() => document.querySelectorAll('#fm-pages table.fm-tbl')[1].rows[1].cells[1].textContent);
  check('학번 = 학년 + 반 2자리 + 번호 2자리', sid === '30201', sid);
  const zebra = await P.evaluate(() => [...document.querySelectorAll('#fm-pages table.fm-tbl')[0].rows].slice(1, 4).map(r => r.className));
  check('줄마다 번갈아 연한 회색(기본 켜짐)', zebra.join(',') === ',z,', zebra);
  await P.uncheck('#fm-memo'); await P.waitForTimeout(200);
  check('비고 끄기', !(await sheetsOf(P))[0].head.includes('비고'));
  await P.check('#fm-memo');
  const w = await P.evaluate(() => [...document.querySelectorAll('#fm-pages table.fm-tbl col')].slice(0, 6).map(c => parseFloat(c.style.width)));
  check('칸 폭 합 = 180mm(A4 − 여백 15mm×2)', Math.abs(w.reduce((a, b) => a + b, 0) - 180) < 0.01, w);

  // 다단
  await P.click('#fm-colsn [data-v="2"]'); await P.waitForTimeout(300);
  sh = await sheetsOf(P);
  const colFill = await P.evaluate(() => { const s = document.querySelectorAll('#fm-pages .fm-sheet')[1], t = s.querySelector('table.fm-tbl'), r = s.getBoundingClientRect(), k = r.width / (210 * 3.78);
    return (r.bottom - 15 * 3.78 * k - t.getBoundingClientRect().bottom) / k / 3.78; }); // 왼쪽 표 아래 남은 높이(mm)
  check('2단: 한글처럼 왼쪽 단을 끝까지 채우고 나머지가 오른쪽(30명 → 18·12명, 한 장)', sh[1].tables.join() === '19,13' && sh.length === 2 && sh[1].fits && colFill < 12 + 2, [sh.map(s => s.tables), colFill]);
  const tw2 = await P.evaluate(() => parseFloat(document.querySelectorAll('#fm-pages table.fm-tbl')[2].style.width));
  check('2단 표 폭 = (180 − 단 사이 8) ÷ 2 = 86mm', Math.abs(tw2 - 86) < 0.01, tw2);
  await P.click('#fm-colsn [data-v="3"]'); await P.waitForTimeout(300);
  check('3단: 고르게 나누지 않고 왼쪽 단부터 채움(30명 → 18·12명, 셋째 단은 빔)', (await sheetsOf(P))[1].tables.join() === '19,13');
  await P.click('#fm-colsn [data-v="1"]'); await P.waitForTimeout(300);

  // 큰 반(45명) + 넓은 줄 → 다음 쪽으로, 다음 쪽은 표만
  await P.click('#fm-classes [data-c="1"]'); await P.click('#fm-classes [data-c="2"]'); await P.click('#fm-classes [data-c="3"]'); await P.waitForTimeout(500);
  await P.click('#fm-rowh [data-v="12"]'); await P.waitForTimeout(300);
  sh = await sheetsOf(P);
  const total = sh.reduce((s, x) => s + x.tables.reduce((a, b) => a + b - 1, 0), 0);
  check('45명·넓은 줄 → 여러 장, 학생 수 그대로, 다음 장은 제목 없이 표(머리 줄 다시)', sh.length >= 2 && total === 45 && sh[0].title && !sh[1].title && sh[1].head[0] === '번호' && sh.every(s => s.fits), sh.map(s => [s.title, s.tables, s.fits]));
  const pagesWide = sh.length, firstWide = sh[0].tables[0];
  await P.click('#fm-rowh-input'); await P.waitForTimeout(100);
  const rhStart = await P.inputValue('#fm-rowh-input');
  await setText(P, '#fm-rowh-input', '15'); await P.waitForTimeout(300);
  sh = await sheetsOf(P);
  const rh15 = await P.evaluate(() => parseFloat(document.querySelector('#fm-pages table.fm-tbl tr').style.height));
  check('줄 높이 직접 입력 15mm: 누르면 지금 높이(12)부터, 저장·미리보기 15mm, 버튼은 아무것도 안 켜짐, 한 장에 들어가는 줄 줄어듦', rhStart === '12' && (await cfgOf(hr)).rowH === 15 && rh15 === 15 && sh[0].tables[0] < firstWide && sh.every(s => s.fits) &&
    sh.reduce((a, x) => a + x.tables.reduce((p, q) => p + q - 1, 0), 0) === 45 && await P.evaluate(() => !document.querySelector('#fm-rowh .nt-chip.on')), [rhStart, rh15, sh.map(s => s.tables), firstWide]);
  await setText(P, '#fm-rowh-input', '3'); await P.waitForTimeout(200);
  check('5mm보다 작게 적으면 자동으로 안 바뀌고 무시(자동)', (await cfgOf(hr)).rowH === 0);
  await setText(P, '#fm-rowh-input', '6'); await P.waitForTimeout(200);
  check('글자보다 낮은 높이는 가장 낮은 높이로 + 안내', /너무 낮음/.test(await P.textContent('#fm-fit-info')) && await P.evaluate(() => parseFloat(document.querySelector('#fm-pages table.fm-tbl tr').style.height)) >= 6.5, await P.textContent('#fm-fit-info'));
  await setText(P, '#fm-rowh-input', '9'); await P.waitForTimeout(200);
  check('적은 값이 버튼 값(9 = 보통)이면 그 버튼이 켜짐', await P.evaluate(() => (document.querySelector('#fm-rowh .nt-chip.on') || {}).textContent) === '보통');
  await P.click('#fm-rowh [data-v="0"]'); await P.waitForTimeout(300);
  sh = await sheetsOf(P);
  check('자동 줄 높이: 45명이면 1단은 읽을 수 있는 최소 높이(6.5mm)로 줄여도 넘쳐서 다음 장(넓게보다 적은 장), 모든 장이 종이 안', sh.length >= 2 && sh.length < pagesWide + 1 && sh.every(s => s.fits) && sh.reduce((a, x) => a + x.tables.reduce((p, q) => p + q - 1, 0), 0) === 45, sh.map(s => s.tables));
  await P.click('#fm-colsn [data-v="2"]'); await P.waitForTimeout(300);
  sh = await sheetsOf(P);
  check('2단이면 45명도 한 장(23·22)', sh.length === 1 && sh[0].tables.join() === '24,23' && sh[0].fits, sh.map(s => s.tables));
  await P.click('#fm-colsn [data-v="1"]'); await P.waitForTimeout(300);

  // 글꼴
  await P.selectOption('#fm-tfont', '함초롬바탕'); await setText(P, '#fm-tsize', '24'); await P.waitForTimeout(200);
  const tf = await P.evaluate(() => { const t = document.querySelector('#fm-pages .fm-title'); return [t.style.fontFamily, t.style.fontSize]; });
  check('제목 글꼴·크기', /함초롬바탕/.test(tf[0]) && tf[1] === '24pt', tf);
  await P.waitForTimeout(2500);
  const cfg = await cfgOf(hr);
  check('설정은 계정에 저장(fm-cfg, 학생 명단은 저장 안 함)', cfg.title === '현장체험학습 동의서' && cfg.tFont === '함초롬바탕' && cfg.rCs.join() === '3' && /현장체험학습/.test(serverVal(T2, 'fm-cfg') || '') && !/가나다|학생3-1/.test(serverVal(T2, 'fm-cfg') || ''), cfg);

  // 한글 파일
  if (!JSZIP_JS) console.log('  ⚠️ JSZip 없음 — 한글 파일 검사 건너뜀');
  else {
    await P.click('#fm-classes [data-c="1"]'); await P.click('#fm-classes [data-c="2"]'); await P.click('#fm-colsn [data-v="2"]'); await P.waitForTimeout(500);
    await P.screenshot({ path: 'fm-ui.png' });
    const dl = P.waitForEvent('download');
    await P.click('#fm-hwpx-btn');
    const d = await dl;
    // (헤드리스 크롬은 한글 파일 이름을 "download"로 바꿔 버려서, 앱이 정한 이름을 따로 확인)
    const fname = await P.evaluate(() => fmFileName(fmCfg()));
    const buf = fs.readFileSync(await d.path());
    if (process.env.HWPX_OUT) fs.writeFileSync(process.env.HWPX_OUT, buf);
    check('한글 파일 이름: 제목 + 반', fname === '현장체험학습 동의서 3학년 1·2·3반.hwpx', fname);
    // zip 첫 항목: mimetype, 압축 안 함(0), 내용 application/hwp+zip
    const nameLen = buf.readUInt16LE(26), first = buf.slice(30, 30 + nameLen).toString(), method = buf.readUInt16LE(8);
    const mime = buf.slice(30 + nameLen + buf.readUInt16LE(28), 30 + nameLen + buf.readUInt16LE(28) + 19).toString();
    check('zip 맨 앞 mimetype · 압축 안 함 · application/hwp+zip', buf.slice(0, 4).toString('hex') === '504b0304' && first === 'mimetype' && method === 0 && mime === 'application/hwp+zip', [first, method, mime]);
    const info = await P.evaluate(async (b64) => {
      const zip = await JSZip.loadAsync(b64, { base64: true });
      const names = Object.keys(zip.files);
      const parse = async (n) => { const x = await zip.file(n).async('string'); const d = new DOMParser().parseFromString(x, 'application/xml'); return d.getElementsByTagName('parsererror').length ? null : d; };
      const sec = await parse('Contents/section0.xml'), head = await parse('Contents/header.xml');
      if (!sec || !head) return { bad: true, names };
      const NS_P = 'http://www.hancom.co.kr/hwpml/2011/paragraph', NS_H = 'http://www.hancom.co.kr/hwpml/2011/head';
      const tbls = [...sec.getElementsByTagNameNS(NS_P, 'tbl')];
      const fontsHangul = [...head.getElementsByTagNameNS(NS_H, 'fontface')].find(f => f.getAttribute('lang') === 'HANGUL');
      const cnt = (tag) => { const el = head.getElementsByTagNameNS(NS_H, tag)[0]; return [+el.getAttribute('itemCnt'), el.children.length]; };
      const texts = [...sec.getElementsByTagNameNS(NS_P, 't')].map(t => t.textContent);
      const paras = [...sec.documentElement.children];
      return {
        names, secPr: sec.getElementsByTagNameNS(NS_P, 'secPr').length,
        tables: tbls.map(t => [+t.getAttribute('rowCnt'), +t.getAttribute('colCnt'), t.getElementsByTagNameNS(NS_P, 'tr').length, t.getAttribute('repeatHeader')]),
        cols: [...sec.getElementsByTagNameNS(NS_P, 'colPr')].map(c => c.getAttribute('colCount')),
        pageBreaks: paras.filter(p => p.getAttribute('pageBreak') === '1').length, colBreaks: paras.filter(p => p.getAttribute('columnBreak') === '1').length,
        fonts: [...fontsHangul.children].map(f => f.getAttribute('face')), fontCnt: +fontsHangul.getAttribute('fontCnt'),
        counts: [cnt('charProperties'), cnt('paraProperties'), cnt('borderFills')],
        cellWidthsOk: tbls.every(t => { const w = +t.getElementsByTagNameNS(NS_P, 'sz')[0].getAttribute('width'); const row = t.getElementsByTagNameNS(NS_P, 'tr')[0]; return [...row.getElementsByTagNameNS(NS_P, 'cellSz')].reduce((s, c) => s + +c.getAttribute('width'), 0) === w; }),
        hasTitle: texts.includes('현장체험학습 동의서'), hasName: texts.includes('학생2-30'), hasId: texts.includes('30230'),
        prv: await zip.file('Preview/PrvText.txt').async('string'),
      };
    }, buf.toString('base64'));
    check('XML이 올바르고 필요한 파일이 다 있음(미리보기 그림은 뺌)', !info.bad && ['mimetype', 'version.xml', 'Contents/header.xml', 'Contents/section0.xml', 'Contents/content.hpf', 'META-INF/container.xml', 'settings.xml'].every(n => info.names.includes(n)) && !info.names.includes('Preview/PrvImage.png'), info.names);
    check('표: 3반 2단(왼쪽 단부터 채움 — 5명 반은 한 표) = 5개, 반 인원 + 머리 줄, 머리 줄 반복, 칸 폭 합 = 표 폭', info.tables.length === 5 && info.tables.map(t => t[0]).join() === '6,19,13,24,23' && info.tables.every(t => t[2] === t[0] && t[1] === 6 && t[3] === '1') && info.cellWidthsOk, info.tables);
    check('다단: 제목은 1단, 표는 2단 / 반마다 새 쪽(쪽 나누기 2), 둘째 표는 단 나누기(2)', info.secPr === 1 && info.cols.join() === '1,2,1,2,1,2' && info.pageBreaks === 2 && info.colBreaks === 2, info);
    check('글꼴이 header에 들어감(함초롬바탕 = 기본에 있음, 맑은 고딕 추가) + 개수 맞음', info.fonts.includes('함초롬바탕') && info.fonts.includes('맑은 고딕') && info.fontCnt === info.fonts.length && info.counts.every(c => c[0] === c[1]), info);
    check('글자: 제목·이름·학번이 들어감, 미리보기 글도', info.hasTitle && info.hasName && info.hasId && /현장체험학습/.test(info.prv), info);
  }

  // 칸 너비: 직접 적기·꽉 차게 끄기·모두 자동
  await P.click('#fm-colsn [data-v="1"]'); await P.waitForTimeout(200);
  const colW = () => P.evaluate(() => [...document.querySelectorAll('#fm-pages table.fm-tbl')[0].querySelectorAll('col')].map(c => +parseFloat(c.style.width).toFixed(1)));
  const tblBox = () => P.evaluate(() => { const t = document.querySelector('#fm-pages table.fm-tbl'), col = t.parentElement; return { w: parseFloat(t.style.width), left: t.getBoundingClientRect().left - col.getBoundingClientRect().left, right: col.getBoundingClientRect().right - t.getBoundingClientRect().right }; });
  const wl = await P.evaluate(() => [...document.querySelectorAll('#fm-widths .fm-w span')].map(s => s.textContent));
  check('칸 너비 입력칸: 칸마다 하나(번호·학번·이름·체크 칸·비고)', wl.join('|') === '번호|학번|이름|동의서|회비|비고', wl);
  await P.fill('#fm-widths input[data-wk="chk:회비"]', '30'); await P.waitForTimeout(200);
  let cw = await colW();
  check('체크 칸 너비를 적으면 그 너비(30mm), 나머지는 비고가 채워 여전히 180mm', cw[4] === 30 && Math.abs(cw.reduce((a, b) => a + b, 0) - 180) < 0.1, cw);
  await P.fill('#fm-widths input[data-wk="memo"]', '20'); await P.uncheck('#fm-fill'); await P.waitForTimeout(200);
  cw = await colW(); let tb = await tblBox();
  check('비고 20mm + "꽉 차게" 끄기 → 표가 필요한 만큼만(180mm보다 좁게), 가운데', cw[5] === 20 && tb.w < 179 && Math.abs(tb.left - tb.right) < 1, [cw, tb]);
  check('자동 칸은 회색 예시로 지금 너비가 보임', await P.evaluate(() => document.querySelector('#fm-widths input[data-wk="name"]').placeholder) === '24.0');
  await P.fill('#fm-widths input[data-wk="name"]', '170'); await P.waitForTimeout(200);
  tb = await tblBox();
  check('적은 너비 합이 종이보다 넓으면 비율대로 줄여서 180mm 안', tb.w <= 180.01 && /비율대로 줄였어요/.test(await P.textContent('#fm-width-info')), [tb, await P.textContent('#fm-width-info')]);
  await P.fill('#fm-widths input[data-wk="name"]', ''); await P.waitForTimeout(200);
  if (JSZIP_JS) {
    const narrowW = await P.evaluate(async () => { const zip = await JSZip.loadAsync(await fmBuildHwpx(fmCfg())); const x = await zip.file('Contents/section0.xml').async('string'); return [+x.match(/<hp:sz width="(\d+)"/)[1], fmHu(fmLayout(fmCfg()).tableW)]; });
    check('한글 파일 표 폭도 같은 폭(꽉 차게 끈 너비)', narrowW[0] === narrowW[1] && narrowW[0] < 50000, narrowW);
  }
  await P.click('#fm-width-box .nt-chip'); await P.check('#fm-fill'); await P.waitForTimeout(200);
  cw = await colW();
  check('"모두 자동" → 다시 180mm, 입력칸 비움', Math.abs(cw.reduce((a, b) => a + b, 0) - 180) < 0.1 && (await cfgOf(hr)).colW && !Object.keys((await cfgOf(hr)).colW).length, cw);

  // 글꼴: 경기천년체, 직접 입력
  const fontOpts = await P.evaluate(() => [...document.querySelectorAll('#fm-tfont option')].map(o => o.value));
  check('글꼴 목록에 경기천년제목·경기천년바탕 + 직접 입력', ['경기천년제목 Bold', '경기천년제목 Medium', '경기천년바탕 Regular', '경기천년바탕 Bold', '__custom'].every(f => fontOpts.includes(f)), fontOpts);
  await P.selectOption('#fm-tfont', '경기천년제목 Bold'); await P.selectOption('#fm-bfont', '경기천년바탕 Regular'); await P.waitForTimeout(200);
  let fc = await cfgOf(hr);
  check('경기천년체 고르면 저장(이 PC에 없으면 첫 이름 그대로) + 없다는 안내', fc.tFont === '경기천년제목 Bold' && fc.bFont === '경기천년바탕 Regular' && /이 PC에 없어서/.test(await P.textContent('#fm-font-msg')), [fc.tFont, fc.bFont]);
  if (JSZIP_JS) {
    const faces = await P.evaluate(async () => { const zip = await JSZip.loadAsync(await fmBuildHwpx(fmCfg())); const x = await zip.file('Contents/header.xml').async('string'); return (x.match(/<hh:fontface lang="HANGUL"[\s\S]*?<\/hh:fontface>/)[0].match(/face="[^"]+"/g) || []).join(','); });
    check('한글 파일 글꼴에 경기천년제목 Bold·경기천년바탕 Regular', /경기천년제목 Bold/.test(faces) && /경기천년바탕 Regular/.test(faces), faces);
  }
  await P.selectOption('#fm-tfont', '__custom'); await P.waitForTimeout(200);
  check('직접 입력을 고르면 이름 칸이 보임', await P.isVisible('#fm-tfont-custom'));
  await P.fill('#fm-tfont-custom', '우리학교체'); await P.waitForTimeout(200);
  check('직접 적은 글꼴 이름으로 저장·미리보기', (await cfgOf(hr)).tFont === '우리학교체' && /우리학교체/.test(await P.evaluate(() => document.querySelector('#fm-pages .fm-title').style.fontFamily)) && await P.inputValue('#fm-tfont') === '__custom');
  await P.selectOption('#fm-tfont', '맑은 고딕'); await P.waitForTimeout(200);
  check('목록 글꼴로 돌아가면 이름 칸 숨김', !(await P.isVisible('#fm-tfont-custom')) && (await cfgOf(hr)).tFont === '맑은 고딕');

  // 직접 입력 명단(엑셀·한글 표 복사)
  const before = studentSelects.length;
  await P.click('#fm-src-switch [data-src="manual"]'); await P.waitForTimeout(200);
  check('"직접 입력" → 명단 칸, 비어 있으면 안내', await P.isVisible('#fm-manual') && !(await P.isVisible('#fm-grade')) && /직접 입력/.test(await P.locator('#fm-pages').innerText()));
  await setText(P, '#fm-mlabel', '방과후 A반');
  await setText(P, '#fm-manual', '번호\t이름\n1\t홍길동\n2\t김철수\n30103 이영희\n박민수\n\n5번 최지우\n3\t1\t7\t한소희');
  await P.waitForTimeout(300);
  await P.evaluate(() => { document.getElementById('fm-widths').scrollIntoView(); });
  await P.screenshot({ path: 'fm-manual.png' });
  const mrows = await P.evaluate(() => [...document.querySelectorAll('#fm-pages table.fm-tbl tr')].slice(1).map(tr => [...tr.cells].slice(0, 3).map(c => c.textContent).join(' ')));
  sh = await sheetsOf(P);
  check('붙여 넣은 명단: 머리 줄 건너뜀, 탭·띄어쓰기, 학번(30103 → 3번), 번호 없으면 이어서, "5번", 학년 반 번호', mrows.join(',') === '1  홍길동,2  김철수,3 30103 이영희,4  박민수,5  최지우,7 30107 한소희', mrows);
  check('한 장, 정보 줄은 명단 이름(6명), 서버에 학생 요청 안 함', sh.length === 1 && sh[0].info === '방과후 A반 (6명)' && studentSelects.length === before, [sh, studentSelects.length - before]);
  check('파일 이름: 제목 + 명단 이름', await P.evaluate(() => fmFileName(fmCfg())) === '현장체험학습 동의서 방과후 A반.hwpx');
  if (JSZIP_JS) {
    const mt = await P.evaluate(async () => { const zip = await JSZip.loadAsync(await fmBuildHwpx(fmCfg())); const x = await zip.file('Contents/section0.xml').async('string'); return [(x.match(/<hp:tbl /g) || []).length, /한소희/.test(x), /방과후 A반 \(6명\)/.test(x)]; });
    check('직접 입력 명단으로 한글 파일', mt[0] === 1 && mt[1] && mt[2], mt);
  }
  await P.click('#fm-src-switch [data-src="class"]'); await P.waitForTimeout(400);
  check('반 명단으로 돌아가면 반 고르기(직접 입력한 명단은 남아 있음)', await P.isVisible('#fm-grade') && /한소희/.test((await cfgOf(hr)).manual));

  // 반 고르기: 숫자만, 한 줄
  const chipRow = await P.evaluate(() => { const b = [...document.querySelectorAll('#fm-classes .nt-chip')]; return { txt: b.map(x => x.textContent).join(','), tops: new Set(b.map(x => Math.round(x.getBoundingClientRect().top))).size }; });
  await P.evaluate(() => document.getElementById('fm-class-box').scrollIntoView()); await P.screenshot({ path: 'fm-classes.png', clip: { x: 68, y: 100, width: 360, height: 300 } });
  check('반은 숫자만(1~10), 10개 반도 한 줄', chipRow.txt === '1,2,3,4,5,6,7,8,9,10' && chipRow.tops === 1, chipRow);

  // 정렬
  await P.click('#fm-aligns [data-k="aT"] [data-v="L"]'); await P.click('#fm-aligns [data-k="aTb"] [data-v="R"]');
  await P.click('#fm-aligns [data-k="aBd"] [data-v="L"]'); await P.click('#fm-aligns [data-k="aHd"] [data-v="R"]'); await P.click('#fm-aligns [data-k="aI"] [data-v="R"]');
  await P.uncheck('#fm-fill'); await P.waitForTimeout(300);
  const al = await P.evaluate(() => { const sh = document.querySelector('#fm-pages .fm-sheet'), t = sh.querySelector('table.fm-tbl'), col = t.parentElement; return {
    title: sh.querySelector('.fm-title').style.textAlign, info: sh.querySelector('.fm-info').style.textAlign,
    right: Math.round(col.getBoundingClientRect().right - t.getBoundingClientRect().right), left: Math.round(t.getBoundingClientRect().left - col.getBoundingClientRect().left),
    name: t.rows[1].cells[2].style.textAlign, num: t.rows[1].cells[0].style.textAlign, head: getComputedStyle(t.rows[0].cells[2]).textAlign, head0: getComputedStyle(t.rows[0].cells[0]).textAlign }; });
  await P.evaluate(() => document.getElementById('fm-align-box').scrollIntoView()); await P.screenshot({ path: 'fm-align.png' });
  check('정렬: 제목 왼쪽, 반·인원 오른쪽, 표는 오른쪽, 표 내용(이름·번호 모두) 왼쪽, 표 제목칸 오른쪽', al.title === 'left' && al.info === 'right' && al.right === 0 && al.left > 10 && al.name === 'left' && al.num === 'left' && al.head === 'right' && al.head0 === 'right', al);
  if (JSZIP_JS) {
    const hx = await P.evaluate(async () => {
      const zip = await JSZip.loadAsync(await fmBuildHwpx(fmCfg()));
      const sec = await zip.file('Contents/section0.xml').async('string'), head = await zip.file('Contents/header.xml').async('string');
      const align = (id) => (head.match(new RegExp('<hh:paraPr id="' + id + '"[^>]*>\\s*<hh:align horizontal="(\\w+)"')) || [])[1];
      const paras = [...sec.matchAll(/<hp:p id="\d+" paraPrIDRef="(\d+)"[^>]*>(?:(?!<hp:p ).)*?<hp:t>([^<]*)<\/hp:t>/g)].map(m => [align(m[1]), m[2]]);
      const tblPara = sec.match(/<hp:p id="\d+" paraPrIDRef="(\d+)"[^>]*>(?:<hp:run[^>]*>(?:<hp:ctrl>.*?<\/hp:ctrl>)?<\/hp:run>)?<hp:run[^>]*><hp:tbl /);
      return { title: (paras.find(p => p[1] === '현장체험학습 동의서') || [])[0], name: (paras.find(p => p[1] === '가나다') || [])[0], num: (paras.find(p => p[1] === '1') || [])[0], head: (paras.find(p => p[1] === '번호') || [])[0], table: tblPara ? align(tblPara[1]) : null };
    });
    check('한글 파일도 같은 정렬(제목 LEFT, 표 문단 RIGHT, 표 내용 LEFT, 표 제목칸 RIGHT)', hx.title === 'LEFT' && hx.table === 'RIGHT' && hx.name === 'LEFT' && hx.num === 'LEFT' && hx.head === 'RIGHT', hx);
  }
  await P.click('#fm-aligns [data-k="aT"] [data-v="C"]'); await P.click('#fm-aligns [data-k="aTb"] [data-v="C"]'); await P.click('#fm-aligns [data-k="aBd"] [data-v="C"]'); await P.click('#fm-aligns [data-k="aHd"] [data-v="C"]'); await P.click('#fm-aligns [data-k="aI"] [data-v="C"]');
  await P.check('#fm-fill'); await P.waitForTimeout(200);

  // 자동 너비 칸을 누르면 지금 너비에서 시작
  await P.click('#fm-widths input[data-wk="name"]'); await P.waitForTimeout(100);
  const startV = await P.inputValue('#fm-widths input[data-wk="name"]');
  await P.keyboard.press('ArrowUp'); await P.waitForTimeout(200);
  check('자동 너비 칸을 누르면 지금 너비(24.0)가 들어가고, ↑ 누르면 24.5로(최솟값 5부터 아님)', startV === '24.0' && (await cfgOf(hr)).colW.name === 24.5, [startV, (await cfgOf(hr)).colW]);
  await P.click('#fm-width-box .nt-chip'); await P.waitForTimeout(200);
  await P.click('#fm-widths input[data-wk="id"]'); await P.click('#fm-title'); await P.waitForTimeout(200);
  check('누르기만 하고 안 바꾸면 자동 그대로', !('id' in (await cfgOf(hr)).colW) && (await P.inputValue('#fm-widths input[data-wk="id"]')) === '');

  // 엑셀
  if (!EXCELJS_PATH) console.log('  ⚠️ exceljs가 없어 엑셀 검사를 건너뜀 (npm i exceljs@4.4.0 후 NODE_PATH에 추가)');
  else {
    await P.click('#fm-aligns [data-k="aBd"] [data-v="C"]'); await P.waitForTimeout(100);
    const dlx = P.waitForEvent('download');
    await P.click('#fm-xlsx-btn');
    const xbuf = fs.readFileSync(await (await dlx).path());
    const ExcelJS = require(path.join(path.dirname(EXCELJS_PATH), '..'));
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(xbuf);
    const names = wb.worksheets.map(w => w.name);
    const ws = wb.getWorksheet('3학년 3반');
    const hdrRow = [...Array(ws.rowCount)].map((_, i) => i + 1).find(r => ws.getCell(r, 1).value === '번호');
    const head = [1, 2, 3, 4, 5, 6].map(i => ws.getCell(hdrRow, i).value);
    const last = ws.getRow(ws.rowCount);
    check('엑셀: 반마다 한 시트, 제목·반(인원)·안내 두 줄, 머리 줄', names.join(',') === '3학년 1반,3학년 2반,3학년 3반' && ws.getCell(1, 1).value === '현장체험학습 동의서' && ws.getCell(2, 1).value === '3학년 3반 (45명)' && ws.getCell(3, 1).value === '10월 10일(금)까지 제출' && head.join('|') === '번호|학번|이름|동의서|회비|비고', [names, head]);
    check('엑셀: 1단으로 45명 전부(번호는 숫자), 마지막 줄 45번', ws.rowCount === hdrRow + 45 && last.getCell(1).value === 45 && last.getCell(3).value === '학생3-45', [ws.rowCount, hdrRow]);
    const hc = ws.getCell(hdrRow, 1), z = ws.getCell(hdrRow + 2, 1), nz = ws.getCell(hdrRow + 1, 1), tt = ws.getCell(1, 1);
    check('엑셀: 머리 줄 굵게·회색, 번갈아 연한 회색, 테두리, 제목 글꼴·크기, 비고 가운데', hc.font.bold && hc.fill.fgColor.argb === 'FFE5E5E5' && z.fill && z.fill.fgColor.argb === 'FFF2F2F2' && !nz.fill.fgColor && hc.border.top.style === 'thin' &&
      tt.font.name === '맑은 고딕' && tt.font.size === 24 && ws.getCell(hdrRow + 1, 6).alignment.horizontal === 'center', [hc.font, z.fill, tt.font]);
    check('엑셀: 머리 줄 쪽마다 반복·틀 고정, A4 세로 폭 맞춤', ws.pageSetup.printTitlesRow === hdrRow + ':' + hdrRow && ws.views[0].ySplit === hdrRow && ws.pageSetup.paperSize === 9 && ws.pageSetup.fitToWidth === 1, [ws.pageSetup.printTitlesRow, ws.views]);
    const widths = ws.columns.map(cl => cl.width);
    check('엑셀: 칸 너비 비율이 화면과 같음(이름 > 번호)', widths[2] > widths[0] * 1.5 && widths.length === 6, widths);
  }

  // 쪽 설정(한글 F7): 용지·방향·여백
  const sheetMm = () => P.evaluate(() => { const sh = document.querySelector('#fm-pages .fm-sheet'); return { w: sh.style.width, h: sh.style.height, pad: sh.style.padding }; });
  check('쪽 설정 기본: A4 세로, 여백 15mm(보통 켜짐)', JSON.stringify(await sheetMm()) === JSON.stringify({ w: '210mm', h: '297mm', pad: '15mm' }) && await P.evaluate(() => document.querySelector('#fm-mpre .nt-chip.on').textContent) === '보통', await sheetMm());
  await P.click('#fm-paper [data-paper="B4"]'); await P.click('#fm-paper [data-land="1"]'); await P.waitForTimeout(200);
  await setText(P, '#fm-margins input[data-k="mT"]', '20'); await setText(P, '#fm-margins input[data-k="mL"]', '25'); await P.waitForTimeout(300);
  const pgB4 = await sheetMm(), pc = await cfgOf(hr);
  check('B4 가로 + 위 20·왼쪽 25: 미리보기 364×257mm, 여백 그대로, 저장, "보통"은 꺼짐', pgB4.w === '364mm' && pgB4.h === '257mm' && pgB4.pad === '20mm 15mm 15mm 25mm' && pc.paper === 'B4' && pc.land === true && pc.mT === 20 && pc.mL === 25 &&
    !(await P.evaluate(() => document.querySelector('#fm-mpre .nt-chip.on'))) && /B4 가로/.test(await P.textContent('#fm-prev-label')), [pgB4, pc]);
  const twB4 = await P.evaluate(() => parseFloat(document.querySelector('#fm-pages table.fm-tbl').style.width));
  check('표 폭 = 364 − 25 − 15 = 324mm(꽉 차게)', Math.abs(twB4 - 324) < 0.01, twB4);
  if (JSZIP_JS) {
    const pz = await P.evaluate(async () => { const zip = await JSZip.loadAsync(await fmBuildHwpx(fmCfg())); const sec = await zip.file('Contents/section0.xml').async('string');
      return [(sec.match(/<hp:pagePr [^>]*>/) || [])[0], (sec.match(/<hp:margin [^>]*>/) || [])[0]]; });
    check('한글 파일: B4 세로 크기 + 가로 방향(NARROWLY), 여백 위 20·왼쪽 25·오른쪽 15mm', /landscape="NARROWLY"/.test(pz[0]) && /width="72850"/.test(pz[0]) && /height="103181"/.test(pz[0]) && /top="5669"/.test(pz[1]) && /left="7087"/.test(pz[1]) && /right="4252"/.test(pz[1]), pz);
  }
  await P.click('#fm-mpre [data-m="15"]'); await P.click('#fm-paper [data-paper="A4"]'); await P.click('#fm-paper [data-land="0"]'); await P.waitForTimeout(200);
  check('여백 "보통" 누르면 네 쪽 15mm, A4 세로로 돌아옴', JSON.stringify(await sheetMm()) === JSON.stringify({ w: '210mm', h: '297mm', pad: '15mm' }) && await P.inputValue('#fm-margins input[data-k="mL"]') === '15');

  // 표 선: 빠른 모양, 고칠 곳(여러 개) → 종류·굵기·색
  const bds = () => P.evaluate(() => { const t = document.querySelector('#fm-pages table.fm-tbl'), cs = (r, c) => getComputedStyle(t.rows[r].cells[c]);
    return { outTop: cs(0, 0).borderTopStyle + ' ' + cs(0, 0).borderTopWidth, headBot: cs(0, 1).borderBottomStyle, inH: cs(2, 1).borderTopStyle, inHw: parseFloat(cs(2, 1).borderTopWidth), inV: cs(2, 1).borderLeftStyle + ' ' + cs(2, 1).borderLeftColor, outLeft: cs(2, 0).borderLeftWidth }; });
  await P.click('#fm-ln-pre [data-i="2"]'); await P.waitForTimeout(200);
  let b = await bds();
  check('빠른 모양 "제목칸 이중선": 바깥 0.4mm 실선, 제목칸 아래 이중선, 안쪽은 얇은 실선', b.outTop.startsWith('solid') && parseFloat(b.outTop.split(' ')[1]) > b.inHw && b.headBot === 'double' && b.inH === 'solid' && (await cfgOf(hr)).ln.h.t === 'double', b);
  await P.click('#fm-ln-parts [data-part="o"]'); // 바깥은 빼고(하나뿐이면 안 빠짐 → 그대로)
  await P.click('#fm-ln-parts [data-part="ih"]'); await P.click('#fm-ln-parts [data-part="iv"]'); await P.click('#fm-ln-parts [data-part="o"]'); await P.waitForTimeout(100);
  const selParts = await P.evaluate(() => [...document.querySelectorAll('#fm-ln-parts .nt-chip.on')].map(x => x.dataset.part).join());
  await P.selectOption('#fm-ln-type', 'dash'); await P.click('#fm-ln-colors [data-c="#1F4E9A"]'); await P.waitForTimeout(200);
  b = await bds(); let lc = (await cfgOf(hr)).ln;
  check('고칠 곳 여러 개(안쪽 가로·세로) 골라 파선·파랑 → 그 두 곳만 바뀜, 바깥·제목칸 아래는 그대로', selParts === 'ih,iv' && lc.ih.t === 'dash' && lc.iv.t === 'dash' && lc.ih.c === '#1F4E9A' && lc.o.t === 'solid' && lc.h.t === 'double' &&
    b.inH === 'dashed' && b.inV === 'dashed rgb(31, 78, 154)' && b.headBot === 'double', [selParts, lc, b]);
  await P.click('#fm-ln-parts [data-part="o"]'); await P.click('#fm-ln-parts [data-part="ih"]'); await P.click('#fm-ln-parts [data-part="iv"]'); // 바깥만(마지막 하나는 안 빠지니 바깥을 먼저 고름)
  await P.selectOption('#fm-ln-type', 'none'); await P.waitForTimeout(200);
  b = await bds();
  check('바깥 테두리 "없음" → 바깥 선 안 보임, 굵기 칸은 못 고침', b.outLeft === '0px' && await P.isDisabled('#fm-ln-w') && !(await P.evaluate(() => document.querySelector('#fm-ln-pre .nt-chip.on'))), b);
  if (JSZIP_JS) {
    const lz = await P.evaluate(async () => { const zip = await JSZip.loadAsync(await fmBuildHwpx(fmCfg())); const head = await zip.file('Contents/header.xml').async('string'), sec = await zip.file('Contents/section0.xml').async('string');
      const bf = {}; [...head.matchAll(/<hh:borderFill id="(\d+)"[\s\S]*?<\/hh:borderFill>/g)].forEach(m => bf[m[1]] = m[0]);
      const tbl = sec.match(/<hp:tbl [\s\S]*?<\/hp:tbl>/)[0], cells = [...tbl.matchAll(/<hp:tc [^>]*borderFillIDRef="(\d+)"[\s\S]*?<hp:cellAddr colAddr="(\d+)" rowAddr="(\d+)"/g)].map(m => ({ id: m[1], c: +m[2], r: +m[3] }));
      const side = (r, c, k) => { const x = cells.find(q => q.r === r && q.c === c); return (bf[x.id].match(new RegExp('<hh:' + k + 'Border type="(\\w+)" width="([^"]+)" color="([^"]+)"')) || []).slice(1).join(' '); };
      return { outLeft: side(1, 0, 'left'), headBot: side(0, 1, 'bottom'), inTop: side(2, 1, 'top'), inLeft: side(2, 1, 'left'), headFill: /faceColor="#E5E5E5"/.test(bf[cells.find(q => q.r === 0).id]), itemCnt: +head.match(/<hh:borderFills itemCnt="(\d+)"/)[1], maxId: Math.max(...Object.keys(bf).map(Number)) }; });
    if (process.env.HWPX_OUT2) { // 선·쪽 설정을 바꾼 한글 파일도 저장(검사·그려 보기용) — B4 가로로 다시 만든다
      const b64 = await P.evaluate(async () => { const c = Object.assign(fmCfg(), { paper: 'B4', land: true, colsN: 2 }); const bl = await fmBuildHwpx(c); const u8 = new Uint8Array(await bl.arrayBuffer()); let t = ''; u8.forEach(x => t += String.fromCharCode(x)); return btoa(t); });
      fs.writeFileSync(process.env.HWPX_OUT2, Buffer.from(b64, 'base64'));
    }
    check('한글 파일 칸 테두리: 바깥 NONE, 제목칸 아래 DOUBLE_SLIM 0.5mm, 안쪽 DASH 파랑, 머리 줄 회색 배경, 테두리 개수 맞음', lz.outLeft.startsWith('NONE') && lz.headBot === 'DOUBLE_SLIM 0.5 mm #000000' && lz.inTop === 'DASH 0.12 mm #1F4E9A' && lz.inLeft === 'DASH 0.12 mm #1F4E9A' && lz.headFill && lz.itemCnt === lz.maxId, lz);
  }
  if (EXCELJS_PATH) {
    const dlx2 = P.waitForEvent('download'); await P.click('#fm-xlsx-btn');
    const ExcelJS = require(path.join(path.dirname(EXCELJS_PATH), '..'));
    const wb2 = new ExcelJS.Workbook(); await wb2.xlsx.load(fs.readFileSync(await (await dlx2).path()));
    const w2 = wb2.worksheets[0], hr2 = [...Array(w2.rowCount)].map((_, i) => i + 1).find(r => w2.getCell(r, 1).value === '번호');
    const e = { headBot: (w2.getCell(hr2, 2).border.bottom || {}).style, inTop: (w2.getCell(hr2 + 2, 2).border.top || {}).style, inColor: ((w2.getCell(hr2 + 2, 2).border.top || {}).color || {}).argb, outLeft: w2.getCell(hr2 + 1, 1).border.left };
    check('엑셀 테두리도 같게(제목칸 아래 이중선, 안쪽 파선 파랑, 바깥 없음)', e.headBot === 'double' && e.inTop === 'dashed' && e.inColor === 'FF1F4E9A' && !e.outLeft, e);
  }
  await P.click('#fm-ln-pre [data-i="1"]'); await P.waitForTimeout(200);
  await P.emulateMedia({ media: 'print' });
  // (getComputedStyle은 화면 픽셀로 깎아 보여서, 인쇄 때 화면용 px 대신 mm 쪽이 쓰이는지(--fms = 0)와 적힌 mm 값을 본다)
  const prW = await P.evaluate(() => { const t = document.querySelector('#fm-pages table.fm-tbl'); return [getComputedStyle(document.getElementById('fm-pages')).getPropertyValue('--fms').trim(), t.rows[0].cells[0].style.borderTop]; });
  await P.emulateMedia({ media: 'screen' });
  const scW = await P.evaluate(() => getComputedStyle(document.getElementById('fm-pages')).getPropertyValue('--fms').trim());
  check('인쇄 때는 선 굵기를 정확한 mm로(바깥 0.4mm), 화면에선 굵기 차이가 보이게 px로', prW[0] === '0' && scW === '1' && /0\.4mm/.test(prW[1]), [prW, scW]);
  await P.click('#fm-ln-pre [data-i="0"]'); await P.waitForTimeout(200);
  check('빠른 모양 "기본"으로 되돌리기', (await bds()).headBot === 'solid' && (await cfgOf(hr)).ln.o.w === 0.12);

  // 못 받는 반 → 안내, 다시 그려도 재요청 안 함
  failStudents = true;
  await P.click('#fm-classes [data-c="4"]'); await P.waitForTimeout(500);
  const n0 = studentSelects.length;
  await setText(P, '#fm-title', '다시'); await setText(P, '#fm-title', '다시2'); await P.waitForTimeout(300);
  check('명렬표를 못 받으면 안내 + 글을 고쳐도 다시 요청 안 함', /불러오지 못했어요/.test(await P.locator('#fm-pages').innerText()) && studentSelects.length === n0, studentSelects.slice(-3));
  failStudents = false;

  // 다른 화면으로 가면 닫힘
  await P.click('#rail-nametag-btn'); await P.waitForTimeout(300);
  check('이름표를 누르면 양식 화면이 닫힘', !(await P.isVisible('#form-page')) && await P.isVisible('#nametag-page') && !(await P.evaluate(() => document.getElementById('rail-forms-btn').classList.contains('active'))));
  await P.click('#rail-forms-btn'); await P.waitForTimeout(300);
  await P.click('#rail-forms-btn'); await P.waitForTimeout(300);
  check('양식 버튼을 한 번 더 누르면 홈', !(await P.isVisible('#form-page')) && await P.isVisible('#main-dashboard'));

  // 담임이 아니면 빈 화면에서 시작
  const t1 = await openDevice(browser, '김교사PC', T1);
  await t1.page.click('#rail-forms-btn'); await t1.page.waitForTimeout(400);
  check('담임이 아니면 학년·반을 고르라는 안내', /학년·반/.test(await t1.page.locator('#fm-pages').innerText()));

  const allErrors = pages.flatMap(p => (p.errors || []).map(e => p.name + ': ' + e));
  check('전체 페이지 오류 없음', allErrors.length === 0, allErrors);
  console.log(failures === 0 ? '\n모든 검사 통과' : '\n실패 ' + failures + '건');
  await browser.close();
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
