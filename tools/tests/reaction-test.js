// 공지 👍❤️: 다른 선생님이 누른 것까지 합친 전체 숫자가 모두에게 보이는지,
// 그리고 숫자만 바뀔 때는 공지 목록을 다시 받지 않는지(Supabase 사용량) 확인한다.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(process.env.HTML_PATH || path.join(ROOT, 'index.html'), 'utf8');

// ---------- 가짜 서버 ----------
const T1 = '11111111-1111-1111-1111-111111111111';
const T2 = '22222222-2222-2222-2222-222222222222';
const teachers = {
  [T1]: { id: T1, name: '김교사', is_admin: false, must_change_password: false, role: '교사', homeroom_grade: null, homeroom_class: null },
  [T2]: { id: T2, name: '박교사', is_admin: false, must_change_password: false, role: '교사', homeroom_grade: null, homeroom_class: null },
};
const notices = [
  { id: 1, created_at: '2026-09-30T06:00:00Z', msg: '첫 공지', likes: 0, hearts: 0, author: '김교사' },
  { id: 2, created_at: '2026-10-01T06:00:00Z', msg: '둘째 공지', likes: 3, hearts: 1, author: '김교사' },
];
const pages = [];
let noticeSelects = 0;

async function fireNotice(payload) {
  for (const p of pages) {
    if (p.page.isClosed()) continue;
    try { await p.page.evaluate((pl) => window.__fireRealtime && window.__fireRealtime('notices', pl), payload); } catch (e) {}
  }
}

async function handleDb(pageInfo, req) {
  const { table, op, filters, rows, single, maybe } = req;
  if (table === 'teachers') {
    const f = filters.find(x => x.col === 'id');
    const list = f ? [teachers[f.val]].filter(Boolean) : Object.values(teachers);
    return { data: single || maybe ? (list[0] || null) : list, error: null };
  }
  if (table === 'notices' && op === 'select') {
    noticeSelects++;
    return { data: [...notices].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).map(n => ({ ...n })), error: null };
  }
  if (table === 'notices' && op === 'update') {
    const n = notices.find(x => x.id === filters.find(f => f.col === 'id').val);
    Object.assign(n, rows);
    setTimeout(() => fireNotice({ eventType: 'UPDATE', new: { ...n } }), 50);
    return { data: null, error: null };
  }
  if (op === 'select') return { data: single || maybe ? null : [], error: null };
  return { data: null, error: null };
}

async function handleRpc(pageInfo, name, args) {
  if (name !== 'bump_reaction') return { data: null, error: null };
  const n = notices.find(x => x.id === args.notice_id);
  const col = args.reaction_type === 'like' ? 'likes' : 'hearts';
  n[col] = Math.max(0, n[col] + Math.sign(args.delta));
  setTimeout(() => fireNotice({ eventType: 'UPDATE', new: { ...n } }), 50);
  return { data: null, error: null };
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

async function openDevice(browser, name, uid) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  const info = { page, ctx, name, uid };
  pages.push(info);
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  info.errors = errors;
  await page.exposeFunction('__db', (q) => handleDb(info, q));
  await page.exposeFunction('__rpc', (n, a) => handleRpc(info, n, a));
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
  await page.waitForFunction(() => document.querySelectorAll('#recent-notice-list li').length === 2, null, { timeout: 15000 });
  return info;
}

const wait = (ms) => new Promise(r => setTimeout(r, ms));
const counts = (d, id) => d.page.evaluate((id) => {
  const b = document.querySelectorAll('#recent-notice-list li')[id === 2 ? 0 : 1].querySelectorAll('button .cnt');
  return [b[0].innerText, b[1].innerText].map(Number);
}, id);
const click = (d, id, type) => d.page.evaluate(([id, type]) => {
  document.querySelectorAll('#recent-notice-list li')[id === 2 ? 0 : 1].querySelector('button[onclick*="\'' + type + '\'"]').click();
}, [id, type]);

let failures = 0;
function check(label, cond, detail) {
  console.log((cond ? '  ✅ ' : '  ❌ ') + label + (cond ? '' : '  → ' + JSON.stringify(detail)));
  if (!cond) failures++;
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }).catch(() => chromium.launch());
  const kim = await openDevice(browser, '김교사', T1);
  const park = await openDevice(browser, '박교사', T2);
  await wait(1200);
  check('처음 열면 서버의 전체 숫자', JSON.stringify(await counts(kim, 2)) === '[3,1]' && JSON.stringify(await counts(park, 2)) === '[3,1]', [await counts(kim, 2), await counts(park, 2)]);

  const before = noticeSelects;
  await click(park, 2, 'like'); await wait(800);
  check('박교사가 김교사 글에 👍 → 서버 4', notices[1].likes === 4, notices[1]);
  check('박교사 화면 4', JSON.stringify(await counts(park, 2)) === '[4,1]', await counts(park, 2));
  check('김교사 화면도 새로 안 받고 4', JSON.stringify(await counts(kim, 2)) === '[4,1]', await counts(kim, 2));

  await click(kim, 2, 'heart'); await click(kim, 1, 'like'); await wait(800);
  check('김교사 ❤️·👍 → 두 화면 모두 합계', JSON.stringify(await counts(park, 2)) === '[4,2]' && JSON.stringify(await counts(park, 1)) === '[1,0]' && JSON.stringify(await counts(kim, 2)) === '[4,2]', [await counts(park, 2), await counts(park, 1), await counts(kim, 2)]);

  await click(park, 2, 'like'); await wait(800);
  check('박교사 👍 다시 누르면 취소 → 두 화면 3', notices[1].likes === 3 && (await counts(kim, 2))[0] === 3 && (await counts(park, 2))[0] === 3, [notices[1], await counts(kim, 2), await counts(park, 2)]);
  check('👍❤️만 바뀔 땐 공지 목록을 다시 안 받음', noticeSelects === before, { before, after: noticeSelects });

  await kim.page.evaluate(() => gasUpdateNotice(2, '고친 공지')); await wait(1500);
  check('글 내용이 바뀌면 목록을 다시 받아 새 글이 보임', noticeSelects > before && await park.page.evaluate(() => document.querySelector('#recent-notice-list li .msg').innerText) === '고친 공지', { noticeSelects });

  const allErrors = pages.flatMap(p => (p.errors || []).map(e => p.name + ': ' + e));
  check('전체 페이지 오류 없음', allErrors.length === 0, allErrors);
  console.log(failures === 0 ? '\n모든 검사 통과' : '\n실패 ' + failures + '건');
  await browser.close();
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
