// Supabase 로그 줄이기(10/8): 요청마다 로그가 1줄씩 쌓여 무료 요금제 Log Ingestion 한도를 많이 썼다.
// ① PC에서 다른 탭을 잠깐(3분 미만) 보고 돌아오면 공지·개인 자료를 다시 받지 않음(오래면 받음, 휴대폰은 늘 받음)
// ② 고정 링크(app_settings fixed_bookmarks)는 페이지를 열 때 한 번만 — 홈을 다시 그릴 때마다 다시 받지 않음
// ③ 뉴스 함수는 30분 안에 다시 열거나 새로고침하면 이 컴퓨터에 넣어 둔 것을 씀
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(process.env.HTML_PATH || path.join(ROOT, 'index.html'), 'utf8');

const T1 = '11111111-1111-1111-1111-111111111111';
const teachers = {
  [T1]: { id: T1, name: '김교사', is_admin: false, must_change_password: false, role: '교사', homeroom_grade: null, homeroom_class: null },
};
const pages = [];
const n = { notices: 0, items: 0, bookmarks: 0, news: 0 };

async function handleDb(pageInfo, req) {
  const { table, op, filters, single, maybe } = req;
  if (table === 'teachers') {
    const f = filters.find(x => x.col === 'id');
    const list = f ? [teachers[f.val]].filter(Boolean) : Object.values(teachers);
    return { data: single || maybe ? (list[0] || null) : list, error: null };
  }
  if (op === 'select' && table === 'notices') { n.notices++; return { data: [{ id: 1, created_at: '2026-10-01T06:00:00Z', msg: '공지', likes: 0, hearts: 0, author: '김교사' }], error: null }; }
  if (op === 'select' && table === 'user_data_items') { n.items++; return { data: [], error: null }; }
  if (op === 'select' && table === 'app_settings' && filters.some(f => f.val === 'fixed_bookmarks')) { n.bookmarks++; return { data: null, error: null }; }
  if (op === 'select') return { data: single || maybe ? null : [], error: null };
  return { data: null, error: null };
}
async function handleFn(pageInfo, name) {
  if (name !== 'news') return { data: null, error: { message: 'mock' } };
  n.news++;
  return { data: { fetchedAt: new Date().toISOString(), categories: { '종합': [{ title: '뉴스 ' + n.news, link: 'http://x', pubDate: '', source: '' }] } }, error: null };
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

async function openDevice(browser, name, uid, ctx) {
  const mobile = name.includes('휴대폰');
  ctx = ctx || await browser.newContext(mobile ? { viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true } : { viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  const info = { page, ctx, name, uid };
  pages.push(info);
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  info.errors = errors;
  await page.exposeFunction('__db', (q) => handleDb(info, q));
  await page.exposeFunction('__rpc', () => ({ data: null, error: null }));
  await page.exposeFunction('__fn', (name) => handleFn(info, name));
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

const wait = (ms) => new Promise(r => setTimeout(r, ms));
async function setVisibility(d, state) {
  await d.page.evaluate((s) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => s });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
}
async function hideShow(d, ms) { await setVisibility(d, 'hidden'); await wait(ms); await setVisibility(d, 'visible'); await wait(1200); }

let failures = 0;
function check(label, cond, detail) {
  console.log((cond ? '  ✅ ' : '  ❌ ') + label + (cond ? '' : '  → ' + JSON.stringify(detail)));
  if (!cond) failures++;
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }).catch(() => chromium.launch());
  console.log('[1] PC에서 다른 탭을 잠깐 보고 돌아오기');
  const pc = await openDevice(browser, 'PC', T1);
  await wait(1500);
  check('처음 열면 공지·개인 자료·고정 링크·뉴스를 받음', n.notices >= 1 && n.items >= 1 && n.bookmarks === 1 && n.news === 1, { ...n });
  check('뉴스가 화면에 보임', await pc.page.evaluate(() => document.getElementById('news-list').innerText.includes('뉴스 1')));
  let b = { ...n };
  await hideShow(pc, 300);
  await hideShow(pc, 300);
  check('잠깐 숨겼다 보이면 공지를 다시 안 받음', n.notices === b.notices, { before: b, after: { ...n } });
  check('잠깐 숨겼다 보이면 개인 자료를 다시 안 받음', n.items === b.items, { before: b, after: { ...n } });
  check('잠깐 숨겼다 보이면 뉴스도 다시 안 부름(30분 안)', n.news === b.news, { before: b, after: { ...n } });

  console.log('\n[2] 오래(기준 이상) 안 보였다가 돌아오기');
  await pc.page.evaluate(() => { PAGE_HIDDEN_RECHECK_MS = 1000; });
  b = { ...n };
  await hideShow(pc, 1300);
  check('오래 숨겼다 보이면 공지를 받음', n.notices === b.notices + 1, { before: b, after: { ...n } });
  check('오래 숨겼다 보이면 개인 자료를 받음', n.items > b.items, { before: b, after: { ...n } });
  await pc.page.evaluate(() => { PAGE_HIDDEN_RECHECK_MS = 3 * 60 * 1000; });

  console.log('\n[3] 실시간 연결이 끊겨 있으면 잠깐이어도 받음');
  await pc.page.evaluate(() => { syncRealtimeStatus = 'CHANNEL_ERROR'; });
  b = { ...n };
  await hideShow(pc, 300);
  check('개인 자료를 받음', n.items > b.items, { before: b, after: { ...n } });
  await pc.page.evaluate(() => { syncRealtimeStatus = 'SUBSCRIBED'; });

  console.log('\n[4] 고정 링크는 한 번만');
  b = { ...n };
  await pc.page.evaluate(() => { refreshDashboardFromLocalStorage(); refreshDashboardFromLocalStorage(); loadAllData(); });
  await wait(500);
  check('홈을 다시 그려도 고정 링크를 다시 안 받음', n.bookmarks === b.bookmarks, { before: b, after: { ...n } });
  check('고정 링크 칸은 그대로 그려짐', await pc.page.evaluate(() => document.querySelectorAll('#fav-grid .fav-cell, .fav-cell').length > 0));
  await pc.page.evaluate(() => loadFixedBookmarks(true)); await wait(300);
  check('설정 화면처럼 새로 받기(force)는 받음', n.bookmarks === b.bookmarks + 1, { ...n });

  console.log('\n[5] 뉴스: 새로고침해도 30분 안이면 이 컴퓨터 것을 씀');
  b = { ...n };
  await pc.page.reload();
  await pc.page.waitForFunction(() => window.currentTeacher && syncAppStarted === true, null, { timeout: 15000 });
  await wait(1000);
  check('새로고침 → 뉴스 함수 안 부름', n.news === b.news, { before: b, after: { ...n } });
  check('새로고침 → 넣어 둔 뉴스가 보임', await pc.page.evaluate(() => document.getElementById('news-list').innerText.includes('뉴스 1')));
  check('뉴스 저장 칸은 서버로 안 올림', await pc.page.evaluate(() => isLocalOnlyKey('device-news-cache') && getSyncDirtyKeys().indexOf('device-news-cache') === -1));
  await pc.page.evaluate(() => { const c = JSON.parse(localStorage.getItem('device-news-cache')); c.at = Date.now() - 31 * 60 * 1000; rawSetItem('device-news-cache', JSON.stringify(c)); });
  await hideShow(pc, 300);
  check('30분 지난 뒤 화면이 보이면 새로 받음', n.news === b.news + 1, { before: b, after: { ...n } });
  check('새 뉴스가 보임', await pc.page.evaluate(() => document.getElementById('news-list').innerText.includes('뉴스 ' + 2)), await pc.page.evaluate(() => document.getElementById('news-list').innerText));

  console.log('\n[6] 휴대폰은 잠깐 꺼졌다 켜져도 받음(화면이 꺼지면 연결이 소리 없이 죽을 수 있음)');
  const phone = await openDevice(browser, '휴대폰', T1);
  await wait(1500);
  b = { ...n };
  await hideShow(phone, 300);
  check('휴대폰 → 개인 자료를 받음', n.items > b.items, { before: b, after: { ...n } });
  check('휴대폰 → 공지를 받음', n.notices > b.notices, { before: b, after: { ...n } });

  const allErrors = pages.flatMap(p => (p.errors || []).map(e => p.name + ': ' + e));
  check('전체 페이지 오류 없음', allErrors.length === 0, allErrors);
  console.log(failures === 0 ? '\n모든 검사 통과' : '\n실패 ' + failures + '건');
  await browser.close();
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
