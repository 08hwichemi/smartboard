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
  const open = () => P.evaluate(() => document.getElementById('sgb-overlay').style.display === 'flex');
  const type = async (t) => { await P.fill('#sgb-text', t); await wait(120); };
  const count = () => P.evaluate(() => document.getElementById('sgb-count').innerText.replace(/\s+/g, ' '));
  const finds = () => P.evaluate(() => [...document.querySelectorAll('#sgb-result .sgb-find[data-check]')].map(e => (e.classList.contains('no') ? 'no:' : 'chk:') + e.dataset.check));

  // 바이트 세는 법(사용자가 준 규칙) — 함수 직접
  const c = await P.evaluate(() => [sgbCount('가나 다'), sgbCount('AB 1!'), sgbCount('가\n나'), sgbCount('가\r\n나'), sgbCount('')]);
  check('한글 3·띄어쓰기 1', c[0].bytes === 10 && c[0].withSpace === 4 && c[0].noSpace === 3, c[0]);
  check('영어·숫자·특수문자·띄어쓰기 1', c[1].bytes === 5 && c[1].noSpace === 4, c[1]);
  check('엔터 2바이트(\\n, \\r\\n 모두)', c[2].bytes === 8 && c[3].bytes === 8, [c[2], c[3]]);
  check('빈 문장 0', c[4].bytes === 0 && c[4].withSpace === 0);

  // 레일: 단축키 바로 아래
  const order = await P.evaluate(() => [...document.querySelectorAll('#app-rail .rail-item')].map(e => e.title));
  check('레일 순서: 단축키 바로 아래 생기부', order[order.indexOf('단축키') + 1] === '생기부 문장 점검', order);

  await P.click('#rail-sgb-btn'); await wait(300);
  check('누르면 열림 + 버튼 표시 + 입력칸에 커서', await open() && await P.evaluate(() => document.getElementById('rail-sgb-btn').classList.contains('active') && document.activeElement.id === 'sgb-text'));
  const areas = () => P.evaluate(() => [...document.querySelectorAll('#sgb-areas .top-btn')].map(b => b.innerText + (b.classList.contains('theme-active') ? '*' : '')).join(','));
  check('영역 4개, 처음엔 세특 묶음', await areas() === '세특·개세특·자율자치 (500자)*,진로 (500자),동아리 (500자),행특 (300자)', await areas());
  check('세특 묶음엔 앞말 칸 없음', await P.evaluate(() => document.getElementById('sgb-prefix-row').style.display === 'none'));
  check('빈 칸: 0자 0바이트 / 1500바이트', /공백 제외 0자 공백 포함 0자 0바이트 \/ 1500바이트\(500자\)/.test(await count()), await count());

  // 한도: 과목별 500자 = 1500바이트
  await type('가'.repeat(500));
  check('500자 = 1500바이트 딱 맞음(초과 아님)', /1500바이트/.test(await count()) && !(await P.evaluate(() => document.getElementById('sgb-count').classList.contains('over'))), await count());
  await type('가'.repeat(500) + 'A');
  check('1바이트 넘으면 빨간 표시 + 넘은 양', await P.evaluate(() => document.getElementById('sgb-count').classList.contains('over')) && /1바이트 넘음/.test(await count()), await count());
  await P.click('#sgb-areas [data-area="behav"]'); await wait(150);
  check('행특: 900바이트(300자)', /\/ 900바이트\(300자\)/.test(await count()) && /601바이트 넘음/.test(await count()), await count());
  check('고른 영역 기억(계정 자료)', await ls(pc, 'sgb-area') === 'behav');
  await P.click('#sgb-areas [data-area="s500"]'); await wait(100);
  check('다시 500자 묶음 → 1500바이트', /\/ 1500바이트\(500자\)/.test(await count()) && await ls(pc, 'sgb-area') === 's500', await count());
  await P.evaluate(() => { localStorage.setItem('sgb-area', 'indiv'); renderSgb(); });
  check('예전 영역 id(개인별 세특 등)는 세특 묶음으로', /세특·개세특·자율자치 \(500자\)\*/.test(await areas()), await areas());

  // 동아리: 동아리명 바이트를 본문과 합쳐 셈, 동아리명은 계정별 기억
  await P.click('#sgb-areas [data-area="club"]'); await wait(100);
  check('동아리 → 동아리명 칸 보임', await P.evaluate(() => document.getElementById('sgb-prefix-row').style.display === 'flex' && document.getElementById('sgb-prefix-label').innerText === '동아리명'));
  await P.fill('#sgb-prefix', '(과학탐구반)'); await wait(150);   // 괄호 2 + 한글 5 = 17바이트
  await type('가'.repeat(494));                                   // 1482바이트 → 합 1499
  check('동아리명 17 + 본문 1482 = 1499바이트, 1 남음', /1499바이트/.test(await count()) && /1바이트 남음/.test(await count()) && /동아리명 17 \+ 본문 1482바이트/.test(await count()), await count());
  await type('가'.repeat(495));
  check('본문만으론 1485지만 동아리명 합치면 넘음', await P.evaluate(() => document.getElementById('sgb-count').classList.contains('over')) && /2바이트 넘음/.test(await count()), await count());
  await P.fill('#sgb-text', '과학 실험 설계에 관심이 많아 산화 환원 반응을 주제로 탐구함.'); await wait(120);
  await P.locator('#sgb-overlay .modal-box').screenshot({ path: 'sgb-club.png' });
  await type('가'.repeat(495));
  check('동아리명은 계정 자료로 기억', await ls(pc, 'sgb-club-name') === '(과학탐구반)');
  await P.click('#sgb-areas [data-area="s500"]'); await wait(100);
  check('세특으로 바꾸면 동아리명은 안 셈', /1485바이트/.test(await count()), await count());

  // 진로: 진로 희망 분야도 합쳐 셈(기억은 안 함)
  await P.click('#sgb-areas [data-area="career"]'); await wait(100);
  check('진로 → 진로 희망 분야 칸(비어 있음)', await P.evaluate(() => document.getElementById('sgb-prefix-label').innerText === '진로 희망 분야' && document.getElementById('sgb-prefix').value === ''));
  await P.fill('#sgb-prefix', '의사'); await wait(150);
  check('진로 분야 6 + 본문 1485 = 1491', /1491바이트/.test(await count()), await count());
  check('진로 분야는 저장 안 함', !Object.keys(await P.evaluate(() => ({ ...localStorage }))).some(k => /career/.test(k) && k !== 'sgb-area'));
  await P.click('#sgb-areas [data-area="club"]'); await wait(100);
  check('동아리로 돌아오면 동아리명 그대로', await P.inputValue('#sgb-prefix') === '(과학탐구반)');
  await P.click('#sgb-areas [data-area="career"]'); await wait(100);
  check('진로로 돌아오면 진로 분야 그대로', await P.inputValue('#sgb-prefix') === '의사');
  await P.click('#sgb-areas [data-area="s500"]'); await wait(100);

  // 점검
  await type('TOEIC 900점을 받았고 수학 경시대회에서 금상을 수상하였다.\n① 부광고등학교 축제에서 발표함.');
  const f1 = await finds();
  check('어학시험 = 기재 불가', f1.includes('no:공인어학시험'), f1);
  check('대회·수상 = 확인', f1.includes('chk:대회·수상'), f1);
  check('우리 학교 이름 = 기재 불가', f1.includes('no:우리 학교 이름(고교블라인드)'), f1);
  check('특수문자 ①', f1.includes('chk:특수문자·문단 번호'), f1);
  check('"~하였다." → 명사형 종결 확인', f1.includes('chk:명사형 종결'), f1);
  check('영문 TOEIC도 표시', f1.includes('chk:영문 사용'), f1);
  check('기재 불가가 위에', f1.findIndex(x => x.startsWith('chk:')) > f1.lastIndexOf(f1.filter(x => x.startsWith('no:')).pop()), f1);
  const marks = await P.evaluate(() => [...document.querySelectorAll('#sgb-preview mark.no')].map(m => m.innerText));
  check('미리보기에 빨간 색칠(TOEIC, 부광)', marks.some(m => m.includes('TOEIC')) && marks.some(m => m.includes('부광')), marks);
  check('줄바꿈 = 엔터 2바이트로 셈', await P.evaluate(() => { const t = document.getElementById('sgb-text').value; return sgbCount(t).bytes === sgbCount(t.replace('\n', '')).bytes + 2; }));
  const pages = await P.evaluate(() => [...document.querySelectorAll('.sgb-find-page')].map(e => e.innerText));
  check('근거 쪽 표시', pages.every(p => /^p\.\d+/.test(p)), pages);
  await P.locator('#sgb-overlay .modal-box').screenshot({ path: 'sgb.png' });

  await type('AI와 SNS, TV를 활용한 탐구 보고서를 작성함. 모둠 활동에서 역할을 성실히 수행함.');
  const f2 = await finds();
  check('허용된 영문(AI·SNS·TV)과 명사형 종결은 안 걸림', f2.length === 0, f2);
  check('문제 없으면 ✅ 안내', /자동으로 찾은 문제 표현은 없어요/.test(await P.locator('#sgb-result').innerText()));

  await type('<b>굵게</b> 모의고사 2등급');
  const f3 = await finds();
  check('모의고사·등급 = 기재 불가', f3.includes('no:모의고사·학력평가 성적'), f3);
  check('입력한 태그가 그대로 글자로 보임(HTML로 안 바뀜)', await P.evaluate(() => !document.querySelector('#sgb-preview b') && document.getElementById('sgb-preview').innerText.includes('<b>')));

  // 학생 문장은 어디에도 저장되지 않음
  await type('홍길동 학생은 비밀 문장 확인용');
  await wait(1500);
  const leaked = await P.evaluate(() => Object.keys(localStorage).filter(k => (localStorage.getItem(k) || '').includes('비밀 문장')));
  const serverLeak = [...items.values()].filter(r => String(r.value).includes('비밀 문장'));
  check('문장은 localStorage·서버 어디에도 저장 안 됨', leaked.length === 0 && serverLeak.length === 0, { leaked, serverLeak });

  // 복사 버튼
  await P.evaluate(() => { window.__clip = null; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => { window.__clip = t; } } }); });
  await type('첫 줄 탐구함.\n둘째 줄 발표함.');
  await P.click('#sgb-copy-btn'); await wait(200);
  const clip = await P.evaluate(() => window.__clip);
  check('복사 → 쓴 문장 그대로(줄바꿈 포함) 클립보드에', clip === '첫 줄 탐구함.\n둘째 줄 발표함.', clip);
  await P.click('#sgb-areas [data-area="club"]'); await wait(100);
  await P.evaluate(() => { window.__clip = null; });
  await P.click('#sgb-copy-btn'); await wait(200);
  check('동아리에서 복사해도 본문만(동아리명 빼고)', await P.evaluate(() => window.__clip) === '첫 줄 탐구함.\n둘째 줄 발표함.', await P.evaluate(() => window.__clip));
  await P.click('#sgb-areas [data-area="s500"]'); await wait(100);
  check('복사했다는 표시', /복사했어요/.test(await P.innerText('#sgb-copy-btn')));
  await wait(2000);
  check('잠시 뒤 버튼 글자 원래대로', /^📋 복사/.test(await P.innerText('#sgb-copy-btn')));
  await P.click('#sgb-overlay button:has-text("지우기")'); await wait(100);
  await P.click('#sgb-copy-btn'); await wait(100);
  check('빈 칸에서 복사 → 안내', /복사할 문장이 없어요/.test(await P.innerText('#sgb-copy-btn')));

  check('지우기 → 비움', await P.inputValue('#sgb-text') === '' && /0바이트/.test(await count()));

  await P.click('#sgb-overlay button:has-text("A+")'); await wait(150);
  check('A+ → 14px, 계정 자료로 저장', await ls(pc, 'fz-sgb') === '14' && await P.evaluate(() => getComputedStyle(document.getElementById('sgb-text')).fontSize) === '14px');

  const overflow = await P.evaluate(() => { const b = document.querySelector('#sgb-overlay .modal-box'); return b.scrollWidth > b.clientWidth + 1; });
  check('가로로 넘치지 않음', !overflow);

  // 닫기·다른 패널과 번갈아
  await P.click('#rail-sgb-btn'); await wait(200);
  check('같은 버튼 한 번 더 → 닫힘', !(await open()) && !(await P.evaluate(() => document.getElementById('rail-sgb-btn').classList.contains('active'))));
  await P.click('#rail-sgb-btn'); await wait(200);
  check('다시 열면 마지막 영역(세특 묶음)', /자율자치 \(500자\)\*/.test(await areas()), await areas());
  await P.mouse.click(1400, 500); await wait(200);
  check('바깥 누르면 닫힘', !(await open()));
  await P.click('#rail-sgb-btn'); await wait(200);
  await P.click('#rail-hwpkeys-btn'); await wait(300);
  check('단축키 누르면 생기부 닫히고 단축키 열림', !(await open()) && await P.evaluate(() => document.getElementById('hwpkeys-overlay').style.display === 'flex'));
  await P.click('#rail-sgb-btn'); await wait(300);
  check('생기부 누르면 단축키 닫힘', await open() && await P.evaluate(() => document.getElementById('hwpkeys-overlay').style.display === 'none'));
  await P.click('.rail-item[title="명렬표"]'); await wait(500);
  check('명렬표 누르면 생기부 닫힘', !(await open()) && await P.evaluate(() => document.getElementById('roster-overlay').style.display === 'flex'));
  await P.click('#rail-sgb-btn'); await wait(300);
  check('생기부 누르면 명렬표 닫힘', await open() && await P.evaluate(() => document.getElementById('roster-overlay').style.display === 'none'));
  await P.click('#rail-monthly-btn'); await wait(600);
  check('다른 메뉴(월간일정표) 누르면 닫힘', !(await open()) && await P.evaluate(() => document.getElementById('monthly-page').style.display === 'flex'));
  await P.click('#rail-sgb-btn'); await wait(200);
  await P.click('#rail-home-btn'); await wait(300);
  check('홈 누르면 닫힘', !(await open()));

  check('페이지 오류 없음', pc.errors.length === 0, pc.errors);
  console.log(failures ? ('실패 ' + failures + '건') : '모든 검사 통과');
  await browser.close();
  process.exit(failures ? 1 : 0);
})();
