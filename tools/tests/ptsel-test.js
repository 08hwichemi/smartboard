// 가짜 Supabase 서버(Node 메모리) 하나에 PC/휴대폰 브라우저 두 개를 붙여서
// index.html의 실제 동기화 코드를 시나리오별로 돌려 본다.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// ---------- 가짜 서버 ----------
const T1 = '11111111-1111-1111-1111-111111111111';
const T2 = '22222222-2222-2222-2222-222222222222';
const teachers = {
  [T1]: { id: T1, name: '김교사', is_admin: false, must_change_password: false, role: '교사', homeroom_grade: null, homeroom_class: null },
  [T2]: { id: T2, name: '박교사', is_admin: false, must_change_password: false, role: '교사', homeroom_grade: null, homeroom_class: null },
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
      if (url.split('?')[0] === 'http://app.test/' || url.includes('index.html')) return route.fulfill({ body: html, contentType: 'text/html; charset=utf-8' });
      return route.fulfill({ status: 404, body: '' });
    }
    if (url.includes('@supabase/supabase-js')) return route.fulfill({ body: mockLib, contentType: 'application/javascript' });
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

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }).catch(() => chromium.launch());

  const pc = await openDevice(browser, 'PC', T1);
  const P = pc.page;
  await P.click('#rail-persontt-btn'); await wait(600);

  // 과목별 색상 테마 버튼 4개가 한 줄에
  const tops = await P.evaluate(() => [...document.querySelectorAll('#pt-theme-grid .pt-theme-btn')].map(b => { const r = b.getBoundingClientRect(); return { top: Math.round(r.top), w: Math.round(r.width), sw: b.scrollWidth, cw: b.clientWidth }; }));
  check('색상 테마 버튼 4개', tops.length === 4, tops);
  check('4개가 한 줄', new Set(tops.map(t => t.top)).size === 1, tops);
  check('글자가 잘리지 않음', tops.every(t => t.sw <= t.cw), tops);
  await P.locator('#pt-theme-grid').screenshot({ path: 'ptsel-theme.png' });

  // 넓은 화면 두 줄 + 지금 할 일 상자(①→⑤ 한 단계씩, 건너뛰지 않음)
  const nbox = () => P.evaluate(() => ({ t: document.getElementById('pt-next').innerText, done: !!document.querySelector('#pt-next .pa-next.done'),
    glow: [...document.querySelectorAll('#persontt-page .pa-glow')].map(e => e.id), st: [1, 2, 3, 4].map(i => document.getElementById('pt-st-' + i).textContent) }));
  const R = (id) => P.evaluate((id) => { const r = document.getElementById(id).getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom) }; }, id);
  const sch = await R('pt-box-school'), siz = await R('pt-box-size'), des = await R('pt-box-design');
  const fsz = await R('pt-box-fsize');
  check('넓은 화면: 왼쪽 = 학교 → 색상·디자인, 오른쪽 = 시간표 크기 → 세부 글자', des.l === sch.l && des.t > sch.b && siz.l > sch.r - 1 && fsz.l === siz.l, { sch, siz, des, fsz });
  check('높이 맞춤: 시간표 크기 = 학교/학기 줄, 세부 글자 = 색상·디자인 줄', Math.abs(siz.t - sch.t) < 2 && Math.abs(siz.b - sch.b) < 2 && Math.abs(fsz.t - des.t) < 2 && Math.abs(fsz.b - des.b) < 2, { sch, siz, des, fsz });
  check('넓은 화면(1600×1000) 내 시간표: 왼쪽 칸 스크롤 없음', await P.evaluate(() => { const p = document.getElementById('pt-panel'); return p.scrollHeight <= p.clientHeight; }));
  check('칸 제목에 ②③④, 위쪽에 ①⑤', await P.evaluate(() => ['pt-box-school', 'pt-box-design', 'pt-box-size'].map(id => document.querySelector('#' + id + ' .pt-no').textContent).join('') === '②③④' && [...document.querySelectorAll('.pt-hdr-no')].map(e => e.textContent).join('') === '①⑤'));
  const ptSeen = [];
  let nb = await nbox(); ptSeen.push(nb.t.match(/[①②③④⑤]/)[0]);
  check('① 내 시간표: 탭 설명·탭 반짝·다음 단추', /① 지금 할 일/.test(nb.t) && /내 시간표/.test(nb.t) && /학생 시간표/.test(nb.t) && nb.glow.includes('pt-tab-switch') && /다음: ② 학교/.test(nb.t), nb);
  check('내 시간표가 비었으면 알려 줌', /비어 있어요/.test(nb.t));
  const ptNext = async () => { await P.click('#pt-next .top-btn:not(.pt-again)'); await wait(300); nb = await nbox(); ptSeen.push((nb.t.match(/[①②③④⑤]/) || ['?'])[0]); };
  await ptNext();
  check('② 학교/학기: 무엇인지·예시·칸 반짝', /② 지금 할 일/.test(nb.t) && /학교명/.test(nb.t) && /학기명/.test(nb.t) && nb.glow.includes('pt-box-school') && nb.st[1] === '지금', nb);
  await ptNext();
  check('③ 색상·스타일·글꼴 설명(학교 다음 = 디자인)', /③ 지금 할 일/.test(nb.t) && /색상 테마/.test(nb.t) && /표 스타일/.test(nb.t) && /글꼴/.test(nb.t) && nb.glow.includes('pt-box-design') && nb.st[1] === '✓' && nb.st[2] === '지금', nb);
  await ptNext();
  check('④ 크기: 너비·높이·글씨·모서리 설명(디자인 다음 = 크기)', /④ 지금 할 일/.test(nb.t) && /전체 너비·높이/.test(nb.t) && /과목명/.test(nb.t) && /모서리/.test(nb.t) && nb.glow.includes('pt-box-fsize') && nb.st[2] === '✓' && nb.st[3] === '지금', nb);
  await ptNext();
  check('⑤ 출력: 모양·인쇄·이미지·PDF·완료 모양·①~④ ✓', nb.done && /⑤/.test(nb.t) && /카드 1장/.test(nb.t) && /이미지/.test(nb.t) && /PDF/.test(nb.t) && nb.glow.includes('pt-print-layout') && nb.st.every(x => x === '✓'), nb);
  check('단계가 하나도 건너뛰지 않음(①②③④⑤)', ptSeen.join('') === '①②③④⑤', ptSeen);
  await P.evaluate(() => ptSwitchTab('me')); await wait(300);
  check('다시 열어도(같은 탭) 마지막 단계 기억', (await nbox()).done);
  await P.click('#pt-next .pt-again'); await wait(300);
  check('"처음부터 안내"를 누르면 ①', /① 지금 할 일/.test((await nbox()).t));
  // 학생 탭: 학생을 고르기 전엔 ①(학년 → 반 → 학생), 고르면 그 학생 + 다음
  await P.evaluate(() => ptSwitchTab('student')); await wait(700);
  nb = await nbox();
  check('학생 탭 ①: 학년·반·학생 고르는 순서 설명·학년 칸 반짝·다음 단추 없음', /학생 고르기/.test(nb.t) && /학년/.test(nb.t) && /이 학생만/.test(nb.t) && nb.glow.includes('pt-student-grade') && !/다음:/.test(nb.t), nb);
  { const stu = await R('pt-student-controls'), sz = await R('pt-box-size'), sc = await R('pt-box-school');
    check('학생 탭: ① 학생 고르기가 맨 위 한 줄 전체, 아래는 시간표 크기 = 학교 줄', stu.r >= sz.r - 1 && stu.b < sc.t && Math.abs(sz.t - sc.t) < 2 && Math.abs(sz.b - sc.b) < 2, { stu, sz, sc }); }
  check('학생 탭 칸 제목 ① 학생 고르기 + "지금"', await P.evaluate(() => document.querySelector('#pt-student-controls .pt-no').textContent === '①') && nb.st[0] === '지금');
  await P.selectOption('#pt-student-grade', '2'); await wait(300);
  check('학년 고르면 반 칸 반짝', (await nbox()).glow.includes('pt-student-class'));
  await P.selectOption('#pt-student-class', '1'); await wait(400);
  nb = await nbox();
  check('반 고르면 첫 학생이 골라지고 "다음: ② 학교"', /20101/.test(nb.t) && /다음: ② 학교/.test(nb.t), nb);
  await P.evaluate(() => { document.getElementById('pt-student-grade').value = ''; ptOnGradeChange(); }); await wait(300);

  // 학생 시간표: 학년/반/범위 기억
  await P.evaluate(() => ptSwitchTab('student')); await wait(600);
  await P.selectOption('#pt-student-grade', '2'); await wait(200);
  await P.selectOption('#pt-student-class', '2'); await wait(300);
  await P.click('#pt-scope-class-btn'); await wait(300);
  check('선택이 저장됨', JSON.parse(await ls(pc, 'pt-student-sel')).cls === '2', await ls(pc, 'pt-student-sel'));
  await P.evaluate(() => ptSwitchTab('me')); await wait(300);
  await P.evaluate(() => ptSwitchTab('student')); await wait(300);
  check('탭 왕복 후에도 2학년 2반 유지', await P.evaluate(() => document.getElementById('pt-student-grade').value + '-' + document.getElementById('pt-student-class').value) === '2-2');
  await wait(1500); // 서버에 올라갈 시간
  check('서버(계정)에 저장됨', !!serverVal(T1, 'pt-student-sel'), serverVal(T1, 'pt-student-sel'));

  // 같은 계정 다른 기기(새 브라우저)에서 열어도 기억
  const pc2 = await openDevice(browser, 'PC2', T1);
  const Q = pc2.page;
  await Q.click('#rail-persontt-btn'); await wait(600);
  await Q.evaluate(() => ptSwitchTab('student')); await wait(800);
  const st = await Q.evaluate(() => ({ g: document.getElementById('pt-student-grade').value, c: document.getElementById('pt-student-class').value, scope: ptScope, stu: document.getElementById('pt-student-select').options[0] && document.getElementById('pt-student-select').options[0].text, page: document.getElementById('pt-page-text') && document.getElementById('pt-page-text').innerText }));
  check('다른 기기: 2학년 2반·반 전체 복원, 학생 목록 채워짐', st.g === '2' && st.c === '2' && st.scope === 'class' && /^20201/.test(st.stu || ''), st);

  // 다른 계정은 영향 없음
  const other = await openDevice(browser, 'T2', T2);
  await other.page.click('#rail-persontt-btn'); await wait(600);
  await other.page.evaluate(() => ptSwitchTab('student')); await wait(800);
  check('다른 계정은 선택 없음', await other.page.evaluate(() => document.getElementById('pt-student-grade').value) === '');

  const errs = [...pc.errors, ...pc2.errors, ...other.errors];
  check('페이지 오류 없음', errs.length === 0, errs);
  console.log(failures ? ('실패 ' + failures + '건') : '모든 검사 통과');
  await browser.close();
  process.exit(failures ? 1 : 0);
})();
