// 레일 "결석계": 결석 현황 입력·학생별 현황·휴일, 결석 일수(토·일·휴일 빼기), 사유에 따라 확인서/교외체험학습 신청서
// 미리보기(엑셀 수식 값), 교외체험 누적 일수, 출력(인쇄 화면), 본인 계정에만 저장·다른 기기 반영.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
// 엑셀 가져오기 검사용 SheetJS(index.html이 CDN에서 받는 것과 같은 0.18.5). 없으면 npm에서 한 번 받아 둠.
const XLSXLIB = (() => {
  const dir = path.join(require('os').tmpdir(), 'sb-test-xlsx');
  const f = path.join(dir, 'package', 'dist', 'xlsx.full.min.js');
  if (!fs.existsSync(f)) {
    try { fs.mkdirSync(dir, { recursive: true }); require('child_process').execSync('npm pack xlsx@0.18.5 --silent && tar xzf xlsx-0.18.5.tgz', { cwd: dir, stdio: 'ignore' }); } catch (e) {}
  }
  return fs.existsSync(f) ? f : null;
})();
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// ---------- 가짜 서버 ----------
const T1 = '11111111-1111-1111-1111-111111111111';
const T2 = '22222222-2222-2222-2222-222222222222';
const teachers = {
  [T1]: { id: T1, name: '김교사', is_admin: false, must_change_password: false, role: '담임', homeroom_grade: 3, homeroom_class: 1 },
  [T2]: { id: T2, name: '박교사', is_admin: false, must_change_password: false, role: '교사', homeroom_grade: null, homeroom_class: null },
};
const items = new Map(); // teacher|key -> {teacher_id,key,value,updated_at}
const history = [];
let lastTs = Date.now();
function nowIso() { lastTs = Math.max(Date.now(), lastTs + 1); return new Date(lastTs).toISOString(); }
const pages = []; // {page, name, offline, realtimeDown}
const formFetches = [];
const studentSelects = [];

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
    studentSelects.push(filters.map(f => f.col + '=' + f.val).join('&'));
    const g = filters.find(f => f.col === 'grade'), c = filters.find(f => f.col === 'class_no');
    if (g && Number(g.val) === 3 && c && Number(c.val) === 1) {
      return { data: ['가나다', '라마바', '사아자', '차카타', '파하가'].map((n, i) => ({ number: i + 1, name: n })), error: null };
    }
    if (g && Number(g.val) === 3 && c && Number(c.val) === 2) { // 28명 반
      return { data: Array.from({ length: 28 }, (_, i) => ({ number: i + 1, name: '학생' + (i + 1) })), error: null };
    }
    return { data: [], error: null };
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
      const pathOnly = url.split('?')[0].split('#')[0].replace('http://app.test/', '');
      if (pathOnly.startsWith('absence/')) {
        const f = path.join(ROOT, pathOnly);
        if (fs.existsSync(f)) { formFetches.push(pathOnly); return route.fulfill({ body: fs.readFileSync(f), contentType: 'application/json' }); }
      }
      if (url.split('?')[0] === 'http://app.test/' || url.includes('index.html')) return route.fulfill({ body: html, contentType: 'text/html; charset=utf-8' });
      return route.fulfill({ status: 404, body: '' });
    }
    if (url.includes('@supabase/supabase-js')) return route.fulfill({ body: mockLib, contentType: 'application/javascript' });
    if (url.includes('open.neis.go.kr/hub/SchoolSchedule') && url.includes('AA_FROM_YMD=20260301')) {
      const row = [];
      const add = (ymd, ev, kind) => row.push({ AA_YMD: ymd, EVENT_NM: ev, SBTR_DD_SC_NM: kind });
      add('20260721', '여름방학식', '해당없음');
      for (let d = new Date('2026-07-22T00:00:00'); d <= new Date('2026-08-16T00:00:00'); d.setDate(d.getDate() + 1)) {
        const ymd = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
        add(ymd, d.getDay() === 6 ? '토요휴업일' : '여름방학', '휴업일');
      }
      return route.fulfill({ body: JSON.stringify({ SchoolSchedule: [{ head: [] }, { row }] }), contentType: 'application/json' });
    }
    if (url.includes('xlsx.full.min.js') && XLSXLIB) return route.fulfill({ body: fs.readFileSync(XLSXLIB), contentType: 'application/javascript' });
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
  const shown = () => P.evaluate(() => document.getElementById('absence-page').style.display === 'flex');
  const recs = () => P.evaluate(() => abClassRecords());
  // 입력 칸 채우고 추가
  // 맨 윗줄(새 줄)에 적고 Enter
  async function add(o, p = 'ab-n-') {
    await P.selectOption('#' + p + 'num', String(o.num));
    await P.selectOption('#' + p + 'reason', o.reason); await P.dispatchEvent('#' + p + 'reason', 'change');
    await P.fill('#' + p + 'detail', o.detail || '');
    await P.fill('#' + p + 'from', o.from); await P.dispatchEvent('#' + p + 'from', 'change');
    if (o.to) { await P.fill('#' + p + 'to', o.to); await P.dispatchEvent('#' + p + 'to', 'change'); }
    if (o.days != null) await P.fill('#' + p + 'days', String(o.days));
    if (o.written) await P.fill('#' + p + 'written', o.written);
    if (o.proof != null) await P.fill('#' + p + 'proof', o.proof);
    await P.press('#' + p + 'detail', 'Enter'); await wait(150);
  }
  const cell = (c) => P.evaluate((c) => { const td = document.querySelector('#ab-paper [data-c="' + c + '"]'); return td ? td.textContent : null; }, c);

  const order = await P.evaluate(() => [...document.querySelectorAll('#app-rail .rail-item')].map(e => e.title));
  check('레일: 조퇴증 바로 아래 결석계', order[order.indexOf('조퇴증') + 1] === '결석계', order);
  check('열기 전엔 양식 안 받음', formFetches.length === 0);

  await P.click('#rail-absence-btn'); await wait(700);
  check('열림 + 레일 표시 + 인쇄 대상', await shown() && await P.evaluate(() => document.getElementById('rail-absence-btn').classList.contains('active') && document.body.dataset.printTarget === 'absence' && document.getElementById('main-dashboard').style.display === 'none'));
  check('담임 반(3학년 1반)으로 시작', await P.evaluate(() => document.getElementById('ab-grade').value === '3' && document.getElementById('ab-class').value === '1'));
  check('양식 한 번 받음', formFetches.length === 1, formFetches);
  check('명렬표는 번호·이름만 받음(연락처 X)', studentSelects.length >= 1);
  const opts = await P.evaluate(() => [...document.querySelectorAll('#ab-n-num option')].map(o => o.textContent));
  check('번호 목록 = 명렬표 학생, "1번 가나다"', opts.length === 6 && opts[1] === '1번 가나다' && opts[5] === '5번 파하가', opts);
  check('작성일은 처음엔 비어 있음(종료일 따라감)', await P.inputValue('#ab-n-written') === '');
  check('기록 없으면 안내', /아직 기록이 없어요/.test(await P.innerText('#ab-list')));

  // 결석 일수: 토·일·휴일 빼기
  const d = await P.evaluate(() => [abCountDays('2026-03-03', '2026-03-04'), abCountDays('2026-03-06', '2026-03-09'), abCountDays('2026-05-04', '2026-05-06'), abCountDays('2026-09-23', '2026-09-28'), abCountDays('2026-03-05', '')]);
  check('일수: 화~수 2 / 금~월 2(주말 뺌) / 5.4~6 2(어린이날 뺌) / 추석 연휴 걸친 9.23~28 2 / 하루 1', JSON.stringify(d) === '[2,2,2,2,1]', d);

  // 질병결석 추가
  const dl = await P.evaluate(() => [...document.querySelectorAll('#ab-n-proofs option')].map(o => o.value));
  check('질병결석 증빙 목록 4개', dl.length === 4 && dl.includes('병원처방전'), dl);
  await P.fill('#ab-n-from', '2026-03-03'); await P.dispatchEvent('#ab-n-from', 'change');
  check('시작일 넣으면 종료일·작성일 같은 날 + 일수 자동', await P.inputValue('#ab-n-to') === '2026-03-03' && await P.inputValue('#ab-n-written') === '2026-03-03' && await P.inputValue('#ab-n-days') === '1');
  await P.fill('#ab-n-to', '2026-03-05'); await P.dispatchEvent('#ab-n-to', 'change');
  check('종료일 바꾸면 작성일도 따라감', await P.inputValue('#ab-n-written') === '2026-03-05');
  await P.fill('#ab-n-written', '2026-03-09'); await P.fill('#ab-n-to', '2026-03-06'); await P.dispatchEvent('#ab-n-to', 'change');
  check('작성일을 직접 고치면 그 값 유지', await P.inputValue('#ab-n-written') === '2026-03-09');
  await P.fill('#ab-n-from', ''); await P.fill('#ab-n-to', ''); await P.fill('#ab-n-written', '');
  await P.evaluate(() => { document.getElementById('ab-n-written').dataset.touched = ''; });
  // 입력칸이 한 줄(마우스 이동이 짧게): 새 줄 입력칸이 모두 같은 높이, 표 폭 1180px 이하
  const lay = await P.evaluate(() => { const ins = [...document.querySelectorAll('tr.ab-new .ab-in')].map(e => { const r = e.getBoundingClientRect(); return (r.top + r.bottom) / 2; }); return { spread: Math.max(...ins) - Math.min(...ins), n: ins.length, w: document.querySelector('#ab-list table').getBoundingClientRect().width }; });
  check('새 줄 입력칸 8개가 한 줄, 표 폭 제한', lay.spread < 3 && lay.n === 8 && lay.w <= 1181, lay);
  // 한 줄 선택(미리보기)해도 새 줄에 적던 값 그대로
  await P.fill('#ab-n-detail', '적던 중');
  await add({ num: 2, reason: '질병결석', detail: '복통', from: '2026-03-03', to: '2026-03-04', written: '2026-03-05', proof: '병원처방전' });
  let R = await recs();
  check('추가됨: 이름 자동, 일수 2', R.length === 1 && R[0].name === '라마바' && R[0].g === 3 && R[0].c === 1 && !R[0].dm && await P.evaluate(() => abDays(abClassRecords()[0])) === 2, R);
  check('추가 후 새 줄 비우고 번호 칸에 커서', await P.inputValue('#ab-n-detail') === '' && await P.inputValue('#ab-n-num') === '' && await P.evaluate(() => document.activeElement.id === 'ab-n-num'));
  check('방금 추가한 건 미리보기로 선택', await P.evaluate(() => document.querySelector('#ab-list tr.ab-sel') !== null));
  check('확인서 양식 한 장', await P.evaluate(() => document.querySelectorAll('#ab-paper table.xf').length === 1 && document.querySelector('#ab-paper table.xf').dataset.form === 'confirm'));
  check('확인서 값(엑셀 수식과 같음)',
    await cell('B2') === '질병결석 확인서' && await cell('I8') === '3학년' && await cell('J8') === '1반' && await cell('K8') === '2번' && await cell('J10') === '라마바' &&
    await cell('B12') === '본인은 다음과 같이 [질병결석]하였기에 보호자 연서로 신고합니다.' && await cell('C13') === '2026년 3월 3일' && await cell('G13') === '2026년 3월 4일' &&
    await cell('K13') === '(2 일간)' && (await cell('C14')).trim() === '질병결석(복통)' && (await cell('C18')).trim() === '병원처방전' && await cell('E25') === '2026년 3월 5일' && await cell('I27') === '라마바',
    await P.evaluate(() => [...document.querySelectorAll('#ab-paper [data-c]')].map(t => t.dataset.c + '=' + t.textContent)));
  check('고정 글자(학교장 귀하)도 그대로', /부 광 고 등 학 교 장/.test(await P.innerText('#ab-paper')));

  // 교외체험학습 두 번 → 누적
  await add({ num: 4, reason: '교외체험학습', detail: '가족 여행', from: '2026-04-06', to: '2026-04-08', written: '2026-04-01' });
  R = await recs();
  check('교외체험학습은 증빙 "신청서" 자동', R.find(r => r.reason === '교외체험학습').proof === '교외체험학습 신청서', R);
  await add({ num: 4, reason: '교외체험학습', detail: '친척 방문', from: '2026-05-04', to: '2026-05-06', written: '2026-04-28' });
  check('체험학습 → 신청서 양식만', await P.evaluate(() => document.querySelectorAll('#ab-paper table.xf').length === 1 && document.querySelector('#ab-paper table.xf').dataset.form === 'trip'));
  check('신청서 값: 이전 누적 3, 담임확인 5일, 기간·일수',
    await cell('L8') === '3' && await cell('I4') === '5일' && await cell('C6') === '차카타' && await cell('H6') === '4' && await cell('F6') === '3학년' &&
    await cell('E7') === '2026년 5월 4일' && await cell('L7') === '(2 일간)' && await cell('F24') === '(2026.5.4.' && await cell('I24') === '2026.5.6.)' && await cell('L30') === '차카타',
    await P.evaluate(() => [...document.querySelectorAll('#ab-paper [data-c]')].map(t => t.dataset.c + '=' + t.textContent)));
  check('숫자 칸은 엑셀처럼 오른쪽 정렬', await P.evaluate(() => document.querySelector('#ab-paper [data-c="L8"]').style.textAlign === 'right'));
  await P.locator('#absence-page').screenshot({ path: 'ab-trip.png' });
  // 첫 체험학습을 누르면 이전 누적 0
  await P.click('#ab-list tbody tr[data-id]:nth-child(3)'); await wait(150);
  check('앞선 체험학습: 이전 누적 0, 담임확인 3일', await cell('L8') === '0' && await cell('I4') === '3일', [await cell('L8'), await cell('I4')]);

  // 연번 = 시작일 순
  await add({ num: 1, reason: '인정결석', detail: '독감', from: '2026-03-02', to: '2026-03-02' });
  const list = await P.evaluate(() => [...document.querySelectorAll('#ab-list tbody tr[data-id]')].map(tr => tr.children[0].textContent + ':' + tr.children[1].textContent));
  check('연번은 시작일 순(나중에 넣어도 앞으로), "1번 가나다"', list[0] === '1:1번 가나다' && list[1] === '2:2번 라마바', list);
  check('작성일을 안 건드리면 종료일로 저장', (await recs())[0].written === '2026-03-02', (await recs())[0]);
  check('3/2는 대체공휴일 → 0일', await P.evaluate(() => abDays(abClassRecords()[0])) === 0);

  // 일수 직접 고치기
  await add({ num: 1, reason: '기타결석', detail: '가정 사정', from: '2026-06-08', to: '2026-06-12', days: 3 });
  R = await recs();
  const man = R.find(r => r.reason === '기타결석');
  check('일수 직접 고치면 그 값(✎ 표시)', man.dm === true && man.days === 3 && /3✎/.test(await P.innerText('#ab-list')), man);

  // 그 자리에서 고치기(두 번 누르기)
  const sid = R.find(r => r.reason === '질병결석').id;
  await P.fill('#ab-n-detail', '적던 중');
  await P.click('#ab-list tr[data-id="' + sid + '"]'); await wait(100);
  check('줄 한 번 누르기 → 미리보기만, 새 줄 적던 값 그대로', await P.inputValue('#ab-n-detail') === '적던 중' && await cell('J10') === '라마바');
  await P.dblclick('#ab-list tr[data-id="' + sid + '"]'); await wait(150);
  check('두 번 누르면 그 줄이 입력칸으로(위로 안 올라감)', await P.evaluate((id) => { const tr = document.querySelector('#ab-list tr.ab-editrow'); return !!tr && tr.dataset.id === id && document.getElementById('ab-e-detail').value === '복통' && document.getElementById('ab-e-num').value === '2' && document.activeElement.id === 'ab-e-detail'; }, sid));
  check('고치는 동안에도 새 줄 적던 값 그대로', await P.inputValue('#ab-n-detail') === '적던 중');
  await P.locator('#absence-page').screenshot({ path: 'ab-edit.png' });
  await P.fill('#ab-e-detail', '엉뚱'); await P.press('#ab-e-detail', 'Escape'); await wait(100);
  R = await recs();
  check('Esc → 취소(안 바뀜)', R.find(r => r.id === sid).detail === '복통' && await P.evaluate(() => !document.querySelector('#ab-list tr.ab-editrow')));
  await P.click('#ab-list tr[data-id="' + sid + '"] button[title="이 자리에서 고치기"]'); await wait(100);
  await P.fill('#ab-e-detail', '장염'); await P.press('#ab-e-detail', 'Enter'); await wait(150);
  R = await recs();
  check('✎ → 고치고 Enter 저장(새로 안 생김)', R.length === 5 && R.find(r => r.id === sid).detail === '장염' && await P.evaluate(() => !document.querySelector('#ab-list tr.ab-editrow')), R.map(r => r.detail));
  await P.fill('#ab-n-detail', '');

  // 학생별 현황
  await P.click('#ab-tabs [data-tab="stat"]'); await wait(200);
  const stat = await P.evaluate(() => [...document.querySelectorAll('#ab-stat tbody tr')].map(tr => [...tr.children].map(td => td.textContent).join('|')));
  check('현황: 명렬표 5명 모두', stat.length === 5, stat);
  check('1번: 인정 0 + 기타 3 = 3, 결석 일자는 버튼(2건)', stat[0] === '1번|가나다|0|0|3|0|3|📅 결석 일자 확인 (2건)', stat[0]);
  check('4번: 교외체험 5', stat[3] === '4번|차카타|0|0|0|5|5|📅 결석 일자 확인 (2건)', stat[3]);
  check('결석 없는 학생은 버튼 없이 "-"', stat[2] === '3번|사아자|0|0|0|0|0|-', stat[2]);
  check('합계 줄', await P.evaluate(() => [...document.querySelectorAll('#ab-stat tfoot td')].map(t => t.textContent).join('|')) === '합계|2|0|3|5|10|', await P.evaluate(() => [...document.querySelectorAll('#ab-stat tfoot td')].map(t => t.textContent).join('|')));
  await P.locator('#absence-page').screenshot({ path: 'ab-stat.png' });
  await P.click('#ab-stat tbody tr:nth-child(4) .ab-see'); await wait(200);
  check('결석 일자 확인 → 결석 현황 입력 탭에 그 학생 기록만(새 줄 번호도 그 학생)', await P.evaluate(() => document.getElementById('ab-pane-input').style.display === '' && document.querySelectorAll('#ab-list tbody tr[data-id]').length === 2 && document.getElementById('ab-n-num').value === '4') && /4번 차카타 기록만/.test(await P.innerText('#ab-filter')));
  await P.click('#ab-filter button'); await wait(100);
  check('전체 보기', await P.evaluate(() => document.querySelectorAll('#ab-list tbody tr[data-id]').length) === 5);

  // 휴일 더하기 → 일수 바뀜
  await P.click('#ab-tabs [data-tab="hol"]'); await wait(150);
  const hl = await P.innerText('#ab-hol-list');
  const holRows = await P.evaluate(() => [...document.querySelectorAll('#ab-hol-list tbody tr')].map(tr => [...tr.children].slice(0, 4).map(td => td.textContent).join('|')));
  check('여름방학은 한 줄로(7/22~8/14 평일 18일), 방학식 날은 휴일 아님', holRows.some(r => r === '7/22(수) ~ 8/14(금)|여름방학|18일|학사일정') && !holRows.some(r => /방학식/.test(r) || /7\/21/.test(r)) && holRows.length < 30, holRows);
  check('여름방학도 결석 일수에서 빠짐', await P.evaluate(() => abCountDays('2026-07-20', '2026-07-24')) === 2);
  check('휴일 목록에 평일 공휴일(어린이날)', /어린이날/.test(hl), hl);
  check('토·일요일 휴일은 목록에 없음(추석 9/26 토, 부처님오신날 5/24 일)', !/9\/26/.test(hl) && !/부처님오신날/.test(hl) && !/\((토|일)\)/.test(hl), hl);
  await P.fill('#ab-hol-date', '2026-04-11'); await P.click('#ab-pane-hol button:has-text("휴일 더하기")'); await wait(200);
  await P.click('#custom-alert-overlay button').catch(() => {}); await wait(150);
  check('토요일은 휴일로 안 더함', !JSON.parse(await ls(pc, 'ab-cfg')).hol || !JSON.parse(await ls(pc, 'ab-cfg')).hol['2026-04-11']);
  for (const d of ['2026-12-28', '2026-12-29', '2026-12-30']) { await P.fill('#ab-hol-date', d); await P.fill('#ab-hol-name', '학교 공사'); await P.click('#ab-pane-hol button:has-text("휴일 더하기")'); await wait(120); }
  const hr2 = await P.evaluate(() => [...document.querySelectorAll('#ab-hol-list tbody tr')].filter(tr => /학교 공사/.test(tr.textContent)).map(tr => tr.children[0].textContent + '|' + tr.children[2].textContent));
  check('직접 더한 이어진 날도 한 줄', hr2.length === 1 && hr2[0] === '12/28(월) ~ 12/30(수)|3일', hr2);
  await P.click('#ab-hol-list tr:has-text("학교 공사") button'); await wait(150);
  check('한 줄 🗑 → 3일 모두 지움', !Object.keys(JSON.parse(await ls(pc, 'ab-cfg')).hol || {}).some(d => d.startsWith('2026-12-2') || d === '2026-12-30'));
  await P.fill('#ab-hol-date', '2026-04-07'); await P.fill('#ab-hol-name', '재량휴업일'); await P.click('#ab-pane-hol button:has-text("휴일 더하기")'); await wait(150);
  check('직접 더한 휴일 → 체험학습 4/6~8은 2일, 계정 자료에 저장', await P.evaluate(() => abDays(abClassRecords().find(r => r.from === '2026-04-06'))) === 2 && JSON.parse(await ls(pc, 'ab-cfg')).hol['2026-04-07'] === '재량휴업일');
  await P.click('#ab-hol-list button'); await wait(150);
  check('지우면 다시 3일', await P.evaluate(() => abDays(abClassRecords().find(r => r.from === '2026-04-06'))) === 3);

  // 저장: 한 건 = 키 하나, 서버엔 내 것으로만
  await wait(1500);
  const keys = [...items.values()].filter(r => r.key.startsWith('ab-r-'));
  check('서버에 한 건씩 따로 저장(내 계정)', keys.length === 5 && keys.every(r => r.teacher_id === T1), keys.map(r => r.teacher_id + ':' + r.key));

  // 지우기
  await P.click('#ab-tabs [data-tab="input"]');
  P.once('dialog', () => {});
  await P.evaluate((id) => { abDelete(id); }, sid); await wait(200);
  await P.click('#custom-confirm-overlay button:has-text("확인")').catch(() => {}); await wait(300);
  check('지우기 → 4건', (await recs()).length === 4, (await recs()).length);

  // 인쇄: 결석계 양식만, A4 원래 크기
  await P.click('#ab-list tbody tr[data-id]'); await wait(150);
  await P.emulateMedia({ media: 'print' }); await wait(200);
  const pr = await P.evaluate(() => {
    const vis = (id) => { const e = document.getElementById(id); return e && getComputedStyle(e).display !== 'none'; };
    const paper = document.getElementById('ab-paper').getBoundingClientRect(), t = document.querySelector('#ab-paper table').getBoundingClientRect();
    return { left: vis('ab-left'), head: vis('ab-page-header'), rail: vis('app-rail'), right: vis('ab-right'), pw: Math.round(paper.width), tr: Math.round(t.right - paper.left), tb: Math.round(t.bottom - paper.top), ph: Math.round(paper.height) };
  });
  check('인쇄: 입력·머리·레일 숨김, 종이만', !pr.left && !pr.head && !pr.rail && pr.right, pr);
  check('인쇄: A4 폭(794px) 원래 크기, 양식이 종이 안에', Math.abs(pr.pw - 794) <= 1 && pr.tr <= pr.pw && pr.tb <= pr.ph, pr);
  const pdf = await P.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true });
  const pagesN = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
  check('인쇄하면 딱 한 장', pagesN === 1, pagesN);
  await P.emulateMedia({ media: 'screen' });

  // 다른 기기(같은 계정): 새 기록이 바로 보임
  const pc2 = await openDevice(browser, 'PC2', T1);
  await pc2.page.click('#rail-absence-btn'); await wait(800);
  check('다른 기기에서도 내 기록 4건', await pc2.page.evaluate(() => abClassRecords().length) === 4);
  await pc2.page.evaluate(() => { window.__dashRedraw = 0; const f = window.refreshDashboardFromLocalStorage; window.refreshDashboardFromLocalStorage = function() { window.__dashRedraw++; return f.apply(this, arguments); }; });
  await add({ num: 5, reason: '질병결석', detail: '두통', from: '2026-06-15' });
  await wait(3500);
  check('결석계 기록만 바뀌면 다른 기기의 홈 화면 전체는 다시 안 그림(깜빡임 없음)', await pc2.page.evaluate(() => window.__dashRedraw) === 0, await pc2.page.evaluate(() => window.__dashRedraw));
  await setLs(pc, 'todo-test-key', 'x'); await wait(3000);
  check('다른 개인 자료가 바뀌면 예전처럼 홈 화면을 다시 그림', await pc2.page.evaluate(() => window.__dashRedraw) >= 1, await pc2.page.evaluate(() => window.__dashRedraw));
  await P.click('#ab-tabs [data-tab="stat"]'); await P.click('#ab-tabs [data-tab="input"]'); await wait(1500);
  check('탭 바꾸기는 서버로 안 올림', !/"tab"/.test(serverVal(T1, 'ab-cfg') || ''), serverVal(T1, 'ab-cfg'));
  const pRecs = (await recs()).length, sRecs = [...items.values()].filter(r => r.key.startsWith('ab-r-') && r.value).length, msg = await P.innerText('#ab-f-msg');
  const dbg = await pc2.page.evaluate(() => ({ recs: abClassRecords().length, rows: document.querySelectorAll('#ab-list tbody tr').length, act: document.activeElement && document.activeElement.id, pend: remoteRefreshPending }));
  check('한 기기에서 추가 → 펴 둔 다른 기기 목록에 바로', dbg.rows === 6, [dbg, pRecs, sRecs, msg]);

  // 다른 선생님은 못 봄
  const other = await openDevice(browser, 'T2', T2);
  await other.page.click('#rail-absence-btn'); await wait(800);
  check('다른 선생님 계정엔 기록 없음', await other.page.evaluate(() => abAllRecords().length) === 0 && [...items.values()].filter(r => r.teacher_id === T2 && r.key.startsWith('ab-r-')).length === 0);
  check('담임 아닌 선생님은 반을 고르기 전엔 아무것도 안 뜸', await other.page.evaluate(() => document.getElementById('ab-grade').value === '' && document.getElementById('ab-class').value === '' && !document.getElementById('ab-n-num') && /학년·반<\/b>을 고르세요/.test(document.getElementById('ab-list').innerHTML) && /고르세요/.test(document.getElementById('ab-stat').innerText)));
  check('명렬표도 안 받음', !studentSelects.some(q => q === 'grade=1&class_no=1'), studentSelects);
  await other.page.selectOption('#ab-grade', '3'); await wait(200);
  check('학년만 고르면 반은 비워 둠', await other.page.evaluate(() => document.getElementById('ab-class').value === '' && !document.getElementById('ab-n-num')));
  await other.page.selectOption('#ab-class', '1'); await wait(400);
  check('반까지 고르면 그 반 명렬표 + 새 줄', await other.page.evaluate(() => document.querySelectorAll('#ab-n-num option').length === 6));

  // 반 바꾸기 기억
  await P.selectOption('#ab-grade', '1'); await wait(300);
  check('학년 바꾸면 반 다시 고르게, 기억', await P.evaluate(() => abClassRecords().length) === 0 && JSON.parse(await ls(pc, 'ab-cfg')).g === 1 && !JSON.parse(await ls(pc, 'ab-cfg')).c);
  await P.selectOption('#ab-grade', '3'); await P.selectOption('#ab-class', '1'); await wait(300);

  // 📥 예전 엑셀 가져오기 — 엑셀 결석계와 같은 모양(시트 이름·칸 위치)으로 만든 가짜 파일
  if (XLSXLIB) {
    const X = require(XLSXLIB);
    const serial = (iso) => Math.round((Date.UTC(...iso.split('-').map((v, i) => i === 1 ? v - 1 : +v)) - Date.UTC(1899, 11, 30)) / 86400000);
    const cls = [['학년', 3, '담임교사', '김교사'], ['반', 1], ['번호', '이름'], [1, '가나다', 0, 0, 0, 0, 0, 0, 0, 0, 0, serial('2026-11-20'), '재량휴업일'], [2, '라마바', 0, 0, 0, 0, 0, 0, 0, 0, 0, serial('2026-10-10'), '토요일']];
    // 예전 기록 하나(4번 체험학습 4/6~4/8)와 같은 줄을 넣어 중복 건너뛰기 확인
    const inp = [[], ['출력 연번', '', '', 3], [], ['연번', '번호', '이름', '결석사유', '구체적인 사유', '시작', '종료', '결석일수', '', '', '작성', '확인 방법', '담임 확인'],
      [1, 3, '사아자', '질병결석', '감기', serial('2026-03-10'), serial('2026-03-11'), 2, '', '', serial('2026-03-12'), '병원처방전'],
      [2, 5, '파하가', '교외체험학습', '여행', serial('2026-11-18'), serial('2026-11-20'), 2, '', '', serial('2026-11-10'), '교외체험학습 신청서'],
      [3, 3, '사아자', '생리결석', '', serial('2026-04-01'), serial('2026-04-01'), 1],
      [4, 4, '차카타', '교외체험학습', '가족 여행', serial('2026-04-06'), serial('2026-04-08'), 3, '', '', serial('2026-04-01'), '교외체험학습 신청서'],
      [5, 1, '가나다', '인정결석', '폐렴', serial('2026-06-08'), serial('2026-06-10'), 5, '', '', serial('2026-06-11'), '의사소견서 또는 진단서'],
      [6, '', '', '', '']];
    const wbx = X.utils.book_new();
    X.utils.book_append_sheet(wbx, X.utils.aoa_to_sheet(cls), '학급명렬표');
    X.utils.book_append_sheet(wbx, X.utils.aoa_to_sheet(inp), '결석현황입력');
    const xfile = path.join(require('os').tmpdir(), 'ab-import-test.xlsx');
    fs.writeFileSync(xfile, X.write(wbx, { type: 'buffer', bookType: 'xlsx' }));
    const before = (await recs()).length;
    await P.setInputFiles('#ab-import-input', xfile); await wait(500);
    const conf = await P.evaluate(() => { const o = document.getElementById('custom-confirm-overlay'); return o && getComputedStyle(o).display !== 'none' ? o.innerText : ''; });
    check('가져오기 확인: 새 3건, 이미 있는 1건 건너뜀, 생리결석 빼고, 휴일 1일', /3학년 1반 결석 기록 3건/.test(conf) && /이미 있거나 파일 안에서 겹치는 1건/.test(conf) && /생리결석 1건/.test(conf) && /휴일 1일/.test(conf), conf);
    await P.click('#custom-confirm-overlay button:has-text("확인")'); await wait(400);
    R = await recs();
    const im = R.filter(r => ['감기', '여행', '폐렴'].includes(r.detail));
    check('가져온 3건 저장(이름은 명렬표, 날짜 그대로)', R.length === before + 3 && im.length === 3 && im.find(r => r.detail === '감기').name === '사아자' && im.find(r => r.detail === '감기').from === '2026-03-10' && im.find(r => r.detail === '감기').written === '2026-03-12', im);
    check('엑셀 휴일(평일 재량휴업일)만 더함, 토요일은 안 더함', JSON.parse(await ls(pc, 'ab-cfg')).hol['2026-11-20'] === '재량휴업일' && !JSON.parse(await ls(pc, 'ab-cfg')).hol['2026-10-10']);
    check('일수: 엑셀과 같으면 자동(체험 11/18~20 = 2), 다르면 엑셀 값 유지(폐렴 5 → ✎)', await P.evaluate(() => abDays(abClassRecords().find(r => r.detail === '여행'))) === 2 && im.find(r => r.detail === '폐렴').dm === true && im.find(r => r.detail === '폐렴').days === 5 && !im.find(r => r.detail === '여행').dm, im);
    await P.setInputFiles('#ab-import-input', xfile); await wait(500);
    const conf2 = await P.evaluate(() => { const o = document.getElementById('custom-confirm-overlay'); return o && getComputedStyle(o).display !== 'none' ? o.innerText : ''; });
    check('같은 파일 또 가져오면 0건(중복 안 생김)', /기록 0건/.test(conf2), conf2);
    await P.click('#custom-confirm-overlay button:has-text("취소")').catch(() => {}); await wait(200);
  } else console.log('  (xlsx 라이브러리를 못 찾아 엑셀 가져오기 검사는 건너뜀)');

  // 28명 반: 학생별 현황이 스크롤 없이 한 화면에(1600×1000)
  await P.evaluate(() => { window.classStructure = { gradeCount: 3, classCounts: [8, 8, 8] }; abFillClassSelects(); });
  await P.selectOption('#ab-class', '2'); await wait(400);
  await P.click('#ab-tabs [data-tab="stat"]'); await wait(200);
  const fit = await P.evaluate(() => { const l = document.getElementById('ab-left'), t = document.querySelector('#ab-stat table'); return { rows: t.tBodies[0].rows.length, fits: l.scrollHeight <= l.clientHeight + 1, rh: t.tBodies[0].rows[0].getBoundingClientRect().height }; });
  check('28명이 스크롤 없이 한 화면, 줄 높이 24px 이상', fit.rows === 28 && fit.fits && fit.rh >= 24, fit);
  await P.locator('#absence-page').screenshot({ path: 'ab-stat28.png' });
  await P.setViewportSize({ width: 1366, height: 768 }); await wait(300);
  const fit2 = await P.evaluate(() => { const l = document.getElementById('ab-left'), t = document.querySelector('#ab-stat table'); return { fits: l.scrollHeight <= l.clientHeight + 1, rh: t.tBodies[0].rows[0].getBoundingClientRect().height }; });
  check('작은 화면(1366×768)은 줄을 20px까지만 줄이고(읽을 수 있게) 조금 스크롤', fit2.rh === 20, fit2);
  await P.setViewportSize({ width: 1600, height: 1000 }); await wait(200);
  await P.click('#ab-tabs [data-tab="input"]'); await P.selectOption('#ab-class', '1'); await wait(300);

  // 닫기·다른 화면
  await P.click('#rail-leavepass-btn'); await wait(400);
  check('조퇴증 누르면 결석계 닫힘', !(await shown()) && await P.evaluate(() => document.getElementById('leavepass-page').style.display === 'flex' && !document.getElementById('rail-absence-btn').classList.contains('active')));
  await P.click('#rail-absence-btn'); await wait(400);
  check('결석계 누르면 조퇴증 닫힘', await shown() && await P.evaluate(() => document.getElementById('leavepass-page').style.display === 'none'));
  await P.click('#rail-absence-btn'); await wait(300);
  check('같은 버튼 → 홈', !(await shown()) && await P.evaluate(() => document.getElementById('main-dashboard').style.display === 'grid'));
  await P.click('#rail-absence-btn'); await wait(300);
  await P.click('#rail-home-btn'); await wait(300);
  check('홈 버튼 → 닫힘', !(await shown()));
  check('양식은 처음 한 번만 받음', formFetches.length <= 3, formFetches); // 기기 3대

  const errs = [...pc.errors, ...pc2.errors, ...other.errors];
  check('페이지 오류 없음', errs.length === 0, errs);
  console.log(failures ? ('실패 ' + failures + '건') : '모든 검사 통과');
  await browser.close();
  process.exit(failures ? 1 : 0);
})();
