// 수업변경 담당(계정 관리 체크): 실무사처럼 본인 시간표가 없어도 홈 둘째 줄 버튼으로 아무 선생님 수업을
// 교환·보강 등록하고, 이번 주 전체 내역을 보는지 확인한다. 일반 교사는 예전 그대로. 가짜 서버는 staff-test.js와 같다.
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
    if (op === 'insert') { const r = Array.isArray(rows) ? rows : [rows]; r.forEach(x => changes.push(Object.assign({ id: changes.length + 1, created_by: teachers[pageInfo.uid].name }, x))); return { data: null, error: null }; }
    if (op === 'select') return { data: changes.slice(), error: null };
    return { data: null, error: null };
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
  const M = '55555555-5555-5555-5555-555555555555';
  const d = await openDevice(browser, '수업계PC', M);
  const P = d.page;
  await P.setViewportSize({ width: 2000, height: 1030 }); await wait(1500);
  check('실무사 홈은 그대로 + 둘째 줄에 수업변경 버튼', await P.evaluate(() => document.getElementById('main-dashboard').classList.contains('staff-mode') && getComputedStyle(document.getElementById('btn-scc-manager')).display !== 'none'));
  await P.click('#btn-scc-manager'); await wait(300);
  const m = await P.evaluate(() => ({
    open: getComputedStyle(document.getElementById('schedule-change-overlay')).display === 'flex',
    aRow: getComputedStyle(document.getElementById('scc-teacher-a-row')).display,
    aOpts: document.getElementById('scc-teacher-a').options.length,
    label: document.getElementById('scc-my-period-label').innerText,
    title: document.getElementById('scc-list-title').innerText,
  }));
  check('담당 창: 선생님 고르는 줄, "교시", "전체 변경 내역"', m.open && m.aRow === 'flex' && m.aOpts === 9 && m.label === '교시' && m.title.includes('전체'), m);
  await P.selectOption('#scc-teacher-a', '김교사'); await wait(100);
  check('상대방 목록에서 고른 선생님은 빠짐', await P.evaluate(() => ![...document.getElementById('scc-partner').options].some(o => o.value === '김교사')));
  await P.selectOption('#scc-partner', '박교사'); await wait(100);
  await P.selectOption('#scc-partner-period', '2'); await wait(100);
  const pv = await P.evaluate(() => document.getElementById('scc-preview').innerText);
  check('미리보기가 "김교사쌤 …"로', pv.includes('김교사쌤') && !pv.includes('나('), pv);
  await P.click('#schedule-change-overlay button[onclick="sccSave()"]'); await wait(500);
  await P.click('#custom-alert-ok-btn'); await wait(300);
  check('등록된 기록의 주인이 김교사/박교사', changes.length === 1 && changes[0].teacher_a === '김교사' && changes[0].teacher_b === '박교사', changes);
  changes.push({ id: 2, change_date: changes[0].change_date, type: 'makeup', teacher_a: '이교사', period_a: 2, teacher_b: '정교사', period_b: 2, created_by: '이교사' });
  await P.evaluate(async () => { await fetchScheduleChanges(); sccRenderList(); });
  const list = await P.evaluate(() => document.getElementById('scc-list').innerText);
  check('다른 사람이 등록한 내역도 목록에 전부(이름 두 개씩)', list.includes('김교사') && list.includes('박교사') && list.includes('이교사') && list.includes('정교사') && (list.match(/삭제/g) || []).length === 2, list);
  // 학기 안의 다음 주 날짜도 등록되고, 학기 밖은 막힘
  const dr = await P.evaluate(() => {
    const r = sccDateRange();
    const next = new Date(); next.setDate(next.getDate() + 14); while (next.getDay() !== 3) next.setDate(next.getDate() + 1);
    const ymd = (x) => x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
    const far = new Date(); far.setDate(far.getDate() + 90);
    const sat = new Date(next); sat.setDate(sat.getDate() + 3);
    return { r, nextOk: sccDateProblem(ymd(next)) === '', farBad: sccDateProblem(ymd(far)) !== '', satBad: sccDateProblem(ymd(sat)) !== '', next: ymd(next), inputMax: document.getElementById('scc-date').max };
  });
  check('기간: 이번 주 월요일 ~ 학기 끝, 2주 뒤 수요일 가능 / 학기 뒤·토요일 불가', dr.nextOk && dr.farBad && dr.satBad && dr.inputMax === dr.r.max && dr.r.max > dr.next, dr);
  await P.fill('#scc-date', dr.next); await P.dispatchEvent('#scc-date', 'change'); await wait(100);
  await P.selectOption('#scc-partner', '이교사'); await wait(100);
  await P.selectOption('#scc-partner-period', '3'); await wait(100);
  await P.click('#schedule-change-overlay button[onclick="sccSave()"]'); await wait(500);
  await P.click('#custom-alert-ok-btn'); await wait(300);
  const nextSlot = await P.evaluate((d) => sccSlotText(d, 1), dr.next);
  check('2주 뒤 변경 등록됨 + 목록에 보임', changes.some(c => c.change_date === dr.next) && (await P.evaluate(() => document.getElementById('scc-list').innerText)).includes(nextSlot), [changes.map(c => c.change_date), nextSlot]);

  // ---- 서로 다른 날짜끼리 교환/보강 ----
  // 같은 날짜·같은 교시 교환도 등록됨(그 시간에 서로 반을 맞바꿔 들어감)
  await P.selectOption('#scc-partner-period', '1'); await wait(100);
  const pvSame = await P.evaluate(() => document.getElementById('scc-preview').innerText);
  check('같은 날짜·같은 교시 미리보기: 서로 반을 맞바꿈', /서로 반을 맞바꿔/.test(pvSame), pvSame);
  const n0 = changes.length;
  await P.click('#schedule-change-overlay button[onclick="sccSave()"]'); await wait(500);
  await P.click('#custom-alert-ok-btn'); await wait(300);
  check('같은 날짜·같은 교시 교환 저장됨', changes.length === n0 + 1 && changes[changes.length - 1].period_a === changes[changes.length - 1].period_b, changes[changes.length - 1]);
  const beforeN = changes.length;

  const wk = await P.evaluate(() => getCurrentWeekDates());
  // 상대방 날짜를 직접 바꾸면 내 날짜를 바꿔도 따라가지 않음
  await P.fill('#scc-date', wk[0]); await P.dispatchEvent('#scc-date', 'change'); await wait(100);
  check('상대방 날짜는 처음엔 내 날짜를 따라감', await P.evaluate(() => document.getElementById('scc-date-b').value) === wk[0]);
  await P.fill('#scc-date-b', wk[2]); await P.dispatchEvent('#scc-date-b', 'change'); await wait(100);
  await P.fill('#scc-date', wk[1]); await P.dispatchEvent('#scc-date', 'change'); await wait(100);
  check('직접 고친 상대방 날짜는 그대로', await P.evaluate(() => document.getElementById('scc-date-b').value) === wk[2]);
  await P.fill('#scc-date', wk[0]); await P.dispatchEvent('#scc-date', 'change'); await wait(100);
  await P.selectOption('#scc-teacher-a', '김교사'); await wait(100);
  await P.selectOption('#scc-my-period', '1'); await wait(100);
  await P.selectOption('#scc-partner', '박교사'); await wait(100);
  await P.selectOption('#scc-partner-period', '1'); await wait(100);
  const pv2 = await P.evaluate(() => document.getElementById('scc-preview').innerText);
  check('미리보기에 두 날짜가 모두(월 1교시 ↔ 수 1교시)', /\(월\) 1교시/.test(pv2) && /\(수\) 1교시/.test(pv2), pv2);
  await P.click('#schedule-change-overlay button[onclick="sccSave()"]'); await wait(500);
  await P.click('#custom-alert-ok-btn'); await wait(300);
  const ex = changes[changes.length - 1];
  check('다른 날짜 교환 저장: change_date=월, change_date_b=수', changes.length === beforeN + 1 && ex.type === 'exchange' && ex.change_date === wk[0] && ex.change_date_b === wk[2] && ex.period_a === 1 && ex.period_b === 1, ex);

  // 시간표에 반영: 김교사 월1(국어)은 비고 수1로, 박교사 수1(미술)은 비고 월1로
  const cell = (tn, period, d) => P.evaluate(([tn, period, d]) => {
    document.getElementById('search-select').value = tn; renderSearchTimetable(true);
    const e = document.getElementById('search-tt-' + period + '-' + d + '-s'); return e ? e.innerText.trim() : null;
  }, [tn, period, d]);
  await P.evaluate(() => { window.scheduleChangesRaw = window.scheduleChangesRaw.filter(c => c.change_date_b); });
  const k1 = await cell('김교사', 1, 1), k3 = await cell('김교사', 1, 3);
  const b3 = await cell('박교사', 1, 3), b1 = await cell('박교사', 1, 1);
  check('교환 반영: 김교사 월1 빔·수1 국어 / 박교사 수1 빔·월1 미술', k1 === '' && k3 === '국어' && b3 === '' && b1 === '미술', { k1, k3, b3, b1 });

  // 다른 날짜·교시 보강: 김교사 월1을 이교사가 목2에
  await P.evaluate(() => sccSetType('makeup')); await wait(100);
  check('보강 칸 이름', await P.evaluate(() => document.getElementById('scc-date-b-label').innerText + '/' + document.getElementById('scc-partner-period-label').innerText) === '보강 날짜/보강 교시');
  await P.selectOption('#scc-partner', '이교사'); await wait(100);
  await P.fill('#scc-date-b', wk[3]); await P.dispatchEvent('#scc-date-b', 'change'); await wait(100);
  await P.selectOption('#scc-partner-period', '2'); await wait(100);
  await P.click('#schedule-change-overlay button[onclick="sccSave()"]'); await wait(500);
  await P.click('#custom-alert-ok-btn'); await wait(300);
  const mk = changes[changes.length - 1];
  check('다른 날짜 보강 저장', mk.type === 'makeup' && mk.change_date === wk[0] && mk.change_date_b === wk[3] && mk.period_b === 2, mk);
  await P.evaluate(() => { window.scheduleChangesRaw = window.scheduleChangesRaw.filter(c => c.type === 'makeup' && c.change_date_b); });
  const l4 = await cell('이교사', 2, 4), k1b = await cell('김교사', 1, 1);
  check('보강 반영: 이교사 목2에 김교사 국어, 김교사 월1 빔', l4 === '국어' && k1b === '', { l4, k1b });
  await P.evaluate(async () => { await fetchScheduleChanges(); sccRenderList(); });
  const list2 = await P.evaluate(() => document.getElementById('scc-list').innerText);
  check('목록에 두 날짜 표시', list2.includes('(월) 1교시 ↔ 박교사') && /\(수\) 1교시/.test(list2) && /이교사쌤이 \d+\/\d+\(목\) 2교시에/.test(list2), list2);

  // 같은 시간 교환 반영: 김교사 월1 국어 ↔ 정교사 월1 과학 → 김교사 칸에 과학, 정교사 칸에 국어
  await P.evaluate((d) => { window.scheduleChangesRaw = [{ id: 98, change_date: d, change_date_b: d, type: 'exchange', teacher_a: '김교사', period_a: 1, teacher_b: '정교사', period_b: 1, created_by: 'x' }]; }, wk[0]);
  const sk = await cell('김교사', 1, 1), sj = await cell('정교사', 1, 1);
  check('같은 시간 교환 반영: 김교사 월1 과학 / 정교사 월1 국어', sk === '과학' && sj === '국어', { sk, sj });

  // 예전 기록(change_date_b 없음)은 예전처럼 같은 날로
  await P.evaluate((d) => { window.scheduleChangesRaw = [{ id: 99, change_date: d, type: 'exchange', teacher_a: '김교사', period_a: 1, teacher_b: '박교사', period_b: 4, created_by: 'x' }]; }, wk[0]);
  const o1 = await cell('김교사', 4, 1);
  check('예전 기록(날짜 하나)도 그대로: 김교사 월1 국어가 월4로', o1 === '국어', o1);
  await P.evaluate(async () => { await fetchScheduleChanges(); });
  // 역할 "교사" + 담당 + 본인 시간표 없음: 내 시간표 자리에서 선생님 골라 보기 + 수업변경 버튼 둘 다
  const g = await openDevice(browser, '수업계교사PC', '66666666-6666-6666-6666-666666666666');
  await wait(1000);
  const gs = await g.page.evaluate(() => { const w = document.getElementById('my-tt-widget'); const vis = (el) => getComputedStyle(el).display !== 'none'; return { browse: w.classList.contains('my-tt-browse'), sel: vis(document.getElementById('m-tt-teacher-select')), wBtn: vis(w.querySelector('.m-tt-change-btn')), qBtn: vis(document.getElementById('btn-scc-manager')) }; });
  check('교사 역할 담당: 선생님 골라 보기 + 시간표 칸·둘째 줄 수업변경 버튼', gs.browse && gs.sel && gs.wBtn && gs.qBtn, gs);
  // 일반 교사
  const t = await openDevice(browser, '김교사PC', T1);
  await wait(1000);
  const tb = await t.page.evaluate(() => getComputedStyle(document.getElementById('btn-scc-manager')).display);
  await t.page.click('#my-tt-widget .m-tt-change-btn'); await wait(300);
  const tm = await t.page.evaluate(() => ({ aRow: getComputedStyle(document.getElementById('scc-teacher-a-row')).display, label: document.getElementById('scc-my-period-label').innerText, list: document.getElementById('scc-list').innerText }));
  check('일반 교사: 둘째 줄 버튼 없음, 창은 예전 그대로(내 교시, 내 내역만)', tb === 'none' && tm.aRow === 'none' && tm.label === '내 교시' && tm.list.includes('박교사') && !tm.list.includes('정교사'), [tb, tm]);
  const allErrors = pages.flatMap(p => (p.errors || []).map(e => p.name + ': ' + e));
  check('전체 페이지 오류 없음', allErrors.length === 0, allErrors);
  console.log(failures === 0 ? '\n모든 검사 통과' : '\n실패 ' + failures + '건');
  await browser.close();
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
