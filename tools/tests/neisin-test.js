// 📥 나이스 변경수업 가져오기: 확장 프로그램(tools/neis-ext)이 넘겨 주는 나이스 "전체시간표 (변경수업)" 보고서(크라운릭스 MML XML)를
// 읽어 보강·교체를 수업 변경으로 넣는다. 보강 / 교체 짝 / 한 교사의 두 교체가 맞물린 것 / 행사 날(동아리활동) / 이미 있음 /
// 스마트보드와 다름 / 짝 없음 / 모르는 선생님 / 여러 쪽 / 두 학년 합치기 / 고른 것만 넣기 / 확인(ack) / 다시 받으면 이미 있음 /
// 담당이 아니면 안 열림. 선생님 이름·시간표는 모두 가짜(실제 보고서 구조만 따름). 가짜 서버는 sccmgr-test.js와 같다.
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
const changes = [];
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
  if (table === 'schedule_changes') {
    if (op === 'insert') { const r = Array.isArray(rows) ? rows : [rows]; const out = []; r.forEach(x => { const row = Object.assign({ id: Math.max(0, ...changes.map(c => c.id)) + 1, created_by: teachers[pageInfo.uid].name }, x); changes.push(row); out.push({ id: row.id }); }); return { data: out, error: null }; }
    if (op === 'delete') { const f = filters.find(x => x.col === 'id'); const ids = f ? (f.op === 'in' ? f.val : [f.val]) : []; for (let i = changes.length - 1; i >= 0; i--) if (ids.includes(changes[i].id)) changes.splice(i, 1); return { data: null, error: null }; }
    if (op === 'select') { let l = changes.slice().sort((x, y) => x.id - y.id); const r0 = range ? range[0] : 0, r1 = range ? range[1] + 1 : l.length; l = l.slice(r0, Math.min(r1, r0 + 1000)); return { data: l, error: null }; } // 진짜 서버처럼 한 번에 최대 1000줄(max_rows)
    return { data: null, error: null };
  }
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


// ---------- 날짜(다음 주 월~금) ----------
const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const mon = new Date(); mon.setHours(0, 0, 0, 0); mon.setDate(mon.getDate() + ((8 - mon.getDay()) % 7 || 7));
const D = [0, 1, 2, 3, 4].map((i) => { const d = new Date(mon); d.setDate(d.getDate() + i); return ymd(d); }); // D[0]=월 … D[4]=금
const WD = ['일', '월', '화', '수', '목', '금', '토'];

// ---------- 가짜 시간표(요일 1=월, 교시) ----------
const tt = {};
function put(t, wd, p, subj, room) { (tt[t] = tt[t] || Array(35).fill('')); tt[t][(wd - 1) * 7 + p - 1] = subj + '\n' + room; }
put('가교사', 1, 1, '국어', '101');                                            // 교체 짝: 가(월1 101) ↔ 나(수3 101)
put('나교사', 3, 3, '수학', '101');
put('다교사', 1, 2, '영어', '102');                                            // 보강: 월2 102 다 → 라
put('라교사', 1, 3, '영어', '103');
put('마교사', 2, 1, '정보', '103'); put('마교사', 2, 5, '정보', '104');      // 맞물린 교체: 화1·화5
put('바교사', 2, 5, '과학', '103'); put('사교사', 2, 1, '영어', '104');
put('아교사', 1, 4, '역사', '101'); put('자교사', 1, 5, '역사', '102');      // 이미 있음(보강 아 → 자)
put('차교사', 2, 3, '미술', '102'); put('카교사', 5, 3, '미술', '103');      // 다름: 차 화3을 이미 다른 기록이 옮김
put('타교사', 5, 1, '미술', '101');
put('파교사', 5, 2, '음악', '103'); put('하교사', 4, 6, '음악', '104');      // 짝 없는 교체
put('거교사', 4, 1, '체육', '101'); put('너교사', 4, 1, '체육', '102'); put('더교사', 4, 1, '체육', '103'); // 행사 날
put('러교사', 3, 2, '물리', '305'); put('머교사', 3, 2, '화학', '306');      // 3학년 보강
put('버교사', 1, 7, '지구', '306');
put('쉬교사', 4, 2, '국어', '301'); put('위교사', 4, 3, '수학', '302');      // 다른 반·다른 시간 → 짝짓지 않음(10/22 실제로 잘못 들어갔던 꼴)
put('키교사', 5, 4, '영어', '301'); put('피교사', 5, 4, '과학', '302');      // 같은 시간에 두 반 맞바꿈 → 교환
global.__tt = Object.keys(tt).map((n) => ({ teacher_name: n, cells: tt[n] }));
// 이미 있는 기록: 보강 아 월4 → 자 / 교환 차 화3 ↔ 카 금3
changes.push({ id: 1, type: 'makeup', change_date: D[0], period_a: 4, teacher_a: '아교사', change_date_b: D[0], period_b: 4, teacher_b: '자교사', room_a: '101', room_b: null, created_by: '수업계', created_at: '2026-01-01T00:00:00Z' });
changes.push({ id: 2, type: 'exchange', change_date: D[1], period_a: 3, teacher_a: '차교사', change_date_b: D[4], period_b: 3, teacher_b: '카교사', room_a: '102', room_b: '103', created_by: '수업계', created_at: '2026-01-01T00:00:01Z' });

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
// 1학년(두 쪽 — 목·금은 둘째 쪽)
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

const wait2 = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }).catch(() => chromium.launch());
  const MG = '66666666-6666-6666-6666-666666666666';
  const d = await openDevice(browser, '담당PC', MG);
  const P = d.page;
  await P.evaluate(() => { window.__acks = []; window.addEventListener('message', (e) => { if (e.data && e.data.__sbNeis === 'ack') window.__acks.push(e.data.ids); }); });

  console.log('== 1. 읽기(여러 쪽·두 줄 글·추가반 열)');
  const parsed = await P.evaluate((x) => neisParseChangeXml(x), g1);
  check('학년·기간·변경수업 표시', parsed.grade === 1 && parsed.from === D[0] && parsed.to === D[4] && parsed.isChange, { g: parsed.grade, f: parsed.from, t: parsed.to });
  check('칸 14개, 못 읽은 칸 없음(둘째 쪽 머리칸 번호가 다시 1부터여도)', parsed.entries.length === 14 && parsed.skipped.length === 0, parsed.entries.length);
  const e1 = parsed.entries.find((e) => e.date === D[1] && e.period === 1 && e.room === '103');
  check('반 103·과목·교사·보강 여부', e1 && e1.subject === '과학' && e1.teacher === '바교사' && !e1.makeup, e1);
  check('[보강] 두 줄 글을 이어 읽음', parsed.entries.some((e) => e.makeup && e.teacher === '라교사' && e.subject === '영어'));

  console.log('== 2. 받기 → 미리 보기');
  await P.evaluate((x) => window.postMessage({ __sbNeis: 'reports', reports: [{ id: 'r1', xml: x, at: 1 }] }, '*'), g1);
  await P.waitForSelector('#neis-in-overlay', { state: 'visible', timeout: 5000 });
  await wait2(300);
  const view = await P.evaluate(() => ({ rows: [...document.querySelectorAll('#neis-in-body .neis-in-row')].map((r) => r.innerText), body: document.getElementById('neis-in-body').innerText, btn: document.getElementById('neis-in-save').textContent }));
  check('넣을 것 4건: 교환 가↔나, 보강 다→라, 맞물린 교환 마↔바·마↔사', view.rows.length === 4 && view.btn === '4건 넣기', [view.rows, view.btn]);
  check('교환 가교사 월1 101 국어 ↔ 나교사 수3 101 수학', view.rows.some((r) => /교환 가교사 .*월\) 1교시 1-1 국어 ↔ 나교사 .*수\) 3교시 1-1 수학/.test(r)), view.rows);
  check('보강 월2 1-2 영어 다교사 → 라교사', view.rows.some((r) => /보강 .*월\) 2교시 1-2 영어 — 다교사 → 라교사/.test(r)), view.rows);
  check('맞물린 교체 둘 다(103·104)', view.rows.some((r) => /마교사 .*화\) 1교시 1-3 정보 ↔ 바교사 .*화\) 5교시 1-3 과학/.test(r)) && view.rows.some((r) => /사교사 .*화\) 1교시 1-4 영어 ↔ 마교사 .*화\) 5교시 1-4 정보/.test(r)), view.rows);
  check('넣지 않은 칸: 이미 있음·다름·짝 없음·모르는 선생님·행사', /이미 스마트보드에 있음/.test(view.body) && /스마트보드와 다름/.test(view.body) && /교체 짝을 못 찾음/.test(view.body) && /없는교사 선생님이 스마트보드 시간표에 없음/.test(view.body) && /행사\(동아리활동\)/.test(view.body), view.body);
  check('아직 안 받은 학년 안내(2·3학년)', /2·3학년도 나이스에서 조회하면/.test(view.body));

  console.log('== 3. 다른 학년을 더 받으면 같은 창에 합침');
  await P.evaluate((x) => window.postMessage({ __sbNeis: 'reports', reports: [{ id: 'r1', xml: 'dup', at: 1 }, { id: 'r3', xml: x, at: 2 }] }, '*'), g3);
  await wait2(800);
  const v2 = await P.evaluate(() => ({ n: document.querySelectorAll('#neis-in-body .neis-in-row').length, body: document.getElementById('neis-in-body').innerText }));
  check('3학년 보강(러교사 → 머교사)·같은 시간 반 맞바꿈(키↔피) 더해져 6건, 받은 조회에 1·3학년', v2.n === 6 && /키교사 .*금\) 4교시 3-1 영어 ↔ 피교사 .*금\) 4교시 3-2 과학/.test(v2.body) && /러교사 → 머교사/.test(v2.body) && /1학년 .* · 3학년/.test(v2.body) && /2학년도 나이스에서/.test(v2.body), v2);

  check('다른 반·다른 시간끼리는 짝짓지 않음(쉬↔위 확인 필요)', !/쉬교사 .*↔|위교사 .*↔/.test(v2.body) && /목\) 2교시 3-1 수학\(위교사\)/.test(v2.body) && /목\) 3교시 3-2 국어\(쉬교사\)/.test(v2.body), v2.body);
  console.log('== 4. 고른 것만 넣기 → 저장·확인(ack)');
  await P.evaluate(() => { const r = [...document.querySelectorAll('#neis-in-body .neis-in-row')].find((x) => /다교사 → 라교사/.test(x.innerText)); r.querySelector('input').click(); });
  check('체크를 끄면 단추 글이 5건', (await P.textContent('#neis-in-save')) === '5건 넣기', await P.textContent('#neis-in-save'));
  const before = changes.length;
  await P.click('#neis-in-save'); await wait2(800);
  const added = changes.slice(before);
  check('5건 저장(보강 다→라는 뺌)', added.length === 5 && !added.some((c) => c.teacher_b === '라교사'), added);
  const ex = added.find((c) => c.teacher_a === '가교사');
  check('교환 기록 모양: 가 월1 ↔ 나 수3, 반 101', ex && ex.type === 'exchange' && ex.change_date === D[0] && ex.period_a === 1 && ex.teacher_b === '나교사' && ex.change_date_b === D[2] && ex.period_b === 3 && ex.room_a === '101' && ex.room_b === '101', ex);
  const mk = added.find((c) => c.type === 'makeup');
  check('보강 기록 모양: 러 수2 305 → 머', mk && mk.teacher_a === '러교사' && mk.teacher_b === '머교사' && mk.change_date === D[2] && mk.change_date_b === D[2] && mk.period_a === 2 && mk.period_b === 2 && mk.room_a === '305' && mk.room_b === null, mk);
  check('날짜 순으로 넣음', added.every((c, i) => !i || added[i - 1].change_date <= c.change_date));
  check('창 닫힘 + 받은 것 확인(ack r1·r3)', !(await P.isVisible('#neis-in-overlay')) && JSON.stringify(await P.evaluate(() => window.__acks)) === '[["r1","r3"]]', await P.evaluate(() => window.__acks));
  await P.click('#custom-alert-ok-btn').catch(() => {}); await wait2(200);
  const tt1 = await P.evaluate((d0) => { const m = sccEffectiveMap(sccAllChanges()); return [m.get('나교사', d0, 1).text, m.get('가교사', d0, 1).text]; }, D[0]);
  check('넣은 뒤 실제 시간표: 나교사 월1에 101 수학, 가교사 월1 비움', tt1[0] === '수학 101' && tt1[1] === '', tt1);

  console.log('== 5. 같은 조회를 다시 받으면 새로 넣을 건 뺀 보강 하나뿐');
  await P.evaluate((x) => window.postMessage({ __sbNeis: 'reports', reports: [{ id: 'r4', xml: x, at: 3 }] }, '*'), g1);
  await P.waitForSelector('#neis-in-overlay', { state: 'visible', timeout: 5000 }); await wait2(300);
  const v3 = await P.evaluate(() => [...document.querySelectorAll('#neis-in-body .neis-in-row')].map((r) => r.innerText));
  check('남은 것은 지난번에 뺀 보강 다→라 하나', v3.length === 1 && /다교사 → 라교사/.test(v3[0]), v3);
  await P.click('#neis-in-overlay .top-btn:not(.accent)'); await wait2(200);
  const acks = await P.evaluate(() => window.__acks);
  check('닫기도 확인(ack r4), 저장은 안 함', JSON.stringify(acks[acks.length - 1]) === '["r4"]' && changes.length === before + 5, [acks, changes.length - before]);

  console.log('== 6. 아침 자동 조회로 받은 것(auto): 확인 없이 바로 넣고 알림 카드 · 보기 · 되돌리기');
  const b6 = changes.length;
  await P.evaluate(([x1, x3]) => window.postMessage({ __sbNeis: 'reports', reports: [{ id: 'a1', xml: x1, at: 5, auto: true }, { id: 'a3', xml: x3, at: 5, auto: true }] }, '*'), [g1, g3]);
  await P.waitForSelector('#neis-toast', { state: 'visible', timeout: 5000 }); await wait2(300);
  const added6 = changes.slice(b6);
  check('창 없이 바로 넣음: 지난번에 뺀 보강 다→라 1건', added6.length === 1 && added6[0].teacher_a === '다교사' && added6[0].teacher_b === '라교사' && !(await P.isVisible('#neis-in-overlay')), added6);
  const toast = await P.evaluate(() => document.getElementById('neis-toast').innerText);
  check('알림 카드: 1·3학년, 1건 넣음, 확인 필요 칸 수, 보기·되돌리기', /1·3학년/.test(toast) && /1건을 넣었어요/.test(toast) && /확인 필요 \d+칸/.test(toast) && /보기/.test(toast) && /되돌리기/.test(toast), toast);
  check('받은 것 확인(ack a1·a3)', JSON.stringify((await P.evaluate(() => window.__acks)).pop()) === '["a1","a3"]');
  const t6 = await P.evaluate((d0) => sccEffectiveMap(sccAllChanges()).get('라교사', d0, 2).text, D[0]);
  check('시간표에 바로 반영(라교사 월2 = 영어 102)', t6 === '영어 102', t6);
  await P.click('#neis-toast button:has-text("보기")'); await wait2(300);
  const v6 = await P.evaluate(() => ({ vis: getComputedStyle(document.getElementById('neis-in-overlay')).display === 'flex', body: document.getElementById('neis-in-body').innerText, boxes: document.querySelectorAll('#neis-in-body input[type=checkbox]').length, save: getComputedStyle(document.getElementById('neis-in-save')).display }));
  check('보기: 넣은 것 1건(체크칸·넣기 단추 없이) + 넣지 않은 칸', v6.vis && /넣은 것 1건/.test(v6.body) && v6.boxes === 0 && v6.save === 'none' && /넣지 않은 칸/.test(v6.body), v6);
  await P.click('#neis-in-overlay .top-btn:not(.accent)'); await wait2(200);
  const ackN = (await P.evaluate(() => window.__acks)).length;
  await P.click('#neis-toast button:has-text("되돌리기")'); await wait2(300);
  check('되돌리기 전에 확인을 물음', /1건을 지울까요/.test(await P.evaluate(() => document.getElementById('custom-confirm-overlay').innerText)));
  await P.click('#custom-confirm-ok-btn'); await wait2(800);
  check('되돌리기: 넣은 1건을 지움, 시간표도 돌아감', changes.length === b6 && (await P.evaluate((d0) => sccEffectiveMap(sccAllChanges()).get('라교사', d0, 2).text, D[0])) === '', changes.length - b6);
  check('되돌린 뒤 알림', /지웠어요/.test(await P.evaluate(() => document.getElementById('neis-toast').innerText)) && (await P.evaluate(() => window.__acks)).length === ackN);
  console.log('== 6b. 자동 조회 실패 알림');
  await P.evaluate(() => window.postMessage({ __sbNeis: 'status', ok: false, msg: '나이스 변경수업 자동 조회를 끝내지 못했어요(1학년만 받음).' }, '*')); await wait2(300);
  check('실패하면 알림 카드에 이유', /자동 조회를 끝내지 못했어요/.test(await P.evaluate(() => document.getElementById('neis-toast').innerText)));

  console.log('== 7. 담당이 아니면 열리지 않음');
  const T = await openDevice(browser, '교사PC', T1);
  const b7 = changes.length;
  await T.page.evaluate((x) => window.postMessage({ __sbNeis: 'reports', reports: [{ id: 'r9', xml: x, at: 1 }, { id: 'r10', xml: x, at: 2, auto: true }] }, '*'), g1);
  await wait2(1200);
  check('일반 교사 화면엔 창도 알림도 안 뜨고, 자동이어도 안 넣음', !(await T.page.isVisible('#neis-in-overlay').catch(() => false)) && !(await T.page.isVisible('#neis-toast').catch(() => false)) && changes.length === b7);

  const errs = pages.flatMap((p) => p.errors || []);
  check('페이지 오류 없음', errs.length === 0, errs);
  await browser.close();
  console.log(failures ? '\n실패 ' + failures + '개' : '\n모든 검사 통과');
  process.exit(failures ? 1 : 0);
})();
