// 레일 "양식" → 명렬표 수합: 담임 반으로 시작, 여러 반(반마다 한 장), 체크 칸·학번·비고·번갈아 색, 다단(1~3단),
// 줄 높이(자동 = 한 장에 맞춤), 큰 반은 다음 쪽으로(제목 없이 표만), 글꼴·크기, 계정에 저장,
// 한글 파일(.hwpx): mimetype 맨 앞·압축 안 함, XML이 올바른지, 표 줄·칸 수, 다단·쪽/단 나누기, 글꼴이 header에 들어가는지.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(process.env.HTML_PATH || path.join(ROOT, 'index.html'), 'utf8');
// 앱은 JSZip을 CDN에서 받지만 여기선 CDN이 막혀 있어 로컬 파일을 대신 준다(없으면 한글 파일 검사만 건너뜀).
const JSZIP_PATH = ['/opt/node-tools/node_modules/jszip/dist/jszip.min.js'].concat((process.env.NODE_PATH || '').split(':').map(p => path.join(p, 'jszip/dist/jszip.min.js'))).find(p => p && fs.existsSync(p));
const JSZIP_JS = JSZIP_PATH ? fs.readFileSync(JSZIP_PATH, 'utf8') : '';

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
  check('레일 "양식"(이름표 아래) → 양식 만들기 화면', await P.isVisible('#form-page') && await P.evaluate(() => document.getElementById('rail-nametag-btn').nextElementSibling.id === 'rail-forms-btn'));
  let sh = await sheetsOf(P);
  check('담임은 담임 반(3학년 1반)으로 시작 — 5명, 한 장', (await P.inputValue('#fm-grade')) === '3' && sh.length === 1 && sh[0].tables.join() === '6' && sh[0].info === '3학년 1반 (5명)', sh);
  check('기본 칸: 번호·이름·제출·비고, 제목 "제출 확인"', sh[0].head.join('|') === '번호|이름|제출|비고' && sh[0].title === '제출 확인', sh[0]);
  check('명렬표는 번호·이름만 요청(한 번)', studentSelects.join(' ') === '3:1', studentSelects);
  const names = await P.evaluate(() => [...document.querySelectorAll('#fm-pages table.fm-tbl tr')].slice(1, 3).map(tr => tr.cells[0].textContent + tr.cells[1].textContent));
  check('번호 순서대로 이름', names.join(',') === '1가나다,2라마바', names);

  // 반 여러 개
  await P.click('#fm-classes [data-c="2"]'); await P.waitForTimeout(500);
  sh = await sheetsOf(P);
  check('2반도 고르면 반마다 한 장(1반 5명 · 2반 30명)', sh.length === 2 && sh[1].cls === '2' && sh[1].tables.join() === '31' && sh[1].info === '3학년 2반 (30명)', sh.map(s => [s.cls, s.tables]));
  check('30명 반도 한 장에 들어감(줄 높이 자동)', sh.every(s => s.fits), sh.map(s => s.fits));
  check('반을 바꿀 때만 다시 요청', studentSelects.join(' ') === '3:1 3:1,2', studentSelects);

  // 제목·안내·칸
  await setText(P, '#fm-title', '현장체험학습 동의서');
  await setText(P, '#fm-note', '10월 10일(금)까지 제출\n부모님 서명 꼭 받기');
  await setText(P, '#fm-cols', '동의서\n회비\n\n');
  await P.check('#fm-showid'); await P.waitForTimeout(300);
  sh = await sheetsOf(P);
  const notes = await P.evaluate(() => [...document.querySelectorAll('#fm-pages .fm-sheet')[0].querySelectorAll('.fm-note')].map(n => n.textContent));
  check('제목·안내 두 줄·체크 칸(빈 줄 무시)·학번', sh[0].title === '현장체험학습 동의서' && notes.join('|') === '10월 10일(금)까지 제출|부모님 서명 꼭 받기' && sh[0].head.join('|') === '번호|학번|이름|동의서|회비|비고', [sh[0], notes]);
  const sid = await P.evaluate(() => document.querySelectorAll('#fm-pages table.fm-tbl')[1].rows[1].cells[1].textContent);
  check('학번 = 학년 + 반 2자리 + 번호 2자리', sid === '30201', sid);
  const zebra = await P.evaluate(() => [...document.querySelectorAll('#fm-pages table.fm-tbl')[0].rows].slice(1, 4).map(r => r.className));
  check('줄마다 번갈아 연한 회색(기본 켜짐)', zebra.join(',') === ',z,', zebra);
  await P.uncheck('#fm-memo'); await P.waitForTimeout(200);
  check('비고 끄기', !(await sheetsOf(P))[0].head.includes('비고'));
  await P.check('#fm-memo');
  const w = await P.evaluate(() => [...document.querySelectorAll('#fm-pages table.fm-tbl col')].slice(0, 6).map(c => parseFloat(c.style.width)));
  check('칸 폭 합 = 180mm(A4 − 여백 15mm×2)', Math.abs(w.reduce((a, b) => a + b, 0) - 180) < 0.01, w);

  // 다단
  await P.click('#fm-colsn [data-v="2"]'); await P.waitForTimeout(300);
  sh = await sheetsOf(P);
  check('2단: 30명 반이 15명씩 두 표로 한 장', sh[1].tables.join() === '16,16' && sh.length === 2, sh.map(s => s.tables));
  const tw2 = await P.evaluate(() => parseFloat(document.querySelectorAll('#fm-pages table.fm-tbl')[2].style.width));
  check('2단 표 폭 = (180 − 단 사이 8) ÷ 2 = 86mm', Math.abs(tw2 - 86) < 0.01, tw2);
  await P.click('#fm-colsn [data-v="3"]'); await P.waitForTimeout(300);
  check('3단: 10명씩 세 표', (await sheetsOf(P))[1].tables.join() === '11,11,11');
  await P.click('#fm-colsn [data-v="1"]'); await P.waitForTimeout(300);

  // 큰 반(45명) + 넓은 줄 → 다음 쪽으로, 다음 쪽은 표만
  await P.click('#fm-classes [data-c="1"]'); await P.click('#fm-classes [data-c="2"]'); await P.click('#fm-classes [data-c="3"]'); await P.waitForTimeout(500);
  await P.click('#fm-rowh [data-v="12"]'); await P.waitForTimeout(300);
  sh = await sheetsOf(P);
  const total = sh.reduce((s, x) => s + x.tables.reduce((a, b) => a + b - 1, 0), 0);
  check('45명·넓은 줄 → 여러 장, 학생 수 그대로, 다음 장은 제목 없이 표(머리 줄 다시)', sh.length >= 2 && total === 45 && sh[0].title && !sh[1].title && sh[1].head[0] === '번호' && sh.every(s => s.fits), sh.map(s => [s.title, s.tables, s.fits]));
  const pagesWide = sh.length;
  await P.click('#fm-rowh [data-v="0"]'); await P.waitForTimeout(300);
  sh = await sheetsOf(P);
  check('자동 줄 높이: 45명이면 1단은 읽을 수 있는 최소 높이(6.5mm)로 줄여도 넘쳐서 다음 장(넓게보다 적은 장), 모든 장이 종이 안', sh.length >= 2 && sh.length < pagesWide + 1 && sh.every(s => s.fits) && sh.reduce((a, x) => a + x.tables.reduce((p, q) => p + q - 1, 0), 0) === 45, sh.map(s => s.tables));
  await P.click('#fm-colsn [data-v="2"]'); await P.waitForTimeout(300);
  sh = await sheetsOf(P);
  check('2단이면 45명도 한 장(23·22)', sh.length === 1 && sh[0].tables.join() === '24,23' && sh[0].fits, sh.map(s => s.tables));
  await P.click('#fm-colsn [data-v="1"]'); await P.waitForTimeout(300);

  // 글꼴
  await P.selectOption('#fm-tfont', '함초롬바탕'); await setText(P, '#fm-tsize', '24'); await P.waitForTimeout(200);
  const tf = await P.evaluate(() => { const t = document.querySelector('#fm-pages .fm-title'); return [t.style.fontFamily, t.style.fontSize]; });
  check('제목 글꼴·크기', /함초롬바탕/.test(tf[0]) && tf[1] === '24pt', tf);
  await P.waitForTimeout(2500);
  const cfg = await cfgOf(hr);
  check('설정은 계정에 저장(fm-cfg, 학생 명단은 저장 안 함)', cfg.title === '현장체험학습 동의서' && cfg.tFont === '함초롬바탕' && cfg.rCs.join() === '3' && /현장체험학습/.test(serverVal(T2, 'fm-cfg') || '') && !/가나다|학생3-1/.test(serverVal(T2, 'fm-cfg') || ''), cfg);

  // 한글 파일
  if (!JSZIP_JS) console.log('  ⚠️ JSZip 없음 — 한글 파일 검사 건너뜀');
  else {
    await P.click('#fm-classes [data-c="1"]'); await P.click('#fm-classes [data-c="2"]'); await P.click('#fm-colsn [data-v="2"]'); await P.waitForTimeout(500);
    await P.screenshot({ path: 'fm-ui.png' });
    const dl = P.waitForEvent('download');
    await P.click('#fm-hwpx-btn');
    const d = await dl;
    // (헤드리스 크롬은 한글 파일 이름을 "download"로 바꿔 버려서, 앱이 정한 이름을 따로 확인)
    const fname = await P.evaluate(() => fmFileName(fmCfg()));
    const buf = fs.readFileSync(await d.path());
    if (process.env.HWPX_OUT) fs.writeFileSync(process.env.HWPX_OUT, buf);
    check('한글 파일 이름: 제목 + 반', fname === '현장체험학습 동의서 3학년 1·2·3반.hwpx', fname);
    // zip 첫 항목: mimetype, 압축 안 함(0), 내용 application/hwp+zip
    const nameLen = buf.readUInt16LE(26), first = buf.slice(30, 30 + nameLen).toString(), method = buf.readUInt16LE(8);
    const mime = buf.slice(30 + nameLen + buf.readUInt16LE(28), 30 + nameLen + buf.readUInt16LE(28) + 19).toString();
    check('zip 맨 앞 mimetype · 압축 안 함 · application/hwp+zip', buf.slice(0, 4).toString('hex') === '504b0304' && first === 'mimetype' && method === 0 && mime === 'application/hwp+zip', [first, method, mime]);
    const info = await P.evaluate(async (b64) => {
      const zip = await JSZip.loadAsync(b64, { base64: true });
      const names = Object.keys(zip.files);
      const parse = async (n) => { const x = await zip.file(n).async('string'); const d = new DOMParser().parseFromString(x, 'application/xml'); return d.getElementsByTagName('parsererror').length ? null : d; };
      const sec = await parse('Contents/section0.xml'), head = await parse('Contents/header.xml');
      if (!sec || !head) return { bad: true, names };
      const NS_P = 'http://www.hancom.co.kr/hwpml/2011/paragraph', NS_H = 'http://www.hancom.co.kr/hwpml/2011/head';
      const tbls = [...sec.getElementsByTagNameNS(NS_P, 'tbl')];
      const fontsHangul = [...head.getElementsByTagNameNS(NS_H, 'fontface')].find(f => f.getAttribute('lang') === 'HANGUL');
      const cnt = (tag) => { const el = head.getElementsByTagNameNS(NS_H, tag)[0]; return [+el.getAttribute('itemCnt'), el.children.length]; };
      const texts = [...sec.getElementsByTagNameNS(NS_P, 't')].map(t => t.textContent);
      const paras = [...sec.documentElement.children];
      return {
        names, secPr: sec.getElementsByTagNameNS(NS_P, 'secPr').length,
        tables: tbls.map(t => [+t.getAttribute('rowCnt'), +t.getAttribute('colCnt'), t.getElementsByTagNameNS(NS_P, 'tr').length, t.getAttribute('repeatHeader')]),
        cols: [...sec.getElementsByTagNameNS(NS_P, 'colPr')].map(c => c.getAttribute('colCount')),
        pageBreaks: paras.filter(p => p.getAttribute('pageBreak') === '1').length, colBreaks: paras.filter(p => p.getAttribute('columnBreak') === '1').length,
        fonts: [...fontsHangul.children].map(f => f.getAttribute('face')), fontCnt: +fontsHangul.getAttribute('fontCnt'),
        counts: [cnt('charProperties'), cnt('paraProperties'), cnt('borderFills')],
        cellWidthsOk: tbls.every(t => { const w = +t.getElementsByTagNameNS(NS_P, 'sz')[0].getAttribute('width'); const row = t.getElementsByTagNameNS(NS_P, 'tr')[0]; return [...row.getElementsByTagNameNS(NS_P, 'cellSz')].reduce((s, c) => s + +c.getAttribute('width'), 0) === w; }),
        hasTitle: texts.includes('현장체험학습 동의서'), hasName: texts.includes('학생2-30'), hasId: texts.includes('30230'),
        prv: await zip.file('Preview/PrvText.txt').async('string'),
      };
    }, buf.toString('base64'));
    check('XML이 올바르고 필요한 파일이 다 있음(미리보기 그림은 뺌)', !info.bad && ['mimetype', 'version.xml', 'Contents/header.xml', 'Contents/section0.xml', 'Contents/content.hpf', 'META-INF/container.xml', 'settings.xml'].every(n => info.names.includes(n)) && !info.names.includes('Preview/PrvImage.png'), info.names);
    check('표: 3반 × 2단 = 6개, 반 인원 + 머리 줄, 머리 줄 반복, 칸 폭 합 = 표 폭', info.tables.length === 6 && info.tables.map(t => t[0]).join() === '4,3,16,16,24,23' && info.tables.every(t => t[2] === t[0] && t[1] === 6 && t[3] === '1') && info.cellWidthsOk, info.tables);
    check('다단: 제목은 1단, 표는 2단 / 반마다 새 쪽(쪽 나누기 2), 둘째 표는 단 나누기(3)', info.secPr === 1 && info.cols.join() === '1,2,1,2,1,2' && info.pageBreaks === 2 && info.colBreaks === 3, info);
    check('글꼴이 header에 들어감(함초롬바탕 = 기본에 있음, 맑은 고딕 추가) + 개수 맞음', info.fonts.includes('함초롬바탕') && info.fonts.includes('맑은 고딕') && info.fontCnt === info.fonts.length && info.counts.every(c => c[0] === c[1]), info);
    check('글자: 제목·이름·학번이 들어감, 미리보기 글도', info.hasTitle && info.hasName && info.hasId && /현장체험학습/.test(info.prv), info);
  }

  // 칸 너비: 직접 적기·꽉 차게 끄기·모두 자동
  await P.click('#fm-colsn [data-v="1"]'); await P.waitForTimeout(200);
  const colW = () => P.evaluate(() => [...document.querySelectorAll('#fm-pages table.fm-tbl')[0].querySelectorAll('col')].map(c => +parseFloat(c.style.width).toFixed(1)));
  const tblBox = () => P.evaluate(() => { const t = document.querySelector('#fm-pages table.fm-tbl'), col = t.parentElement; return { w: parseFloat(t.style.width), left: t.getBoundingClientRect().left - col.getBoundingClientRect().left, right: col.getBoundingClientRect().right - t.getBoundingClientRect().right }; });
  const wl = await P.evaluate(() => [...document.querySelectorAll('#fm-widths .fm-w span')].map(s => s.textContent));
  check('칸 너비 입력칸: 칸마다 하나(번호·학번·이름·체크 칸·비고)', wl.join('|') === '번호|학번|이름|동의서|회비|비고', wl);
  await P.fill('#fm-widths input[data-wk="chk:회비"]', '30'); await P.waitForTimeout(200);
  let cw = await colW();
  check('체크 칸 너비를 적으면 그 너비(30mm), 나머지는 비고가 채워 여전히 180mm', cw[4] === 30 && Math.abs(cw.reduce((a, b) => a + b, 0) - 180) < 0.1, cw);
  await P.fill('#fm-widths input[data-wk="memo"]', '20'); await P.uncheck('#fm-fill'); await P.waitForTimeout(200);
  cw = await colW(); let tb = await tblBox();
  check('비고 20mm + "꽉 차게" 끄기 → 표가 필요한 만큼만(180mm보다 좁게), 가운데', cw[5] === 20 && tb.w < 179 && Math.abs(tb.left - tb.right) < 1, [cw, tb]);
  check('자동 칸은 회색 예시로 지금 너비가 보임', await P.evaluate(() => document.querySelector('#fm-widths input[data-wk="name"]').placeholder) === '24.0');
  await P.fill('#fm-widths input[data-wk="name"]', '170'); await P.waitForTimeout(200);
  tb = await tblBox();
  check('적은 너비 합이 종이보다 넓으면 비율대로 줄여서 180mm 안', tb.w <= 180.01 && /비율대로 줄였어요/.test(await P.textContent('#fm-width-info')), [tb, await P.textContent('#fm-width-info')]);
  await P.fill('#fm-widths input[data-wk="name"]', ''); await P.waitForTimeout(200);
  if (JSZIP_JS) {
    const narrowW = await P.evaluate(async () => { const zip = await JSZip.loadAsync(await fmBuildHwpx(fmCfg())); const x = await zip.file('Contents/section0.xml').async('string'); return [+x.match(/<hp:sz width="(\d+)"/)[1], fmHu(fmLayout(fmCfg()).tableW)]; });
    check('한글 파일 표 폭도 같은 폭(꽉 차게 끈 너비)', narrowW[0] === narrowW[1] && narrowW[0] < 50000, narrowW);
  }
  await P.click('#fm-width-box .nt-chip'); await P.check('#fm-fill'); await P.waitForTimeout(200);
  cw = await colW();
  check('"모두 자동" → 다시 180mm, 입력칸 비움', Math.abs(cw.reduce((a, b) => a + b, 0) - 180) < 0.1 && (await cfgOf(hr)).colW && !Object.keys((await cfgOf(hr)).colW).length, cw);

  // 글꼴: 경기천년체, 직접 입력
  const fontOpts = await P.evaluate(() => [...document.querySelectorAll('#fm-tfont option')].map(o => o.value));
  check('글꼴 목록에 경기천년제목·경기천년바탕 + 직접 입력', ['경기천년제목 Bold', '경기천년제목 Medium', '경기천년바탕 Regular', '경기천년바탕 Bold', '__custom'].every(f => fontOpts.includes(f)), fontOpts);
  await P.selectOption('#fm-tfont', '경기천년제목 Bold'); await P.selectOption('#fm-bfont', '경기천년바탕 Regular'); await P.waitForTimeout(200);
  let fc = await cfgOf(hr);
  check('경기천년체 고르면 저장(이 PC에 없으면 첫 이름 그대로) + 없다는 안내', fc.tFont === '경기천년제목 Bold' && fc.bFont === '경기천년바탕 Regular' && /이 PC에 없어서/.test(await P.textContent('#fm-font-msg')), [fc.tFont, fc.bFont]);
  if (JSZIP_JS) {
    const faces = await P.evaluate(async () => { const zip = await JSZip.loadAsync(await fmBuildHwpx(fmCfg())); const x = await zip.file('Contents/header.xml').async('string'); return (x.match(/<hh:fontface lang="HANGUL"[\s\S]*?<\/hh:fontface>/)[0].match(/face="[^"]+"/g) || []).join(','); });
    check('한글 파일 글꼴에 경기천년제목 Bold·경기천년바탕 Regular', /경기천년제목 Bold/.test(faces) && /경기천년바탕 Regular/.test(faces), faces);
  }
  await P.selectOption('#fm-tfont', '__custom'); await P.waitForTimeout(200);
  check('직접 입력을 고르면 이름 칸이 보임', await P.isVisible('#fm-tfont-custom'));
  await P.fill('#fm-tfont-custom', '우리학교체'); await P.waitForTimeout(200);
  check('직접 적은 글꼴 이름으로 저장·미리보기', (await cfgOf(hr)).tFont === '우리학교체' && /우리학교체/.test(await P.evaluate(() => document.querySelector('#fm-pages .fm-title').style.fontFamily)) && await P.inputValue('#fm-tfont') === '__custom');
  await P.selectOption('#fm-tfont', '맑은 고딕'); await P.waitForTimeout(200);
  check('목록 글꼴로 돌아가면 이름 칸 숨김', !(await P.isVisible('#fm-tfont-custom')) && (await cfgOf(hr)).tFont === '맑은 고딕');

  // 직접 입력 명단(엑셀·한글 표 복사)
  const before = studentSelects.length;
  await P.click('#fm-src-switch [data-src="manual"]'); await P.waitForTimeout(200);
  check('"직접 입력" → 명단 칸, 비어 있으면 안내', await P.isVisible('#fm-manual') && !(await P.isVisible('#fm-grade')) && /직접 입력/.test(await P.locator('#fm-pages').innerText()));
  await setText(P, '#fm-mlabel', '방과후 A반');
  await setText(P, '#fm-manual', '번호\t이름\n1\t홍길동\n2\t김철수\n30103 이영희\n박민수\n\n5번 최지우\n3\t1\t7\t한소희');
  await P.waitForTimeout(300);
  await P.evaluate(() => { document.getElementById('fm-widths').scrollIntoView(); });
  await P.screenshot({ path: 'fm-manual.png' });
  const mrows = await P.evaluate(() => [...document.querySelectorAll('#fm-pages table.fm-tbl tr')].slice(1).map(tr => [...tr.cells].slice(0, 3).map(c => c.textContent).join(' ')));
  sh = await sheetsOf(P);
  check('붙여 넣은 명단: 머리 줄 건너뜀, 탭·띄어쓰기, 학번(30103 → 3번), 번호 없으면 이어서, "5번", 학년 반 번호', mrows.join(',') === '1  홍길동,2  김철수,3 30103 이영희,4  박민수,5  최지우,7 30107 한소희', mrows);
  check('한 장, 정보 줄은 명단 이름(6명), 서버에 학생 요청 안 함', sh.length === 1 && sh[0].info === '방과후 A반 (6명)' && studentSelects.length === before, [sh, studentSelects.length - before]);
  check('파일 이름: 제목 + 명단 이름', await P.evaluate(() => fmFileName(fmCfg())) === '현장체험학습 동의서 방과후 A반.hwpx');
  if (JSZIP_JS) {
    const mt = await P.evaluate(async () => { const zip = await JSZip.loadAsync(await fmBuildHwpx(fmCfg())); const x = await zip.file('Contents/section0.xml').async('string'); return [(x.match(/<hp:tbl /g) || []).length, /한소희/.test(x), /방과후 A반 \(6명\)/.test(x)]; });
    check('직접 입력 명단으로 한글 파일', mt[0] === 1 && mt[1] && mt[2], mt);
  }
  await P.click('#fm-src-switch [data-src="class"]'); await P.waitForTimeout(400);
  check('반 명단으로 돌아가면 반 고르기(직접 입력한 명단은 남아 있음)', await P.isVisible('#fm-grade') && /한소희/.test((await cfgOf(hr)).manual));

  // 못 받는 반 → 안내, 다시 그려도 재요청 안 함
  failStudents = true;
  await P.click('#fm-classes [data-c="4"]'); await P.waitForTimeout(500);
  const n0 = studentSelects.length;
  await setText(P, '#fm-title', '다시'); await setText(P, '#fm-title', '다시2'); await P.waitForTimeout(300);
  check('명렬표를 못 받으면 안내 + 글을 고쳐도 다시 요청 안 함', /불러오지 못했어요/.test(await P.locator('#fm-pages').innerText()) && studentSelects.length === n0, studentSelects.slice(-3));
  failStudents = false;

  // 다른 화면으로 가면 닫힘
  await P.click('#rail-nametag-btn'); await P.waitForTimeout(300);
  check('이름표를 누르면 양식 화면이 닫힘', !(await P.isVisible('#form-page')) && await P.isVisible('#nametag-page') && !(await P.evaluate(() => document.getElementById('rail-forms-btn').classList.contains('active'))));
  await P.click('#rail-forms-btn'); await P.waitForTimeout(300);
  await P.click('#rail-forms-btn'); await P.waitForTimeout(300);
  check('양식 버튼을 한 번 더 누르면 홈', !(await P.isVisible('#form-page')) && await P.isVisible('#main-dashboard'));

  // 담임이 아니면 빈 화면에서 시작
  const t1 = await openDevice(browser, '김교사PC', T1);
  await t1.page.click('#rail-forms-btn'); await t1.page.waitForTimeout(400);
  check('담임이 아니면 학년·반을 고르라는 안내', /학년·반/.test(await t1.page.locator('#fm-pages').innerText()));

  const allErrors = pages.flatMap(p => (p.errors || []).map(e => p.name + ': ' + e));
  check('전체 페이지 오류 없음', allErrors.length === 0, allErrors);
  console.log(failures === 0 ? '\n모든 검사 통과' : '\n실패 ' + failures + '건');
  await browser.close();
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
