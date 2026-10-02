// 감독표 수정 모드: 이름 칸을 칠 때마다 저장하지 않고, "💾 저장"을 누르면 바뀐 칸만 한 번에 저장하는지.
// 가짜 Supabase 서버(Node 메모리)에 브라우저를 붙여 index.html의 실제 코드를 돌린다.
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
  [T2]: { id: T2, name: '박교사', is_admin: false, must_change_password: false, role: '교사', homeroom_grade: null, homeroom_class: null },
};
const items = new Map(); // teacher|key -> {teacher_id,key,value,updated_at}
const history = [];
let lastTs = Date.now();
function nowIso() { lastTs = Math.max(Date.now(), lastTs + 1); return new Date(lastTs).toISOString(); }
const pages = []; // {page, name, offline, realtimeDown}
const duty = new Map(); // board|date|col -> row
const dbLog = [];
function dutyVal(board, date, col) { const r = duty.get(board + '|' + date + '|' + col); return r ? r.value : undefined; }
function seedDuty(board, date, col, value) { duty.set(board + '|' + date + '|' + col, { board, duty_date: date, col_index: col, value }); }

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
  if (table === 'duty_roster') {
    dbLog.push({ op, rows: rows ? JSON.parse(JSON.stringify(rows)) : null, filters });
    const fv = (c) => { const f = filters.find(x => x.col === c); return f ? f.val : undefined; };
    if (op === 'upsert') {
      for (const r of rows) duty.set(r.board + '|' + r.duty_date + '|' + r.col_index, { ...r });
      return { data: null, error: null };
    }
    if (op === 'delete') {
      for (const k of [...duty.keys()]) { const r = duty.get(k); if (r.board === fv('board') && r.duty_date === fv('duty_date')) duty.delete(k); }
      return { data: null, error: null };
    }
    const list = [...duty.values()].filter(r => r.board === fv('board')).sort((a, b) => a.duty_date < b.duty_date ? -1 : 1);
    return { data: list.map(r => ({ duty_date: r.duty_date, col_index: r.col_index, value: r.value })), error: null };
  }
  if (table === 'timetable' && op === 'select') {
    const subj = ['국어','수학','영어','과학','사회','체육','음악','미술'];
    const rows = ['김교사','박교사','이교사','정교사','한교사','오교사','윤교사','장교사'].map((nm, t) => ({ teacher_name: nm, cells: Array.from({length:35}, (_, j) => (j + t) % 3 === 0 ? subj[(j + t) % 8] + '\n' + (200 + j) : '') }));
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
  const D = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'];
  seedDuty('야자감독', D[0], 1, '김교사');
  seedDuty('야자감독', D[1], 1, '');
  seedDuty('야자감독', D[2], 1, '');
  seedDuty('야자감독', D[3], 1, '이교사');
  seedDuty('야자감독', D[4], 1, '');
  seedDuty('급식감독', D[0], 1, '정교사'); seedDuty('급식감독', D[0], 2, '한교사');

  // ---------- 일반 교사(박교사): 홈에서 야자 감독표 ----------
  const t2 = await openDevice(browser, 'PC박교사', T2);
  const P = t2.page;
  await P.evaluate(() => { window.__confirmAnswer = true; window.__confirms = []; window.customConfirm = async (m) => { window.__confirms.push(m); return window.__confirmAnswer; }; window.__alerts = []; window.customAlert = async (m) => { window.__alerts.push(m); }; });
  await P.evaluate(() => openDutyModal('야자감독', '🌙')); await wait(500);
  await P.click('#duty-edit-toggle'); await wait(300);
  const cell = (d) => `#duty-list-container .duty-cell-input[data-date="${d}"][data-col="1"]`;
  check('수정 모드: 저장 막대가 보이고 처음엔 저장 버튼 꺼짐', await P.evaluate(() => !!document.getElementById('duty-save-bar') && document.getElementById('duty-save-btn').disabled));

  dbLog.length = 0;
  await P.click(cell(D[1])); await P.keyboard.type('박교사');
  await P.keyboard.press('Enter');
  check('Enter → 아래 칸으로', await P.evaluate((d) => document.activeElement && document.activeElement.dataset.date === d, D[2]));
  await P.keyboard.type('최교사');
  await P.keyboard.press('Enter');
  await P.keyboard.press('Enter'); // D[3]은 그대로 두고 지나감
  await P.keyboard.type('오교사');
  await P.click(cell(D[0])); await P.keyboard.press('End'); await P.keyboard.type('X'); // 바꿨다가
  await P.keyboard.press('Backspace'); // 원래대로
  await wait(300);
  check('입력·칸 이동하는 동안 서버에 아무것도 안 보냄', dbLog.filter(x => x.op !== 'select').length === 0 && dbLog.length === 0, dbLog);
  const st1 = await P.evaluate(() => [document.getElementById('duty-save-btn').innerText, document.getElementById('duty-save-btn').disabled, document.querySelectorAll('.duty-cell-dirty').length]);
  check('바뀐 칸 3개만 표시(되돌린 칸은 빠짐)·버튼 "3건 저장"', st1[0].includes('3건') && !st1[1] && st1[2] === 3, st1);

  await P.click('#duty-save-btn'); await wait(500);
  const ups = dbLog.filter(x => x.op === 'upsert');
  check('저장: 서버 요청 1번에 바뀐 칸 3개만', ups.length === 1 && ups[0].rows.length === 3 && ups[0].rows.every(r => r.board === '야자감독'), ups);
  check('서버 값 반영', dutyVal('야자감독', D[1], 1) === '박교사' && dutyVal('야자감독', D[2], 1) === '최교사' && dutyVal('야자감독', D[4], 1) === '오교사' && dutyVal('야자감독', D[0], 1) === '김교사' && dutyVal('야자감독', D[3], 1) === '이교사');
  const st2 = await P.evaluate(() => [document.getElementById('duty-save-btn').disabled, document.querySelectorAll('.duty-cell-dirty').length, document.getElementById('duty-save-note').innerText, window.__alerts.length, dutyEditMode]);
  check('저장 후: 표시 지워짐·알림 창 없이 "저장했어요"·수정 모드 유지', st2[0] && st2[1] === 0 && st2[2].includes('저장했어요') && st2[3] === 0 && st2[4] === true, st2);

  // 닫기: 저장 안 한 게 있으면 묻고, 취소면 그대로 남음
  await P.fill(cell(D[3]), '윤교사'); await P.dispatchEvent(cell(D[3]), 'input');
  dbLog.length = 0;
  await P.evaluate(() => { window.__confirmAnswer = false; window.__confirms = []; });
  await P.click('#duty-close-row button'); await wait(300);
  check('닫기(취소): 창 그대로·입력 그대로·서버 요청 없음', await P.evaluate(() => document.getElementById('duty-overlay').style.display === 'flex' && window.__confirms.length === 1 && document.querySelectorAll('.duty-cell-dirty').length === 1) && dbLog.length === 0);
  await P.evaluate(() => { window.__confirmAnswer = false; window.__confirms = []; });
  await P.click('#duty-edit-toggle'); await wait(300);
  check('보기 모드로(취소): 수정 모드 그대로', await P.evaluate(() => dutyEditMode === true && window.__confirms.length === 1));
  await P.evaluate(() => { window.__confirmAnswer = true; window.__confirms = []; });
  await P.click('#duty-close-row button'); await wait(500);
  check('닫기(확인): 저장하고 닫힘', await P.evaluate(() => document.getElementById('duty-overlay').style.display === 'none') && dutyVal('야자감독', D[3], 1) === '윤교사' && dbLog.filter(x => x.op === 'upsert').length === 1);

  // 되돌리기
  await P.evaluate(() => openDutyModal('야자감독', '🌙')); await wait(400);
  await P.click('#duty-edit-toggle'); await wait(200);
  await P.fill(cell(D[1]), '아무개'); await P.dispatchEvent(cell(D[1]), 'input');
  await P.click('#duty-undo-btn'); await wait(300);
  check('↺ 되돌리기: 저장된 값으로', await P.evaluate((s) => document.querySelector(s).value === '박교사' && document.querySelectorAll('.duty-cell-dirty').length === 0, cell(D[1])));
  check('일반 교사: 새 줄 추가 버튼 없음', await P.evaluate(() => !document.querySelector('#duty-list-container [onclick^="addBlankDutyRow"]')));
  await P.screenshot({ path: 'duty-edit.png' });

  // ---------- 관리자(김교사): 설정 → 감독표 탭 ----------
  teachers[T1].is_admin = true;
  const t1 = await openDevice(browser, 'PC관리자', T1);
  const A = t1.page;
  await A.evaluate(() => { window.__confirmAnswer = true; window.__confirms = []; window.customConfirm = async (m) => { window.__confirms.push(m); return window.__confirmAnswer; }; window.__alerts = []; window.customAlert = async (m) => { window.__alerts.push(m); }; });
  await A.click('#rail-settings-btn'); await wait(800);
  await A.evaluate(() => switchAdminTab('duty')); await wait(600);
  await A.click('#duty-edit-toggle'); await wait(200);
  await A.fill(cell(D[2]), '최교사, 수정'); await A.dispatchEvent(cell(D[2]), 'input');
  await A.evaluate(() => addBlankDutyRow('야자감독')); await wait(300);
  check('새 줄을 만들어도 고친 칸은 그대로', await A.evaluate((s) => document.querySelector(s).value === '최교사, 수정' && document.querySelector(s).classList.contains('duty-cell-dirty'), cell(D[2])));
  const pid = await A.evaluate(() => pendingNewDutyRows[0].id);
  await A.fill(`#pending-duty-row-${pid} input[type=date]`, '2026-10-10'); await A.dispatchEvent(`#pending-duty-row-${pid} input[type=date]`, 'change');
  await A.fill(`#pending-duty-row-${pid} input[type=text]`, '장교사'); await A.dispatchEvent(`#pending-duty-row-${pid} input[type=text]`, 'input');
  check('저장 버튼 = 고친 칸 1 + 새 줄 1', await A.evaluate(() => document.getElementById('duty-save-btn').innerText.includes('2건')));

  // 다른 감독표로 가려 하면 묻기 — 취소면 그대로
  await A.evaluate(() => { window.__confirmAnswer = false; window.__confirms = []; });
  await A.click('.admin-duty-board-btn[data-board="급식감독"]'); await wait(300);
  check('급식으로 바꾸기(취소): 야자 그대로', await A.evaluate(() => currentDutySheetName === '야자감독' && window.__confirms.length === 1 && pendingNewDutyRows.length === 1));
  await A.evaluate(() => switchAdminTab('school')); await wait(300);
  check('다른 설정 탭(취소): 감독표 탭 그대로', await A.evaluate(() => adminSettingsActiveTab === 'duty'));
  // 홈 갔다 다시 와도 입력 그대로
  await A.evaluate(() => goHome()); await wait(200);
  await A.click('#rail-settings-btn'); await wait(800);
  check('설정 → 홈 → 설정: 입력하던 것 그대로', await A.evaluate((s) => document.querySelector(s) && document.querySelector(s).value === '최교사, 수정' && pendingNewDutyRows.length === 1 && dutyEditMode, cell(D[2])));

  dbLog.length = 0;
  await A.evaluate(() => { window.__confirmAnswer = true; window.__confirms = []; });
  await A.click('.admin-duty-board-btn[data-board="급식감독"]'); await wait(700);
  const ups2 = dbLog.filter(x => x.op === 'upsert');
  check('급식으로 바꾸기(확인): 한 번에 저장 후 이동', ups2.length === 1 && ups2[0].rows.length === 2 && dutyVal('야자감독', D[2], 1) === '최교사, 수정' && dutyVal('야자감독', '2026-10-10', 1) === '장교사' && await A.evaluate(() => currentDutySheetName === '급식감독'), ups2);

  // 급식(이름 칸 2개): 둘째 칸만 바꾸면 그 칸만
  await A.click('#duty-edit-toggle'); await wait(200);
  const c2 = `#duty-list-container .duty-cell-input[data-date="${D[0]}"][data-col="2"]`;
  await A.fill(c2, '오교사'); await A.dispatchEvent(c2, 'input');
  dbLog.length = 0;
  await A.click('#duty-save-btn'); await wait(500);
  const ups3 = dbLog.filter(x => x.op === 'upsert');
  check('이름 칸 2개짜리: 바꾼 둘째 칸만 저장', ups3.length === 1 && ups3[0].rows.length === 1 && ups3[0].rows[0].col_index === 2 && dutyVal('급식감독', D[0], 1) === '정교사' && dutyVal('급식감독', D[0], 2) === '오교사', ups3);

  // 저장 실패하면 입력이 남는다
  await A.fill(c2, '실패교사'); await A.dispatchEvent(c2, 'input');
  await A.evaluate(() => { window.__origFrom = sb.from; sb.from = function(t) { const b = window.__origFrom.call(sb, t); const up = b.upsert; b.upsert = function() { up.apply(b, arguments); return { then: (res) => res({ error: { message: 'offline' } }) }; }; return b; }; });
  await A.click('#duty-save-btn'); await wait(300);
  check('저장 실패: 알림·입력 그대로', await A.evaluate((s) => window.__alerts.some(m => m.includes('저장 실패')) && document.querySelector(s).value === '실패교사' && document.querySelectorAll('.duty-cell-dirty').length === 1, c2));
  await A.evaluate(() => { sb.from = window.__origFrom; });
  await A.screenshot({ path: 'duty-admin.png' });

  const allErrors = pages.flatMap(p => (p.errors || []).map(e => p.name + ': ' + e));
  check('전체 페이지 오류 없음', allErrors.length === 0, allErrors);
  console.log(failures === 0 ? '\n모든 검사 통과' : '\n실패 ' + failures + '건');
  await browser.close();
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
