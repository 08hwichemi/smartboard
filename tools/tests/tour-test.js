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

// 각 설명서를 끝까지 넘기며 단계마다 실제로 짚는 위치를 기록한다(빠진 단계·엉뚱한 순서 확인용).
async function walk(P, openExpr) {
  await P.evaluate(openExpr); await wait(400);
  const seen = [];
  for (let k = 0; k < 40; k++) {
    const st = await P.evaluate(() => {
      const ov = document.getElementById('tour-overlay');
      if (ov.style.display === 'none') return null;
      const sp = document.getElementById('tour-spotlight').getBoundingClientRect();
      return { title: document.getElementById('tour-card-title').innerText, prog: document.getElementById('tour-card-progress').innerText, x: Math.round(sp.left), y: Math.round(sp.top), w: Math.round(sp.width), h: Math.round(sp.height), btn: document.getElementById('tour-next-btn').innerText };
    });
    if (!st) break;
    seen.push(st);
    await P.click('#tour-next-btn'); await wait(450);
  }
  return seen;
}
function show(name, seen) {
  console.log('--- ' + name);
  seen.forEach(s => console.log('   ' + s.prog.padEnd(7) + ' (' + s.x + ',' + s.y + ' ' + s.w + 'x' + s.h + ') ' + s.title));
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }).catch(() => chromium.launch());
  const pc = await openDevice(browser, 'PC', T1);
  const P = pc.page;
  await wait(800);

  const home = await walk(P, () => openTour());
  show('홈', home);
  check('홈: 모든 단계를 다 보여줌(건너뛴 것 없음)', home.length === await P.evaluate(() => tourSteps.length), home.length);
  check('홈: 첫 단계는 왼쪽 메뉴', home[0] && home[0].title.includes('왼쪽 메뉴'));
  check('홈: D-DAY 단계가 이제 나옴', home.some(s => s.title.includes('D-DAY')));
  // 아래쪽 칸들(y>150, 모달 제외)은 왼쪽 열 → 오른쪽 열 순서여야 함
  const grid = home.filter(s => s.y > 150 && s.w < 700 && !/감독표|시간표 관리|테마/.test(s.title));
  // 열 번호(넓은 캘린더는 첫 열에서 시작)가 줄어들지 않아야 함 = 왼쪽 열부터 차례로
  const col = (s) => s.x + 8 < 500 ? 0 : s.x + 8 < 940 ? 1 : s.x + 8 < 1260 ? 2 : 3;
  const cols = grid.filter(s => s.w < 800).map(col);
  check('홈: 아래 칸들은 왼쪽 열→오른쪽 열 순서', cols.every((c, i) => i === 0 || c >= cols[i - 1]), grid.map(s => s.title + '@' + col(s)));
  const theme = home.find(s => s.title.includes('테마'));
  check('홈: 테마 단계에서 테마 메뉴가 실제로 보임', theme && theme.w > 100 && theme.x > 900, theme);
  check('홈: 끝나면 닫힘', await P.evaluate(() => document.getElementById('tour-overlay').style.display === 'none'));

  const pages = [
    ['좌석배치표', '#rail-seatchart-btn', () => scOpenTour(), () => scTourSteps.length],
    ['월간일정표', '#rail-monthly-btn', () => msOpenTour(), () => msTourSteps.length],
    ['시간표 만들기', '#rail-persontt-btn', () => ptOpenTour(), () => ptTourSteps.length],
    ['조퇴증', '#rail-leavepass-btn', () => lpOpenTour(), () => lpTourSteps.length],
    ['양식 만들기', '#rail-forms-btn', () => fmOpenTour(), () => fmTourSteps.length],
  ];
  for (const [name, btn, open, len] of pages) {
    await P.click(btn); await wait(700);
    const seen = await walk(P, open);
    show(name, seen);
    check(name + ': 모든 단계 표시', seen.length === await P.evaluate(len), seen.length);
    check(name + ': 끝나면 닫힘', await P.evaluate(() => document.getElementById('tour-overlay').style.display === 'none' && tourMode === 'dashboard'));
    if (name === '시간표 만들기') {
      check('시간표 만들기: 제목 바뀜', (await P.evaluate(() => document.getElementById('pt-page-header').innerText)).includes('시간표 만들기'));
      check('시간표 만들기: 설명서 끝나면 원래 탭(내 시간표)으로', await P.evaluate(() => ptCurrentTab === 'me'));
    }
    if (name === '양식 만들기') {
      check('양식 만들기: 학습지 단계도 나옴', seen.some(s => s.title.includes('학습지')) && seen.some(s => s.title.includes('초기화')));
      check('양식 만들기: 이름표 단계(① 무엇을·분리수거 종류·사물함·⑦ 출력)도 맨 뒤에 나옴', seen.some(s => s.title.includes('분리수거 종류')) && seen.some(s => s.title.includes('사물함')) && seen[seen.length - 1].title.includes('이름표') && seen[seen.length - 1].title.includes('출력'));
      check('양식 만들기: 설명서 끝나면 원래 양식(명렬표 수합)·이름표는 원래 모드(게시판)로', await P.evaluate(() => fmCfg().kind === 'roster' && document.getElementById('fm-grid').style.display !== 'none' && document.getElementById('nt-grid').style.display === 'none' && ntCfg().mode === 'board'));
    }
    await P.click(btn); await wait(400); // 홈으로
  }
  // 이전 버튼: 시간표 만들기에서 학생 단계 → 이전 → 1단계(내 시간표 탭으로 돌아감)
  await P.click('#rail-persontt-btn'); await wait(600);
  await P.evaluate(() => ptOpenTour()); await wait(200);
  for (let k = 0; k < 3; k++) { await P.click('#tour-next-btn'); await wait(250); }
  check('이전/다음: 학생 단계', (await P.evaluate(() => document.getElementById('tour-card-title').innerText)).includes('학생 고르기'));
  await P.click('#tour-prev-btn'); await wait(250);
  check('이전 누르면 1단계 + 내 시간표 탭', (await P.evaluate(() => document.getElementById('tour-card-title').innerText)).includes('1단계') && await P.evaluate(() => ptCurrentTab === 'me'));
  // 설명서 중 홈으로 가면 닫힘
  await P.evaluate(() => goHome()); await wait(200);
  check('설명서 중 홈으로 가면 닫힘', await P.evaluate(() => document.getElementById('tour-overlay').style.display === 'none' && tourMode === 'dashboard'));

  // 양식 만들기 설명서: 명렬표 수합·학습지마다 "이런 걸 만들어요" 완성 예시 → 닫으면 원래 설정(예시는 저장 안 함)
  await P.click('#rail-forms-btn'); await wait(600);
  const before = await P.evaluate(() => ({ fm: localStorage.getItem('fm-cfg'), ws: localStorage.getItem('fm-ws'), title: fmCfg().title }));
  await P.evaluate(() => fmOpenTour()); await wait(300);
  const goTo = async (txt) => { for (let k = 0; k < 30; k++) { if ((await P.evaluate(() => document.getElementById('tour-card-title').innerText)).includes(txt)) return true; await P.click('#tour-next-btn'); await wait(250); } return false; };
  const ex1 = await goTo('명렬표 수합 — 이런 걸 만들어요'); await wait(300); await P.screenshot({ path: 'tour-fm-demo1.png' });
  const r1 = await P.evaluate(() => ({ prev: document.getElementById('fm-pages').innerText, titleInp: document.getElementById('fm-title').value, roster: !!document.querySelector('#fm-pages table.fm-tbl'), grid: document.getElementById('fm-grid').style.display !== 'none' }));
  check('양식 설명서: 명렬표 수합 완성 예시(제목·명단 15명·동의서·회비 칸)가 미리보기·입력칸에 보임', ex1 && r1.roster && r1.grid && /현장체험학습 동의서 제출 확인/.test(r1.prev) && /권나은/.test(r1.prev) && /회비/.test(r1.prev) && r1.titleInp === '현장체험학습 동의서 제출 확인', r1);
  const ex2 = await goTo('학습지 — 이런 걸 만들어요'); await wait(300); await P.screenshot({ path: 'tour-fm-demo2.png' });
  const r2 = await P.evaluate(() => ({ prev: document.getElementById('fm-pages').innerText, ws: document.getElementById('ws-grid').style.display !== 'none', subj: document.getElementById('ws-subj').value }));
  check('양식 설명서: 학습지 완성 예시(통합과학 2단원 원소와 원자 + 제목 뼈대)가 보임', ex2 && r2.ws && r2.subj === '통합과학' && /원소와 원자/.test(r2.prev) && /원자의 구조/.test(r2.prev), r2);
  const titles = await P.evaluate(() => fmTourSteps.map(s => s.title));
  check('양식 설명서: 단계 제목에 어느 양식인지(📋 명렬표 수합 · / 📚 학습지 ·)', titles.filter(t => t.startsWith('📋 명렬표 수합 ·')).length === 9 && titles.filter(t => t.startsWith('📚 학습지 ·')).length === 7, titles);
  await P.evaluate(() => closePageTour()); await wait(300);
  const after = await P.evaluate(() => ({ fm: localStorage.getItem('fm-cfg'), ws: localStorage.getItem('fm-ws'), title: fmCfg().title, inp: document.getElementById('fm-title').value, kind: fmCfg().kind, prev: document.getElementById('fm-pages').innerText }));
  check('양식 설명서 닫으면 예시 사라지고 원래 설정·원래 탭(저장된 값도 그대로)', after.ws === before.ws && after.title === before.title && after.inp === before.title && after.kind === 'roster' && !/권나은|현장체험학습/.test(after.prev) &&
    JSON.parse(after.fm || '{}').title === JSON.parse(before.fm || '{}').title, [before, after]);
  await P.click('#rail-forms-btn'); await wait(300);

  check('페이지 오류 없음', pc.errors.length === 0, pc.errors);
  console.log(failures ? ('실패 ' + failures + '건') : '모든 검사 통과');
  await browser.close();
  process.exit(failures ? 1 : 0);
})();
