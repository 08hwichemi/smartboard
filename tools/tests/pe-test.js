// 레일 "양식" → 📝 수행평가(보고서): 탭 전환, 머리 표(제목·학번·이름 / 반·번호·이름 / 없음, 둘째 줄 주제), 항목(번호 자동 0/1부터·빈 줄 수·Enter·붙여 넣기),
// 쪽 나누기(머리 표는 첫 쪽만), 준비 중 종류, 초기화(수행평가만), 서버 저장, 한글 파일(표 칸·폭·글·쪽 설정).
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(process.env.HTML_PATH || path.join(ROOT, 'index.html'), 'utf8');
// 앱은 JSZip을 CDN에서 받지만 여기선 CDN이 막혀 있어 로컬 파일을 대신 준다(없으면 한글 파일 검사만 건너뜀).
const JSZIP_PATH = ['/opt/node-tools/node_modules/jszip/dist/jszip.min.js'].concat((process.env.NODE_PATH || '').split(':').map(p => path.join(p, 'jszip/dist/jszip.min.js'))).find(p => p && fs.existsSync(p));
const JSZIP_JS = JSZIP_PATH ? fs.readFileSync(JSZIP_PATH, 'utf8') : '';
// 엑셀 검사는 exceljs가 있을 때만(수업 변경 테스트와 같음 — npm i exceljs@4.4.0 후 NODE_PATH에 추가)
let EXCELJS_PATH = ''; try { EXCELJS_PATH = require.resolve('exceljs/dist/exceljs.min.js'); } catch (e) {}

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
    const g = filters.find(f => f.col === 'grade'), inF = filters.find(f => f.op === 'in' && f.col === 'class_no');
    studentSelects.push((g ? g.val : '?') + ':' + (inF ? inF.val.join(',') : '?'));
    if (failStudents) return { data: null, error: { message: 'Failed to fetch' } };
    const sizes = { 1: 5, 2: 30, 3: 45 };
    const out = [];
    (inF ? inF.val : []).forEach(k => { for (let i = 1; i <= (Number(g.val) === 3 ? (sizes[k] || 0) : 0); i++) out.push({ class_no: k, number: i, name: (k === 1 ? ['가나다', '라마바', '사아자', '차카타', '파하가'][i - 1] : '학생' + k + '-' + i) }); });
    return { data: out, error: null };
  }
  if (table === 'app_settings' && filters.some(f => f.val === 'class_structure')) return { data: { value: { gradeCount: 3, classCounts: [8, 9, 10] } }, error: null };
  if (op === 'select') return { data: single || maybe ? null : [], error: null };
  return { data: null, error: null };
}
const studentSelects = [];
let failStudents = false;

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
      gte: function(){ return b; }, lte: function(){ return b; }, in: function(c,v){ q.filters.push({op:'in',col:c,val:v}); return b; }, limit: function(){ return b; },
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
      const f = path.join(ROOT, decodeURIComponent(url.slice('http://app.test/'.length).split('?')[0]));
      if (f.startsWith(path.join(ROOT, 'forms')) && fs.existsSync(f)) return route.fulfill({ body: fs.readFileSync(f), contentType: 'application/octet-stream' });
      return route.fulfill({ status: 404, body: '' });
    }
    if (url.includes('@supabase/supabase-js')) return route.fulfill({ body: mockLib, contentType: 'application/javascript' });
    if (url.includes('/jszip') && JSZIP_JS) return route.fulfill({ body: JSZIP_JS, contentType: 'application/javascript' });
    if (url.includes('/exceljs@') && EXCELJS_PATH) return route.fulfill({ body: fs.readFileSync(EXCELJS_PATH), contentType: 'application/javascript' });
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
const cfgOf = async (d) => JSON.parse(await ls(d, 'fm-cfg') || '{}');
const sheetsOf = (P) => P.evaluate(() => [...document.querySelectorAll('#fm-pages .fm-sheet')].map(s => ({
  cls: s.dataset.cls, title: (s.querySelector('.fm-title') || {}).textContent || '', info: (s.querySelector('.fm-info') || {}).textContent || '',
  tables: [...s.querySelectorAll('table.fm-tbl')].map(t => t.rows.length),
  head: [...(s.querySelector('table.fm-tbl tr') || { cells: [] }).cells].map(c => c.textContent),
  fits: (() => { const r = s.getBoundingClientRect(); return [...s.querySelectorAll('table.fm-tbl')].every(t => t.getBoundingClientRect().bottom <= r.bottom - 15 * 3.78 * (r.width / (210 * 3.78)) + 1); })(),
})));
const setText = (P, sel, v) => P.evaluate(([sel, v]) => { const el = document.querySelector(sel); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, [sel, v]);

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }).catch(() => chromium.launch());
  const hr = await openDevice(browser, '박교사PC', T2);
  const P = hr.page;
  await P.click('#rail-forms-btn'); await P.waitForTimeout(600);
  await P.click('#fm-kind-switch [data-kind="pe"]'); await P.waitForTimeout(400);
  const vis = await P.evaluate(() => ({ pe: getComputedStyle(document.getElementById('pe-grid')).display !== 'none', ws: document.getElementById('ws-grid').style.display, fm: document.getElementById('fm-grid').style.display,
    xlsx: document.getElementById('fm-xlsx-btn').style.display, kind: JSON.parse(localStorage.getItem('fm-cfg')).kind, tabs: [...document.querySelectorAll('#fm-kind-switch .tab-btn')].map(b => b.textContent).join() }));
  check('수행평가 탭: 수행평가 칸만 보이고 엑셀 버튼 숨김, 탭 세 개', vis.pe && vis.ws === 'none' && vis.fm === 'none' && vis.xlsx === 'none' && vis.kind === 'pe' && vis.tabs === '명렬표 수합,학습지,수행평가', vis);
  const prev = () => P.evaluate(() => { const sh = [...document.querySelectorAll('#fm-pages .pe-sheet')];
    return { n: sh.length, head: sh.map(s => { const t = s.querySelector('.pe-head'); return t ? [...t.rows].map(r => [...r.cells].map(c => c.textContent)) : null; }),
      paras: sh.map(s => [...s.querySelectorAll('.pe-p')].map(d => d.textContent.replace(/ /g, ''))), w: sh[0] && sh[0].style.width,
      fit: sh.every(s => { const r = s.getBoundingClientRect(), k = r.width / s.offsetWidth, ps = s.querySelectorAll('.pe-p'); return !ps.length || ps[ps.length - 1].getBoundingClientRect().bottom <= r.bottom - parseFloat(s.style.paddingBottom) * 3.78 * k + 1; }) }; });
  const d0 = await prev();
  const types = await P.evaluate(() => [...document.querySelectorAll('#pe-types .nt-chip')].map(b => [b.dataset.type, b.classList.contains('on'), /준비 중/.test(b.textContent)]));
  check('기본: 보고서, 단어 시험만 "준비 중"', JSON.stringify(types) === JSON.stringify([['report', true, false], ['ms', false, false], ['word', false, true]]), types);
  check('기본 미리보기: A4 한 장, 머리 표 [제목|학번|빈칸|이름|빈칸] + "주제 : ", 항목 1.~3. 아래 빈 줄 4개씩', d0.n === 1 && d0.w === '210mm' && JSON.stringify(d0.head[0]) === JSON.stringify([['', '학번', '', '이름', ''], ['주제 : ']]) &&
    d0.paras[0].join('|') === ['1. ', '', '', '', '', '2. ', '', '', '', '', '3. ', '', '', '', ''].join('|'), d0);

  // 제목·항목(여러 줄 붙여 넣기 — 앞 번호 떼기)·0부터
  await setText(P, '#pe-title', '화학 기사 탐구(기사 1개당 2쪽 작성)');
  await P.click('#pe-rows .pe-row[data-i="0"] input[type="text"]');
  await P.evaluate(() => { const el = document.querySelector('#pe-rows .pe-row[data-i="0"] input[type="text"]'); const dt = new DataTransfer(); dt.setData('text/plain', '0. 두 줄 요약\n1. 기사 선정 이유\n2) 화학 기사 요약\n'); el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); });
  await P.waitForTimeout(200);
  const rows1 = await P.evaluate(() => peCfg().items.map(r => r.t));
  check('여러 줄 붙여 넣기 → 줄마다 항목(앞 번호 뗌), 빈 칸부터 채우고 나머지 빈 항목은 그대로', rows1.join('|') === '두 줄 요약|기사 선정 이유|화학 기사 요약||', rows1);
  await P.click('#pe-no [data-start="0"]'); await P.waitForTimeout(150);
  // 빈 항목 두 개 지우기(빈 칸에서 Backspace), 마지막 항목에서 Enter → 새 항목에 글
  await P.click('#pe-rows .pe-row[data-i="4"] input[type="text"]'); await P.keyboard.press('Backspace'); await P.waitForTimeout(150);
  await P.keyboard.press('Backspace'); await P.waitForTimeout(150);
  const afterDel = await P.evaluate(() => [peCfg().items.length, document.activeElement.closest('.pe-row') && document.activeElement.closest('.pe-row').dataset.i]);
  check('빈 항목에서 Backspace → 지우고 위 항목으로', afterDel[0] === 3 && afterDel[1] === '2', afterDel);
  await P.keyboard.press('Enter'); await P.waitForTimeout(150); await P.keyboard.type('참고문헌(사이트)'); await P.waitForTimeout(200);
  await P.fill('#pe-rows .pe-row[data-i="0"] .pe-gap', '2'); await P.dispatchEvent('#pe-rows .pe-row[data-i="0"] .pe-gap', 'input'); await P.waitForTimeout(150);
  const d1 = await prev();
  const nums = await P.evaluate(() => [...document.querySelectorAll('#pe-rows .ws-ol-no')].map(x => x.textContent).join());
  check('번호 0부터: 칸 번호·미리보기 "0. 두 줄 요약 … 3. 참고문헌", 첫 항목 아래 빈 줄 2, 새 항목은 위 항목 줄 수(4)', nums === '0.,1.,2.,3.' && d1.head[0][0][0] === '화학 기사 탐구(기사 1개당 2쪽 작성)' &&
    d1.paras[0].join('|') === ['0. 두 줄 요약', '', '', '1. 기사 선정 이유', '', '', '', '', '2. 화학 기사 요약', '', '', '', '', '3. 참고문헌(사이트)', '', '', '', ''].join('|'), [nums, d1]);
  await P.screenshot({ path: 'pe-report.png' });

  // 학생 칸·둘째 줄
  await P.click('#pe-who [data-who="cn"]'); await P.waitForTimeout(150);
  const hc = (await prev()).head[0];
  await P.click('#pe-who [data-who="none"]'); await P.waitForTimeout(150);
  const hn = (await prev()).head[0];
  await P.click('#pe-who [data-who="id"]'); await P.click('#pe-topic'); await P.waitForTimeout(150);
  const ht = (await prev()).head[0];
  await P.click('#pe-topic'); await setText(P, '#pe-topic-text', '기사 제목'); await P.waitForTimeout(150);
  const hl = (await prev()).head[0];
  check('학생 칸: 반·번호·이름 7칸 / 없음 1칸, 둘째 줄 끄면 한 줄, 둘째 줄 글은 적은 그대로(":" 저절로 안 붙음)', hc[0].join() === '화학 기사 탐구(기사 1개당 2쪽 작성),반,,번호,,이름,' && hn[0].length === 1 && ht.length === 1 && hl[1][0] === '기사 제목', { hc, hn, ht, hl });
  await setText(P, '#pe-topic-text', '기사 제목 :'); await P.waitForTimeout(150);
  check('":"를 직접 적으면 그대로', (await prev()).head[0][1][0] === '기사 제목 :');
  const lines = await P.evaluate(() => { const t = document.querySelector('.pe-head'), c = t.rows[0].cells; const bw = (el, s) => parseFloat(getComputedStyle(el)['border' + s + 'Width']);
    return { top: bw(c[0], 'Top') > bw(c[0], 'Bottom'), left0: getComputedStyle(c[0]).borderLeftStyle, left1: getComputedStyle(c[1]).borderLeftStyle, bot2: bw(t.rows[1].cells[0], 'Bottom') > bw(c[0], 'Bottom'), w: Math.round(t.getBoundingClientRect().width / (document.querySelector('.pe-sheet').getBoundingClientRect().width / 210)) }; });
  check('머리 표 선: 위·맨 아래 굵게, 칸 사이 세로선, 바깥 왼쪽 선 없음, 폭 = 210 − 20 − 20', lines.top && lines.left0 === 'none' && lines.left1 === 'solid' && lines.bot2 && lines.w === 170, lines);

  // 쪽 나누기: 빈 줄을 많이 두면 둘째 쪽, 머리 표는 첫 쪽만
  for (let i = 0; i < 4; i++) { await P.fill('#pe-rows .pe-row[data-i="' + i + '"] .pe-gap', '14'); await P.dispatchEvent('#pe-rows .pe-row[data-i="' + i + '"] .pe-gap', 'input'); }
  await P.waitForTimeout(200);
  const d2 = await prev();
  check('빈 줄이 많으면 다음 쪽으로(머리 표는 첫 쪽만, 쪽마다 아래 여백 안)', d2.n === 2 && d2.head[0] && d2.head[1] === null && d2.paras[1].length > 0 && d2.fit && /2쪽/.test(await P.textContent('#fm-prev-label')), { n: d2.n, fit: d2.fit });

  // 안내 글 + B4
  await setText(P, '#pe-note', '10월 20일까지 제출'); await P.click('#pe-paper [data-paper="B4"]'); await P.waitForTimeout(200);
  const d3 = await prev();
  check('안내 글은 머리 표 아래 첫 줄(한 줄 띄우고 항목), B4는 257mm', d3.paras[0][0] === '10월 20일까지 제출' && d3.paras[0][1] === '' && d3.paras[0][2] === '0. 두 줄 요약' && d3.w === '257mm', d3.paras[0].slice(0, 3));

  // 서버 저장
  await P.waitForTimeout(2500);
  const sv = JSON.parse(serverVal(T2, 'fm-pe') || '{}');
  check('수행평가 설정은 내 계정(fm-pe)에 저장', sv.title === '화학 기사 탐구(기사 1개당 2쪽 작성)' && sv.items.length === 4 && sv.noStart === 0 && sv.paper === 'B4', sv);

  // 한글 파일
  if (JSZIP_JS) {
    const hz = await P.evaluate(async () => { const zip = await JSZip.loadAsync(await peBuildHwpx(peCfg())), names = Object.keys(zip.files);
      const sec = await zip.file('Contents/section0.xml').async('string'), head = await zip.file('Contents/header.xml').async('string');
      const tbl = sec.match(/<hp:tbl [\s\S]*?<\/hp:tbl>/)[0], tw = +tbl.match(/<hp:sz width="(\d+)"/)[1];
      const row0 = tbl.split('</hp:tr>')[0], ws = [...row0.matchAll(/<hp:cellSz width="(\d+)"/g)].reduce((a, m) => a + +m[1], 0);
      const top = sec.replace(/<hp:tbl [\s\S]*?<\/hp:tbl>/, '').match(/<hp:p [^>]*>[\s\S]*?<\/hp:p>/g);
      let ok = true; try { new DOMParser().parseFromString(sec, 'application/xml').getElementsByTagName('parsererror').length && (ok = false); new DOMParser().parseFromString(head, 'application/xml').getElementsByTagName('parsererror').length && (ok = false); } catch (e) { ok = false; }
      return { first: names[0], xml: ok, rc: tbl.match(/rowCnt="(\d+)" colCnt="(\d+)"/).slice(1).join(), ws, tw, span: /colSpan="5"/.test(tbl), page: sec.match(/<hp:pagePr [^>]*>/)[0], margin: sec.match(/<hp:margin [^>]*>/)[0],
        texts: ['화학 기사 탐구(기사 1개당 2쪽 작성)', '학번', '이름', '기사 제목 :', '10월 20일까지 제출', '0. 두 줄 요약', '3. 참고문헌(사이트)'].every(t => sec.includes('<hp:t>' + fmX(t) + '</hp:t>')),
        paras: top.length, blanks: top.filter(p => /<hp:t\/>/.test(p) && !/<hp:t>/.test(p)).length, font: /face="한컴 윤고딕 240"/.test(head) && /face="함초롬바탕"/.test(head) }; });
    check('한글 파일: mimetype 맨 앞, XML 올바름, 머리 표 2줄×5칸(둘째 줄 한 칸으로 합침)·칸 폭 합 = 표 폭, B4·여백 20, 글·글꼴', hz.first === 'mimetype' && hz.xml && hz.rc === '2,5' && hz.span && hz.ws === hz.tw &&
      /width="72850" height="103181"/.test(hz.page) && /left="5669" right="5669" top="5669" bottom="5669"/.test(hz.margin) && hz.texts && hz.font, hz);
    const expBlank = 1 + 2 + 14 * 3 + 14; // 안내 뒤 1 + 항목별 빈 줄(2→14로 바꿈: 0번 14, 1~3번 14)
    check('한글 파일 문단: 머리 표 문단 1 + 안내 1 + 빈 줄 + 항목 4', hz.paras === 1 + 1 + 4 + (1 + 14 * 4) && hz.blanks === 1 + 14 * 4, { paras: hz.paras, blanks: hz.blanks });
    if (process.env.PE_OUT) { const b64 = await P.evaluate(async () => { const u8 = new Uint8Array(await (await peBuildHwpx(peCfg())).arrayBuffer()); let t = ''; u8.forEach(x => t += String.fromCharCode(x)); return btoa(t); }); fs.writeFileSync(process.env.PE_OUT, Buffer.from(b64, 'base64')); }
  } else console.log('  ⚠️ JSZip 없음 — 한글 파일 검사 건너뜀');

  // ===== ✍️ 원고지 =====
  await P.click('#pe-types [data-type="ms"]'); await P.waitForTimeout(300);
  const msPrev = () => P.evaluate(() => { const sh = [...document.querySelectorAll('#fm-pages .pe-sheet')], k = sh[0].getBoundingClientRect().width / sh[0].offsetWidth;
    return { n: sh.length, w: sh[0].style.width, tables: sh.map(s => { const t = s.querySelector('table.pe-ms'); if (!t) return null;
      const rows = [...t.rows], wr = rows.filter(r => r.cells.length === 21);
      return { write: wr.length, gap: rows.length - wr.length, counts: wr.map(r => r.cells[20].textContent).filter(Boolean), cell: Math.round(wr[0].cells[0].getBoundingClientRect().width / k / 3.78 * 10) / 10,
        bottomOk: t.getBoundingClientRect().bottom <= s.getBoundingClientRect().bottom - parseFloat(s.style.paddingBottom) * 3.78 * k + 1 }; }),
      stray: sh.some(s => /mm">/.test(s.textContent)), cols: (sh[0].querySelector('table.pe-ms colgroup') || { children: [] }).children.length,
      head: !!sh[0].querySelector('.pe-head'), head2: sh.length > 1 && !!sh[1].querySelector('.pe-head'), paper: (document.getElementById('pe-paper').querySelector('.on') || {}).dataset,
      items: getComputedStyle(document.getElementById('pe-items-box')).display, box: getComputedStyle(document.getElementById('pe-ms-box')).display, info: document.getElementById('pe-ms-info').textContent }; });
  const m0 = await msPrev();
  const t0 = m0.tables.filter(Boolean);
  check('원고지 기본: 엉뚱한 글자 없이 칸 21개(20 + 글자 수), B4(보고서와 따로), 항목 칸 대신 원고지 칸, 800자 = 40줄을 쪽마다 표로, 100자마다 "100…800"(쪽 넘어가도 이어서), 칸 9mm, 줄 사이 띠, 머리 표는 첫 쪽만, 아래 여백 안',
    !m0.stray && m0.cols === 21 && m0.w === '257mm' && m0.items === 'none' && m0.box !== 'none' && t0.reduce((a, t) => a + t.write, 0) === 40 && t0.flatMap(t => t.counts).join() === '100,200,300,400,500,600,700,800' &&
    t0.every(t => t.cell === 9 && t.gap === t.write - 1 && t.bottomOk) && m0.head && !m0.head2 && m0.n === t0.length && /40줄/.test(m0.info), m0);
  const sep0 = await P.evaluate(() => ({ title: document.getElementById('pe-title').value, topic: document.getElementById('pe-topic-text').value, who: document.querySelector('#pe-who .on').dataset.who, head: [...document.querySelector('.pe-head').rows[0].cells].map(x => x.textContent).join() }));
  check('원고지는 머리 표를 따로 기억: 처음엔 빈 제목·학번·이름·"주제 : "(보고서 제목·둘째 줄 글이 따라오지 않음)', sep0.title === '' && sep0.topic === '주제 : ' && sep0.who === 'id' && sep0.head === ',학번,,이름,', sep0);
  await setText(P, '#pe-title', '논술 수행평가'); await P.click('#pe-who [data-who="cn"]'); await P.waitForTimeout(200);
  const sep1 = await P.evaluate(() => { const v = JSON.parse(localStorage.getItem('fm-pe')); return { ms: [v.ms_title, v.ms_who], rep: [v.title, v.who] }; });
  check('원고지에서 고친 제목·학생 칸은 원고지 것(ms_title·ms_who)으로만 저장', sep1.ms.join() === '논술 수행평가,cn' && sep1.rep.join() === '화학 기사 탐구(기사 1개당 2쪽 작성),id', sep1);
  const gapRow = await P.evaluate(() => ({ cell: [...document.querySelectorAll('#pe-ms-cell .nt-chip')].map(b => b.textContent).join(), gap: [...document.querySelectorAll('#pe-ms-gap .nt-chip')].map(b => b.textContent).join(),
    below: document.getElementById('pe-ms-gap').getBoundingClientRect().top >= document.getElementById('pe-ms-cell').getBoundingClientRect().bottom - 1 }));
  check('줄 사이는 칸 크기 아래 따로 한 줄', gapRow.cell === '8mm,9mm,10mm' && gapRow.gap === '없음,2mm,3mm,4mm' && gapRow.below, gapRow);
  check('보고서 쪽 설정(B4·안내 글 등)은 그대로', await P.evaluate(() => JSON.parse(localStorage.getItem('fm-pe')).paper === 'B4' && !('ms_paper' in JSON.parse(localStorage.getItem('fm-pe')))));
  await P.click('#pe-paper [data-paper="A4"]'); await P.waitForTimeout(200);
  const msA4 = await P.evaluate(() => [JSON.parse(localStorage.getItem('fm-pe')).ms_paper, JSON.parse(localStorage.getItem('fm-pe')).paper, document.querySelector('#fm-pages .pe-sheet').style.width, document.getElementById('pe-ms-info').textContent]);
  const m1 = await msPrev();
  check('원고지에서 A4로 바꾸면 원고지만 A4(보고서는 B4 그대로), A4 폭에 맞게 칸을 줄이고 안내', msA4[0] === 'A4' && msA4[1] === 'B4' && msA4[2] === '210mm' && m1.tables[0].cell < 9 && /줄였어요/.test(msA4[3]), [msA4, m1.tables[0]]);
  await P.click('#pe-paper [data-paper="B4"]');
  await P.click('#pe-ms-chars [data-chars="1500"]'); await P.click('#pe-ms-cell [data-cell="10"]'); await P.click('#pe-ms-gap [data-gap="0"]'); await P.click('#pe-ms-color [data-color="#2E8B57"]');
  await setText(P, '#pe-ms-prompt', "제시문을 읽고 '공정'에 대해 논술하시오."); await P.waitForTimeout(300);
  const m2 = await msPrev(); const t2 = m2.tables.filter(Boolean);
  const col = await P.evaluate(() => getComputedStyle(document.querySelector('table.pe-ms td')).borderTopColor);
  check('1500자·칸 10mm·띠 없음·초록 선: 75줄, 100자마다 1500까지, 띠 줄 없음, 발문은 첫 쪽 머리 표 아래', t2.reduce((a, t) => a + t.write, 0) === 75 && t2.flatMap(t => t.counts).length === 15 && t2.flatMap(t => t.counts).pop() === '1500' &&
    t2.every(t => t.gap === 0 && t.cell === 10 && t.bottomOk) && col === 'rgb(46, 139, 87)' && await P.evaluate(() => document.querySelector('#fm-pages .pe-sheet .pe-note').textContent.includes('공정')), [m2, col]);
  const pb0 = await P.evaluate(() => ({ on: document.querySelector('#pe-ms-pbox .on').dataset.pbox, box: !!document.querySelector('#fm-pages .pe-pbox') }));
  await P.click('#pe-ms-pbox [data-pbox="1"]'); await P.waitForTimeout(200);
  const pb1 = await P.evaluate(() => { const b = document.querySelector('#fm-pages .pe-pbox'), t = document.querySelector('#fm-pages table.pe-ms');
    return { box: !!b, text: b && b.textContent.includes('공정'), border: b && getComputedStyle(b).borderTopStyle, above: b && t && b.getBoundingClientRect().bottom <= t.getBoundingClientRect().top, hmm: b && Math.round(b.getBoundingClientRect().height / (document.querySelector('.pe-sheet').getBoundingClientRect().width / 257)), saved: JSON.parse(localStorage.getItem('fm-pe')).msPromptBox }; });
  check('발문: 기본은 글씨만, "상자"를 고르면 테두리 상자 안(원고지 위, 한 줄이면 상자 높이 = 줄 하나 + 위아래 여백)', pb0.on === '0' && !pb0.box && pb1.box && pb1.text && pb1.border === 'solid' && pb1.above && pb1.saved === true && pb1.hmm <= 11, [pb0, pb1]);
  if (JSZIP_JS) {
    const bz = await P.evaluate(async () => { const sec = await (await JSZip.loadAsync(await peBuildHwpx(peCfg()))).file('Contents/section0.xml').async('string');
      const tbls = sec.match(/<hp:tbl [\s\S]*?<\/hp:tbl>/g); return { n1: tbls.filter(t => /rowCnt="1" colCnt="1"/.test(t)).length, inBox: /rowCnt="1" colCnt="1"[\s\S]*공정[\s\S]*?<\/hp:tbl>/.test(sec), title: sec.includes('<hp:t>논술 수행평가</hp:t>'), rep: !sec.includes('화학 기사 탐구') }; });
    check('한글 파일: 발문 상자 = 1칸 표 안에 발문, 원고지 제목만(보고서 제목 없음)', bz.n1 === 1 && bz.inBox && bz.title && bz.rep, bz);
  }
  await P.fill('#pe-ms-chars-in', '730'); await P.dispatchEvent('#pe-ms-chars-in', 'change'); await P.waitForTimeout(200);
  check('글자 수 직접 적기: 730 → 20자 단위로 올려 740(37줄)', await P.evaluate(() => peCfg().msChars === 740 && peLayout(peCfg()).ms.lines === 37));
  await P.click('#pe-ms-chars [data-chars="800"]'); await P.click('#pe-ms-gap [data-gap="3"]'); await P.waitForTimeout(200);
  await P.screenshot({ path: 'pe-ms.png' });
  if (JSZIP_JS) {
    const mz = await P.evaluate(async () => { const c = peCfg(), L = peLayout(c), zip = await JSZip.loadAsync(await peBuildHwpx(c));
      const sec = await zip.file('Contents/section0.xml').async('string'), head = await zip.file('Contents/header.xml').async('string');
      const tbls = sec.match(/<hp:tbl [\s\S]*?<\/hp:tbl>/g), grids = tbls.filter(t => /colCnt="21"/.test(t));
      let ok = true; try { if (new DOMParser().parseFromString(sec, 'application/xml').getElementsByTagName('parsererror').length) ok = false; } catch (e) { ok = false; }
      const g0 = grids[0], rows0 = g0.match(/<hp:tr>[\s\S]*?<\/hp:tr>/g);
      const sumW = (row) => [...row.matchAll(/<hp:cellSz width="(\d+)"/g)].reduce((a, m) => a + +m[1], 0);
      const hgt = (t) => +t.match(/<hp:sz width="\d+" widthRelTo="ABSOLUTE" height="(\d+)"/)[1], rowsH = (t) => t.match(/<hp:tr>[\s\S]*?<\/hp:tr>/g).reduce((a, r) => a + +r.match(/<hp:cellSz width="\d+" height="(\d+)"/)[1], 0);
      return { xml: ok, n: grids.length, chunks: L.ms.chunks.filter(x => x.n).length, cols: grids.every(t => /colCnt="21"/.test(t)), rows: grids.map(t => +t.match(/rowCnt="(\d+)"/)[1]),
        lines: L.ms.chunks.filter(x => x.n).map(x => x.n), w: grids.every(t => t.match(/<hp:tr>[\s\S]*?<\/hp:tr>/g).every(r => sumW(r) === +t.match(/<hp:sz width="(\d+)"/)[1])), h: grids.every(t => hgt(t) === rowsH(t)),
        counts: [...sec.matchAll(/<hp:t>(\d+00)<\/hp:t>/g)].map(m => m[1]).join(), brk: (sec.match(/pageBreak="1"/g) || []).length, span: /colSpan="20"/.test(g0), paper: /width="72850" height="103181"/.test(sec),
        color: /width="0.12 mm" color="#2E8B57"/.test(head) && /width="0.4 mm" color="#2E8B57"/.test(head) }; });
    check('원고지 한글 파일: 쪽마다 표(21칸 = 20 + 글자 수), 줄·띠 줄 수, 칸 폭 합 = 표 폭(모든 줄), 표 높이 = 줄 높이 합, 100자마다 글자 수, 둘째 표부터 쪽 나누기, 띠 = 20칸 합침, B4, 선 색(초록)',
      mz.xml && mz.n === mz.chunks && mz.cols && mz.rows.every((r, i) => r === mz.lines[i] * 2 - 1) && mz.w && mz.h && mz.counts === '100,200,300,400,500,600,700,800' && mz.brk === mz.n - 1 && mz.span && mz.paper && mz.color, mz);
    if (process.env.MS_OUT) { const b64 = await P.evaluate(async () => { const u8 = new Uint8Array(await (await peBuildHwpx(peCfg())).arrayBuffer()); let t = ''; u8.forEach(x => t += String.fromCharCode(x)); return btoa(t); }); fs.writeFileSync(process.env.MS_OUT, Buffer.from(b64, 'base64')); }
  }
  await P.click('#pe-types [data-type="report"]'); await P.waitForTimeout(200);
  check('보고서로 돌아오면 항목 칸·B4·보고서 제목·학번·이름 그대로', await P.evaluate(() => getComputedStyle(document.getElementById('pe-items-box')).display !== 'none' && peCfg().paper === 'B4' && peCfg().items.length === 4 &&
    document.getElementById('pe-title').value === '화학 기사 탐구(기사 1개당 2쪽 작성)' && document.querySelector('#pe-who .on').dataset.who === 'id'));
  await P.click('#pe-types [data-type="ms"]'); await P.waitForTimeout(200);
  check('다시 원고지로 가면 원고지 제목·반·번호·이름 그대로', await P.evaluate(() => document.getElementById('pe-title').value === '논술 수행평가' && document.querySelector('#pe-who .on').dataset.who === 'cn'));
  await P.click('#pe-types [data-type="report"]'); await P.waitForTimeout(200);

  // 준비 중 종류
  await P.evaluate(() => { window.__alerts = []; window.customAlert = async (m) => { window.__alerts.push(m); }; });
  await P.click('#pe-types [data-type="word"]'); await P.waitForTimeout(200);
  const soon = await P.evaluate(() => ({ msg: document.getElementById('fm-pages').textContent, sheets: document.querySelectorAll('#fm-pages .pe-sheet').length }));
  await P.click('#fm-hwpx-btn'); await P.waitForTimeout(200);
  check('단어 시험(준비 중): 미리보기에 안내, 한글 파일 누르면 안내 창', /다음 단계/.test(soon.msg) && soon.sheets === 0 && await P.evaluate(() => window.__alerts.some(m => /다음 단계/.test(m))), soon);
  await P.click('#pe-types [data-type="report"]'); await P.waitForTimeout(200);

  // 초기화: 수행평가만
  const wsBefore = await ls(hr, 'fm-ws');
  await P.evaluate(() => { window.customConfirm = async (m) => { window.__cm = m; return true; }; });
  await P.click('#fm-reset-btn'); await P.waitForTimeout(300);
  const rs = await P.evaluate(() => ({ m: window.__cm, c: peCfg(), title: document.getElementById('pe-title').value, kind: fmCfg().kind }));
  check('초기화: 수행평가만 기본값(제목 비움·항목 3개·A4·1부터), 탭 그대로, 학습지 설정은 그대로', /수행평가 설정/.test(rs.m) && rs.c.title === '' && rs.c.items.length === 3 && rs.c.paper === 'A4' && rs.c.noStart === 1 && rs.title === '' && rs.kind === 'pe' && (await ls(hr, 'fm-ws')) === wsBefore, rs);

  // 다른 탭 갔다 오기
  await P.click('#fm-kind-switch [data-kind="ws"]'); await P.waitForTimeout(200); await P.click('#fm-kind-switch [data-kind="pe"]'); await P.waitForTimeout(200);
  check('학습지 ↔ 수행평가 오가도 수행평가 칸 그대로', await P.evaluate(() => getComputedStyle(document.getElementById('pe-grid')).display !== 'none' && document.getElementById('ws-grid').style.display === 'none' && !!document.querySelector('#fm-pages .pe-sheet')));
  await P.setViewportSize({ width: 1366, height: 768 }); await P.waitForTimeout(300);
  const over = await P.evaluate(() => { const l = document.getElementById('fm-left'); return [...document.querySelectorAll('#pe-grid .nt-box')].filter(b => b.getBoundingClientRect().right > l.getBoundingClientRect().right + 1).map(b => b.id); });
  check('1366×768에서 수행평가 칸이 왼쪽 칸 밖으로 안 넘침', over.length === 0, over);
  await P.screenshot({ path: 'pe-1366.png' });

  const allErrors = pages.flatMap(p => (p.errors || []).map(e => p.name + ': ' + e));
  check('전체 페이지 오류 없음', allErrors.length === 0, allErrors);
  console.log(failures === 0 ? '\n모든 검사 통과' : '\n실패 ' + failures + '건');
  await browser.close();
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
