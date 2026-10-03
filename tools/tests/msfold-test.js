// 가짜 Supabase 서버(Node 메모리) 하나에 PC/휴대폰 브라우저 두 개를 붙여서
// index.html의 실제 동기화 코드를 시나리오별로 돌려 본다.
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
  await P.click('#rail-monthly-btn'); await wait(800);

  const state = () => P.evaluate(() => {
    const heads = [...document.querySelectorAll('#ms-table-body tr.ms-month-head')].map(h => h.innerText.replace(/\s+/g, ' ').trim());
    const rows = msDataRows().map(tr => ({ d: tr.children[0].innerText.trim(), c: tr.children[1].innerText.trim(), m: tr.dataset.month, hidden: tr.offsetParent === null }));
    return { heads, rows, expandAll: document.getElementById('ms-expand-all').checked };
  });

  let s = await state();
  check('처음엔 항상 펼치기 꺼짐', s.expandAll === false, s);
  check('빈 줄 15개는 "새 일정 입력" 묶음에 펼쳐져 있음', s.rows.length === 15 && s.rows.every(r => !r.hidden) && s.heads.length === 1 && /새 일정 입력/.test(s.heads[0]), s);

  // 여러 달 일정 붙여넣기 (엑셀에서 복사한 것처럼)
  await P.click('#ms-table-body tr:not(.ms-example-row):not(.ms-month-head) td:first-child .ms-cell-input');
  await P.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/plain', '3/2\t입학식\n5/5\t어린이날\n3/15\t학부모총회\n1/7\t겨울방학 보충\n5/20\t체육대회');
    document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await wait(400);
  s = await state();
  check('달 머리줄이 학기 순서(3월→5월→1월) + 새 일정 입력', s.heads.length === 4 && /^▶ 3월 2건/.test(s.heads[0]) && /^▶ 5월 2건/.test(s.heads[1]) && /^▶ 1월 1건/.test(s.heads[2]) && /새 일정 입력/.test(s.heads[3]), s.heads);
  check('항상 펼치기 꺼짐 → 달 일정은 접혀 있음', s.rows.filter(r => r.c).every(r => r.hidden), s.rows);
  check('빈 줄은 계속 보임', s.rows.filter(r => !r.c).every(r => !r.hidden) && s.rows.filter(r => !r.c).length === 10, s.rows);
  check('달력 데이터는 그대로(3월 2일 입학식)', await P.evaluate(() => { msCurMonth = 3; const d = msGetUserData(); return !!(d[msCurYear + '-3-2'] && d[msCurYear + '-3-2'][0].text === '입학식'); }));
  // 🐞 접힌 달(display:none) 줄은 innerText가 줄바꿈을 버려서 달력에 "수능대비분반수업 신청"처럼 붙어 나오다가, 그 달을 펼치면 다시 맞게 나왔다
  const brk = await P.evaluate(() => {
    const tr = msDataRows().find(r => r.dataset.month === '5' && /어린이날/.test(r.textContent));
    const cell = tr.children[1].querySelector('.ms-cell-input');
    cell.innerHTML = '수능대비<br>분반수업 신청';
    const tr2 = msDataRows().find(r => r.dataset.month === '5' && /체육대회/.test(r.textContent));
    tr2.children[1].querySelector('.ms-cell-input').innerHTML = '체육<div>대회</div><div><br></div><div>우천 시 연기</div>';
    msCurMonth = 5; const d = msGetUserData();
    return { hidden: tr.offsetParent === null, a: d[msCurYear + '-5-5'][0].text, b: d[msCurYear + '-5-20'][0].text };
  });
  check('접힌 달의 일정도 줄바꿈 그대로 달력에(<br>·한 줄씩 div)', brk.hidden && brk.a === '수능대비\n분반수업 신청' && brk.b === '체육\n대회\n\n우천 시 연기', brk);
  await P.evaluate(() => { msRenderCalendar(); });
  await wait(300);
  const calTxt = await P.evaluate(() => [...document.querySelectorAll('#ms-cal-grid .ms-event-item')].map(e => e.innerText).filter(t => /수능대비/.test(t))[0] || '');
  check('달력 칸에 두 줄로 그려짐', calTxt.split('\n').length === 2, calTxt);
  await P.evaluate(() => {
    msDataRows().find(r => /수능대비/.test(r.textContent)).children[1].querySelector('.ms-cell-input').innerHTML = '어린이날';
    msDataRows().find(r => /우천/.test(r.textContent)).children[1].querySelector('.ms-cell-input').innerHTML = '체육대회';
  });

  // 머리줄 눌러 한 달만 펼치기
  await P.click('#ms-table-body tr.ms-month-head[data-month="5"]'); await wait(200);
  s = await state();
  check('5월만 펼쳐짐', s.rows.filter(r => r.m === '5').every(r => !r.hidden) && s.rows.filter(r => r.m === '3').every(r => r.hidden) && /^▼ 5월/.test(s.heads[1]), s);
  await P.click('#ms-table-body tr.ms-month-head[data-month="5"]'); await wait(200);
  s = await state();
  check('다시 누르면 접힘', s.rows.filter(r => r.m === '5').every(r => r.hidden), s);

  // 새 줄에 날짜를 적고 줄을 벗어나면 그 달로 옮겨지고 펼쳐짐
  await P.evaluate(() => { const tr = msDataRows().find(r => !r.children[0].innerText.trim()); tr.id = 'newrow'; });
  await P.click('#newrow td:first-child .ms-cell-input');
  await P.keyboard.type('3/10');
  await P.click('#newrow td:nth-child(2) .ms-cell-input'); await wait(200);
  check('같은 줄 내용 칸으로 넘어갈 땐 안 옮겨짐(입력 계속)', await P.evaluate(() => document.activeElement === document.querySelector('#newrow td:nth-child(2) .ms-cell-input') && document.getElementById('newrow').dataset.month === '0'));
  await P.keyboard.type('진단평가');
  await P.click('#ms-cfg-title'); await wait(300);
  s = await state();
  check('줄을 벗어나면 3월 묶음으로 옮겨지고 3월이 펼쳐짐', /^▼ 3월 3건/.test(s.heads[0]) && s.rows.filter(r => r.m === '3').every(r => !r.hidden) && s.rows.filter(r => r.m === '5').every(r => r.hidden), s);
  const saved = JSON.parse(await ls(pc, 'ms-data'));
  check('저장 데이터에 머리줄이 섞이지 않음', saved.table.length === 15 && saved.table.some(r => r.d === '3/10' && r.c === '진단평가'), saved.table);

  // 항상 펼치기 켜기 → 전부 펼침, 기억
  await P.click('#ms-expand-all'); await wait(300);
  s = await state();
  check('항상 펼치기 켜면 모든 달 펼침', s.rows.every(r => !r.hidden) && s.heads.slice(0, 3).every(h => h.startsWith('▼')), s);
  check('설정 기억(localStorage)', await ls(pc, 'ms-expand-all') === '1');
  await wait(1500);
  check('서버(계정)에 저장됨', serverVal(T1, 'ms-expand-all') === '1', serverVal(T1, 'ms-expand-all'));

  // 날짜순 정렬 후에도 묶음 유지
  await P.click('#ms-schedule-table th'); await wait(300);
  s = await state();
  check('정렬 후에도 달별 묶음 유지', s.heads.length === 4 && s.rows.filter(r => r.m === '3').map(r => r.d).join(',') === '3/2,3/10,3/15', s);

  // 5칸 추가 후 패널 맨 아래에서 🗑️를 연달아 눌러도 스크롤이 위로 끌려가지 않음
  await P.setViewportSize({ width: 1400, height: 700 }); await wait(300);
  await P.evaluate(() => { const p = document.getElementById('ms-panel'); p.scrollTop = document.getElementById('ms-section-table').offsetTop - 10; });
  await wait(200);
  { const b = await P.locator('text=+ 5칸 추가').boundingBox(); await P.mouse.click(b.x + b.width / 2, b.y + b.height / 2); await wait(300); }
  await P.evaluate(() => { const p = document.getElementById('ms-panel'); p.scrollTop = p.scrollHeight; }); await wait(200);
  const lastBtn = P.locator('#ms-table-body .ms-del-row-btn').last();
  const box = await lastBtn.boundingBox();
  const top0 = await P.evaluate(() => document.getElementById('ms-panel').scrollTop);
  const rows0 = (await state()).rows.length;
  const x = box.x + box.width / 2, y = box.y - box.height * 3;   // 끝에서 몇 번째 줄 🗑️
  for (let i = 0; i < 3; i++) { await P.mouse.click(x, y); await wait(250); }
  const top1 = await P.evaluate(() => document.getElementById('ms-panel').scrollTop);
  check('맨 아래에서 3줄 지워도 스크롤 그대로', top1 === top0 && (await state()).rows.length === rows0 - 3, { top0, top1 });
  await P.evaluate(() => { document.getElementById('ms-panel').scrollTop = 0; }); await wait(300);
  check('위로 스크롤하면 채워 둔 빈 칸은 사라짐', await P.evaluate(() => document.getElementById('ms-panel-spacer').style.height === ''));

  // 같은 계정 다른 기기: 켜진 채로 복원, 일정도 달별로 묶임
  const pc2 = await openDevice(browser, 'PC2', T1);
  const Q = pc2.page;
  await Q.click('#rail-monthly-btn'); await wait(800);
  const s2 = await Q.evaluate(() => ({ expandAll: document.getElementById('ms-expand-all').checked, heads: [...document.querySelectorAll('#ms-table-body tr.ms-month-head')].map(h => h.innerText.replace(/\s+/g, ' ').trim()), hidden: msDataRows().filter(tr => tr.offsetParent === null).length }));
  check('다른 기기: 항상 펼치기 켜진 채로, 전부 펼쳐져 있음', s2.expandAll && s2.hidden === 0 && s2.heads.length === 4, s2);

  // 끄면 다시 접히고, 끈 것도 기억
  await Q.click('#ms-expand-all'); await wait(300);
  check('끄면 모두 접힘', await Q.evaluate(() => msDataRows().filter(tr => tr.dataset.month !== '0').every(tr => tr.offsetParent === null)));
  check('끈 설정도 기억', await ls(pc2, 'ms-expand-all') === '0');
  await Q.reload(); await Q.waitForFunction(() => window.currentTeacher && syncAppStarted === true);
  await Q.click('#rail-monthly-btn'); await wait(800);
  check('새로고침 후에도 꺼진 채 + 접힘', await Q.evaluate(() => !document.getElementById('ms-expand-all').checked && msDataRows().filter(tr => tr.dataset.month !== '0').every(tr => tr.offsetParent === null)));
  await Q.locator('#ms-panel').screenshot({ path: 'msfold-panel.png' });

  const errs = [...pc.errors, ...pc2.errors];
  check('페이지 오류 없음', errs.length === 0, errs);
  console.log(failures ? ('실패 ' + failures + '건') : '모든 검사 통과');
  await browser.close();
  process.exit(failures ? 1 : 0);
})();
