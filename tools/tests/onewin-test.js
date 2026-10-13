// 🪟 한 브라우저에 보드 창 하나(10/13): 같은 브라우저에 보드 창을 또 열면 먼저 있던 창은 고치던 것을
// 서버에 올린 뒤 "쉬는 창"(?sleep=1, 서버와 주고받지 않음)으로 바뀐다. 다른 기기(다른 브라우저)는 상관없음.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(process.env.HTML_PATH || path.join(ROOT, 'index.html'), 'utf8');

const T1 = '11111111-1111-1111-1111-111111111111';
const teachers = {
  [T1]: { id: T1, name: '김교사', is_admin: false, must_change_password: false, role: '교사', homeroom_grade: null, homeroom_class: null },
};
const upserts = [];   // { who, key, value }
const calls = [];     // { who, table, op }

async function handleDb(info, req) {
  const { table, op, filters, single, maybe } = req;
  calls.push({ who: info.name, table, op, at: Date.now() });
  if (table === 'teachers') {
    const f = filters.find(x => x.col === 'id');
    const list = f ? [teachers[f.val]].filter(Boolean) : Object.values(teachers);
    return { data: single || maybe ? (list[0] || null) : list, error: null };
  }
  if (op === 'upsert' && table === 'user_data_items') {
    await new Promise(r => setTimeout(r, 300)); // 서버가 조금 느려도 올린 뒤에 쉬는지
    (req.rows || []).forEach(r => upserts.push({ who: info.name, key: r.key, value: r.value }));
    return { data: (req.rows || []).map(r => ({ key: r.key, updated_at: new Date().toISOString() })), error: null };
  }
  if (op === 'select') return { data: single || maybe ? null : [], error: null };
  return { data: null, error: null };
}
async function handleFn(info, name) {
  calls.push({ who: info.name, table: 'fn:' + name, op: 'invoke', at: Date.now() });
  return { data: null, error: { message: 'mock' } };
}

// ---------- 브라우저에 심는 가짜 supabase-js ----------
const mockLib = `
(function(){
  const uid = new URLSearchParams(location.search).get('uid');
  const channels = [];
  window.__fireRealtime = function(table, payload) {
    channels.forEach(function(ch){ ch.handlers.forEach(function(h){
      if (h.opts.table !== table) return;
      h.cb(payload || {});
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
      update: function(rows){ q.op='update'; q.rows=rows; return b; },
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
      rpc: function(name, args){ return window.__rpc(name, args); },
      functions: { invoke: function(name){ return window.__fn(name); } },
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


async function openPage(ctx, name, uid, opts) {
  opts = opts || {};
  const page = await ctx.newPage();
  const info = { page, ctx, name, errors: [] };
  page.on('pageerror', e => info.errors.push(String(e)));
  await page.exposeFunction('__db', (q) => handleDb(info, q));
  await page.exposeFunction('__rpc', () => ({ data: null, error: null }));
  await page.exposeFunction('__fn', (n) => handleFn(info, n));
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
  if (!opts.noWait) await page.waitForFunction(() => window.currentTeacher && typeof syncAppStarted !== 'undefined' && syncAppStarted === true, null, { timeout: 15000 });
  return info;
}

const wait = (ms) => new Promise(r => setTimeout(r, ms));
let failures = 0;
function check(label, cond, detail) {
  console.log((cond ? '  ✅ ' : '  ❌ ') + label + (cond ? '' : '  → ' + JSON.stringify(detail)));
  if (!cond) failures++;
}
const isSleeping = (d) => d.page.evaluate(() => !!document.getElementById('sb-sleep') && getComputedStyle(document.getElementById('sb-sleep')).display !== 'none').catch(() => null);
const waitSleep = (d) => d.page.waitForFunction(() => !!document.getElementById('sb-sleep'), null, { timeout: 8000 }).then(() => true, () => false);

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }).catch(() => chromium.launch());
  const pcCtx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });

  console.log('[1] 같은 브라우저에 보드 창을 또 열면 먼저 있던 창이 쉼');
  const A = await openPage(pcCtx, '창A', T1);
  await wait(800);
  // 창 A에서 막 고친 것(아직 1.5초 기다렸다 올리기 전)
  await A.page.evaluate(() => localStorage.setItem('cal-memo-2026-10-13', 'A에서 막 쓴 메모'));
  const B = await openPage(pcCtx, '창B', T1);
  check('창 A가 쉬는 창으로 바뀜', await waitSleep(A));
  check('창 A 주소가 ?sleep=1', /\?sleep=1$/.test(A.page.url()), A.page.url());
  check('창 A가 쉬기 전에 고친 것을 서버에 올림', upserts.some(u => u.who === '창A' && u.key === 'cal-memo-2026-10-13' && u.value === 'A에서 막 쓴 메모'), upserts);
  check('창 A 제목에 (쉬는 창)', /^\(쉬는 창\)/.test(await A.page.title()), await A.page.title());
  check('창 A 로그인 화면은 안 보임', await A.page.evaluate(() => getComputedStyle(document.getElementById('login-gate-overlay')).display === 'none'));
  check('창 A 안내 글', (await A.page.evaluate(() => document.getElementById('sb-sleep').innerText)).includes('다른 창에서 열려 있어요'));
  check('창 B는 그대로 씀(쉬지 않음)', (await isSleeping(B)) === false && await B.page.evaluate(() => syncAppStarted === true));
  check('창 B 화면에 A가 올린 메모가 있음(같은 저장 공간)', await B.page.evaluate(() => localStorage.getItem('cal-memo-2026-10-13')) === 'A에서 막 쓴 메모');

  console.log('\n[2] 쉬는 창은 서버와 주고받지 않음');
  const before = calls.filter(c => c.who === '창A').length;
  await A.page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('online'));
  });
  await wait(2500);
  check('쉬는 창 A의 서버 요청 0', calls.filter(c => c.who === '창A').length === before, calls.filter(c => c.who === '창A').slice(before));
  check('쉬는 창 A는 화면을 그리지 않음(로그인 안 함)', await A.page.evaluate(() => !window.currentTeacher && syncAppStarted === false));
  check('쉬는 창 A 오류 없음', A.errors.length === 0, A.errors);

  console.log('\n[3] 다른 기기(다른 브라우저)는 상관없음');
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true });
  const P = await openPage(phoneCtx, '휴대폰', T1);
  await wait(1500);
  check('휴대폰을 열어도 PC 창 B는 그대로', (await isSleeping(B)) === false);
  check('휴대폰도 그대로 씀', (await isSleeping(P)) === false);

  console.log('\n[4] 쉬는 창에서 "이 창에서 쓰기" → 그 창이 쓰는 창, 다른 창이 쉼');
  await A.page.click('#sb-sleep-use');
  check('창 B가 쉬는 창으로 바뀜', await waitSleep(B));
  await A.page.waitForLoadState('load');
  check('창 A 주소에서 sleep이 빠짐', !/sleep=1/.test(A.page.url()), A.page.url());
  check('창 A는 쉬는 화면이 아님', (await isSleeping(A)) === false);

  console.log('\n[5] 셋째 창을 열면 둘째로 늦은 창도 쉼 / 거의 같이 열려도 하나만 남음');
  const C = await openPage(pcCtx, '창C', T1);
  await wait(1500);
  check('셋째 창 C를 열면 창 A도 쉼', await waitSleep(A));
  check('창 C는 씀', (await isSleeping(C)) === false);
  check('창 B는 계속 쉼', (await isSleeping(B)) === true);
  const [D, E] = await Promise.all([openPage(pcCtx, '창D', T1, { noWait: true }), openPage(pcCtx, '창E', T1, { noWait: true })]);
  await wait(4000);
  const awake = [];
  for (const d of [C, D, E]) if ((await isSleeping(d)) === false) awake.push(d.name);
  check('거의 같이 연 창들 중 쓰는 창은 하나', awake.length === 1, awake);

  console.log('\n[6] 저장하지 않은 감독표가 있으면 창을 떠나지 않고 덮개만');
  const ctx2 = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const F = await openPage(ctx2, '창F', T1);
  await F.page.evaluate(() => { dutyEditMode = true; window.dutyHasUnsaved = () => true; window.__keep = 'same page'; });
  const G = await openPage(ctx2, '창G', T1);
  check('창 F에 덮개', await waitSleep(F));
  check('창 F는 그 페이지 그대로(입력 안 사라짐)', await F.page.evaluate(() => window.__keep === 'same page' && !/sleep=1/.test(location.search)));
  check('덮개에 감독표 안내', (await F.page.evaluate(() => document.getElementById('sb-sleep').innerText)).includes('저장하지 않은 감독표'));
  await F.page.click('#sb-sleep-use');
  check('"이 창에서 쓰기" → 창 F 덮개 사라짐', await F.page.evaluate(() => !document.getElementById('sb-sleep') && !/^\(쉬는 창\)/.test(document.title)));
  check('그리고 창 G가 쉼', await waitSleep(G));

  console.log('\n[7] "이 창 닫기"');
  const closed = new Promise(r => G.page.once('close', () => r(true)));
  await G.page.click('#sb-sleep-close');
  const ok = await Promise.race([closed, wait(1500).then(async () => (await G.page.evaluate(() => document.getElementById('sb-sleep-hint').textContent).catch(() => '')).includes('✕'))]);
  check('창이 닫히거나, 못 닫으면 ✕ 안내', ok === true);

  console.log('\n[8] 설치한 앱 아이콘을 다시 누르면 열린 창으로(manifest)');
  const mf = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  check('manifest launch_handler = focus-existing', mf.launch_handler && [].concat(mf.launch_handler.client_mode)[0] === 'focus-existing', mf.launch_handler);

  const errs = [A, B, C, P, F].flatMap(d => d.errors);
  check('어느 창에도 오류 없음', errs.length === 0, errs);

  await browser.close();
  console.log(failures ? '\n실패 ' + failures + '건' : '\n모든 검사 통과');
  process.exit(failures ? 1 : 0);
})();
