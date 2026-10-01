// 레일 "이름표": 게시판 이름표(내용 한 줄에 하나, 부제, 장수, 글자 크기 맞춤·모두 같게, A4 세로/가로 자동 배치),
// 분리수거함 이름표(종류 체크·아이콘·종류별 색), 글꼴(웹 글꼴·PC 글꼴 직접 입력), 색(순환·한 색), 인쇄(PDF 쪽수·방향),
// 계정 자료 저장·다른 기기 반영(홈 화면은 다시 그리지 않음), 화면 닫기.
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
  [T2]: { id: T2, name: '박교사', is_admin: false, must_change_password: false, role: '담임', homeroom_grade: 3, homeroom_class: 1 },
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
  if (table === 'students' && op === 'select') {
    const g = filters.find(f => f.col === 'grade'), c = filters.find(f => f.col === 'class_no');
    studentSelects.push(g && c ? g.val + '-' + c.val : '?');
    if (g && Number(g.val) === 3 && c && Number(c.val) === 1) return { data: ['가나다', '라마바', '사아자', '차카타', '파하가'].map((n, i) => ({ number: i + 1, name: n })), error: null };
    if (g && Number(g.val) === 3 && c && Number(c.val) === 2) return { data: Array.from({ length: 30 }, (_, i) => ({ number: i + 1, name: '학생' + (i + 1) })), error: null };
    if (g && Number(g.val) === 3 && c && Number(c.val) === 3) return { data: null, error: { message: 'Failed to fetch' } }; // 못 받는 반
    return { data: [], error: null };
  }
  if (table === 'app_settings' && filters.some(f => f.val === 'class_structure')) return { data: { value: { gradeCount: 3, classCounts: [8, 9, 10] } }, error: null };
  if (op === 'select') return { data: single || maybe ? null : [], error: null };
  return { data: null, error: null };
}
const studentSelects = [];

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
  const ctx = opts.context || await browser.newContext(opts.mobile ? { viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true } : { viewport: opts.viewport || { width: 1600, height: 1000 } });
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
const cfgOf = async (d) => JSON.parse(await ls(d, 'nt-cfg') || '{}');
const labels = (P) => P.evaluate(() => document.querySelectorAll('#nt-pages .nt-sheet > svg').length);
const sheets = (P) => P.evaluate(() => document.querySelectorAll('#nt-pages .nt-sheet').length);
const mainSizes = (P) => P.evaluate(() => [...document.querySelectorAll('#nt-pages .nt-sheet > svg')].map(s => +s.querySelector('text:not(.nt-sh)').getAttribute('font-size')));
function pdfInfo(buf) {
  const s = buf.toString('latin1');
  const pages = (s.match(/\/Type\s*\/Page[^s]/g) || []).length;
  const mb = (s.match(/\/MediaBox\s*\[\s*0 0 ([\d.]+) ([\d.]+)\s*\]/) || []).slice(1).map(Number);
  return { pages, w: Math.round(mb[0]), h: Math.round(mb[1]) };
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }).catch(() => chromium.launch());
  const pc = await openDevice(browser, 'PC', T1);
  const P = pc.page;
  const shown = () => P.evaluate(() => document.getElementById('nametag-page').style.display === 'flex');
  const pickFont = async (title) => { await P.click('#nt-font-btn'); await wait(100); await P.click('#nt-font-menu .nt-font-opt[title="' + title + '"]'); await wait(200); };

  const order = await P.evaluate(() => [...document.querySelectorAll('#app-rail .rail-item')].map(e => e.title));
  check('레일 순서: 공용(명렬표~이름표·양식) → "학급" 선 → 좌석배치표·조퇴증·결석계', order.join(',') === '홈,명렬표,단축키,생기부 문장 점검,시간표,월간일정표,이름표,양식 만들기,좌석배치표,조퇴증,결석계,관리자 설정', order);
  const sep = await P.evaluate(() => { const s = document.querySelector('#app-rail .rail-sep'); return s && s.previousElementSibling.id === 'rail-forms-btn' && s.nextElementSibling.id === 'rail-seatchart-btn' && s.innerText.trim() === '학급'; });
  check('양식과 좌석배치표 사이에 "학급" 구분선', sep);

  await P.click('#rail-nametag-btn'); await wait(300);
  check('누르면 이름표 화면 + 버튼 표시, 홈은 숨김', await shown() && await P.evaluate(() => document.getElementById('rail-nametag-btn').classList.contains('active') && document.getElementById('main-dashboard').style.display === 'none'));
  check('처음엔 입체 글씨 디자인·주아 글꼴(엑셀 양식처럼)', await P.evaluate(() => document.querySelector('#nt-styles .nt-style.on').innerText.includes('입체 글씨') && document.getElementById('nt-font-btn').innerText.includes('주아') && document.querySelector('#nt-font-menu .nt-font-opt.on').title === '주아'));
  check('처음엔 게시판 모드·14.8×6.4cm(엑셀 기본)·안내 문구', await P.inputValue('#nt-w') === '14.8' && await P.inputValue('#nt-h') === '6.4' && /한 줄에 하나씩/.test(await P.locator('#nt-pages').innerText()));
  check('글꼴은 드롭다운(닫혀 있음) + 디자인 6가지', await P.evaluate(() => document.getElementById('nt-font-menu').style.display === 'none' && document.querySelectorAll('#nt-styles .nt-style').length === 6));
  await P.click('#nt-font-btn'); await wait(200);
  const menu = await P.evaluate(() => { const m = document.getElementById('nt-font-menu'); const opts = [...m.querySelectorAll('.nt-font-opt')]; const r = m.getBoundingClientRect();
    return { shown: m.style.display === 'block', n: opts.length, custom: /직접 입력/.test(m.innerText), inFont: opts.slice(0, -1).every(o => o.querySelector('.nt-fname').style.fontFamily.includes(o.dataset.f)),
      tall: opts.every(o => o.getBoundingClientRect().height >= 30), inView: r.top >= 0 && r.bottom <= innerHeight, onVisible: (() => { const on = m.querySelector('.on').getBoundingClientRect(); return on.top >= r.top && on.bottom <= r.bottom; })() }; });
  check('펼치면 글꼴 26개 + 직접 입력, 이름이 각 글꼴로·찌그러지지 않음·화면 안·지금 글꼴이 보이게', menu.shown && menu.n === 27 && menu.custom && menu.inFont && menu.tall && menu.inView && menu.onVisible, menu);
  await P.locator('#nt-font-menu').screenshot({ path: 'nt-fontmenu.png' });
  await P.mouse.click(1000, 500); await wait(150);
  check('바깥 누르면 닫힘', await P.evaluate(() => document.getElementById('nt-font-menu').style.display === 'none'));
  await P.click('#nt-font-btn'); await P.keyboard.press('Escape'); await wait(100);
  check('Esc로 닫힘', await P.evaluate(() => document.getElementById('nt-font-menu').style.display === 'none'));

  // 내용 입력 → 바로 그려짐, 계정 자료에 저장
  await P.fill('#nt-text', '월간 일정표\n오늘의 메뉴\n\n  수능 D-Day  \n날씨&미세먼지\n일반 게시물\n시간표 변경 / TIMETABLE'); await wait(300);
  check('빈 줄 빼고 6개, A4 세로 한 장에 4개 → 2장', await labels(P) === 6 && await sheets(P) === 2, [await labels(P), await sheets(P)]);
  check('미리보기 안내: "A4 세로 · 이름표 6개 · 종이 2장"', (await P.textContent('#nt-prev-label')) === 'A4 세로 · 이름표 6개 · 종이 2장', await P.textContent('#nt-prev-label'));
  check('크기 칸 옆 "A4 세로 한 장에 4개"', /세로 한 장에 4개/.test(await P.textContent('#nt-fit-info')));
  check('내용이 nt-cfg에 저장', (await cfgOf(pc)).text.split('\n').length === 7);
  const sub = await P.evaluate(() => { const s = [...document.querySelectorAll('#nt-pages .nt-sheet > svg')][5]; return [...s.querySelectorAll('text:not(.nt-sh)')].map(t => t.textContent); });
  check('" / " 뒤는 작은 부제로', sub.join('|') === '시간표 변경|TIMETABLE', sub);
  // 띄어쓰기 없이 "/"만 써도 부제
  const sub2 = await P.evaluate(() => ['월간 일정표/MONTHLY', '급식 /MENU', '/앞이 빈 줄'].map(s => ntItems({ mode: 'board', text: s, colorMode: 'cycle' })[0]).map(it => it.text + '|' + it.sub));
  check('"/"만 써도(띄어쓰기 없이) 부제, 앞이 비면 그대로', sub2.join(',') === '월간 일정표|MONTHLY,급식|MENU,/앞이 빈 줄|', sub2);
  // 실제 크기(mm)·배치
  const geo = await P.evaluate(() => { const sh = document.querySelector('.nt-sheet'); const s = sh.querySelector('svg'); return { sw: sh.style.width, w: s.getAttribute('width'), h: s.getAttribute('height'), left: s.style.left, top: s.style.top, top2: sh.querySelectorAll('svg')[1].style.top }; });
  check('이름표 148×64mm, 가운데 정렬, 위 여백 8mm·사이 4mm', geo.sw === '210mm' && geo.w === '148mm' && geo.h === '64mm' && geo.left === '31mm' && geo.top === '8mm' && geo.top2 === '76mm', geo);
  // 글자가 칸 밖으로 안 나감
  const overflow = await P.evaluate(() => [...document.querySelectorAll('#nt-pages .nt-sheet > svg')].map(s => { const vb = s.viewBox.baseVal; return [...s.querySelectorAll('text:not(.nt-sh)')].map(t => { const b = t.getBBox(); return b.x >= 0 && b.y >= 0 && b.x + b.width <= vb.width && b.y + b.height <= vb.height; }).every(Boolean); }));
  check('모든 글자가 이름표 안에 들어감', overflow.every(Boolean), overflow);
  const pop = await P.evaluate(() => { const s = document.querySelector('#nt-pages svg'); const sh = s.querySelector('text.nt-sh'), m = s.querySelector('text:not(.nt-sh)'); return { sh: !!sh && sh.getAttribute('fill') === '#141414' && +sh.getAttribute('x') > +m.getAttribute('x'), m: m.getAttribute('fill') === '#fff' && m.getAttribute('stroke') === '#141414' && m.getAttribute('paint-order') === 'stroke' }; });
  check('입체 글씨: 흰 글자 + 검정 테두리 + 오른쪽 아래 그림자', pop.sh && pop.m, pop);
  let sz = await mainSizes(P);
  check('글자 크기 모두 같게(기본)', new Set(sz).size === 1, sz);
  await P.uncheck('#nt-same'); await wait(200);
  sz = await mainSizes(P);
  check('끄면 이름마다 칸에 맞게(짧은 이름이 더 큼)', new Set(sz).size > 1 && sz[1] > sz[3], sz);
  await P.check('#nt-same'); await wait(200);
  // 글자 크기: 단계 버튼 대신 바(%)로 직접 조절
  const setFill = (pg, v) => pg.evaluate((v) => { const r = document.getElementById('nt-fillr'); r.value = v; r.dispatchEvent(new Event('input', { bubbles: true })); }, v);
  check('글자 크기는 바(기본 74%, 예전 "보통"과 같음), 단계 버튼 없음', await P.inputValue('#nt-fillr') === '74' && (await P.textContent('#nt-fill-val')) === '74%' && !(await P.$('#nt-fill')));
  const mid = (await mainSizes(P))[0];
  await setFill(P, 90); await wait(200);
  const big = (await mainSizes(P))[0];
  await setFill(P, 50); await wait(200);
  const small0 = (await mainSizes(P))[0];
  check('바를 올리면 글자가 커지고 내리면 작아짐, 계정에 저장', big > mid * 1.1 && small0 < mid * 0.8 && (await cfgOf(pc)).fillPct === 50 && (await P.textContent('#nt-fill-val')) === '50%', [small0, mid, big]);
  await setFill(P, 74); await wait(200);

  // 장수
  await P.fill('#nt-copies', '2'); await wait(200);
  check('2장씩 → 12개·3장', await labels(P) === 12 && await sheets(P) === 3);
  await P.fill('#nt-copies', '1'); await wait(200);

  // 크기: 가로가 길면 A4 가로로
  await P.fill('#nt-w', '25'); await P.fill('#nt-h', '8'); await wait(300);
  check('25×8cm → A4 가로(세로 종이엔 안 들어감)', /^A4 가로/.test(await P.textContent('#nt-prev-label')) && await P.evaluate(() => document.querySelector('.nt-sheet').style.width === '297mm'), await P.textContent('#nt-prev-label'));
  await P.fill('#nt-w', '30'); await P.fill('#nt-h', '30'); await wait(300);
  check('A4보다 크면 안내', /A4 종이보다 커요/.test(await P.locator('#nt-pages').innerText()));
  await P.click('#nt-presets .nt-chip:first-child'); await wait(300);
  check('크기 버튼(14.8×6.4)', await P.inputValue('#nt-w') === '14.8' && (await cfgOf(pc)).w === 14.8);
  await P.fill('#nt-w', '9'); await P.fill('#nt-h', '5'); await wait(300);
  check('9×5cm → 한 장에 2열×5줄 = 10개', /한 장에 10개/.test(await P.textContent('#nt-fit-info')) && await sheets(P) === 1, await P.textContent('#nt-fit-info'));

  // 디자인·색
  const fills = () => P.evaluate(() => [...document.querySelectorAll('#nt-pages .nt-sheet > svg')].map(s => s.querySelector('g[clip-path] rect').getAttribute('fill')));
  let f = await fills();
  check('여러 색 돌아가며(12색) — 6개 모두 다른 색', new Set(f).size === 6, f);
  await P.click('#nt-color-modes .nt-chip:has-text("한 색으로")'); await wait(200);
  await P.click('#nt-swatches .nt-sw:nth-child(3)'); await wait(200);
  f = await fills();
  check('한 색으로 → 고른 색 하나(입체 글씨는 그 색의 파스텔)', new Set(f).size === 1 && f[0].toLowerCase() !== '#ffffff', f);
  await P.click('#nt-styles .nt-style:nth-child(5)'); await wait(200);
  check('디자인 "컬러" → 색 바탕 + 흰 글씨', await P.evaluate(() => { const s = document.querySelector('#nt-pages svg'); return s.querySelector('g[clip-path] rect').getAttribute('fill').toLowerCase() === ntForWhite(NT_COLORS[2]).toLowerCase() && s.querySelector('text:not(.nt-sh)').getAttribute('fill') === '#fff'; }) && (await cfgOf(pc)).style === 'solid');
  await P.click('#nt-styles .nt-style:nth-child(6)'); await wait(200);
  const ul = await P.evaluate(() => { const s = document.querySelector('#nt-pages svg'); const t = s.querySelector('text:not(.nt-sh)').getBBox(); const r = [...s.querySelectorAll('rect')].pop().getBBox(); return { tw: t.width, rw: r.width, tx: t.x, rx: r.x }; });
  check('밑줄: 글자 전체 폭', Math.abs(ul.rw - ul.tw) < ul.tw * 0.08 && Math.abs(ul.rx - ul.tx) < ul.tw * 0.06, ul);
  await P.click('#nt-styles .nt-style:nth-child(5)'); await wait(200);
  await P.click('#nt-radius [data-v="0"]'); await wait(200);
  check('모서리 각지게', await P.evaluate(() => document.querySelector('#nt-pages svg clipPath rect').getAttribute('rx') === '0'));
  await P.click('#nt-styles .nt-style:nth-child(2)'); await P.click('#nt-color-modes .nt-chip:has-text("여러 색")'); await P.click('#nt-radius [data-v="2"]'); await wait(200);

  // 글꼴
  await pickFont('검은고딕');
  check('고르면 닫히고 버튼에 그 글꼴 이름(그 글꼴로)', await P.evaluate(() => document.getElementById('nt-font-menu').style.display === 'none' && document.querySelector('#nt-font-btn .nt-fname').innerText === '검은고딕' && document.querySelector('#nt-font-btn .nt-fname').style.fontFamily.includes('Black Han Sans')));
  check('글꼴 고르면 이름표 글꼴 바뀜·굵기 칸 잠김(한 가지 굵기)', await P.evaluate(() => document.querySelector('#nt-pages text:not(.nt-sh)').getAttribute('font-family').startsWith("'Black Han Sans'") && document.querySelector('#nt-pages text:not(.nt-sh)').getAttribute('font-weight') === '400' && document.getElementById('nt-weight').disabled) && (await cfgOf(pc)).font === 'Black Han Sans');
  await pickFont('직접 입력');
  check('직접 입력 → 이름 칸 보임', await P.isVisible('#nt-custom'));
  await P.fill('#nt-custom', '없는글꼴이름123'); await wait(200);
  check('PC에 없는 글꼴이면 경고', /찾지 못했어요/.test(await P.textContent('#nt-custom-msg')));
  await P.fill('#nt-custom', 'DejaVu Sans'); await wait(200);
  check('PC에 있는 글꼴이면 확인 + 이름표에 적용', /이 PC에 있는 글꼴/.test(await P.textContent('#nt-custom-msg')) && await P.evaluate(() => document.querySelector('#nt-pages text:not(.nt-sh)').getAttribute('font-family').startsWith("'DejaVu Sans'")) && (await cfgOf(pc)).custom === 'DejaVu Sans');
  await P.fill('#nt-custom', 'a"b<script>'); await wait(200);
  check('글꼴 이름의 따옴표·꺾쇠는 빼고 씀', await P.evaluate(() => !document.querySelector('#nt-pages script') && document.querySelector('#nt-pages text:not(.nt-sh)').getAttribute('font-family').startsWith("'abscript'")));
  await pickFont('프리텐다드');
  check('자간 조절', await P.evaluate(() => { const r = document.getElementById('nt-ls'); r.value = 20; r.dispatchEvent(new Event('input')); return document.querySelector('#nt-pages text:not(.nt-sh)').getAttribute('letter-spacing') > 0 && document.getElementById('nt-ls-val').textContent === '0.2em'; }));

  // 인쇄: 쪽수·방향
  await P.evaluate(() => { window.print = function() { window.__printed = (window.__printed || 0) + 1; }; });
  await P.fill('#nt-w', '14.8'); await P.fill('#nt-h', '6.4'); await wait(300);
  await P.evaluate(() => ntPrint()); await wait(300);
  check('출력 → 인쇄 창', await P.evaluate(() => window.__printed === 1));
  let pdf = pdfInfo(await P.pdf({ preferCSSPageSize: true, printBackground: true }));
  check('인쇄: A4 세로 2쪽(미리보기 종이 2장과 같음)', pdf.pages === 2 && pdf.w === 595 && pdf.h === 842, pdf);
  await P.fill('#nt-w', '25'); await P.fill('#nt-h', '8'); await wait(300);
  await P.evaluate(() => ntPrint()); await wait(300);
  pdf = pdfInfo(await P.pdf({ preferCSSPageSize: true, printBackground: true }));
  check('인쇄: 가로 배치면 A4 가로 3쪽', pdf.pages === 3 && pdf.w === 842 && pdf.h === 595, pdf);
  await P.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  check('인쇄 끝나면 가로 방향 설정 지움(다른 화면 인쇄에 안 남게)', await P.evaluate(() => document.getElementById('nt-page-style').textContent === ''));
  await P.screenshot({ path: 'nt-board.png' });

  // 분리수거함
  await P.click('#nt-mode-switch [data-mode="recycle"]'); await wait(300);
  check('분리수거함: 기본 5종(일반쓰레기·플라스틱·비닐·종이·캔/유리), 18×8cm', await labels(P) === 5 && await P.inputValue('#nt-w') === '18' && await P.isVisible('#nt-rc-box') && !(await P.isVisible('#nt-board-box')));
  const rc = await P.evaluate(() => [...document.querySelectorAll('#nt-pages .nt-sheet > svg')].map(s => ({ t: [...s.querySelectorAll('text:not(.nt-sh)')].map(x => x.textContent).join('|'), icon: !!s.querySelector('circle + g path'), fill: s.querySelector('g[clip-path] rect:nth-child(2)').getAttribute('fill') })));
  check('아이콘 + 한글 + 영어', rc.map(r => r.t).join(',') === '일반쓰레기|GENERAL WASTE,플라스틱|PLASTIC,비닐|VINYL,종이|PAPER,캔/유리|CAN & GLASS' && rc.every(r => r.icon), rc);
  check('종류별 색(플라스틱 파랑)', rc[1].fill.toLowerCase() === '#3b6fd4' && new Set(rc.map(r => r.fill)).size === 5, rc.map(r => r.fill));
  await P.click('.nt-rc:has-text("스티로폼") input'); await P.click('.nt-rc:has-text("비닐") input'); await wait(200);
  const rc2 = await P.evaluate(() => [...document.querySelectorAll('#nt-pages .nt-sheet > svg')].map(s => s.querySelector('text:not(.nt-sh)').textContent));
  check('체크 바꾸면 목록 순서대로', rc2.join(',') === '일반쓰레기,플라스틱,종이,캔/유리,스티로폼', rc2);
  await P.fill('#nt-rc-text', '건전지'); await P.uncheck('#nt-rc-eng'); await wait(200);
  const rc3 = await P.evaluate(() => [...document.querySelectorAll('#nt-pages .nt-sheet > svg')].map(s => s.querySelectorAll('text:not(.nt-sh)').length));
  check('직접 더하기 + 영어 끄기', rc3.length === 6 && rc3.every(n => n === 1), rc3);
  const both = await P.evaluate(() => ntCfg());
  check('게시판 크기·내용은 따로 기억', both.w === 25 && both.rw === 18 && /월간 일정표/.test(both.text), both);
  await P.fill('#nt-w', '19'); await P.fill('#nt-h', '27'); await wait(300);
  check('세로로 긴 이름표(19×27) → 아이콘 위·글자 아래', await P.evaluate(() => { const s = document.querySelector('#nt-pages svg'); return +s.querySelector('circle').getAttribute('cy') < +s.querySelector('text:not(.nt-sh)').getAttribute('y'); }));
  await P.screenshot({ path: 'nt-recycle.png' });

  // 서버 저장 + 다른 기기
  await wait(2500);
  check('서버(개인 자료)에 nt-cfg 저장', JSON.parse(serverVal(T1, 'nt-cfg') || '{}').rcText === '건전지');
  const pc2 = await openDevice(browser, 'PC2', T1);
  await pc2.page.click('#rail-nametag-btn'); await wait(300);
  check('다른 기기에서 열면 같은 설정(분리수거함·건전지)', await pc2.page.evaluate(() => document.querySelectorAll('#nt-pages .nt-sheet > svg').length === 6 && document.getElementById('nt-rc-text').value === '건전지'));
  await P.evaluate(() => { window.__homeRedraw = 0; const o = window.refreshDashboardFromLocalStorage; window.refreshDashboardFromLocalStorage = function() { window.__homeRedraw++; return o.apply(this, arguments); }; });
  await P.evaluate(() => document.activeElement && document.activeElement.blur()); // 입력칸에 커서가 있으면 벗어날 때까지 미룸(정상)
  await pc2.page.click('.nt-rc:has-text("음식물") input'); await wait(3000);
  check('다른 기기에서 바꾸면 여기 이름표도 바로 바뀜', await labels(P) === 7, await labels(P));
  check('이름표 설정만 바뀌면 홈 화면은 다시 안 그림', await P.evaluate(() => window.__homeRedraw === 0));

  // 🔐 사물함 이름표
  const texts = (pg) => pg.evaluate(() => [...document.querySelectorAll('#nt-pages .nt-sheet > svg')].map(s => s.querySelector('text:not(.nt-sh)').textContent));
  check('탭 이름·순서: 게시판 / 사물함 / 분리수거함(아이콘 없음)', (await P.evaluate(() => [...document.querySelectorAll('#nt-mode-switch .tab-btn')].map(b => b.textContent.trim()).join('/'))) === '게시판/사물함/분리수거함');
  await P.click('#nt-mode-switch [data-mode="locker"]'); await wait(300);
  check('사물함: 기본 6.7×2.1cm, 담임 아니면 학년·반 고르라는 안내(명렬표 안 받음)', await P.inputValue('#nt-w') === '6.7' && await P.inputValue('#nt-h') === '2.1' && await P.isVisible('#nt-lk-box') && !(await P.isVisible('#nt-rc-box')) && !(await P.isVisible('#nt-board-box')) && /학년·반/.test(await P.locator('#nt-pages').innerText()) && studentSelects.length === 0);
  check('반 목록은 학급 구성대로(3학년 10반)', await P.evaluate(() => document.querySelectorAll('#nt-lk-grade option').length === 4));
  await P.selectOption('#nt-lk-grade', '3'); await wait(150);
  check('학급 구성대로 3학년 반 10개', await P.evaluate(() => document.querySelectorAll('#nt-lk-class option').length) === 11);
  await P.selectOption('#nt-lk-class', '1'); await wait(400);
  check('3학년 1반 → 명렬표 5명, 기본 "번호 이름"', JSON.stringify(await texts(P)) === JSON.stringify(['1번 가나다', '2번 라마바', '3번 사아자', '4번 차카타', '5번 파하가']) && /5명/.test(await P.textContent('#nt-lk-count')), await texts(P));
  check('6.7×2.1cm → 사이 간격 없이 A4 가로 한 장에 36개(4×9)', /가로 한 장에 36개/.test(await P.textContent('#nt-fit-info')) && await P.evaluate(() => { const s = document.querySelector('#nt-pages .nt-sheet > svg'); return s.getAttribute('width') === '67mm' && s.getAttribute('height') === '21mm'; }), await P.textContent('#nt-fit-info'));
  const lkPos = await P.evaluate(() => [...document.querySelectorAll('#nt-pages .nt-sheet > svg')].map(s => [parseFloat(s.style.left), parseFloat(s.style.top)]));
  check('사물함은 이름표끼리 딱 붙음(옆 67mm·아래 21mm 간격), 모서리는 각지게·모서리 고르기 숨김', Math.abs(lkPos[1][0] - lkPos[0][0] - 67) < 0.01 && Math.abs(lkPos[4][1] - lkPos[0][1] - 21) < 0.01 &&
    await P.evaluate(() => document.querySelector('#nt-pages svg rect[clip-path], #nt-pages svg clipPath rect').getAttribute('rx') === '0' && document.getElementById('nt-radius').parentElement.style.display === 'none'), lkPos.slice(0, 5));
  const fmtBtns = await P.evaluate(() => [...document.querySelectorAll('#nt-lk-fmt .nt-chip')].map(b => b.textContent));
  check('표시 버튼 4개, 이 반 첫 학생으로 예시', JSON.stringify(fmtBtns) === JSON.stringify(['30101', '1번 가나다', '30101 가나다', '가나다']), fmtBtns);
  await P.click('#nt-lk-fmt [data-v="id"]'); await wait(200);
  check('"학번" → 30101 …', (await texts(P)).join(',') === '30101,30102,30103,30104,30105' && (await cfgOf(pc)).lFmt === 'id', await texts(P));
  await P.click('#nt-lk-fmt [data-v="idname"]'); await wait(200);
  check('"학번 이름" → 30101 가나다', (await texts(P))[0] === '30101 가나다');
  await P.click('#nt-lk-fmt [data-v="numname"]'); await wait(200);
  const lkIn = await P.evaluate(() => [...document.querySelectorAll('#nt-pages .nt-sheet > svg')].every(s => { const vb = s.viewBox.baseVal; return [...s.querySelectorAll('text')].every(t => { const b = t.getBBox(); return b.x >= 0 && b.y >= 0 && b.x + b.width <= vb.width && b.y + b.height <= vb.height; }); }));
  check('작은 이름표에서도 글자가 칸 안에', lkIn);
  const lkMid = (await mainSizes(P))[0];
  await setFill(P, 50); await wait(200);
  check('사물함에서도 글자 크기 바가 먹음', (await mainSizes(P))[0] < lkMid * 0.8);
  await setFill(P, 74); await wait(200);
  // 글자 크기·자간·모두 같게는 모드마다 따로
  await setFill(P, 92); await wait(200);
  await P.evaluate(() => { const r = document.getElementById('nt-ls'); r.value = 36; r.dispatchEvent(new Event('input', { bubbles: true })); });
  await P.uncheck('#nt-same'); await wait(200);
  let sc = await cfgOf(pc);
  check('사물함 글자 크기·자간·모두 같게를 바꿔도 게시판·분리수거함은 그대로', sc.lFillPct === 92 && sc.lLs === 36 && sc.lSame === false && sc.fillPct === 74 && sc.rcFillPct === 74 && sc.ls === 20 && sc.rcLs === 4 && sc.same === true && sc.rcSame === true, sc);
  await P.click('#nt-mode-switch [data-mode="board"]'); await wait(300);
  check('게시판 탭으로 가면 게시판 값(74%·자간 20·모두 같게)', await P.inputValue('#nt-fillr') === '74' && await P.inputValue('#nt-ls') === '20' && await P.isChecked('#nt-same'));
  await setFill(P, 60); await wait(200);
  await P.click('#nt-mode-switch [data-mode="locker"]'); await wait(300);
  sc = await cfgOf(pc);
  check('게시판을 바꿔도 사물함은 그대로(92%)', await P.inputValue('#nt-fillr') === '92' && sc.lFillPct === 92 && sc.fillPct === 60 && sc.rcFillPct === 74, sc);
  await setFill(P, 74); await P.evaluate(() => { const r = document.getElementById('nt-ls'); r.value = 4; r.dispatchEvent(new Event('input', { bubbles: true })); }); await P.check('#nt-same');
  await P.click('#nt-mode-switch [data-mode="board"]'); await wait(300); await setFill(P, 74);
  await P.click('#nt-mode-switch [data-mode="locker"]'); await wait(300);
  // 예전 설정(모드별 값 없음)은 게시판 값에서 시작
  const legacy = await P.evaluate(() => { const old = localStorage.getItem('nt-cfg'); localStorage.setItem('nt-cfg', JSON.stringify({ mode: 'locker', fill: 'l' })); const c = ntCfg(); localStorage.setItem('nt-cfg', old); return c.fillPct; });
  check('예전 설정(글자 크기 하나)은 모든 모드가 그 값에서 시작', legacy === 86, legacy);
  // 12색: 예전 파스텔과 같은 밝기, 같은 계열이 붙지 않게, 옆 이름표끼리는 확실히 구별
  const pal = await P.evaluate(() => {
    const hue = (c) => ntOk(c)[2] * 180 / Math.PI, gap = (a, b) => { const d = Math.abs(hue(a) - hue(b)) % 360; return Math.min(d, 360 - d); };
    const lab = (h) => { const v = parseInt(h.slice(1), 16); const [r, g, b] = [v >> 16 & 255, v >> 8 & 255, v & 255].map(x => { x /= 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); const f = t => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116; const X = f((r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047), Y = f(r * 0.2126 + g * 0.7152 + b * 0.0722), Z = f((r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883); return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)]; };
    const dE = (a, b) => { a = lab(a); b = lab(b); return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); };
    const n = NT_COLORS.length, tints = NT_COLORS.map(c => ntTheme('soft', c).bg);
    let minHue = 360, minNb = 1e9, minAll = 1e9;
    for (let i = 0; i < n; i++) {
      for (const k of [1, 4]) { minHue = Math.min(minHue, gap(NT_COLORS[i], NT_COLORS[(i + k) % n])); minNb = Math.min(minNb, dE(tints[i], tints[(i + k) % n])); }
      for (let j = i + 1; j < n; j++) minAll = Math.min(minAll, dE(tints[i], tints[j]));
    }
    const r1 = (x) => Math.round(x * 10) / 10;
    return { minHue: Math.round(minHue), minNb: r1(minNb), minAll: r1(minAll), minL: r1(Math.min(...tints.map(t => lab(t)[0]))), solidOk: NT_COLORS.every(c => 1.05 / (ntLum(ntTheme('solid', c).bg) + 0.05) >= 3) };
  });
  check('12색: 연한 바탕은 예전 파스텔처럼 밝게(L* 93 이상), 옆·위아래(4칸 줄)는 색상 110° 이상·색 차이 ΔE 10 이상, 12색 어느 둘도 예전보다 구별(ΔE 3 이상), 컬러 디자인은 흰 글자가 읽힘', pal.minL >= 93 && pal.minHue >= 110 && pal.minNb >= 10 && pal.minAll >= 3 && pal.solidOk, pal);
  await P.screenshot({ path: 'nt-locker.png' });
  await P.selectOption('#nt-lk-class', '2'); await wait(400);
  check('3학년 2반(30명) → 30개, 종이 1장(36개 들어감)', await labels(P) === 30 && await sheets(P) === 1, [await labels(P), await sheets(P)]);
  await P.click('#nt-presets .nt-chip:nth-child(2)'); await wait(200);
  const lc = await cfgOf(pc);
  check('사물함 크기 바꾸면 사물함만(게시판·분리수거 크기 그대로)', lc.lw === 8 && lc.lh === 2.5 && lc.w === 25 && lc.rw === 19, lc);
  await P.fill('#nt-w', '6.7'); await P.fill('#nt-h', '2.1'); await wait(200);
  const nSel = studentSelects.length;
  await P.selectOption('#nt-lk-class', '3'); await wait(400);
  for (let k = 0; k < 4; k++) { await setFill(P, 70 + k * 2); await wait(100); }
  check('명렬표를 못 받으면 안내 + 다시 그려도 요청이 되풀이되지 않음', /불러오지 못했어요/.test(await P.locator('#nt-pages').innerText()) && studentSelects.length === nSel + 1, studentSelects.slice(nSel));
  await setFill(P, 74);
  await P.selectOption('#nt-lk-class', '1'); await wait(400);
  check('반을 고를 때만 명렬표를 받음(표시·크기·글자 크기를 바꿔 다시 그려도 안 받음)', studentSelects.join(',') === '3-1,3-2,3-3,3-1' && (await texts(P)).length === 5, studentSelects);
  // 담임 선생님: 담임 반으로 시작
  const hr = await openDevice(browser, 'HR', T2);
  await hr.page.click('#rail-nametag-btn'); await wait(300);
  await hr.page.click('#nt-mode-switch [data-mode="locker"]'); await wait(500);
  check('담임은 사물함을 열면 담임 반(3학년 1반) 학생으로 바로', await hr.page.inputValue('#nt-lk-grade') === '3' && await hr.page.inputValue('#nt-lk-class') === '1' && (await texts(hr.page)).length === 5, await texts(hr.page));
  await hr.page.locator('#nt-right').screenshot({ path: 'nt-locker-pop.png' }); // 기본 디자인(입체 글씨·주아)

  // 닫기
  await P.click('#rail-nametag-btn'); await wait(300);
  check('같은 버튼 한 번 더 → 홈', !(await shown()) && await P.evaluate(() => document.getElementById('main-dashboard').style.display === 'grid'));
  await P.click('#rail-nametag-btn'); await wait(300);
  await P.click('#rail-absence-btn'); await wait(600);
  check('결석계 누르면 이름표 닫히고 결석계', !(await shown()) && await P.evaluate(() => document.getElementById('absence-page').style.display === 'flex' && !document.getElementById('rail-nametag-btn').classList.contains('active')));
  await P.click('#rail-nametag-btn'); await wait(300);
  check('이름표 누르면 결석계 닫힘', await shown() && await P.evaluate(() => document.getElementById('absence-page').style.display === 'none'));
  await P.click('#rail-monthly-btn'); await wait(600);
  check('월간일정표 누르면 이름표 닫힘', !(await shown()) && await P.evaluate(() => document.getElementById('monthly-page').style.display === 'flex'));
  await P.click('#rail-home-btn'); await wait(300);

  // 1366×768 화면에서도 레일·입력칸이 잘리지 않음
  const small = await openDevice(browser, 'S', T1, { viewport: { width: 1366, height: 768 } });
  await small.page.click('#rail-nametag-btn'); await wait(400);
  check('1366×768: 이름표 버튼 보이고 화면 열림', await small.page.evaluate(() => { const r = document.getElementById('rail-nametag-btn').getBoundingClientRect(); return r.bottom <= innerHeight && document.getElementById('nametag-page').style.display === 'flex'; }));
  const zoomOk = await small.page.evaluate(() => { const z = parseFloat(document.getElementById('nt-pages').style.zoom || '1'); const sh = document.querySelector('.nt-sheet'); const sc = document.getElementById('nt-prev-scroll'); return sh.offsetHeight * z <= sc.clientHeight && sh.offsetWidth * z <= sc.clientWidth; });
  check('미리보기: 종이 한 장이 칸 안에 다 보임', zoomOk);
  const boxes = await small.page.evaluate(() => [...document.querySelectorAll('#nt-left > .nt-box')].map(b => b.scrollHeight <= b.clientHeight + 1));
  check('1366×768: 왼쪽 칸들이 눌려 잘리지 않음(패널이 스크롤)', boxes.every(Boolean) && await small.page.evaluate(() => document.getElementById('nt-font-btn').getBoundingClientRect().height >= 38), boxes);
  await small.page.evaluate(() => { document.getElementById('nt-left').scrollTop = 99999; }); await wait(200);
  await small.page.click('#nt-font-btn'); await wait(200);
  check('1366×768: 아래쪽에서 펼쳐도 목록이 화면 안', await small.page.evaluate(() => { const r = document.getElementById('nt-font-menu').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.height > 200; }));
  await small.page.screenshot({ path: 'nt-1366.png' });

  const errs = [...pc.errors, ...pc2.errors, ...small.errors, ...hr.errors];
  check('페이지 오류 없음', errs.length === 0, errs);
  console.log(failures ? ('실패 ' + failures + '건') : '모든 검사 통과');
  await browser.close();
  process.exit(failures ? 1 : 0);
})();
