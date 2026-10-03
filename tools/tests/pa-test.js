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
  await setVal(P, '#pa-f-hours', '3');
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
  for (const n of ['7반', '4반', '6반']) { await P.click('#pa-classes .pa-add-cls'); await answerPrompt(P, n); }
  check('반을 7·4·6 순서로 더해도 숫자 순(2·4·6·7반)', (await P.evaluate(() => paSub().classes.map(x => x.name).join())) === '2반,4반,6반,7반' && (await P.evaluate(() => [...document.querySelectorAll('#pa-classes [data-cid]')].map(b => b.childNodes[0].textContent).join())) === '2반,4반,6반,7반');
  await P.selectOption('#pa-subj', (await cfg(P)).subjects[0].id); await P.waitForTimeout(200);
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
  await setVal(P, '[data-fid="sn-' + A.subs[1].id + '"]', '전기화학');
  await setVal(P, '[data-fid="sp-' + A.subs[1].id + '"]', '15, 10, 5');
  A = (await cfg(P)).subjects[0].areas[0];
  check('세부영역 2개·배점(1~15 / 15,10,5)·최하점 2, 영역 만점 30', A.min === 2 && A.subs.map(x => x.name).join() === '반응속도,전기화학' && await P.evaluate((a) => paAreaMax(a), A) === 30 && /만점 30/.test(await P.innerText('#pa-pane .pa-area')), A);
  check('배점 미리보기: "15~1 (15가지)"', /15~1/.test(await P.innerText('#pa-pane .pa-area')) && /15가지/.test(await P.innerText('#pa-pane .pa-area')));
  await P.click('#pa-pane button:has-text("영역 더하기")'); await P.waitForTimeout(150);
  let A2 = (await cfg(P)).subjects[0].areas[1];
  await P.fill('#pa-pane .pa-area >> nth=1 >> .pa-aname', '화학자료분석'); await P.press('#pa-pane .pa-area >> nth=1 >> .pa-aname', 'Tab'); await P.waitForTimeout(150);
  await setVal(P, '[data-fid="sn-' + A2.subs[0].id + '"]', '자료분석');
  await setVal(P, '[data-fid="sp-' + A2.subs[0].id + '"]', '30 25 20');
  await P.click('#pa-pane .pa-area >> nth=1 >> input[type=checkbox]'); await P.waitForTimeout(150);
  A2 = (await cfg(P)).subjects[0].areas[1];
  check('둘째 영역: 배점 30·25·20, 평가내용 칸 끔, 최하점 없음', A2.name === '화학자료분석' && A2.note === false && A2.min == null && await P.evaluate((a) => paAreaMax(a), A2) === 30, A2);
  check('파싱: "0-10" "5,5,3" "abc"', JSON.stringify(await P.evaluate(() => [paParsePts('0-10').length, paParsePts('5,5,3'), paParsePts('abc')])) === JSON.stringify([11, [5, 3], []]));

  if (process.env.PA_SHOTS) await P.screenshot({ path: path.join(process.env.PA_SHOTS, '2-areas.png') });
  // ===== ③ 점수 입력 =====
  await P.click('#pa-tabs [data-tab="score"]'); await P.waitForTimeout(200);
  const sc = (r, col) => '#pa-pane .pa-sc[data-r="' + r + '"][data-col="' + col + '"]';
  await P.click(sc(0, 0)); await P.keyboard.type('15'); await P.keyboard.press('Enter'); await P.waitForTimeout(100);
  check('점수 입력 머리: 영역 탭 "개념 구조화(30점)", 칸 "반응속도(15점)" 아래 넣을 수 있는 점수', /개념 구조화\(30점\)/.test(await P.innerText('#pa-pane .pa-area-tabs')) && /반응속도\(15점\)\s*15~1/.test(await P.innerText('#pa-pane thead')) && /전기화학\(15점\)\s*15, 10, 5/.test(await P.innerText('#pa-pane thead')), await P.innerText('#pa-pane thead'));
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
  // ===== 저장·동기화 =====
  await P.evaluate(() => flushPendingSaveAndSync && flushPendingSaveAndSync()); await wait(2500);
  const keys = Object.keys(await lsKeys(P, '^pa-'));
  check('저장 키: pa-cfg·pa-ui·pa-ro·pa-sc(영역마다)·pa-nt·pa-st·pa-fin', ['pa-cfg', 'pa-ui'].every(k => keys.includes(k)) && keys.filter(k => k.startsWith('pa-ro-')).length === 2 && keys.filter(k => k.startsWith('pa-sc-')).length === 2 && keys.some(k => k.startsWith('pa-st-')), keys);
  check('서버(내 계정)로 올라감', serverVal(TB, 'pa-cfg') && keys.filter(k => k.startsWith('pa-sc-')).every(k => serverVal(TB, k)), keys.map(k => [k, !!serverVal(TB, k)]));

  // 다시 열면 그대로(새로고침)
  await P.reload(); await P.waitForFunction(() => window.currentTeacher && syncAppStarted === true); await P.click('#rail-pa-btn'); await P.waitForTimeout(300);
  check('새로고침 후에도 마지막 탭(세특)·과목 그대로', (await P.evaluate(() => paTab())) === 'sk' && (await P.inputValue('#pa-subj')) === (await cfg(P)).subjects[0].id);
  // 다른 레일 누르면 닫힘, 다시 누르면 홈
  await P.click('#rail-monthly-btn'); await P.waitForTimeout(300);
  check('다른 레일(월간일정표)을 누르면 수행평가 화면 닫힘', !(await P.isVisible('#pa-page')) && !(await P.evaluate(() => document.getElementById('rail-pa-btn').classList.contains('active'))));
  await P.click('#rail-pa-btn'); await P.waitForTimeout(200); await P.click('#rail-pa-btn'); await P.waitForTimeout(200);
  check('수행평가 버튼을 한 번 더 누르면 홈', !(await P.isVisible('#pa-page')) && await P.isVisible('#main-dashboard'));

  // ===== 지우기 =====
  await P.click('#rail-pa-btn'); await P.waitForTimeout(200); await P.click('#pa-tabs [data-tab="setup"]'); await P.waitForTimeout(200);
  await P.click('#pa-pane button:has-text("이 과목 지우기")'); await answerConfirm(P, true); await answerConfirm(P, true); await P.waitForTimeout(200);
  const left = Object.keys(await lsKeys(P, '^pa-(ro|sc|nt|st|drf|fin)-'));
  check('과목 지우기(두 번 확인): 그 과목 자료만 지우고 다른 과목(물리학Ⅰ)으로', left.length === 1 && /^pa-ro-/.test(left[0]) && (await cfg(P)).subjects.map(x => x.name).join() === '물리학Ⅰ' && (await P.inputValue('#pa-f-name')) === '물리학Ⅰ', left);

  check('페이지 오류 없음', d.errors.length === 0, d.errors);
  await P.screenshot({ path: 'pa-test.png' });
  console.log(failures ? ('실패 ' + failures + '건') : '모든 검사 통과');
  await browser.close();
  process.exit(failures ? 1 : 0);
})();
