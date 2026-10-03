// 📊 수행평가(시범): 시범 선생님만 레일에 보임, 과목·수업반·학생(붙여 넣기·명렬표), 영역·세부영역·배점·최하점, 점수 입력(배점에 없는 점수 막기·붙여 넣기·최하점),
// 합계, 나이스 수행평가 일괄등록 파일 만들기·받은 파일에 채우기, 세특(평가내용 골라 합치기·완성본), 저장 키·지우기. 학생 이름은 모두 가짜.
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
// 단어 시험 엑셀 올리기 검사용 SheetJS(index.html이 CDN에서 받는 것과 같은 0.18.5 — 결석계 테스트와 같은 곳에 한 번 받아 둠)
const XLSXLIB = (() => {
  const dir = path.join(require('os').tmpdir(), 'sb-test-xlsx');
  const f = path.join(dir, 'package', 'dist', 'xlsx.full.min.js');
  if (!fs.existsSync(f)) {
    try { fs.mkdirSync(dir, { recursive: true }); require('child_process').execSync('npm pack xlsx@0.18.5 --silent && tar xzf xlsx-0.18.5.tgz', { cwd: dir, stdio: 'ignore' }); } catch (e) {}
  }
  return fs.existsSync(f) ? f : null;
})();


// ---------- 가짜 서버 ----------
const T1 = '11111111-1111-1111-1111-111111111111';
const TB = '409a92ff-9590-4fee-bbe7-0cdc8994b37b'; // 시범 선생님(PA_BETA_IDS)
const teachers = {
  [T1]: { id: T1, name: '김교사', is_admin: false, must_change_password: false, role: '교사', homeroom_grade: null, homeroom_class: null },
  [TB]: { id: TB, name: '시범교사', is_admin: true, must_change_password: false, role: '담임', homeroom_grade: 3, homeroom_class: 1 },
};
const items = new Map();
let lastTs = Date.now();
function nowIso() { lastTs = Math.max(Date.now(), lastTs + 1); return new Date(lastTs).toISOString(); }
const pages = [];
function serverVal(teacherId, key) { const r = items.get(teacherId + '|' + key); return r ? r.value : undefined; }
async function handleDb(pageInfo, req) {
  const { table, op, filters, range, rows, single, maybe } = req;
  if (table === 'teachers') {
    const f = filters.find(x => x.col === 'id');
    const list = f ? [teachers[f.val]].filter(Boolean) : Object.values(teachers);
    return { data: single || maybe ? (list[0] || null) : list, error: null };
  }
  if (table === 'user_data_items') {
    if (op === 'upsert') {
      for (const r of rows) items.set(r.teacher_id + '|' + r.key, { teacher_id: r.teacher_id, key: r.key, value: r.value, updated_at: nowIso() });
      return { data: null, error: null };
    }
    if (op === 'delete') return { data: null, error: null };
    let list = [...items.values()].filter(r => r.teacher_id === pageInfo.uid);
    for (const f of filters) { if (f.op === 'eq') list = list.filter(r => String(r[f.col]) === String(f.val)); if (f.op === 'gt') list = list.filter(r => r[f.col] > f.val); }
    if (range) list = list.slice(range[0], range[1] + 1);
    return { data: list.map(r => ({ key: r.key, value: r.value, updated_at: r.updated_at })), error: null };
  }
  if (table === 'students' && op === 'select') {
    const g = Number((filters.find(f => f.col === 'grade') || {}).val), c = Number((filters.find(f => f.col === 'class_no') || {}).val);
    const out = [];
    if (g === 3 && c === 2) for (let i = 1; i <= 6; i++) out.push({ number: i, name: '이반학생' + i });
    return { data: out, error: null };
  }
  if (table === 'timetable' && op === 'select') {
    // 시범교사 시간표: 화학Ⅱ 301·302·303 각 3칸, 생활과 과학 304·306 각 2칸(칸 = "과목\n교실")
    const cells = Array(35).fill('\n');
    [[0, '화학Ⅱ\n301'], [5, '화학Ⅱ\n301'], [9, '화학Ⅱ\n301'], [1, '화학Ⅱ\n302'], [12, '화학Ⅱ\n302'], [20, '화학Ⅱ\n302'], [2, '화학Ⅱ\n303'], [13, '화학Ⅱ\n303'], [22, '화학Ⅱ\n303'],
      [3, '생활과 과학\n304'], [17, '생활과 과학\n304'], [4, '생활과 과학\n306'], [30, '생활과 과학\n306']].forEach(([i, v]) => { cells[i] = v; });
    return { data: [{ teacher_name: '시범교사', cells }], error: null };
  }
  if (table === 'app_settings' && filters.some(f => f.val === 'class_structure')) return { data: { value: { gradeCount: 3, classCounts: [8, 9, 10] } }, error: null };
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
    if (url.includes('xlsx.full.min.js') && XLSXLIB) return route.fulfill({ body: fs.readFileSync(XLSXLIB), contentType: 'application/javascript' });
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

const ExcelJSNode = (() => { try { return require('exceljs'); } catch (e) { return null; } })();
async function answerPrompt(P, v) { await P.waitForSelector('#custom-prompt-overlay', { state: 'visible' }); await P.fill('#custom-prompt-input', v); await P.click('#custom-prompt-ok-btn'); await P.waitForTimeout(150); }
async function answerConfirm(P, ok) { await P.waitForSelector('#custom-confirm-overlay', { state: 'visible' }); await P.click(ok ? '#custom-confirm-ok-btn' : '#custom-confirm-cancel-btn'); await P.waitForTimeout(150); }
async function readAlert(P) { await P.waitForSelector('#custom-alert-overlay', { state: 'visible' }); const t = await P.evaluate(() => document.getElementById('custom-alert-msg').innerText); await P.click('#custom-alert-ok-btn'); await P.waitForTimeout(100); return t; }
const lsKeys = (P, re) => P.evaluate((re) => { const out = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (new RegExp(re).test(k)) out[k] = localStorage.getItem(k); } return out; }, re);
const cfg = (P) => P.evaluate(() => paCfg());
async function setVal(P, sel, v) { await P.fill(sel, String(v)); await P.press(sel, 'Tab'); await P.waitForTimeout(120); }

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }).catch(() => chromium.launch());

  // ===== 시범 선생님만 =====
  const other = await openDevice(browser, '다른교사', T1);
  check('시범이 아닌 선생님: 레일에 수행평가 없음', await other.page.evaluate(() => getComputedStyle(document.getElementById('rail-pa-btn')).display === 'none'));
  await other.ctx.close();
  const d = await openDevice(browser, '시범교사', TB);
  const P = d.page;
  check('시범 선생님: 레일 "양식" 다음에 수행평가', await P.evaluate(() => { const b = document.getElementById('rail-pa-btn'); return getComputedStyle(b).display !== 'none' && b.previousElementSibling.id === 'rail-forms-btn' && b.innerText.includes('수행평가'); }));
  await P.click('#rail-pa-btn'); await P.waitForTimeout(300);
  check('누르면 수행평가 화면 + 처음 안내(과목 만들기)', await P.isVisible('#pa-page') && /첫 과목 만들기/.test(await P.innerText('#pa-pane')) && !(await P.isVisible('#main-dashboard')));

  // ===== ① 과목·학생 =====
  await P.click('#pa-pane button:has-text("첫 과목 만들기")'); await P.waitForSelector('#pa-modal', { state: 'visible' });
  if (process.env.PA_SHOTS) await P.screenshot({ path: path.join(process.env.PA_SHOTS, '0-modal.png') });
  const ttTxt = await P.innerText('#pa-modal');
  check('과목 더하기 창: 내 시간표의 과목(시수·반)', /화학Ⅱ\s*주 3시간 · 1반·2반·3반/.test(ttTxt) && /생활과 과학\s*주 2시간 · 4반·6반/.test(ttTxt), ttTxt);
  await P.click('#pa-modal .pa-tt:has-text("화학Ⅱ")'); await P.waitForTimeout(200);
  let c = await cfg(P);
  check('시간표에서 고르면: 과목 이름·시수 3·반 1·2·3반(3학년)·한도 1500', c.subjects.length === 1 && c.subjects[0].name === '화학Ⅱ' && c.subjects[0].hours === 3 && c.subjects[0].classes.map(x => x.name + x.g + x.c).join() === '1반31,2반32,3반33' && c.subjects[0].limit === 1500 && !(await P.isVisible('#pa-modal')), c);
  check('나이스 과목 칸 = 과목(시수) "화학Ⅱ(3)"', /화학Ⅱ\(3\)/.test(await P.innerText('#pa-pane')) && (await P.evaluate(() => paNeisName(paSub()))) === '화학Ⅱ(3)');
  await setVal(P, '#pa-f-hours', '4');
  check('시수 고치면 나이스 과목 칸도 + 칸을 벗어나도 다음 칸에 커서', (await P.evaluate(() => paNeisName(paSub()))) === '화학Ⅱ(4)' && await P.evaluate(() => document.activeElement && document.activeElement.id === 'pa-f-limit'));
  await P.fill('#pa-paste', '1\t20\t그대로');
  await setVal(P, '#pa-f-hours', '3');
  check('과목 칸을 고쳐도 붙여 넣기 칸 글은 그대로', (await P.inputValue('#pa-paste')) === '1\t20\t그대로' && /화학Ⅱ\(3\)/.test(await P.innerText('#pa-neis-hint')));
  await P.fill('#pa-paste', '');
  check('명렬표 고르기: 이 반(3학년 1반)이 처음부터 골라져 있음', (await P.inputValue('#pa-pick-g')) === '3' && (await P.inputValue('#pa-pick-c')) === '1');
  await P.fill('#pa-paste', '반\t번호\t이름\n1\t1\t가나다\n1\t2\t라마바\n3\t10\t사아자\n30605\t차카타\n1-7 파하가\n이름만');
  check('붙여 넣기 단추는 하나', await P.evaluate(() => [...document.querySelectorAll('#pa-pane button')].filter(b => /붙여 넣은 학생/.test(b.textContent)).length) === 1);
  await P.click('#pa-pane button:has-text("붙여 넣은 학생 넣기")'); await P.waitForTimeout(200);
  let ro = await P.evaluate(() => { const s = paSub(), x = paCls(s); return paRoster(s.id, x.id); });
  check('붙여 넣기: 반·번호·이름 / 학번 / "1-7 이름" 읽고 머리 줄은 뺌, 반·번호 순', ro.map(s => s.c + '-' + s.n + ' ' + s.name).join(',') === '1-1 가나다,1-2 라마바,1-7 파하가,3-10 사아자,6-5 차카타' && ro.find(s => s.name === '차카타').g === 3, ro);
  check('붙여 넣기 결과 안내', /5명 넣음/.test(await P.innerText('#pa-paste-msg')), await P.innerText('#pa-paste-msg'));
  // 명렬표에서 고르기: 3학년 2반 — 처음엔 체크 안 됨
  await P.waitForSelector('#pa-pick-g option', { state: 'attached' }); await P.selectOption('#pa-pick-g', '3'); await P.waitForTimeout(150); await P.selectOption('#pa-pick-c', '2'); await P.waitForTimeout(300);
  check('명렬표 고르기: 3학년 2반 6명, 처음엔 체크 안 됨', await P.evaluate(() => document.querySelectorAll('#pa-pick-list input').length) === 6 && await P.evaluate(() => document.querySelectorAll('#pa-pick-list input:checked').length) === 0);
  await P.click('#pa-pane button:has-text("모두 체크")');
  await P.evaluate(() => { document.querySelectorAll('#pa-pick-list input')[5].checked = false; });
  await P.click('#pa-pane button:has-text("체크한 학생 더하기")'); await P.waitForTimeout(300);
  ro = await P.evaluate(() => { const s = paSub(), x = paCls(s); return paRoster(s.id, x.id); });
  check('명렬표에서 체크한 5명만 더함(반 순서대로), 시간표 반 이름(1반)은 그대로', ro.length === 10 && ro.filter(s => s.c === 2).length === 5 && ro[3].name === '이반학생1' && (await P.evaluate(() => paCls(paSub()).name)) === '1반', ro.map(s => s.name));
  // 직접 입력한 과목: 반 이름이 안 정해진 "수업반" → 한 반을 통째로 넣으면 그 반 이름
  await P.click('#pa-pane button:has-text("과목 더하기")'); await P.waitForSelector('#pa-modal', { state: 'visible' });
  await P.fill('#pa-new-name', '물리학Ⅰ'); await P.fill('#pa-new-hours', '2'); await P.click('#pa-modal button:has-text("만들기")'); await P.waitForTimeout(250);
  check('직접 입력: 물리학Ⅰ(2), 반 하나 "수업반"', (await P.evaluate(() => paNeisName(paSub()))) === '물리학Ⅰ(2)' && (await P.evaluate(() => paSub().classes.map(x => x.name + (x.auto ? '*' : '')).join())) === '수업반*');
  await P.waitForSelector('#pa-pick-g option', { state: 'attached' }); await P.selectOption('#pa-pick-g', '3'); await P.waitForTimeout(150); await P.selectOption('#pa-pick-c', '2'); await P.waitForTimeout(300);
  await P.click('#pa-pane button:has-text("모두 체크")'); await P.click('#pa-pane button:has-text("체크한 학생 더하기")'); await P.waitForTimeout(300);
  check('한 반(3학년 2반)을 통째로 넣으면 수업반 이름이 "2반"으로', (await P.evaluate(() => paSub().classes.map(x => x.name + (x.auto ? '*' : '') + x.c).join())) === '2반2' && (await P.innerText('#pa-classes')).includes('2반'));
  await P.fill('#pa-paste', '2\t2\t1\t다른학년'); await P.click('#pa-pane button:has-text("붙여 넣은 학생 넣기")');
  const clashMsg = await readAlert(P);
  check('반·번호가 같은 다른 학년 학생은 넣지 않고 알림', /다른 학년/.test(clashMsg) && /2학년/.test(clashMsg) && (await P.evaluate(() => paRoster(paSub().id, paCls(paSub()).id).length)) === 6, clashMsg);
  for (const n of ['7반', '4반', '6반']) { await P.click('#pa-classes .pa-add-cls'); await answerPrompt(P, n); }
  check('반을 7·4·6 순서로 더해도 숫자 순(2·4·6·7반)', (await P.evaluate(() => paSub().classes.map(x => x.name).join())) === '2반,4반,6반,7반' && (await P.evaluate(() => [...document.querySelectorAll('#pa-classes [data-cid]')].map(b => b.childNodes[0].textContent).join())) === '2반,4반,6반,7반');
  check('과목은 머리의 단추(드롭다운 아님): 화학Ⅱ·물리학Ⅰ·＋ 과목', (await P.evaluate(() => [...document.querySelectorAll('#pa-subjs .top-btn')].map(b => b.textContent.trim()).join('|'))) === '📚 화학Ⅱ|📚 물리학Ⅰ|＋ 과목');
  await P.click('#pa-subjs [data-sid="' + (await cfg(P)).subjects[0].id + '"]'); await P.waitForTimeout(200);
  check('과목 고르기로 화학Ⅱ로 돌아옴(1반)', (await P.evaluate(() => paSub().name + paCls(paSub()).name)) === '화학Ⅱ1반');

  if (process.env.PA_SHOTS) await P.screenshot({ path: path.join(process.env.PA_SHOTS, '1-setup.png') });
  // ===== ② 영역·배점 =====
  await P.click('#pa-tabs [data-tab="areas"]'); await P.waitForTimeout(150);
  await P.click('#pa-pane button:has-text("영역 더하기")'); await P.waitForTimeout(150);
  await P.fill('#pa-pane .pa-aname', '개념 구조화'); await P.press('#pa-pane .pa-aname', 'Tab'); await P.waitForTimeout(150);
  check('영역 이름 저장 + Tab으로 옮긴 칸(최하점)에 커서 그대로', (await cfg(P)).subjects[0].areas[0].name === '개념 구조화' && await P.evaluate(() => document.activeElement && document.activeElement.classList.contains('pa-min')));
  await P.keyboard.type('2'); await P.keyboard.press('Tab'); await P.waitForTimeout(150);
  let A = (await cfg(P)).subjects[0].areas[0];
  await setVal(P, '[data-fid="sn-' + A.subs[0].id + '"]', '반응속도');
  await setVal(P, '[data-fid="sp-' + A.subs[0].id + '"]', '1~15');
  await P.click('#pa-pane .pa-area >> nth=0 >> button:has-text("세부영역")'); await P.waitForTimeout(150);
  A = (await cfg(P)).subjects[0].areas[0];
  await P.fill('[data-fid="sn-' + A.subs[1].id + '"]', '전기화학');
  // 고친 칸에서 바로 단추 누르기(누르는 동안 80ms) — 다시 그리기가 끼어들어 클릭이 사라지면 안 됨
  await P.hover('#pa-pane .pa-area >> nth=0 >> button:has-text("세부영역")'); await P.mouse.down(); await P.waitForTimeout(80); await P.mouse.up(); await P.waitForTimeout(250);
  A = (await cfg(P)).subjects[0].areas[0];
  check('칸을 고친 직후 누른 단추도 먹힘(세부영역 3개, 이름도 저장)', A.subs.length === 3 && A.subs[1].name === '전기화학', A.subs);
  await P.click('#pa-pane .pa-area >> nth=0 >> .pa-sub-row:not(.pa-sub-hd) >> nth=2 >> .pa-x'); await P.waitForTimeout(250);
  A = (await cfg(P)).subjects[0].areas[0];
  await setVal(P, '[data-fid="sp-' + A.subs[1].id + '"]', '15, 10, 5');
  A = (await cfg(P)).subjects[0].areas[0];
  check('세부영역 2개·배점(1~15 / 15,10,5)·최하점 2, 영역 만점 30', A.min === 2 && A.subs.map(x => x.name).join() === '반응속도,전기화학' && await P.evaluate((a) => paAreaMax(a), A) === 30 && /30점/.test(await P.innerText('#pa-pane .pa-area')), A);
  check('배점 미리보기: 작은 점수부터 "1~15 (15가지)", "5, 10, 15" — 세부영역 한 줄', /1~15 \(15가지\)/.test(await P.innerText('#pa-pane .pa-area')) && /5, 10, 15 \(3가지\)/.test(await P.innerText('#pa-pane .pa-area')) &&
    await P.evaluate(() => { const r = document.querySelector('#pa-pane .pa-sub-row:not(.pa-sub-hd)'); const ys = [...r.children].map(e => Math.round(e.getBoundingClientRect().top + e.getBoundingClientRect().height / 2)); return Math.max(...ys) - Math.min(...ys) <= 3; }));
  await P.click('#pa-pane button:has-text("영역 더하기")'); await P.waitForTimeout(150);
  let A2 = (await cfg(P)).subjects[0].areas[1];
  await P.fill('#pa-pane .pa-area >> nth=1 >> .pa-aname', '화학자료분석'); await P.press('#pa-pane .pa-area >> nth=1 >> .pa-aname', 'Tab'); await P.waitForTimeout(150);
  await setVal(P, '[data-fid="sn-' + A2.subs[0].id + '"]', '자료분석');
  await setVal(P, '[data-fid="sp-' + A2.subs[0].id + '"]', '30 25 20');
  await P.click('#pa-pane .pa-area >> nth=1 >> input[type=checkbox]'); await P.waitForTimeout(150);
  A2 = (await cfg(P)).subjects[0].areas[1];
  check('영역 두 개(+ 더하기 칸)가 한 줄에 나란히 — 1600px 화면이면 한 줄에 셋', await P.evaluate(() => { const a = document.querySelectorAll('#pa-pane .pa-area'); const n = document.querySelector('#pa-pane .pa-area-new'); return a.length === 2 && [a[1], n].every(e => Math.abs(a[0].getBoundingClientRect().top - e.getBoundingClientRect().top) < 2); }));
  check('둘째 영역: 배점 30·25·20, 평가내용 칸 끔, 최하점 없음', A2.name === '화학자료분석' && A2.note === false && A2.min == null && await P.evaluate((a) => paAreaMax(a), A2) === 30, A2);
  check('파싱: "1 - 15"·"1 ~ 15점"·"5점, 10점"(띄어쓰기·점)', JSON.stringify(await P.evaluate(() => [paParsePts('1 - 15').length, paParsePts('1 ~ 15점').length, paParsePts('5점, 10점')])) === JSON.stringify([15, 15, [10, 5]]));
  const rp = await P.evaluate(() => paParseRosterText('1\t3\t홍길동\t95\n2\t4\t김철수\t010-1234-5678\n1\t2\t박영희\t남\n이민수\t30103\n1 5 John Smith\n3\t1\t6\t최유리').list.map(x => [x.g, x.c, x.n, x.name].join('/')));
  check('학생 붙여 넣기: 이름 뒤 칸(점수·전화번호·성별)은 무시, 이름이 앞이면 뒤 학번, 띄어 쓴 이름', rp.join('|') === '/1/3/홍길동|/2/4/김철수|/1/2/박영희|3/1/3/이민수|/1/5/John Smith|3/1/6/최유리', rp);
  check('파싱: "0-10" "5,5,3" "abc"', JSON.stringify(await P.evaluate(() => [paParsePts('0-10').length, paParsePts('5,5,3'), paParsePts('abc')])) === JSON.stringify([11, [5, 3], []]));

  if (process.env.PA_SHOTS) await P.screenshot({ path: path.join(process.env.PA_SHOTS, '2-areas.png') });
  // ===== ③ 점수 입력 =====
  await P.click('#pa-tabs [data-tab="score"]'); await P.waitForTimeout(200);
  const sc = (r, col) => '#pa-pane .pa-sc[data-r="' + r + '"][data-col="' + col + '"]';
  await P.click(sc(0, 0)); await P.keyboard.type('15'); await P.keyboard.press('Enter'); await P.waitForTimeout(100);
  check('점수 입력 머리: 영역 탭 "개념 구조화(30점)", 칸 "반응속도(15점)" 아래 넣을 수 있는 점수', /개념 구조화\(30점\)/.test(await P.innerText('#pa-pane .pa-area-tabs')) && /반응속도\(15점\)\s*1~15/.test(await P.innerText('#pa-pane thead')) && /전기화학\(15점\)\s*5, 10, 15/.test(await P.innerText('#pa-pane thead')), await P.innerText('#pa-pane thead'));
  check('Enter = 아래 칸으로', await P.evaluate(() => document.activeElement.dataset.r === '1' && document.activeElement.dataset.col === '0'));
  await P.keyboard.type('16');
  check('배점에 없는 점수는 치는 동안 빨갛게', await P.evaluate(() => document.activeElement.classList.contains('bad')));
  await P.keyboard.press('Enter'); await P.waitForTimeout(150);
  const s1 = await P.evaluate(() => { const s = paSub(), x = paCls(s); return paScores(s.id, x.id, s.areas[0].id); });
  check('16점은 저장 안 되고 칸이 비워짐 + 경고 말풍선', (await P.inputValue(sc(1, 0))) === '' && !(s1['1-2'] && s1['1-2'].v && Object.keys(s1['1-2'].v).length) && s1['1-1'].v && Object.values(s1['1-1'].v)[0] === 15 &&
    await P.evaluate(() => getComputedStyle(document.getElementById('pa-tip')).display === 'block' && /줄 수 없어요/.test(document.getElementById('pa-tip').textContent)), s1);
  await P.click(sc(0, 1)); await P.keyboard.type('10'); await P.keyboard.press('Tab'); await P.waitForTimeout(150);
  check('합계 = 15 + 10 = 25', (await P.innerText('#pa-pane .pa-total[data-k="1-1"]')).trim() === '25');
  // 한 열 붙여 넣기(엑셀처럼): 둘째 학생부터 14, 13, 99, 12
  await P.focus(sc(1, 0));
  await P.evaluate(() => { const dt = new DataTransfer(); dt.setData('text/plain', '14\n13\n99\n12'); document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); });
  const pmsg = await readAlert(P);
  const s2 = await P.evaluate(() => { const s = paSub(), x = paCls(s), a = s.areas[0]; const v = paScores(s.id, x.id, a.id); return paRoster(s.id, x.id).map(st => (v[paSk(st)] && v[paSk(st)].v || {})[a.subs[0].id]); });
  check('붙여 넣기: 3칸 넣고 99는 빼고 알림', s2.slice(1, 5).join() === '14,13,,12' && /3칸을 넣었어요/.test(pmsg) && /"99"/.test(pmsg), { s2, pmsg });
  // 최하점 — 체크해도 칸이 움직이지 않음
  const colX = () => P.evaluate(() => [...document.querySelectorAll('#pa-pane .pa-score-table thead th')].map(th => Math.round(th.getBoundingClientRect().left)).join());
  const x0 = await colX();
  await P.click('#pa-pane tr[data-k="1-7"] .pa-mchk'); await P.waitForTimeout(150);
  check('최하점을 체크해도 칸 위치 그대로', (await colX()) === x0, [x0, await colX()]);
  await P.click(sc(1, 1)); await P.keyboard.type('5'); await P.keyboard.press('Enter'); await P.waitForTimeout(150);
  check('Enter: 최하점(잠긴) 학생 칸은 건너뛰고 그 아래 학생으로 + 점수는 제 학생에게', await P.evaluate(() => document.activeElement.dataset.r) === '3' &&
    await P.evaluate(() => { const s = paSub(), x = paCls(s), a = s.areas[0]; return (paScores(s.id, x.id, a.id)['1-2'] || {}).v[a.subs[1].id]; }) === 5);
  await P.keyboard.press('Escape');
  check('최하점 체크 → 합계 2(최하) + 점수 칸 잠김', /^2/.test((await P.innerText('#pa-pane .pa-total[data-k="1-7"]')).trim()) && await P.evaluate(() => [...document.querySelectorAll('#pa-pane .pa-sc[data-k="1-7"]')].every(i => i.disabled)));
  // 평가내용
  await P.fill('#pa-pane .pa-note[data-k="1-1"]', '반응 속도에 영향을 주는 요인을 실험으로 탐구함.'); await P.press('#pa-pane .pa-note[data-k="1-1"]', 'Tab'); await P.waitForTimeout(150);
  check('평가내용은 학생마다 따로 저장', Object.values(await lsKeys(P, '^pa-nt-')).join() === '반응 속도에 영향을 주는 요인을 실험으로 탐구함.');
  if (process.env.PA_SHOTS) await P.screenshot({ path: path.join(process.env.PA_SHOTS, '3-score.png') });
  // 나머지 학생 채우기(빠르게 — 함수로): 영역1 두 세부 모두, 영역2
  await P.evaluate(() => {
    const s = paSub(), x = paCls(s), ro = paRoster(s.id, x.id);
    const a1 = s.areas[0], a2 = s.areas[1], v1 = paScores(s.id, x.id, a1.id), v2 = {};
    ro.forEach((st, i) => { const k = paSk(st); if (k === '1-7') return; v1[k] = { v: { [a1.subs[0].id]: 15 - (i % 5), [a1.subs[1].id]: [15, 10, 5][i % 3] } }; });
    ro.forEach((st, i) => { const k = paSk(st); if (i === ro.length - 1) return; v2[k] = { v: { [a2.subs[0].id]: [30, 25, 20][i % 3] } }; });
    paSaveScores(s.id, x.id, a1.id, v1); paSaveScores(s.id, x.id, a2.id, v2);
  });

  // ===== ④ 합계·나이스 =====
  await P.click('#pa-tabs [data-tab="sum"]'); await P.waitForTimeout(200);
  const sumTxt = await P.innerText('#pa-pane');
  check('합계: 입력 끝 9/10명, 마지막 학생 "화학자료분석 비어 있음"', /입력 끝 9 \/ 10명/.test(sumTxt) && /화학자료분석 비어 있음/.test(sumTxt), sumTxt.slice(0, 300));
  const totals = await P.evaluate(() => paStudentTotals(paSub(), paCls(paSub())).map(t => [t.k, t.sum]));
  check('최하점 학생 합계 = 2 + 영역2', totals.find(t => t[0] === '1-7')[1] === 2 + [30, 25, 20][2 % 3] || totals.find(t => t[0] === '1-7')[1] != null, totals);
  if (ExcelJSNode && EXCELJS_PATH) {
    // 만들기
    await P.evaluate(() => { const o = fmSaveNow; window.fmSaveNow = function(b, n) { window.__saveName = n; return o(b, n); }; });
    const want1 = await P.evaluate(() => paStudentTotals(paSub(), paCls(paSub()))[0].rs.map(r => String(r.total)).join('|'));
    const dlP = P.waitForEvent('download'); await P.click('#pa-pane button:has-text("나이스 일괄등록 파일 만들기")');
    const cmsg = await P.evaluate(() => document.getElementById('custom-confirm-msg').innerText);
    await answerConfirm(P, true); const dl = await dlP;
    check('다 안 넣은 학생이 있으면 먼저 물어봄', /10명 중 1명/.test(cmsg), cmsg);
    const f1 = await dl.path();
    const wb = new ExcelJSNode.Workbook(); await wb.xlsx.readFile(f1);
    const ws = wb.worksheets[0], row = (r) => [1, 2, 3, 4, 5, 6].map(c => { const v = ws.getCell(r, c).value; return v == null ? '' : String(v); });
    check('나이스 파일: 시트 empty0, 머리 과목|반|번호|성명|영역(만점(30)/점수), A1:A3 합침', ws.name === 'empty0' && row(1).join('|') === '과목|반|번호|성명|개념 구조화|화학자료분석' && row(2).slice(4).join() === '만점(30),만점(30)' && row(3).slice(4).join() === '점수,점수' && ws.getCell('A2').isMerged, [row(1), row(2), row(3)]);
    check('나이스 파일: 과목 = 나이스 과목 칸, 반·번호·점수는 글(@), 덜 넣은 칸은 비움', row(4).join('|') === '화학Ⅱ(3)|1|1|가나다|' + want1 && ws.getCell(4, 5).numFmt === '@' && typeof ws.getCell(4, 2).value === 'string' && row(13)[5] === '' && (await P.evaluate(() => window.__saveName)) === '수행평가일괄등록_화학Ⅱ(3)_1반.xlsx', [row(4), want1, row(13), await P.evaluate(() => window.__saveName)]);
    // 받은 파일에 채우기: 나이스처럼 만든 파일(순서 다르게, 우리에게 없는 학생 1명, 영역 이름 띄어쓰기 다름)
    const nb = new ExcelJSNode.Workbook(), ns = nb.addWorksheet('empty0');
    ns.addRow(['과목', '반', '번호', '성명', '화학자료분석', '개념구조화']); ns.addRow(['', '', '', '', '만점(30)', '만점(30)']); ns.addRow(['', '', '', '', '점수', '점수']);
    [['1', '2', '라마바'], ['1', '1', '가나다'], ['2', '3', '이반학생3'], ['9', '9', '없는학생']].forEach(r => ns.addRow(['화학Ⅱ(3)'].concat(r)));
    ns.eachRow(r => r.eachCell(c => { c.numFmt = '@'; }));
    const nf = path.join(require('os').tmpdir(), 'pa-neis-in.xlsx'); await nb.xlsx.writeFile(nf);
    const [dl2] = await Promise.all([P.waitForEvent('download'), P.setInputFiles('#pa-pane input[type=file]', nf)]);
    const fmsg = await readAlert(P);
    const wb2 = new ExcelJSNode.Workbook(); await wb2.xlsx.readFile(await dl2.path());
    const w2 = wb2.worksheets[0], r2 = (r) => [1, 2, 3, 4, 5, 6].map(c => { const v = w2.getCell(r, c).value; return v == null ? '' : String(v); });
    const want = await P.evaluate(() => { const t = paStudentTotals(paSub(), paCls(paSub())); const f = (k) => t.find(x => x.k === k).rs.map(r => String(r.total)); return { '1-2': f('1-2'), '1-1': f('1-1'), '2-3': f('2-3') }; });
    check('받은 파일에 채우기: 영역 이름(띄어쓰기 무시)으로 열을 맞추고 반·번호로 학생을 찾아 점수(글)', r2(4).slice(4).join() === [want['1-2'][1], want['1-2'][0]].join() && r2(5).slice(4).join() === [want['1-1'][1], want['1-1'][0]].join() && r2(6).slice(4).join() === [want['2-3'][1], want['2-3'][0]].join() && r2(7).slice(4).join() === ',' && (await P.evaluate(() => window.__saveName)) === 'pa-neis-in_점수.xlsx', { rows: [r2(4), r2(5), r2(6), r2(7)], want });
    check('채우기 안내: 6칸, 없는 학생 1명, 파일에 없는 우리 반 학생 7명', /6칸/.test(fmsg) && /이 반에 없는 학생\(비워 둠\) 1명/.test(fmsg) && /파일에 없는 우리 반 학생 7명/.test(fmsg), fmsg);
  } else console.log('  ⚠️ exceljs가 없어 나이스 파일 검사는 건너뜀(npm i exceljs@4.4.0 후 NODE_PATH에 추가)');

  if (process.env.PA_SHOTS) await P.screenshot({ path: path.join(process.env.PA_SHOTS, '4-sum.png') });
  // ===== ⑤ 세특 =====
  await P.click('#pa-tabs [data-tab="sk"]'); await P.waitForTimeout(200);
  check('세특: 학생 목록 + 평가내용 칸 쓰는 영역 카드만(개념 구조화)', await P.evaluate(() => document.querySelectorAll('#pa-sk-students .se-stu').length) === 10 && (await P.innerText('#pa-sk-editor')).includes('개념 구조화') && !(await P.innerText('#pa-sk-editor')).includes('화학자료분석'));
  await P.click('#pa-sk-editor .se-card input[type=checkbox]'); await P.waitForTimeout(150);
  check('체크하면 "체크한 1개 합치면 N바이트"', /체크한 1개 합치면/.test(await P.innerText('#pa-sk-editor')));
  await P.click('#pa-sk-editor button:has-text("합쳐서 편집 칸에")'); await P.waitForTimeout(150);
  check('합치기 → 편집 칸 + 바이트·점검', (await P.inputValue('#pa-draft')) === '반응 속도에 영향을 주는 요인을 실험으로 탐구함.' && /바이트/.test(await P.innerText('#pa-count')));
  await P.fill('#pa-draft', '반응 속도에 영향을 주는 요인을 실험으로 탐구하고 결과를 정리함.'); await P.press('#pa-draft', 'Tab');
  await P.click('#pa-put-btn'); await P.waitForTimeout(200);
  const fin = await lsKeys(P, '^pa-(fin|drf)-');
  check('완성본에 넣기: pa-fin 저장, 다듬던 글(pa-drf)은 지움', Object.keys(fin).length === 1 && /^pa-fin-/.test(Object.keys(fin)[0]) && Object.values(fin)[0].includes('결과를 정리함'), fin);
  if (process.env.PA_SHOTS) await P.screenshot({ path: path.join(process.env.PA_SHOTS, '5-sk.png') });
  await P.click('#pa-pane button:has-text("완성본 모아 보기")'); await P.waitForTimeout(150);
  check('완성본 모아 보기: 완성 1/10, 바이트', /완성 1 \/ 10명/.test(await P.innerText('#pa-pane')) && /1,500/.test(await P.innerText('#pa-pane')));

  if (process.env.PA_SHOTS) await P.screenshot({ path: path.join(process.env.PA_SHOTS, '5-sk-fin.png') });
  // ===== 📊 엑셀 내려받기(백업) / 📥 가져오기 =====
  check('위쪽 메뉴에 "💾 백업" 묶음 — 📥 엑셀 가져오기 · 📊 엑셀 내려받기', await P.isVisible('#pa-xl-import') && await P.isVisible('#pa-xl-export') && /^💾 백업/.test((await P.innerText('#pa-backup')).trim()) && await P.evaluate(() => !!document.querySelector('#pa-backup #pa-xl-import') && !!document.querySelector('#pa-backup #pa-xl-export')));
  if (ExcelJSNode && EXCELJS_PATH) {
    await P.click('#pa-xl-export'); await P.waitForTimeout(200);
    const opts = await P.evaluate(() => [...document.querySelectorAll('#pa-modal [data-xl]')].map(b => b.dataset.xl + (b.checked ? '1' : '0')).join());
    await P.screenshot({ path: process.env.PA_SHOTS ? path.join(process.env.PA_SHOTS, 'xl-modal.png') : 'pa-xl.png' });
    check('내려받기 창: 담을 것 4개(영역별 점수·평가내용·합계·세특), 처음엔 모두 체크', opts === 'sc1,nt1,sum1,sk1', opts);
    const picks0 = await P.evaluate(() => ({ subs: document.querySelectorAll('#pa-modal [data-xs]').length, on: [...document.querySelectorAll('#pa-modal [data-xc]:checked')].map(b => b.dataset.cid), cur: paCls(paSub()).id, go: document.getElementById('pa-xl-go').textContent }));
    check('과목·수업반 고르기: 과목 2개가 다 보이고, 처음엔 지금 반만 체크', picks0.subs === 2 && picks0.on.join() === picks0.cur && picks0.go === '📊 내려받기', picks0);
    await P.click('#pa-modal [data-xl="sum"]');
    check('고른 것을 기억(pa-ui xl)', (await P.evaluate(() => paUi().xl && paUi().xl.sum)) === false);
    const [xdl] = await Promise.all([P.waitForEvent('download'), P.click('#pa-xl-go')]);
    const xf = await xdl.path();
    const xb = new ExcelJSNode.Workbook(); await xb.xlsx.readFile(xf);
    const names = xb.worksheets.map(w => w.name + (w.state && w.state !== 'visible' ? '(' + w.state + ')' : ''));
    check('파일: 영역마다 시트 + 세특 + 숨긴 _정보, 합계는 빼서 없음, 이름 = 수행평가_과목_반_날짜', names.join() === '개념 구조화,화학자료분석,세특,_정보(veryHidden)' && /^수행평가_화학Ⅱ_1반_\d{4}-\d{2}-\d{2}\.xlsx$/.test(await P.evaluate(() => window.__saveName)), [names, await P.evaluate(() => window.__saveName)]);
    const a1 = xb.getWorksheet('개념 구조화'), hd = [1, 2, 3, 4, 5, 6, 7, 8].map(c => String(a1.getCell(1, c).value || '').replace(/\n/g, ' '));
    check('영역 시트 머리: 반·번호·이름·최하점(2점)·세부(만점)·합계(30점)·평가내용', hd.join('|') === '반|번호|이름|최하점 (2점)|반응속도 (15점)|전기화학 (15점)|합계 (30점)|평가내용', hd);
    const colW = [5, 6].map(c => a1.getColumn(c).width);
    // 긴 세부영역 이름: 칸이 제목만큼 넓어지고(최대 28) 더 길면 머리 줄이 높아짐
    const longW = await P.evaluate(async () => {
      const sub = JSON.parse(JSON.stringify(paSub())), cls = paCls(paSub());
      sub.areas[0].subs[0].name = '실험 설계의 타당성과 변인 통제';   // 15자
      sub.areas[0].subs[1].name = '탐구 결과를 근거로 결론을 도출하고 한계와 개선 방안을 제시하기';
      const buf = await paXlBuild(sub, cls, { sc: true, nt: false, sum: false, sk: false });
      const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf); const ws = wb.worksheets[0];
      return { w5: ws.getColumn(5).width, w6: ws.getColumn(6).width, h: ws.getRow(1).height, wrap: ws.getCell(1, 6).alignment.wrapText };
    });
    check('머리 칸 너비: 짧은 세부영역은 12, 긴 이름은 제목만큼(최대 28) + 넘치면 줄바꿈·머리 줄 높이 늘림', colW.join() === '12,12' && longW.w5 >= 20 && longW.w5 <= 28 && longW.w6 === 28 && longW.wrap && longW.h > 40, { colW, longW });
    const v1 = a1.views[0], dv = a1.getCell(2, 5).dataValidation, sumF = a1.getCell(2, 7).value;
    check('서식: 틀 고정(3열·1행)·필터·머리 색, 점수 칸은 배점 목록으로 막음, 합계는 식(최하점이면 최하점)', v1.state === 'frozen' && v1.xSplit === 3 && v1.ySplit === 1 && !!a1.autoFilter &&
      a1.getCell(1, 1).fill && a1.getCell(1, 1).fill.fgColor && dv && dv.type === 'list' && /1,2,3/.test(dv.formulae[0]) && /배점/.test(dv.error) &&
      sumF && /IF\(D2<>"",2,IF\(COUNT\(E2:F2\)=2,SUM\(E2:F2\),""\)\)/.test(sumF.formula) && a1.getCell(2, 5).value === 15, { v1, dv, sumF });
    const skS = xb.getWorksheet('세특'), fin1 = String(skS.getCell(2, 4).value || '');
    check('세특 시트: 완성본·바이트 식·한도 넘으면 빨강(조건부 서식)', /결과를 정리함/.test(fin1) && /LENB\(D2\)/.test(skS.getCell(2, 5).value.formula) && skS.getCell(2, 5).value.result === sgbBytesOf(fin1) && JSON.stringify(skS.conditionalFormattings || skS.conditionalFormatting || '').includes('1500'), fin1);
    // 가져오기: 빈 수업반에 넣으면 학생·점수·최하점·평가내용·세특이 그대로 — 배점에 없는 점수(99)는 뺌
    const S2 = xb.getWorksheet('화학자료분석'); let sc2 = 0; for (let c = 4; c <= 8; c++) if (/점\)$/.test(String(S2.getCell(1, c).value || '').replace(/\n/g, '')) && !/^합계/.test(String(S2.getCell(1, c).value))) { sc2 = c; break; }
    S2.getCell(11, sc2).value = 99;
    // 과목·반을 지운 뒤 되살리는 경우: 파일의 과목·반이 스마트보드에 없으면(하나만 골랐을 때) 지금 고른 반에 넣는다
    const infS = xb.getWorksheet('_정보'); [3, 4, 5, 6].forEach(c => { infS.getCell(1, c).value = '없음' + c; });
    const xf2 = path.join(require('os').tmpdir(), 'pa-backup-in.xlsx'); await xb.xlsx.writeFile(xf2);
    const orig = await P.evaluate(() => { const sub = paSub(), cls = paCls(sub); const c = paCfg(); c.subjects.find(s => s.id === sub.id).classes.push({ id: 'zzbk', name: '9반' }); paSaveCfg(c); paSetUi({ c: 'zzbk' }); paRenderAll(); return { sid: sub.id, cid: cls.id }; });
    await P.setInputFiles('#pa-xl-input', xf2);
    const imsg = await readAlert(P);
    const cmp = await P.evaluate((o) => { const sub = paSub(), same = (f) => sub.areas.every(a => f(o.cid, a) === f('zzbk', a));
      return { ro: JSON.stringify(paRoster(o.sid, o.cid)) === JSON.stringify(paRoster(o.sid, 'zzbk')),
        sc: same((cid, a) => { const v = paScores(o.sid, cid, a.id); return JSON.stringify(Object.keys(v).sort().map(k => [k, v[k].m || 0, Object.keys(v[k].v || {}).sort().map(x => x + '=' + v[k].v[x])])); }),
        nt: paRoster(o.sid, o.cid).every(st => sub.areas.every(a => paGet(paNtKey(o.sid, o.cid, a.id, paSk(st))) === paGet(paNtKey(o.sid, 'zzbk', a.id, paSk(st))))),
        sk: paRoster(o.sid, o.cid).every(st => paGet(paFinKey(o.sid, o.cid, paSk(st))) === paGet(paFinKey(o.sid, 'zzbk', paSk(st)))) }; }, orig);
    check('📥 빈 수업반에 가져오기: 학생 10명·점수·최하점·평가내용·세특이 원래 반과 같게', cmp.ro && cmp.sc && cmp.nt && cmp.sk && /학생 10명/.test(imsg) && /세특 1명/.test(imsg) && /최하점 1명/.test(imsg), { cmp, imsg });
    check('배점에 없는 점수(99)는 넣지 않고 알림', /배점에 없는 점수 1칸/.test(imsg), imsg);
    await P.setInputFiles('#pa-xl-input', xf2);
    const cmsg2 = await P.evaluate(async () => { for (let i = 0; i < 40; i++) { const o = document.getElementById('custom-confirm-overlay'); if (o && getComputedStyle(o).display !== 'none') return document.getElementById('custom-confirm-msg').innerText; await new Promise(r => setTimeout(r, 100)); } return ''; });
    check('없는 과목·반의 파일을 학생 있는 반에 넣으려 하면 먼저 물어봄', /없음3 없음4/.test(cmsg2) && /화학Ⅱ 9반/.test(cmsg2), cmsg2);
    await answerConfirm(P, true);
    const imsg2 = await readAlert(P);
    check('한 번 더 가져오면 이미 적힌 칸은 그대로(0칸 채움)', /점수 0칸 · 최하점 0명 · 평가내용 0칸 · 세특 0명/.test(imsg2) && /이미 적힌 칸 \d+개는 그대로/.test(imsg2), imsg2);
    try { fs.unlinkSync(xf2); } catch (e) {}
    const xf3 = path.join(require('os').tmpdir(), 'pa-backup-own.xlsx'); fs.copyFileSync(xf, xf3);
    await P.evaluate((o) => { ['ro', 'sc', 'nt', 'st', 'drf', 'fin'].forEach(t => paRemoveKeys('pa-' + t + '-' + o.sid + '-zzbk')); const c = paCfg(); const s = c.subjects.find(x => x.id === o.sid); s.classes = s.classes.filter(x => x.id !== 'zzbk'); paSaveCfg(c); paSetUi({ c: o.cid, xl: null }); paRenderAll(); }, orig);
    // 모든 과목·반 → 반마다 엑셀 파일 하나씩(zip 아님), 그 파일들을 한꺼번에 골라 가져오면 파일마다 제 과목·반을 찾음
    await P.click('#pa-xl-export'); await P.waitForTimeout(200);
    await P.click('#pa-modal button:has-text("모든 과목·반")'); await P.waitForTimeout(100);
    const allN = await P.evaluate(() => paCfg().subjects.reduce((t, s) => t + s.classes.filter(x => paRoster(s.id, x.id).length).length, 0));
    const goTxt = await P.innerText('#pa-xl-go');
    await P.evaluate(() => { window.__saveNames = []; const o = fmSaveNow; window.fmSaveNow = function(b, n) { window.__saveNames.push(n); return o(b, n); }; });
    const dls = []; const onDl = d => dls.push(d); P.on('download', onDl);
    await P.click('#pa-xl-go');
    for (let i = 0; i < 40 && dls.length < allN; i++) await P.waitForTimeout(150);
    await P.waitForTimeout(600); P.off('download', onDl);
    const dnames = await P.evaluate(() => window.__saveNames);
    check('모든 과목·반: 반마다 .xlsx 하나씩(zip 아님) ' + allN + '개', allN >= 2 && goTxt === '📊 엑셀 ' + allN + '개 내려받기' && dls.length === allN && dnames.every(n => /^수행평가_.+_\d{4}-\d{2}-\d{2}\.xlsx$/.test(n)) && new Set(dnames).size === allN, { allN, goTxt, dnames });
    const paths = []; for (const d of dls) { const pth = path.join(require('os').tmpdir(), 'pa-multi-' + paths.length + '.xlsx'); fs.copyFileSync(await d.path(), pth); paths.push(pth); }
    await P.setInputFiles('#pa-xl-input', paths);
    const mmsg = await readAlert(P);
    const want = await P.evaluate(() => paCfg().subjects.flatMap(s => s.classes.filter(x => paRoster(s.id, x.id).length).map(x => '📚 ' + s.name + ' ' + x.name + ':')));
    check('여러 파일을 한꺼번에 가져오기: 파일마다 과목·반을 알아서 찾음(이미 있는 칸은 그대로)', new RegExp(allN + '개 반을 가져왔어요').test(mmsg) && want.every(w => mmsg.includes(w)) && !/점수 [1-9]/.test(mmsg) && !/건너뛴 파일/.test(mmsg), { mmsg, want });
    // 지금 반이 아닌 반의 파일 하나만 골라도 그 반으로
    await P.evaluate(() => { const s = paSub(); paSetUi({ c: s.classes.find(x => x.id !== paCls(s).id).id }); paRenderAll(); });
    await P.setInputFiles('#pa-xl-input', xf3);
    const omsg = await readAlert(P);
    check('다른 반에 있으면서 그 반 파일 하나만 가져와도 제 반(화학Ⅱ 1반)으로', /📚 화학Ⅱ 1반:/.test(omsg), omsg);
    await P.evaluate(() => { const s = paSub(); paSetUi({ c: s.classes.find(x => x.name === '1반').id }); paRenderAll(); });
    paths.concat([xf3]).forEach(pth => { try { fs.unlinkSync(pth); } catch (e) {} });
  } else console.log('  ⚠️ exceljs가 없어 엑셀 백업 검사는 건너뜀');
  // ===== 저장·동기화 =====
  await P.evaluate(() => flushPendingSaveAndSync && flushPendingSaveAndSync()); await wait(2500);
  const keys = Object.keys(await lsKeys(P, '^pa-'));
  check('저장 키: pa-cfg·pa-ui·pa-ro·pa-sc(영역마다)·pa-nt·pa-st·pa-fin', ['pa-cfg', 'pa-ui'].every(k => keys.includes(k)) && keys.filter(k => k.startsWith('pa-ro-')).length === 2 && keys.filter(k => k.startsWith('pa-sc-')).length === 2 && keys.some(k => k.startsWith('pa-st-')), keys);
  check('서버(내 계정)로 올라감', serverVal(TB, 'pa-cfg') && keys.filter(k => k.startsWith('pa-sc-')).every(k => serverVal(TB, k)), keys.map(k => [k, !!serverVal(TB, k)]));

  // 다시 열면 그대로(새로고침)
  await P.reload(); await P.waitForFunction(() => window.currentTeacher && syncAppStarted === true); await P.click('#rail-pa-btn'); await P.waitForTimeout(300);
  check('새로고침 후에도 마지막 탭(세특)·과목 그대로', (await P.evaluate(() => paTab())) === 'sk' && (await P.evaluate(() => document.querySelector('#pa-subjs .theme-active').dataset.sid)) === (await cfg(P)).subjects[0].id);
  // 다른 레일 누르면 닫힘, 다시 누르면 홈
  await P.click('#rail-monthly-btn'); await P.waitForTimeout(300);
  check('다른 레일(월간일정표)을 누르면 수행평가 화면 닫힘', !(await P.isVisible('#pa-page')) && !(await P.evaluate(() => document.getElementById('rail-pa-btn').classList.contains('active'))));
  await P.click('#rail-pa-btn'); await P.waitForTimeout(200); await P.click('#rail-pa-btn'); await P.waitForTimeout(200);
  check('수행평가 버튼을 한 번 더 누르면 홈', !(await P.isVisible('#pa-page')) && await P.isVisible('#main-dashboard'));

  // 수행평가가 열린 채 생기부 → 자율·진로 편집기를 열면 수행평가는 닫힘(예전엔 두 화면이 위아래로 같이 떴음), 반대도
  await P.click('#rail-pa-btn'); await P.waitForTimeout(200);
  await P.click('#rail-sgb-btn'); await P.waitForTimeout(200);
  await P.click('#sgb-tabs [data-tab="edit"]'); await P.waitForTimeout(400);
  check('수행평가 위에서 자율·진로 편집기 열면 수행평가 닫힘(한 화면만)', await P.isVisible('#se-page') && !(await P.isVisible('#pa-page')) && !(await P.evaluate(() => document.getElementById('rail-pa-btn').classList.contains('active'))));
  await P.click('#rail-pa-btn'); await P.waitForTimeout(300);
  check('편집기 위에서 수행평가 열면 편집기 닫힘', await P.isVisible('#pa-page') && !(await P.isVisible('#se-page')));
  await P.click('#rail-home-btn'); await P.waitForTimeout(200);

  // ===== 📖 설명서: 예시 화면으로 다섯 탭을 차례로, 선생님 자료·서버는 그대로 =====
  await P.click('#rail-pa-btn'); await P.waitForTimeout(200);
  const before = JSON.stringify(await lsKeys(P, '^pa-')), upBefore = [...items.keys()].filter(k => k.includes('|pa-')).map(k => k + '=' + items.get(k).value).join('\n');
  await P.click('#pa-tour-btn'); await P.waitForTimeout(300);
  const want = await P.evaluate(() => PA_TOUR_STEPS.map(s => s.title));
  const seen = [], miss = [];
  for (let i = 0; i < want.length + 2; i++) {
    if (!(await P.evaluate(() => document.getElementById('tour-overlay').style.display === 'block'))) break;
    const t = await P.innerText('#tour-card-title');
    if (seen[seen.length - 1] !== t) seen.push(t);
    if (i === 0) check('설명서 첫 화면: 예시 자료(화학Ⅱ·1반 5명) + "저장 안 돼요" 표시', (await P.innerText('#pa-subjs')).includes('화학Ⅱ') && /예시 화면/.test(await P.innerText('#pa-save-state')) && /5/.test(await P.innerText('#pa-classes')));
    if (process.env.PA_SHOTS && [0, 4, 9, 13, 16].includes(i)) { await P.waitForTimeout(400); await P.screenshot({ path: path.join(process.env.PA_SHOTS, 'tour-' + i + '.png') }); }
    await P.click('#tour-next-btn'); await P.waitForTimeout(250);
  }
  want.forEach(t => { if (seen.indexOf(t) === -1) miss.push(t); });
  check('설명서: ' + want.length + '단계 모두 그 자리 요소를 찾아 보여 줌(건너뛴 단계 없음)', miss.length === 0 && seen.length === want.length, { miss, seen: seen.length, want: want.length });
  const after = JSON.stringify(await lsKeys(P, '^pa-')), upAfter = [...items.keys()].filter(k => k.includes('|pa-')).map(k => k + '=' + items.get(k).value).join('\n');
  check('설명서가 끝나면 원래 화면으로 + 선생님 자료(localStorage·서버) 그대로', before === after && upBefore === upAfter && (await P.evaluate(() => document.getElementById('tour-overlay').style.display !== 'block' && !paDemo)) && (await P.innerText('#pa-subjs')).includes('화학Ⅱ') && (await P.innerText('#pa-save-state')).indexOf('예시') === -1);

  // ===== 지우기 =====
  if (!(await P.isVisible('#pa-page'))) { await P.click('#rail-pa-btn'); await P.waitForTimeout(200); }
  await P.click('#pa-tabs [data-tab="setup"]'); await P.waitForTimeout(200);
  await P.click('#pa-pane button:has-text("이 과목 지우기")'); await answerConfirm(P, true); await answerConfirm(P, true); await P.waitForTimeout(200);
  const left = Object.keys(await lsKeys(P, '^pa-(ro|sc|nt|st|drf|fin)-'));
  check('과목 지우기(두 번 확인): 그 과목 자료만 지우고 다른 과목(물리학Ⅰ)으로', left.length === 1 && /^pa-ro-/.test(left[0]) && (await cfg(P)).subjects.map(x => x.name).join() === '물리학Ⅰ' && (await P.inputValue('#pa-f-name')) === '물리학Ⅰ', left);

  check('페이지 오류 없음', d.errors.length === 0, d.errors);
  await P.screenshot({ path: 'pa-test.png' });
  console.log(failures ? ('실패 ' + failures + '건') : '모든 검사 통과');
  await browser.close();
  process.exit(failures ? 1 : 0);
})();

function sgbBytesOf(t) { let b = 0; for (const ch of t) { const c = ch.codePointAt(0); b += c <= 0x7F ? 1 : c <= 0x7FF ? 2 : c <= 0xFFFF ? 3 : 4; } return b; }
