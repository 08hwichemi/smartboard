// 🗓 교외체험학습 현황판(결석계 넷째 탭): 쓰는 학년(3학년)의 교외체험학습 기록은 서버 표(trip_records)에 함께 두고 — 담임이 ✏️ 입력 탭·
// 띠의 빈 칸 두 번·👥 여러 명 같은 기간으로 넣기, 기존사용 직접 적기, 쓰는 기간만 보이는 가로축(방학 없음)·휴일·주/기간 구분선,
// 총일수 색, 신청 현황표(가로 A4, 전체 보기는 반마다 한 장) 인쇄, 📤 내 계정 자료 → 서버 옮기기, 부장(학년 전체 보기)은 보기만 + 실시간,
// 쓰지 않는 학년(1학년)은 탭이 없고 예전처럼 내 계정에만.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(process.env.HTML_PATH || path.join(ROOT, 'index.html'), 'utf8');

// ---------- 가짜 서버 ----------
const T1 = '11111111-1111-1111-1111-111111111111'; // 3학년 1반 담임
const T2 = '22222222-2222-2222-2222-222222222222'; // 3학년 부장(학년 전체 보기, 보기만)
const T3 = '33333333-3333-3333-3333-333333333333'; // 1학년 1반 담임(현황판 안 쓰는 학년)
const teachers = {
  [T1]: { id: T1, name: '김담임', is_admin: false, must_change_password: false, role: '담임', homeroom_grade: 3, homeroom_class: 1, schedule_manager: false, trip_viewer: false },
  [T2]: { id: T2, name: '박부장', is_admin: false, must_change_password: false, role: '교사', homeroom_grade: null, homeroom_class: null, schedule_manager: false, trip_viewer: true },
  [T3]: { id: T3, name: '이담임', is_admin: false, must_change_password: false, role: '담임', homeroom_grade: 1, homeroom_class: 1, schedule_manager: false, trip_viewer: false },
};
const TRIP_BOARD = { grades: [3], periods: { 3: [{ from: '2026-12-01', to: '2026-12-11' }, { from: '2026-12-18', to: '2026-12-30' }, { from: '2027-02-01', to: '2027-02-02' }] } };
const students = [];
[['가나다', '라마바', '사아자', '차카타', '파하가'], ['강민수', '구진모', '김규민'], ['문채원', '배준서']].forEach((names, ci) => names.forEach((n, i) => students.push({ grade: 3, class_no: ci + 1, number: i + 1, name: n })));
['일학년가', '일학년나', '일학년다'].forEach((n, i) => students.push({ grade: 1, class_no: 1, number: i + 1, name: n }));
const items = new Map();      // user_data_items: teacher|key
const tripRecords = new Map(); // id → row
const tripPrior = new Map();   // g-c-num → row
const tripHol = new Map();     // g-day → row
const writes = [];             // 서버 쓰기 기록 [table, op, n]
let lastTs = Date.now();
function nowIso() { lastTs = Math.max(Date.now(), lastTs + 1); return new Date(lastTs).toISOString(); }
const pages = [];

async function fireRealtime(table, tid) {
  for (const p of pages) {
    if (p.page.isClosed()) continue;
    try { await p.page.evaluate(([t, id]) => window.__fireRealtime && window.__fireRealtime(t, id), [table, tid]); } catch (e) {}
  }
}
function can(uid, g, c, write) {
  const t = teachers[uid]; if (!t) return false;
  if (t.is_admin) return true;
  if (t.role === '담임' && t.homeroom_grade === Number(g) && t.homeroom_class === Number(c)) return true;
  if (!write && t.trip_viewer && TRIP_BOARD.grades.includes(Number(g))) return true;
  return false;
}
function applyFilters(list, filters) {
  for (const f of filters) {
    if (f.op === 'eq') list = list.filter(r => String(r[f.col]) === String(f.val));
    if (f.op === 'in') list = list.filter(r => f.val.map(String).includes(String(r[f.col])));
    if (f.op === 'gt') list = list.filter(r => r[f.col] > f.val);
  }
  return list;
}
async function handleDb(pageInfo, req) {
  const { table, op, filters, rows, single, maybe, range } = req;
  const uid = pageInfo.uid;
  if (table === 'teachers') {
    const f = filters.find(x => x.col === 'id');
    const list = f ? [teachers[f.val]].filter(Boolean) : Object.values(teachers);
    return { data: single || maybe ? (list[0] || null) : list, error: null };
  }
  if (table === 'user_data_items') {
    if (op === 'upsert') {
      for (const r of rows) items.set(r.teacher_id + '|' + r.key, { teacher_id: r.teacher_id, key: r.key, value: r.value, updated_at: nowIso() });
      writes.push(['user_data_items', 'upsert', rows.length]);
      return { data: null, error: null };
    }
    let list = applyFilters([...items.values()], filters).filter(r => r.teacher_id === uid);
    list.sort((a, b) => (a.updated_at < b.updated_at ? -1 : 1));
    if (range) list = list.slice(range[0], range[1] + 1);
    return { data: list.map(r => ({ key: r.key, value: r.value, updated_at: r.updated_at })), error: null };
  }
  if (table === 'students') return { data: applyFilters(students.slice(), filters).sort((a, b) => a.class_no - b.class_no || a.number - b.number), error: null };
  if (table === 'app_settings') {
    const k = filters.find(f => f.col === 'key');
    if (k && k.val === 'class_structure') return { data: { value: { gradeCount: 3, classCounts: [8, 9, 3] } }, error: null };
    if (k && k.val === 'trip_board') return { data: { value: TRIP_BOARD }, error: null };
    return { data: single || maybe ? null : [], error: null };
  }
  if (table === 'trip_records' || table === 'trip_prior' || table === 'trip_holidays') {
    const store = table === 'trip_records' ? tripRecords : table === 'trip_prior' ? tripPrior : tripHol;
    const keyOf = r => table === 'trip_records' ? r.id : table === 'trip_prior' ? r.grade + '-' + r.class_no + '-' + r.num : r.grade + '-' + r.day;
    const okWrite = r => table === 'trip_holidays' ? (teachers[uid].is_admin || (teachers[uid].role === '담임' && teachers[uid].homeroom_grade === Number(r.grade))) : can(uid, r.grade, r.class_no, true);
    const okRead = r => table === 'trip_holidays' ? true : can(uid, r.grade, r.class_no, false);
    if (op === 'upsert') {
      for (const r of rows) if (!okWrite(r)) return { data: null, error: { message: 'new row violates row-level security policy for table "' + table + '"' } };
      for (const r of rows) { const old = store.get(keyOf(r)) || { created_at: nowIso(), created_by: uid }; store.set(keyOf(r), Object.assign({}, old, r)); }
      writes.push([table, 'upsert', rows.length]);
      setTimeout(() => fireRealtime(table, uid), 30);
      return { data: null, error: null };
    }
    if (op === 'delete') {
      const hit = applyFilters([...store.values()], filters).filter(okWrite);
      hit.forEach(r => store.delete(keyOf(r)));
      writes.push([table, 'delete', hit.length]);
      setTimeout(() => fireRealtime(table, uid), 30);
      return { data: null, error: null };
    }
    const list = applyFilters([...store.values()], filters).filter(okRead);
    return { data: single || maybe ? (list[0] || null) : list, error: null };
  }
  if (op === 'select') return { data: single || maybe ? null : [], error: null };
  return { data: null, error: null };
}

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
      in: function(c,v){ q.filters.push({op:'in',col:c,val:v}); return b; },
      gte: function(){ return b; }, lte: function(){ return b; }, limit: function(){ return b; },
      order: function(c){ q.orders.push(c); return b; },
      range: function(a,z){ q.range=[a,z]; return b; },
      single: function(){ q.single=true; return b; },
      maybeSingle: function(){ q.maybe=true; return b; },
      upsert: function(rows){ q.op='upsert'; q.rows=Array.isArray(rows)?rows:[rows]; return b; },
      insert: function(rows){ q.op='insert'; q.rows=Array.isArray(rows)?rows:[rows]; return b; },
      update: function(){ q.op='update'; return b; },
      delete: function(){ q.op='delete'; return b; },
      then: function(res, rej){ return window.__db(q).then(res, rej); }
    };
    return b;
  }
  window.supabase = { createClient: function(){
    return {
      auth: { getSession: async function(){ return { data: { session: uid ? { user: { id: uid } } : null } }; }, signOut: async function(){ return {}; }, signInWithPassword: async function(){ return { error: { message: 'no' } }; } },
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
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  const info = { page, ctx, name, uid, errors: [] };
  pages.push(info);
  page.on('pageerror', e => info.errors.push(String(e)));
  await page.exposeFunction('__db', (q) => handleDb(info, q));
  if (opts.preload) {
    await page.addInitScript((obj) => {
      if (sessionStorage.getItem('__preloaded')) return;
      sessionStorage.setItem('__preloaded', '1');
      Object.entries(obj).forEach(([k, v]) => localStorage.setItem(k, v));
    }, opts.preload);
  }
  await page.addInitScript(() => { window.print = function() { window.__printed = (window.__printed || 0) + 1; }; });
  await page.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith('http://app.test/')) {
      if (url.includes('version.txt')) return route.fulfill({ body: 'x', contentType: 'text/plain' });
      const pathOnly = url.split('?')[0].split('#')[0].replace('http://app.test/', '');
      if (pathOnly.startsWith('absence/')) {
        const f = path.join(ROOT, pathOnly);
        if (fs.existsSync(f)) return route.fulfill({ body: fs.readFileSync(f), contentType: 'application/json' });
      }
      if (url.split('?')[0] === 'http://app.test/' || url.includes('index.html')) return route.fulfill({ body: html, contentType: 'text/html; charset=utf-8' });
      return route.fulfill({ status: 404, body: '' });
    }
    if (url.includes('@supabase/supabase-js')) return route.fulfill({ body: mockLib, contentType: 'application/javascript' });
    if (url.includes('open.neis.go.kr/hub/SchoolSchedule')) {
      // 학사일정: 12/23 재량휴업일은 2학년만(3학년 현황판엔 안 나와야), 겨울방학은 12/31~ (기간 밖이라 안 보임)
      const row = [{ AA_YMD: '20261223', EVENT_NM: '재량휴업일', SBTR_DD_SC_NM: '휴업일', ONE_GRADE_EVENT_YN: 'N', TW_GRADE_EVENT_YN: 'Y', THREE_GRADE_EVENT_YN: 'N' }];
      for (let d = new Date('2026-12-31T00:00:00'); d <= new Date('2027-01-29T00:00:00'); d.setDate(d.getDate() + 1)) {
        row.push({ AA_YMD: d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0'), EVENT_NM: '겨울방학', SBTR_DD_SC_NM: '휴업일' });
      }
      return route.fulfill({ body: JSON.stringify({ SchoolSchedule: [{ head: [] }, { row }] }), contentType: 'application/json' });
    }
    return route.abort();
  });
  await page.goto('http://app.test/?uid=' + uid);
  await page.waitForFunction(() => window.currentTeacher && typeof syncAppStarted !== 'undefined' && syncAppStarted === true, null, { timeout: 15000 });
  return info;
}

const wait = (ms) => new Promise(r => setTimeout(r, ms));
let failures = 0;
function check(label, cond, detail) {
  console.log((cond ? '  ✅ ' : '  ❌ ') + label + (cond ? '' : '  → ' + JSON.stringify(detail)));
  if (!cond) failures++;
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }).catch(() => chromium.launch());
  // 담임 PC — 현황판 전에 내 계정 자료로 넣어 둔 교외체험학습 1건(옮기기 검사용) + 1학년 것은 아님
  const oldLocal = { id: 'oldlocal1', created: 1, g: 3, c: 1, num: 5, name: '파하가', reason: '교외체험학습', detail: '예전 것', from: '2026-11-02', to: '2026-11-03', written: '2026-11-03', proof: '교외체험학습 신청서' };
  items.set(T1 + '|ab-r-oldlocal1', { teacher_id: T1, key: 'ab-r-oldlocal1', value: JSON.stringify(oldLocal), updated_at: nowIso() }); // 서버의 내 계정 자료(다른 기기에서 넣어 둔 것)
  const pc = await openDevice(browser, '담임', T1);
  const P = pc.page;
  const cell = (c) => P.evaluate((c) => { const td = document.querySelector('#ab-paper [data-c="' + c + '"]'); return td ? td.textContent : null; }, c);
  const gridRow = (n) => '#trip-grid tr[data-n="' + n + '"]';
  const bars = (page, n) => page.evaluate((n) => [...document.querySelectorAll('#trip-grid tr[data-n="' + n + '"] td.bar')].map(td => td.dataset.n + ':' + (td.classList.contains('s') ? 's' : '') + (td.classList.contains('e') ? 'e' : '')), n);
  const tot = (page, n) => page.evaluate((n) => { const td = document.querySelector('#trip-grid tr[data-n="' + n + '"] td.c-tot'); return td ? [td.textContent, td.className.replace(/fix|c-tot/g, '').trim()] : null; }, n);

  console.log('[1] 담임: 탭·가로축');
  await P.click('#rail-absence-btn'); await wait(900);
  check('3학년 1반 담임 → 🗓 탭 보임 + 머리에 "함께 봐요" 안내', await P.evaluate(() => document.querySelector('#ab-tabs [data-tab="trip"]').style.display !== 'none' && document.getElementById('ab-share-note').style.display !== 'none' && /3학년 담임·관리자·학년 전체 보기/.test(document.getElementById('ab-share-note').textContent)));
  check('담임은 반 목록에 "전체" 없음', await P.evaluate(() => ![...document.querySelectorAll('#ab-class option')].some(o => o.value === 'all')));
  await P.click('#ab-tabs [data-tab="trip"]'); await wait(400);
  const head = await P.evaluate(() => {
    const rows = [...document.querySelectorAll('#trip-grid thead tr')];
    return { periods: [...rows[0].querySelectorAll('th:not(.fix)')].map(t => t.textContent), days: [...rows[1].querySelectorAll('th')].map(t => t.textContent), hol: rows[1].querySelectorAll('th.hol').length, pst: rows[1].querySelectorAll('th.pst').length, wk: rows[1].querySelectorAll('th.wk').length, wd: [...rows[2].querySelectorAll('th')].map(t => t.textContent).join('') };
  });
  check('기간 머리 3개(12/1~11 · 12/18~30 · 2/1~2) — 방학 날짜 없음', head.periods.join('|') === '12/1~11|12/18~30|2/1~2', head.periods);
  check('날짜 칸 20개(평일만: 9 + 9 + 2), 성탄절 1칸 휴, 기간 구분선 2, 주 구분선(월요일) 3', head.days.length === 20 && head.hol === 1 && head.pst === 2 && head.wk === 3, head);
  check('요일 줄: 화수목금월화수목금 | 금월화수목휴월화수 | 월화 (12/23 2학년만 쉬는 날은 3학년엔 휴일 아님)', head.wd === '화수목금월화수목금금월화수목휴월화수월화', head.wd);
  check('쓰는 기간 요약 9일·8일·2일', /12\/1~11\(9일\) · 12\/18~30\(8일\) · 2\/1~2\(2일\)/.test(await P.innerText('#trip-ctrl')), await P.innerText('#trip-ctrl'));
  check('명렬표 5명 모두 줄', await P.evaluate(() => document.querySelectorAll('#trip-grid tbody tr[data-n]').length) === 5);
  check('예전 내 계정 기록 1건 → 📤 옮기기 단추', /📤 서버로 옮기기 \(1건\)/.test(await P.innerText('#trip-ctrl')));
  check('옮기기 전엔 예전 기록이 기존(자동)에 셈: 5번 기존 2', await P.evaluate(() => document.querySelector('#trip-grid tr[data-n="5"] td.c-pre').textContent) === '2');
  check('띠를 안 골랐을 땐 미리보기 = 가로 현황표 1장', await P.evaluate(() => document.getElementById('ab-paper').classList.contains('ab-land') && !!document.querySelector('#ab-paper .tps') && document.querySelectorAll('#ab-paper-box .ab-paper.ab-extra').length === 0 && /현황표 · 가로 A4 1장/.test(document.getElementById('ab-prev-label').textContent)));

  console.log('[2] ✏️ 입력 탭에서 교외체험학습 → 서버 표');
  await P.click('#ab-tabs [data-tab="input"]'); await wait(200);
  await P.selectOption('#ab-n-num', '2');
  await P.selectOption('#ab-n-reason', '교외체험학습'); await P.dispatchEvent('#ab-n-reason', 'change');
  await P.fill('#ab-n-detail', '가족 여행');
  await P.fill('#ab-n-from', '2026-12-01'); await P.dispatchEvent('#ab-n-from', 'change');
  await P.fill('#ab-n-to', '2026-12-03'); await P.dispatchEvent('#ab-n-to', 'change');
  check('입력 줄 자동 일수 3', await P.inputValue('#ab-n-days') === '3');
  await P.press('#ab-n-detail', 'Enter'); await wait(400);
  check('서버 trip_records 1건(3학년 1반 2번 12/1~3, 일수 자동=null), 내 계정 자료(ab-r-)엔 없음', tripRecords.size === 1 && [...tripRecords.values()][0].class_no === 1 && [...tripRecords.values()][0].num === 2 && [...tripRecords.values()][0].days === null && ![...items.keys()].some(k => k.includes('|ab-r-') && !k.includes('oldlocal')), [...tripRecords.values()]);
  check('목록에 srv 기록, 신청서 미리보기(이전 누적 0, 담임확인 3일)', await P.evaluate(() => abClassRecords().filter(r => r.srv).length === 1) && await cell('L8') === '0' && await cell('I4') === '3일', [await cell('L8'), await cell('I4')]);
  await P.click('#ab-tabs [data-tab="trip"]'); await wait(300);
  check('띠: 2번 줄에 1회 3칸(12/1 시작·12/3 끝)', JSON.stringify(await bars(P, 2)) === '["1:s","1:","1:e"]', await bars(P, 2));
  check('총일수 3', (await tot(P, 2))[0] === '3');

  console.log('[3] 빈 칸 두 번 → 한 명 추가');
  await P.click(gridRow(2) + ' td.day[data-d="2026-12-07"]'); await wait(200);
  check('첫 칸: 시작일 안내 + 칸 표시', /시작일 12\/7\(월\)/.test(await P.innerText('#trip-msg')) && await P.evaluate(() => !!document.querySelector('#trip-grid td.pick[data-d="2026-12-07"]')));
  await P.click(gridRow(2) + ' td.day[data-d="2026-12-09"]'); await wait(200);
  const popTxt = await P.innerText('#trip-grid .trip-pop').catch(() => '');
  check('확인 상자: 2회 · 12/7(월) ~ 12/9(수) · 3일 · 총일수 3 → 6일', /2회/.test(popTxt) && /12\/7\(월\) ~ 12\/9\(수\) · 3일/.test(popTxt) && /3 → 6일/.test(popTxt), popTxt);
  await P.fill('#trip-add-detail', '친척 방문'); await P.press('#trip-add-detail', 'Enter'); await wait(400);
  check('추가됨: 서버 2건, 띠 2회(3칸), 총일수 6, 미리보기 = 그 기록 신청서(이전 누적 3, 담임확인 6일)', tripRecords.size === 2 && JSON.stringify(await bars(P, 2)) === '["1:s","1:","1:e","2:s","2:","2:e"]' && (await tot(P, 2))[0] === '6' && await cell('L8') === '3' && await cell('I4') === '6일' && !await P.evaluate(() => document.getElementById('ab-paper').classList.contains('ab-land')), [tripRecords.size, await bars(P, 2), await cell('L8'), await cell('I4')]);
  check('구체적인 사유·증빙 저장', [...tripRecords.values()].some(r => r.detail === '친척 방문' && r.proof === '교외체험학습 신청서' && r.written === '2026-12-09'), [...tripRecords.values()]);
  // 겹치는 기간은 못 넣음
  await P.click(gridRow(2) + ' td.day[data-d="2026-12-04"]'); await wait(100);
  await P.click(gridRow(2) + ' td.day[data-d="2026-12-10"]'); await wait(200);
  check('이미 있는 기간과 겹치면 ⚠️ + 추가 단추 꺼짐', /겹쳐요/.test(await P.innerText('#trip-grid .trip-pop')) && await P.evaluate(() => document.getElementById('trip-add-ok').disabled));
  await P.keyboard.press('Escape'); await wait(200);
  check('Esc → 상자 닫힘, 고른 칸 없음, 미리보기 현황표로', await P.evaluate(() => !document.querySelector('#trip-grid .trip-pop') && !document.querySelector('#trip-grid td.pick') && document.getElementById('ab-paper').classList.contains('ab-land')));

  console.log('[4] 기존사용 직접 적기');
  await P.click(gridRow(1) + ' td.c-pre'); await wait(200);
  check('기존 상자: 자동 0일 + 직접 적는 칸', /올해 기록에서 자동\s*0일/.test(await P.innerText('#trip-grid .trip-pop')) && await P.evaluate(() => document.activeElement.id === 'trip-pre-in'));
  await P.fill('#trip-pre-in', '12'); await P.fill('#trip-pre-memo', '1학기'); await P.press('#trip-pre-in', 'Enter'); await wait(400);
  check('서버 trip_prior 1건(12, 메모), 칸에 12✎, 총일수 12', tripPrior.size === 1 && [...tripPrior.values()][0].days === 12 && [...tripPrior.values()][0].memo === '1학기' && await P.evaluate(() => document.querySelector('#trip-grid tr[data-n="1"] td.c-pre').textContent) === '12✎' && (await tot(P, 1))[0] === '12', [...tripPrior.values()]);

  console.log('[5] 👥 여러 명 같은 기간');
  await P.click('#trip-ctrl button:has-text("여러 명 같은 기간")'); await wait(200);
  check('기간 칸 기본 = 첫 쓰는 기간(12/1~12/11 9일), 칩 5개, 2번은 겹침으로 꺼짐', await P.inputValue('#trip-b-from') === '2026-12-01' && await P.inputValue('#trip-b-to') === '2026-12-11' && await P.evaluate(() => { const ch = [...document.querySelectorAll('#trip-bulk .trip-chip')]; return ch.length === 5 && ch[1].classList.contains('warn') && ch[1].querySelector('input').disabled && /겹침/.test(ch[1].textContent); }));
  await P.click('#trip-bulk button:has-text("전체 선택")'); await wait(200);
  check('전체 선택 → 겹치는 2번 빼고 4명, 1번은 12+9=21일 경고 표시, 단추 "4명 추가 (각 9일)"', await P.evaluate(() => document.querySelectorAll('#trip-bulk .trip-chip.on').length === 4 && /21일/.test(document.querySelectorAll('#trip-bulk .trip-chip')[0].textContent) && /4명 추가 \(각 9일\)/.test(document.querySelector('#trip-bulk button.accent').textContent) && document.querySelectorAll('#trip-grid tr.bsel').length === 4));
  await P.fill('#trip-b-detail', '수능 후 가족 여행');
  await P.click('#trip-bulk button.accent'); await wait(500);
  check('한 번에 4건 저장(요청 1번), 서버 6건, 각자 기록(사유 같음)', tripRecords.size === 6 && writes.filter(w => w[0] === 'trip_records' && w[1] === 'upsert').some(w => w[2] === 4) && [...tripRecords.values()].filter(r => r.detail === '수능 후 가족 여행').length === 4, writes);
  check('👥 칸 닫힘, 1번 총일수 21 → 빨강(tot-over), 4번 9', await P.evaluate(() => document.getElementById('trip-bulk').style.display === 'none') && JSON.stringify(await tot(P, 1)) === '["21","tot-over"]' && (await tot(P, 4))[0] === '9', [await tot(P, 1), await tot(P, 4)]);
  check('합계 줄: 신청 5명 · 20일 이상 1명', /신청 5명 · 20일 이상 1명/.test(await P.innerText('#trip-grid tfoot')), await P.innerText('#trip-grid tfoot'));
  await P.locator('#absence-page').screenshot({ path: 'trip-board.png' });

  console.log('[6] 학년 공통 휴일');
  await P.fill('#trip-hol-date', '2026-12-10'); await P.fill('#trip-hol-name', '학년 체험학습일'); await P.click('#trip-foot button:has-text("더하기")'); await wait(400);
  check('서버 trip_holidays 1건, 12/10 칸이 휴, 1회 기간 12/1~11은 8일로 → 4번 총일수 8, 1번 20', tripHol.size === 1 && await P.evaluate(() => document.querySelector('#trip-grid thead tr:nth-child(2) th.hol[title="학년 체험학습일"]') !== null) && (await tot(P, 4))[0] === '8' && (await tot(P, 1))[0] === '20', [tripHol.size, await tot(P, 4), await tot(P, 1)]);
  check('✏️ 입력 탭 일수도 같은 휴일로(서버 기록 abDays)', await P.evaluate(() => abDays(abClassRecords().find(r => r.num === 4)) === 8));

  console.log('[7] 현황표 인쇄');
  const sheet = await P.evaluate(() => {
    const s = document.querySelector('#ab-paper .tps');
    return { per: [...s.querySelectorAll('th.per')].map(t => t.textContent), rounds: [...s.querySelectorAll('tbody tr')].map(tr => [...tr.querySelectorAll('td.rp')].map(td => td.textContent).join('|')), rd: [...s.querySelectorAll('tbody tr:nth-child(2) td.rd')].map(td => td.textContent + '@' + td.style.getPropertyValue('--tc')), tot: [...s.querySelectorAll('tbody td.tot')].map(td => td.textContent + (td.classList.contains('over') ? '!' : '')), hol: s.querySelectorAll('tbody tr:first-child td.d.hol').length, wk: s.querySelectorAll('thead tr:nth-child(2) th.wk').length, pst: s.querySelectorAll('thead tr:nth-child(2) th.pst').length, title: s.querySelector('.p-meta').textContent };
  });
  check('현황표 머리: 기간 3개(일수 포함), 3학년 1반', sheet.per.join('|') === '12/1~11 · 8일|12/18~30 · 8일|2/1~2 · 2일' && /3학년 1반/.test(sheet.title), sheet);
  check('회차 칸: 2번 = 12/1~3 | 12/7~9 | · , 일수 칸 가운데 숫자 + 회차 색', sheet.rounds[1] === '12/1~3|12/7~9|·' && sheet.rd[0] === '3@#DCE7F5' && sheet.rd[1] === '3@#D5EFE4', sheet);
  check('총일수: 1번 20(한도 19 넘어 빨강), 2번 6, 휴일 빗금 2칸(12/10·12/25), 주 구분선 3·기간 구분선 2', sheet.tot[0] === '20!' && sheet.tot[1] === '6' && sheet.hol === 2 && sheet.wk === 3 && sheet.pst === 2, sheet);
  await P.click('#ab-page-header button:has-text("출력")'); await wait(300);
  check('🖨️ 출력(띠 안 고름) → 인쇄 호출 + 가로 @page', await P.evaluate(() => window.__printed === 1 && /landscape/.test((document.getElementById('ab-page-style') || {}).textContent || '')));
  await P.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  await P.emulateMedia({ media: 'print' }); await wait(200);
  const pr = await P.evaluate(() => { const p = document.getElementById('ab-paper').getBoundingClientRect(); return { w: Math.round(p.width), h: Math.round(p.height), left: getComputedStyle(document.getElementById('ab-left')).display }; });
  check('인쇄 화면: 가로 A4 원래 크기(1123×794px), 입력 칸 숨김', Math.abs(pr.w - 1123) <= 2 && Math.abs(pr.h - 794) <= 2 && pr.left === 'none', pr);
  await P.emulateMedia({ media: 'screen' }); await wait(200);

  console.log('[8] 띠 → 신청서, 두 번 → 고치기, 사유 바꾸면 내 계정으로, 지우기');
  await P.click(gridRow(4) + ' td.bar'); await wait(300);
  check('띠 누르면 미리보기 = 그 학생 신청서(차카타, 8일간)', await cell('C6') === '차카타' && await cell('L7') === '(8 일간)' && /차카타/.test(await P.innerText('#ab-prev-label')), [await cell('C6'), await cell('L7')]);
  await P.dblclick(gridRow(4) + ' td.bar'); await wait(300);
  check('두 번 누르면 ✏️ 입력 탭에서 그 줄 고치기', await P.evaluate(() => document.getElementById('ab-pane-input').style.display === '' && !!document.querySelector('#ab-list tr.ab-editrow') && document.getElementById('ab-e-num').value === '4'));
  await P.selectOption('#ab-e-reason', '질병결석'); await P.dispatchEvent('#ab-e-reason', 'change');
  await P.press('#ab-e-detail', 'Enter'); await wait(400);
  check('사유를 질병결석으로 바꾸면 서버 표에서 빠지고 이 기기 내 계정 자료로', tripRecords.size === 5 && await P.evaluate(() => abClassRecords().filter(r => !r.srv && r.reason === '질병결석').length === 1 && [...Array(localStorage.length).keys()].some(i => localStorage.key(i).startsWith('ab-r-'))), [tripRecords.size]);
  await wait(1600);
  check('그 기록은 내 계정 자료(user_data_items ab-r-)로 올라감', [...items.keys()].filter(k => k.startsWith(T1 + '|ab-r-') && !k.includes('oldlocal')).length === 1, [...items.keys()]);
  const sid = await P.evaluate(() => abClassRecords().find(r => r.srv && r.num === 3).id);
  await P.evaluate((id) => { abDelete(id); }, sid); await wait(200);
  await P.click('#custom-confirm-overlay button:has-text("확인")').catch(() => {}); await wait(400);
  check('지우기 → 서버에서도 지움(4건)', tripRecords.size === 4 && !tripRecords.has(sid), tripRecords.size);

  console.log('[9] 📤 서버로 옮기기');
  await P.click('#ab-tabs [data-tab="trip"]'); await wait(300);
  await P.click('#trip-ctrl button:has-text("서버로 옮기기")'); await wait(200);
  await P.click('#custom-confirm-overlay button:has-text("확인")').catch(() => {}); await wait(500);
  check('옮김: 서버 5건(oldlocal1 포함, id 그대로), 내 계정 자료에서 빠짐, 단추 사라짐, 5번 기존 2 그대로(자동)', tripRecords.has('oldlocal1') && tripRecords.size === 5 && !(await P.evaluate(() => localStorage.getItem('ab-r-oldlocal1'))) && !/옮기기/.test(await P.innerText('#trip-ctrl')) && await P.evaluate(() => document.querySelector('#trip-grid tr[data-n="5"] td.c-pre').textContent) === '2', [tripRecords.size, await P.innerText('#trip-ctrl')]);

  console.log('[10] 부장(학년 전체 보기): 보기만 + 실시간');
  const head2 = await openDevice(browser, '부장', T2);
  const H = head2.page;
  await H.click('#rail-absence-btn'); await wait(700);
  check('부장은 담임 아니라 반 비어 있음 + 🗓 탭은 보임(쓰는 학년이 있어서)', await H.evaluate(() => document.getElementById('ab-grade').value === '' && document.querySelector('#ab-tabs [data-tab="trip"]').style.display !== 'none'));
  await H.selectOption('#ab-grade', '3'); await H.dispatchEvent('#ab-grade', 'change'); await wait(300);
  check('3학년 고르면 반 목록 맨 위에 "전체"', await H.evaluate(() => document.querySelectorAll('#ab-class option')[1].value === 'all' && document.querySelectorAll('#ab-class option')[1].textContent === '전체'));
  await H.selectOption('#ab-class', 'all'); await H.dispatchEvent('#ab-class', 'change'); await wait(800);
  const hv = await H.evaluate(() => ({ tab: document.getElementById('ab-pane-trip').style.display === '', cls: [...document.querySelectorAll('#trip-grid tr.cls th')].map(t => t.textContent), rows: document.querySelectorAll('#trip-grid tr[data-n]').length, ro: /보기만/.test(document.getElementById('trip-ctrl').textContent), bulk: [...document.querySelectorAll('#trip-ctrl button')].some(b => /여러 명/.test(b.textContent)), bars: document.querySelectorAll('#trip-grid td.bar').length, sums: [...document.querySelectorAll('#trip-grid tbody tr:not([data-n]):not(.cls)')].map(tr => tr.textContent.replace(/\s+/g, ' ').trim()), pages: document.querySelectorAll('#ab-paper-box .ab-paper.ab-land').length, label: document.getElementById('ab-prev-label').textContent, other: document.getElementById('ab-list').textContent }));
  check('전체 → 🗓 탭으로, 반 머리 3개(1·2·3반), 학생 5+3+2=10줄, "보기만", 👥 없음', hv.tab && hv.cls.join('|') === '3학년 1반|3학년 2반|3학년 3반' && hv.rows === 10 && hv.ro && !hv.bulk, hv);
  check('담임이 넣은 띠가 보임(1반: 1번·2번·5번 신청 3명), 반 합계 줄 3개', hv.bars > 0 && hv.sums.length === 3 && /신청 3명/.test(hv.sums[0]), hv.sums);
  check('미리보기 = 반마다 한 장(3장)', hv.pages === 3 && /3장/.test(hv.label), [hv.pages, hv.label]);
  check('다른 탭은 반을 고르라는 안내(전체는 현황판에서만)', /학년·반/.test(hv.other));
  await H.click('#trip-grid tr[data-c="1"][data-n="3"] td.day[data-d="2026-12-18"]'); await wait(200);
  check('빈 칸을 눌러도 입력 안 됨(보기만 안내)', /보기만/.test(await H.innerText('#trip-msg')) && await H.evaluate(() => !document.querySelector('#trip-grid td.pick') && !document.querySelector('#trip-grid .trip-pop')));
  check('기존 칸을 눌러도 상자 없음', (await H.click('#trip-grid tr[data-c="1"][data-n="1"] td.c-pre'), await wait(150), await H.evaluate(() => !document.querySelector('#trip-grid .trip-pop'))));
  await H.locator('#absence-page').screenshot({ path: 'trip-head.png' });
  // 실시간: 담임이 넣으면 부장 화면에 바로
  const before = await H.evaluate(() => document.querySelectorAll('#trip-grid td.bar').length);
  await P.click(gridRow(3) + ' td.day[data-d="2026-12-21"]'); await wait(100);
  await P.click(gridRow(3) + ' td.day[data-d="2026-12-22"]'); await wait(200);
  await P.click('#trip-add-ok'); await wait(1600);
  const after = await H.evaluate(() => document.querySelectorAll('#trip-grid td.bar').length);
  check('담임이 넣은 2칸이 부장 화면에 바로(실시간)', after === before + 2, [before, after]);
  // 부장이 반 하나를 고르면 그 반만(보기만)
  await H.selectOption('#ab-class', '2'); await H.dispatchEvent('#ab-class', 'change'); await wait(500);
  check('부장이 2반을 고르면 2반 3명만, 보기만', await H.evaluate(() => document.querySelectorAll('#trip-grid tr[data-n]').length === 3 && !document.querySelector('#trip-grid tr.cls') && /보기만/.test(document.getElementById('trip-ctrl').textContent)));

  console.log('[11] 쓰지 않는 학년(1학년 담임)');
  const other = await openDevice(browser, '1학년', T3);
  const O = other.page;
  await O.click('#rail-absence-btn'); await wait(700);
  check('1학년 담임: 🗓 탭 없음, 예전 안내 그대로', await O.evaluate(() => document.querySelector('#ab-tabs [data-tab="trip"]').style.display === 'none' && document.getElementById('ab-private-note').style.display !== 'none'));
  await O.selectOption('#ab-n-num', '1');
  await O.selectOption('#ab-n-reason', '교외체험학습'); await O.dispatchEvent('#ab-n-reason', 'change');
  await O.fill('#ab-n-from', '2026-12-01'); await O.dispatchEvent('#ab-n-from', 'change');
  await O.press('#ab-n-detail', 'Enter'); await wait(1500);
  check('1학년 교외체험학습은 예전처럼 내 계정 자료에만(서버 trip_records엔 1학년 없음)', [...items.keys()].some(k => k.startsWith(T3 + '|ab-r-')) && ![...tripRecords.values()].some(r => r.grade === 1), [...items.keys()]);

  const errs = [...pc.errors, ...head2.errors, ...other.errors];
  check('페이지 오류 없음', errs.length === 0, errs);
  console.log(failures ? ('실패 ' + failures + '건') : '모든 검사 통과');
  await browser.close();
  process.exit(failures ? 1 : 0);
})();
