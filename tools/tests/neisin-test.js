// 📥 나이스 시간표 받기: 확장 프로그램(tools/neis-ext)이 넘겨 주는 나이스 "전체시간표 (변경수업)" 보고서(크라운릭스 MML XML)의
// 바뀐 칸을 schedule_cell_changes에 나이스에 적힌 그대로 담고, 시간표는 기본 시간표 위에 그 칸을 덮어 그린다(수업 변경 창은 없앰).
// 읽기(여러 쪽·두 줄 글·추가반 열) / 시험·행사 칸 빼기 / 넣은 뒤 칸마다 나이스와 같음 / 홈·검색 시간표 / 여러 학년 합치기 /
// 매일 맞추기(같으면 쓰기 0·바뀌면 바꿈·없어지면 뺌·조회 기간 밖은 그대로) / 되돌리기 / 담당이 아니면 안 넣음.
// 선생님 이름·시간표는 모두 가짜(실제 보고서 구조만 따름).
// 실행: cd tools/tests && NODE_PATH=/opt/node22/lib/node_modules node neisin-test.js
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
  ['33333333-3333-3333-3333-333333333333']: { id: '33333333-3333-3333-3333-333333333333', name: '최실무', is_admin: false, must_change_password: false, role: '실무사', homeroom_grade: null, homeroom_class: null },
  ['55555555-5555-5555-5555-555555555555']: { id: '55555555-5555-5555-5555-555555555555', name: '수업계', is_admin: false, must_change_password: false, role: '실무사', homeroom_grade: null, homeroom_class: null, schedule_manager: true },
  ['66666666-6666-6666-6666-666666666666']: { id: '66666666-6666-6666-6666-666666666666', name: '수업계교사', is_admin: false, must_change_password: false, role: '교사', homeroom_grade: null, homeroom_class: null, schedule_manager: true },
  [T2]: { id: T2, name: '박교사', is_admin: false, must_change_password: false, role: '교사', homeroom_grade: null, homeroom_class: null },
};
const items = new Map(); // teacher|key -> {teacher_id,key,value,updated_at}
const history = [];
const cellChanges = []; // 나이스 바뀐 칸(schedule_cell_changes)
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
  if (table === 'app_settings' && op === 'select' && filters.some(f => f.val === 'semester_ranges')) {
    // 오늘이 속한 학기: 한 달 전 ~ 두 달 뒤
    const d = (n) => { const x = new Date(); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };
    return { data: { value: { '1학기': { start: '2000-03-01', end: '2000-07-20' }, '2학기': { start: d(-30), end: d(60) } } }, error: null };
  }
  if (table === 'schedule_cell_changes') {
    if (op === 'insert') { const out = []; (Array.isArray(rows) ? rows : [rows]).forEach(x => { const row = Object.assign({ id: Math.max(0, ...cellChanges.map(c => c.id)) + 1, created_by: teachers[pageInfo.uid].name, created_at: nowIso() }, x); cellChanges.push(row); out.push({ id: row.id }); }); return { data: out, error: null }; }
    if (op === 'delete') { const f = filters.find(x => x.col === 'id'); const ids = f ? (f.op === 'in' ? f.val : [f.val]) : []; for (let i = cellChanges.length - 1; i >= 0; i--) if (ids.includes(cellChanges[i].id)) cellChanges.splice(i, 1); return { data: null, error: null }; }
    if (op === 'select') return { data: cellChanges.slice().sort((x, y) => x.id - y.id).map((c) => Object.assign({}, c)), error: null };
  }
  if (table === 'schedule_changes') { global.__oldTableUsed = true; return { data: [], error: null }; } // 예전 교환·보강 표는 더 안 씀
  if (table === 'timetable' && op === 'select' && global.__tt) return { data: global.__tt, error: null };
  if (table === 'timetable' && op === 'select') {
    const subj = ['국어','수학','영어','과학','사회','체육','음악','미술'];
    const rows = ['김교사','박교사','이교사','정교사','한교사','오교사','윤교사','장교사'].map((nm, t) => ({ teacher_name: nm, cells: Array.from({length:35}, (_, j) => (j + t) % 3 === 0 ? subj[(j + t) % 8] + '\n' + (200 + j) : '') }));
    // 10/7 담당 선생님이 검증한 실제 시간표(화·목만): 백경미 화1 독서 302·목1 독서 307 / 하영우 화2 물리 302 / 김용남 화1 심화영어 307·화4 302
    const real = (m) => { const c = Array(35).fill(''); for (const k in m) c[k] = m[k]; return c; };
    rows.push({ teacher_name: '백경미', cells: real({ 7: '독서\n302', 10: '독서\n306', 21: '독서\n307', 22: '독서\n303' }) });
    rows.push({ teacher_name: '하영우', cells: real({ 8: '물리학Ⅱ\n302', 9: '물리학Ⅱ\n303', 11: '물리학Ⅱ\n301', 22: '물리학Ⅱ\n301' }) });
    rows.push({ teacher_name: '김용남', cells: real({ 7: '심화영어Ⅰ\n307', 10: '심화영어Ⅰ\n302', 22: '심화영어Ⅰ\n307' }) });
    return { data: rows, error: null };
  }
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
    if (url.includes('/exceljs@')) { try { return route.fulfill({ body: fs.readFileSync(require.resolve('exceljs/dist/exceljs.min.js')), contentType: 'application/javascript' }); } catch (e) {} }
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


// ---------- 날짜(이번 주 월~금 — 홈·검색 시간표가 이번 주를 그린다) ----------
const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const mon = new Date(); mon.setHours(0, 0, 0, 0); mon.setDate(mon.getDate() + (mon.getDay() === 0 ? -6 : 1 - mon.getDay()));
const D = [0, 1, 2, 3, 4].map((i) => { const d = new Date(mon); d.setDate(d.getDate() + i); return ymd(d); }); // D[0]=월 … D[4]=금
const WD = ['일', '월', '화', '수', '목', '금', '토'];

// ---------- 가짜 시간표(요일 1=월, 교시) ----------
const tt = {};
function put(t, wd, p, subj, room) { (tt[t] = tt[t] || Array(35).fill('')); tt[t][(wd - 1) * 7 + p - 1] = subj + '\n' + room; }
put('가교사', 1, 1, '국어', '101'); put('나교사', 3, 3, '수학', '101');      // 교체: 가(월1 101) ↔ 나(수3 101)
put('다교사', 1, 2, '영어', '102'); put('라교사', 1, 3, '영어', '103');      // 보강: 월2 102 다 → 라
put('마교사', 2, 1, '정보', '103'); put('마교사', 2, 5, '정보', '104');      // 맞물린 교체: 화1·화5
put('바교사', 2, 5, '과학', '103'); put('사교사', 2, 1, '영어', '104');
put('아교사', 1, 4, '역사', '101'); put('자교사', 1, 5, '역사', '102');
put('차교사', 2, 3, '미술', '102'); put('타교사', 5, 1, '미술', '101');
put('파교사', 5, 2, '음악', '103'); put('하교사', 4, 6, '음악', '104');
put('거교사', 4, 1, '체육', '101'); put('너교사', 4, 1, '체육', '102'); put('더교사', 4, 1, '체육', '103'); // 행사 날
put('러교사', 3, 2, '물리', '305'); put('머교사', 3, 2, '화학', '306'); put('버교사', 1, 7, '지구', '306');
put('쉬교사', 4, 2, '국어', '301'); put('위교사', 4, 3, '수학', '302');
put('키교사', 5, 4, '영어', '301'); put('피교사', 5, 4, '과학', '302');
put('감교사', 2, 2, '국어', '201'); put('남교사', 2, 2, '수학', '202'); put('담교사', 2, 2, '영어', '203'); // 여러 명이 돌아가며
put('람교사', 3, 1, '물리', '204'); put('맘교사', 3, 2, '화학', '204'); put('밤교사', 3, 3, '생명', '204');
put('삼교사', 4, 1, '지리', '205'); put('암교사', 4, 4, '지리', '206'); put('잠교사', 1, 1, '국어', '207');
global.__tt = Object.keys(tt).map((n) => ({ teacher_name: n, cells: tt[n] }));

// ---------- 크라운릭스 보고서(MML) 흉내: 머리칸 PR id, 칸 PR hd="학년,반,날짜,교시", 긴 글은 TL 두 줄로 ----------
function mml(grade, pages) {
  const all = pages.flat().map((d) => d.date).sort();
  const c8 = (s) => s.replace(/-/g, '');
  let x = '<?xml version="1.0" encoding="utf-8"?><MML version="2.9"><DOCUMENT><HEAD><INFORMATION><TITLE>전체시간표</TITLE><MRD>his_edctm06_r03.mrd</MRD></INFORMATION><VALIST>' +
    '<VA key="$1">E100000215</VA><VA key="$2">2026</VA><VA key="$3">2</VA><VA key="$4">' + grade + '</VA><VA key="$5">1</VA><VA key="$6">' + c8(all[0]) + '</VA><VA key="$7">' + c8(all[all.length - 1]) + '</VA>' +
    '<VA key="s_title">2026 학년도 2 학기 ' + grade + ' 학년</VA></VALIST></HEAD><BODY>';
  const tl = (t) => { if (t.length <= 8) return '<TL tid="3" le="1" to="1">' + t + '\r</TL>'; return '<TL tid="3" le="1" to="1">' + t.slice(0, 8) + '</TL><TL tid="3" le="1" to="2">' + t.slice(8) + '\r</TL>'; };
  pages.forEach((days, pi) => {
    let id = 0; const pr = (t) => '<PR sx="0" sy="0" ex="1" ey="1" id="' + (++id) + '">' + t + '</PR>';
    x += '<PG no="' + (pi + 1) + '"><PR sx="1" sy="1" ex="2" ey="2"><TL tid="2" le="1" to="1">전체시간표 (변경수업)\r</TL></PR><PR sx="0" sy="0" ex="9" ey="9" ty="tb">';
    x += pr('<TL tid="3" le="1" to="1">일자</TL>') + pr('<TL tid="3" le="1" to="1">교시</TL>');
    const gId = id + 1; x += pr('<TL tid="3" le="1" to="1">' + grade + '학년\r</TL>');
    const col = {};
    for (let c = 1; c <= 7; c++) { col[c] = id + 1; x += pr('<TL tid="3" le="1" to="1">' + c + '(' + grade + '학년 ' + c + '반)</TL>'); }
    col[8] = id + 1; x += pr('<TL tid="3" le="1" to="1">8(1,2학년 추가 </TL><TL tid="3" le="1" to="2">반)\r</TL>');
    days.forEach((d) => {
      const dId = id + 1, dt = new Date(d.date + 'T00:00:00');
      x += pr('<TL tid="3" le="1" to="1">' + d.date.replace(/-/g, '.') + '.</TL><TL tid="3" le="1" to="2">(' + WD[dt.getDay()] + '요일)\r</TL>');
      for (let p = 1; p <= 7; p++) {
        const pId = id + 1; x += pr('<TL tid="3" le="1" to="1">' + p + '교시\r</TL>');
        for (let c = 1; c <= 8; c++) {
          const t = (d.cells[p] || {})[c];
          x += '<PR sx="0" sy="0" ex="1" ey="1" hd="' + gId + ',' + col[c] + ',' + dId + ',' + pId + '">' + (t ? tl(t.replace(/&/g, '&amp;')) : '') + '</PR>';
        }
      }
    });
    x += '</PR></PG>';
  });
  return x + '</BODY></DOCUMENT></MML>';
}
// 1학년(두 쪽 — 목·금은 둘째 쪽): 칸 14개 중 행사 3칸
const g1 = mml(1, [
  [{ date: D[0], cells: { 1: { 1: '수학(나교사)' }, 2: { 2: '[보강]영어(라교사)' }, 4: { 1: '[보강]역사(자교사)' } } },
   { date: D[1], cells: { 1: { 3: '과학(바교사)', 4: '정보(마교사)' }, 3: { 2: '[보강]미술(타교사)' }, 5: { 3: '정보(마교사)', 4: '영어(사교사)' } } },
   { date: D[2], cells: { 3: { 1: '국어(가교사)' } } }],
  [{ date: D[3], cells: { 1: { 1: '동아리활동(거교사)', 2: '동아리활동(너교사)', 3: '동아리활동(더교사)' } } },
   { date: D[4], cells: { 2: { 3: '음악(하교사)', 4: '[보강]음악(없는교사)' } } }]
]);
const g3 = mml(3, [[{ date: D[2], cells: { 2: { 5: '[보강]물리(머교사)' } } },
  { date: D[3], cells: { 2: { 1: '수학(위교사)' }, 3: { 2: '국어(쉬교사)' } } },
  { date: D[4], cells: { 4: { 1: '과학(피교사)', 2: '영어(키교사)' } } }]]);
// 2학년: 시험 칸 1 + 여러 명이 돌아가며 바꾼 교체(같은 시간 세 반 / 같은 반 세 교시) + 짝 없는 교체
const g2 = mml(2, [[{ date: D[0], cells: { 1: { 7: '2학기 1차 시험-국어(잠교사)' } } },
  { date: D[1], cells: { 2: { 1: '수학(남교사)', 2: '영어(담교사)', 3: '국어(감교사)' } } },
  { date: D[2], cells: { 1: { 4: '화학(맘교사)' }, 2: { 4: '생명(밤교사)' }, 3: { 4: '물리(람교사)' } } },
  { date: D[3], cells: { 1: { 5: '지리(암교사)' } } }]]);
const wait2 = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }).catch(() => chromium.launch());
  const MG = '66666666-6666-6666-6666-666666666666';
  const d = await openDevice(browser, '담당PC', MG);
  const P = d.page;
  await P.evaluate(() => { window.__acks = []; window.addEventListener('message', (e) => { if (e.data && e.data.__sbNeis === 'ack') window.__acks.push(e.data.ids); }); });
  // 그 날짜·교시에 그 반에 들어가는 선생님들 / 그 선생님 칸 글
  const who = (dt, p, room) => P.evaluate(([dt, p, room]) => Object.keys(window.allSchedules).filter((t) => timetableCellAt(t, dt, p).list.some((x) => x.r === room)).sort().join(), [dt, p, room]);
  const at = (t, dt, p) => P.evaluate(([t, dt, p]) => timetableCellAt(t, dt, p).list.map((x) => x.s + ' ' + x.r).join(' / '), [t, dt, p]);
  const send = async (list, id, auto) => {
    await P.click('#neis-toast .neis-toast-x').catch(() => {});
    await P.evaluate(([xs, id, auto]) => window.postMessage({ __sbNeis: 'reports', reports: xs.map((x, i) => ({ id: id + i, xml: x, at: 1, auto: auto })) }, '*'), [list, id, !!auto]);
    await P.waitForSelector('#neis-toast', { state: 'visible', timeout: 8000 }); await wait2(600);
    return P.evaluate(() => document.getElementById('neis-toast').innerText);
  };

  console.log('== 0. 수업 변경 창·버튼은 없음');
  const gone = await P.evaluate(() => ({ ov: !!document.getElementById('schedule-change-overlay'), btn: !!document.querySelector('.m-tt-change-btn'), fn: typeof window.openScheduleChangeModal }));
  check('수업 변경 창·🔁 수업변경 버튼·여는 함수 없음', !gone.ov && !gone.btn && gone.fn === 'undefined', gone);

  console.log('== 1. 읽기(여러 쪽·두 줄 글·추가반 열)');
  const parsed = await P.evaluate((x) => neisParseChangeXml(x), g1);
  check('학년·기간·변경수업 표시', parsed.grade === 1 && parsed.from === D[0] && parsed.to === D[4] && parsed.isChange, { g: parsed.grade, f: parsed.from, t: parsed.to });
  check('칸 14개, 못 읽은 칸 없음(둘째 쪽 머리칸 번호가 다시 1부터여도)', parsed.entries.length === 14 && parsed.skipped.length === 0, parsed.entries.length);
  const e1 = parsed.entries.find((e) => e.date === D[1] && e.period === 1 && e.room === '103');
  check('반 103·과목·교사·보강 여부', e1 && e1.subject === '과학' && e1.teacher === '바교사' && !e1.makeup, e1);
  check('[보강] 두 줄 글을 이어 읽음', parsed.entries.some((e) => e.makeup && e.teacher === '라교사' && e.subject === '영어'));

  console.log('== 2. 받기 → 확인 없이 바로 넣기(행사 칸은 뺌)');
  const t2 = await send([g1], 'r');
  check('알림: 1학년, 바뀐 칸 11곳을 넣음(행사 3칸 뺌), 되돌리기', /1학년/.test(t2) && /바뀐 칸 11곳을 넣었어요/.test(t2) && /되돌리기/.test(t2), t2);
  check('서버엔 나이스에 적힌 그대로(날짜·교시·반·선생님·과목, 나이스 표시)', cellChanges.length === 11 && cellChanges.every((c) => c.source === 'neis') && cellChanges.some((c) => c.change_date === D[0] && c.period === 1 && c.room === '101' && c.teacher_to === '나교사' && c.subject === '수학' && c.teacher_from === '가교사'), cellChanges);
  check('행사(동아리활동) 칸은 넣지 않음', !cellChanges.some((c) => /동아리/.test(c.subject)));
  check('받은 것 확인(ack)', JSON.stringify(await P.evaluate(() => window.__acks)) === '[["r0"]]', await P.evaluate(() => window.__acks));
  check('예전 교환·보강 표는 읽지도 쓰지도 않음', !global.__oldTableUsed);

  console.log('== 3. 시간표 = 기본 시간표 + 나이스 바뀐 칸');
  check('교체: 월1 101은 나교사 수학, 가교사 월1은 빔', (await at('나교사', D[0], 1)) === '수학 101' && (await at('가교사', D[0], 1)) === '' && (await at('가교사', D[2], 3)) === '국어 101' && (await at('나교사', D[2], 3)) === '', [await at('나교사', D[0], 1), await at('가교사', D[0], 1)]);
  check('보강: 월2 102는 라교사 영어, 다교사는 빔, 라교사 원래 수업(월3)은 그대로', (await at('라교사', D[0], 2)) === '영어 102' && (await at('다교사', D[0], 2)) === '' && (await at('라교사', D[0], 3)) === '영어 103');
  check('맞물린 교체: 화1 103 바·104 마 / 화5 103 마·104 사', (await who(D[1], 1, '103')) === '바교사' && (await who(D[1], 1, '104')) === '마교사' && (await who(D[1], 5, '103')) === '마교사' && (await who(D[1], 5, '104')) === '사교사');
  check('스마트보드에 없는 선생님이 들어온 칸: 원래 선생님만 빠짐(금2 104는 없는교사 — 원래 수업 없음), 금2 103 파 → 하', (await at('파교사', D[4], 2)) === '' && (await at('하교사', D[4], 2)) === '음악 103');
  check('행사 날은 기본 시간표 그대로(거교사 목1 체육 101)', (await at('거교사', D[3], 1)) === '체육 101');
  const allSame = await P.evaluate((xml) => { const p = neisParseChangeXml(xml); const rows = neisCellRows(p.entries, window.allSchedules).rows; return rows.filter((r) => window.allSchedules[r.teacher_to]).filter((r) => Object.keys(window.allSchedules).filter((t) => timetableCellAt(t, r.change_date, r.period).list.some((x) => x.r === r.room)).join() !== r.teacher_to).length; }, g1);
  check('넣은 칸마다 그 반엔 나이스에 적힌 선생님 한 분만', allSame === 0, allSame);
  await P.evaluate(() => { const s = document.getElementById('search-select'); if (![...s.options].some((o) => o.value === '나교사')) s.add(new Option('나교사', '나교사')); s.value = '나교사'; renderSearchTimetable(true); });
  const grid = await P.evaluate(() => [document.getElementById('search-tt-1-1-s').innerText, document.getElementById('search-tt-1-1-r').innerText, document.getElementById('search-tt-3-3-s').innerText.trim()]);
  check('검색 시간표(이번 주): 나교사 월1에 수학 101, 수3(교체로 빠짐)은 빈 칸', /수학/.test(grid[0]) && grid[1] === '101' && grid[2] === '', grid);

  console.log('== 4. 여러 학년을 한꺼번에 받기 · 같은 것을 다시 받으면 쓰기 0');
  const c4 = cellChanges.length;
  const t4 = await send([g1, g3], 'm');
  check('1학년은 그대로, 3학년 5칸만 새로 넣음', cellChanges.length === c4 + 5 && /1·3학년/.test(t4) && /바뀐 칸 5곳/.test(t4), [t4, cellChanges.length - c4]);
  check('3학년 보강: 수2 305 러 → 머', (await who(D[2], 2, '305')) === '머교사' && (await at('러교사', D[2], 2)) === '');
  const c4b = cellChanges.length;
  const t4b = await send([g1, g3], 'n', true);
  check('같은 조회를 다시 받으면 "나이스와 같아요" — 쓰기 0, 되돌리기 없음', /나이스와 같아요/.test(t4b) && !/되돌리기/.test(t4b) && cellChanges.length === c4b, [t4b, cellChanges.length - c4b]);

  console.log('== 5. 시험 칸은 빼고, 여러 명이 돌아가며 바꾼 것도 칸 그대로');
  const t5 = await send([g2], 'g');
  check('2학년 7칸 넣음(시험 1칸 뺌)', /바뀐 칸 7곳/.test(t5) && !cellChanges.some((c) => /시험/.test(c.subject)), t5);
  check('시험 날은 기본 시간표 그대로(잠교사 월1 국어 207)', (await at('잠교사', D[0], 1)) === '국어 207');
  const rot = [await who(D[1], 2, '201'), await who(D[1], 2, '202'), await who(D[1], 2, '203'), await who(D[2], 1, '204'), await who(D[2], 2, '204'), await who(D[2], 3, '204'), await who(D[3], 1, '205')];
  check('칸마다 나이스와 같음(201 남·202 담·203 감 / 204: 1교시 맘·2교시 밤·3교시 람 / 205 암)', JSON.stringify(rot) === JSON.stringify(['남교사', '담교사', '감교사', '맘교사', '밤교사', '람교사', '암교사']), rot);
  check('같은 반에서 돌린 것은 나이스 과목 그대로(맘 화학·밤 생명·람 물리, 반 204)', (await at('맘교사', D[2], 1)) === '화학 204' && (await at('밤교사', D[2], 2)) === '생명 204' && (await at('람교사', D[2], 3)) === '물리 204');

  console.log('== 6. 매일 나이스에 맞추기: 바뀌면 바꿈 · 없어지면 뺌 · 되돌리기 · 조회 기간 밖은 그대로');
  const n0 = cellChanges.length;
  const g1b = g1.replace('[보강]영어(라', '[보강]영어(거'); // 나이스에서 보강 선생님이 라 → 거로 바뀜
  const t6 = await send([g1b], 'b', true);
  check('보강 선생님이 바뀌면 예전 칸을 빼고 새 칸을 넣음(1곳 넣고 1곳 뺌)', /바뀐 칸 1곳을 넣었어요/.test(t6) && /예전 칸 1곳을 뺐어요/.test(t6) && cellChanges.length === n0 && (await who(D[0], 2, '102')) === '거교사' && (await at('라교사', D[0], 2)) === '', t6);
  const g1c = g1b.replace('<TL tid="3" le="1" to="1">음악(하교사)\r</TL>', ''); // 나이스에서 교체(파→하)가 취소됨
  const t6b = await send([g1c], 'c', true);
  check('나이스에서 없어지면 뺌 → 금2 103은 다시 파교사', /예전 칸 1곳을 뺐어요/.test(t6b) && !/넣었어요/.test(t6b) && (await at('파교사', D[4], 2)) === '음악 103' && (await at('하교사', D[4], 2)) === '', t6b);
  await P.click('#neis-toast button:has-text("되돌리기")'); await wait2(300);
  check('되돌리기 전에 확인을 물음(뺀 칸 1곳을 되살려요)', /뺀 칸 1곳을 되살려요/.test(await P.evaluate(() => document.getElementById('custom-confirm-overlay').innerText)));
  await P.click('#custom-confirm-ok-btn'); await wait2(800);
  check('되돌리면 뺀 칸이 되살아남(금2 103 하교사)', cellChanges.some((c) => c.teacher_to === '하교사' && c.source === 'neis') && (await at('하교사', D[4], 2)) === '음악 103' && /되돌렸어요/.test(await P.evaluate(() => document.getElementById('neis-toast').innerText)));
  await send([g1], 'o', true); // 원래 보고서로 다시
  check('원래대로 받으면 거 → 라로 다시 맞춤', (await who(D[0], 2, '102')) === '라교사');
  const keep3 = cellChanges.filter((c) => c.room[0] === '3').length, keepTue = cellChanges.filter((c) => c.room[0] === '1' && c.change_date !== D[0]).length;
  const t6c = await send([mml(1, [[{ date: D[0], cells: {} }]])], 'e', true); // 1학년 월요일 하루만, 바뀐 칸 없음
  check('조회 기간이 하루면 그 날 그 학년 칸만 맞춤(1학년 월 3곳 뺌, 다른 날·다른 학년 그대로)', /예전 칸 3곳/.test(t6c) && !cellChanges.some((c) => c.room[0] === '1' && c.change_date === D[0]) && cellChanges.filter((c) => c.room[0] === '3').length === keep3 && cellChanges.filter((c) => c.room[0] === '1' && c.change_date !== D[0]).length === keepTue, t6c);
  const many = cellChanges.filter((c) => c.room[0] === '2').length;
  for (let i = 0; i < 24; i++) cellChanges.push({ id: 1000 + i, change_date: D[3], period: 7, room: '2' + String(i % 8 + 1).padStart(2, '0'), teacher_from: '', teacher_to: '가짜' + i, subject: '과목', source: 'neis' });
  const t6d = await send([mml(2, [[{ date: D[0], cells: {} }, { date: D[4], cells: {} }]])], 'x', true); // 거의 빈 보고서(2학년) — 뺄 칸이 31곳
  check('안전장치: 거의 빈 보고서로 뺄 칸이 너무 많으면 빼지 않고 알림', /빼지 않았어요/.test(t6d) && cellChanges.filter((c) => c.room[0] === '2').length === many + 24, t6d);

  console.log('== 7. 실패 알림 · 담당이 아니면 안 넣음');
  await P.evaluate(() => window.postMessage({ __sbNeis: 'status', ok: false, msg: '나이스 변경수업 자동 조회를 끝내지 못했어요(1학년만 받음).' }, '*')); await wait2(300);
  check('자동 조회가 실패하면 알림 카드에 이유', /자동 조회를 끝내지 못했어요/.test(await P.evaluate(() => document.getElementById('neis-toast').innerText)));
  const T = await openDevice(browser, '교사PC', T1);
  const b7 = cellChanges.length;
  await T.page.evaluate((x) => window.postMessage({ __sbNeis: 'reports', reports: [{ id: 'r9', xml: x, at: 1, auto: true }] }, '*'), g2.replace('수학(남', '수학(박'));
  await wait2(1200);
  check('일반 교사 화면엔 알림도 안 뜨고 넣지도 않음', !(await T.page.isVisible('#neis-toast').catch(() => false)) && cellChanges.length === b7);
  check('일반 교사 화면도 나이스 칸으로 그림(화2 201은 남교사)', (await T.page.evaluate((dt) => timetableCellAt('남교사', dt, 2).list.map((x) => x.s + ' ' + x.r).join(), D[1])) === '수학 201');

  const errs = pages.flatMap((p) => p.errors || []);
  check('페이지 오류 없음', errs.length === 0, errs);
  await browser.close();
  console.log(failures ? '\n실패 ' + failures + '개' : '\n모든 검사 통과');
  process.exit(failures ? 1 : 0);
})();
