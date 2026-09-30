// 레일 "결석계": 결석 현황 입력·학생별 현황·휴일, 결석 일수(토·일·휴일 빼기), 사유에 따라 확인서/교외체험학습 신청서
// 미리보기(엑셀 수식 값), 교외체험 누적 일수, 출력(인쇄 화면), 본인 계정에만 저장·다른 기기 반영.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
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
  async function add(o) {
    await P.selectOption('#ab-f-num', String(o.num));
    await P.selectOption('#ab-f-reason', o.reason);
    await P.fill('#ab-f-detail', o.detail || '');
    await P.fill('#ab-f-from', o.from); await P.dispatchEvent('#ab-f-from', 'change');
    if (o.to) { await P.fill('#ab-f-to', o.to); await P.dispatchEvent('#ab-f-to', 'change'); }
    if (o.days != null) await P.fill('#ab-f-days', String(o.days));
    if (o.written) await P.fill('#ab-f-written', o.written);
    if (o.proof != null) await P.fill('#ab-f-proof', o.proof);
    await P.click('#ab-f-save'); await wait(150);
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
  const opts = await P.evaluate(() => [...document.querySelectorAll('#ab-f-num option')].map(o => o.textContent));
  check('번호 목록 = 명렬표 학생', opts.length === 6 && opts[1] === '1 가나다' && opts[5] === '5 파하가', opts);
  check('작성일 기본 = 오늘', await P.inputValue('#ab-f-written') === await P.evaluate(() => abToday()));
  check('기록 없으면 안내', /아직 기록이 없어요/.test(await P.innerText('#ab-list')));

  // 결석 일수: 토·일·휴일 빼기
  const d = await P.evaluate(() => [abCountDays('2026-03-03', '2026-03-04'), abCountDays('2026-03-06', '2026-03-09'), abCountDays('2026-05-04', '2026-05-06'), abCountDays('2026-09-23', '2026-09-28'), abCountDays('2026-03-05', '')]);
  check('일수: 화~수 2 / 금~월 2(주말 뺌) / 5.4~6 2(어린이날 뺌) / 추석 연휴 걸친 9.23~28 2 / 하루 1', JSON.stringify(d) === '[2,2,2,2,1]', d);

  // 질병결석 추가
  await P.selectOption('#ab-f-reason', '질병결석');
  const dl = await P.evaluate(() => [...document.querySelectorAll('#ab-proof-list option')].map(o => o.value));
  check('질병결석 증빙 목록 4개', dl.length === 4 && dl.includes('병원처방전'), dl);
  await P.fill('#ab-f-from', '2026-03-03'); await P.dispatchEvent('#ab-f-from', 'change');
  check('시작일 넣으면 종료일 같은 날 + 일수 자동', await P.inputValue('#ab-f-to') === '2026-03-03' && await P.inputValue('#ab-f-days') === '1');
  await add({ num: 2, reason: '질병결석', detail: '복통', from: '2026-03-03', to: '2026-03-04', written: '2026-03-05', proof: '병원처방전' });
  let R = await recs();
  check('추가됨: 이름 자동, 일수 2', R.length === 1 && R[0].name === '라마바' && R[0].g === 3 && R[0].c === 1 && !R[0].dm && await P.evaluate(() => abDays(abClassRecords()[0])) === 2, R);
  check('추가 후 입력 칸 비움', await P.inputValue('#ab-f-detail') === '' && await P.inputValue('#ab-f-num') === '');
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
  await P.click('#ab-list tbody tr:nth-child(2)'); await wait(150);
  check('앞선 체험학습: 이전 누적 0, 담임확인 3일', await cell('L8') === '0' && await cell('I4') === '3일', [await cell('L8'), await cell('I4')]);

  // 연번 = 시작일 순
  await add({ num: 1, reason: '인정결석', detail: '독감', from: '2026-03-02', to: '2026-03-02' });
  const list = await P.evaluate(() => [...document.querySelectorAll('#ab-list tbody tr')].map(tr => tr.children[0].textContent + ':' + tr.children[2].textContent));
  check('연번은 시작일 순(나중에 넣어도 앞으로)', list[0] === '1:가나다' && list[1] === '2:라마바', list);
  check('3/2는 대체공휴일 → 0일', await P.evaluate(() => abDays(abClassRecords()[0])) === 0);

  // 일수 직접 고치기
  await add({ num: 1, reason: '기타결석', detail: '가정 사정', from: '2026-06-08', to: '2026-06-12', days: 3 });
  R = await recs();
  const man = R.find(r => r.reason === '기타결석');
  check('일수 직접 고치면 그 값(✎ 표시)', man.dm === true && man.days === 3 && /3✎/.test(await P.innerText('#ab-list')), man);

  // 고치기
  const sid = R.find(r => r.reason === '질병결석').id;
  await P.evaluate((id) => abEdit(id), sid); await wait(100);
  check('고치기 → 칸에 값, 버튼 "수정 저장"', await P.inputValue('#ab-f-detail') === '복통' && /수정 저장/.test(await P.innerText('#ab-f-save')) && await P.inputValue('#ab-f-num') === '2');
  await P.fill('#ab-f-detail', '장염'); await P.click('#ab-f-save'); await wait(150);
  R = await recs();
  check('고친 내용 저장(새로 안 생김)', R.length === 5 && R.find(r => r.id === sid).detail === '장염', R.map(r => r.detail));

  // 학생별 현황
  await P.click('#ab-tabs [data-tab="stat"]'); await wait(200);
  const stat = await P.evaluate(() => [...document.querySelectorAll('#ab-stat tbody tr')].map(tr => [...tr.children].map(td => td.textContent).join('|')));
  check('현황: 명렬표 5명 모두', stat.length === 5, stat);
  check('1번: 인정 0 + 기타 3 = 3, 결석 일자', stat[0] === '1|가나다|0|0|3|0|3|3/2, 6/8~6/12', stat[0]);
  check('4번: 교외체험 5', stat[3] === '4|차카타|0|0|0|5|5|4/6~4/8, 5/4~5/6', stat[3]);
  check('합계 줄', await P.evaluate(() => [...document.querySelectorAll('#ab-stat tfoot td')].map(t => t.textContent).join('|')) === '합계|2|0|3|5|10|', await P.evaluate(() => [...document.querySelectorAll('#ab-stat tfoot td')].map(t => t.textContent).join('|')));
  await P.locator('#absence-page').screenshot({ path: 'ab-stat.png' });
  await P.click('#ab-stat tbody tr:nth-child(4)'); await wait(200);
  check('학생 줄 누르면 그 학생 기록만', await P.evaluate(() => document.getElementById('ab-pane-input').style.display === '' && document.querySelectorAll('#ab-list tbody tr').length === 2) && /4번 차카타 기록만/.test(await P.innerText('#ab-filter')));
  await P.click('#ab-filter button'); await wait(100);
  check('전체 보기', await P.evaluate(() => document.querySelectorAll('#ab-list tbody tr').length) === 5);

  // 휴일 더하기 → 일수 바뀜
  await P.click('#ab-tabs [data-tab="hol"]'); await wait(150);
  check('휴일 목록에 기본 공휴일', /어린이날/.test(await P.innerText('#ab-hol-list')));
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
  await P.click('#ab-list tbody tr:nth-child(1)'); await wait(150);
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
  await add({ num: 5, reason: '질병결석', detail: '두통', from: '2026-06-15' });
  await wait(3500);
  const pRecs = (await recs()).length, sRecs = [...items.values()].filter(r => r.key.startsWith('ab-r-') && r.value).length, msg = await P.innerText('#ab-f-msg');
  const dbg = await pc2.page.evaluate(() => ({ recs: abClassRecords().length, rows: document.querySelectorAll('#ab-list tbody tr').length, act: document.activeElement && document.activeElement.id, pend: remoteRefreshPending }));
  check('한 기기에서 추가 → 펴 둔 다른 기기 목록에 바로', dbg.rows === 5, [dbg, pRecs, sRecs, msg]);

  // 다른 선생님은 못 봄
  const other = await openDevice(browser, 'T2', T2);
  await other.page.click('#rail-absence-btn'); await wait(800);
  check('다른 선생님 계정엔 기록 없음', await other.page.evaluate(() => abAllRecords().length) === 0 && [...items.values()].filter(r => r.teacher_id === T2 && r.key.startsWith('ab-r-')).length === 0);
  check('담임 아닌 선생님은 1학년 1반으로 시작', await other.page.evaluate(() => document.getElementById('ab-grade').value === '1' && document.getElementById('ab-class').value === '1'));

  // 반 바꾸기 기억
  await P.selectOption('#ab-grade', '1'); await wait(300);
  check('반 바꾸면 그 반 기록만(없음), 기억', await P.evaluate(() => abClassRecords().length) === 0 && JSON.parse(await ls(pc, 'ab-cfg')).g === 1);
  await P.selectOption('#ab-grade', '3'); await wait(300);

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
