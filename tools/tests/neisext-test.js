// 🔁 크롬 확장 프로그램(tools/neis-ext/smartboard-neis) 전달: 가짜 나이스 화면(보고서 뷰어 프레임이 /report/service를 XHR로 받음)에서
// "전체시간표 (변경수업)" 보고서만 잡아 → background가 보관 → 열린 스마트보드 탭에 넘기고, 스마트보드가 확인(ack)하면 지운다.
// 스마트보드 탭이 없을 때 조회한 것은 나중에 탭을 열면 넘어간다. 다른 보고서(반별 조회 등)는 무시. 같은 학년·기간을 다시 조회하면 새것 하나만.
// 실행: cd tools/tests && NODE_PATH=/opt/node22/lib/node_modules node neisext-test.js
const { chromium } = require('playwright');
const path = require('path');

const EXT = path.resolve(__dirname, '..', 'neis-ext', 'smartboard-neis');
let failures = 0;
function check(label, cond, detail) {
  console.log((cond ? '  ✅ ' : '  ❌ ') + label + (cond ? '' : '  → ' + JSON.stringify(detail)));
  if (!cond) failures++;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const report = (grade, from, to, change) => '<?xml version="1.0" encoding="utf-8"?><MML version="2.9"><DOCUMENT><HEAD><VALIST><VA key="$4">' + grade + '</VA><VA key="$6">' + from + '</VA><VA key="$7">' + to + '</VA></VALIST></HEAD><BODY><PG no="1"><PR><TL>전체시간표 (' + (change ? '변경수업' : '반별') + ')</TL></PR></PG></BODY></MML>';
let nextReport = report(3, '20261022', '20261027', true);

(async () => {
  const ctx = await chromium.launchPersistentContext('', { executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', headless: true, args: ['--headless=new', '--disable-extensions-except=' + EXT, '--load-extension=' + EXT] });
  await ctx.route('**/*', (r) => {
    const u = r.request().url();
    if (u.startsWith('https://ice.neis.go.kr/jsp/main.jsp')) return r.fulfill({ contentType: 'text/html; charset=utf-8', body: '<html><body>나이스<iframe id="v" src="/thirdparty/crownix/crownixhtml.jsp"></iframe></body></html>' });
    if (u.includes('/thirdparty/crownix/crownixhtml.jsp')) return r.fulfill({ contentType: 'text/html; charset=utf-8', body: '<html><body><script>window.load=function(){var x=new XMLHttpRequest();x.open("POST","/report/service?token=abc");x.send();};</script></body></html>' });
    if (u.includes('/report/service')) return r.fulfill({ contentType: 'text/xml;charset=utf-8', body: nextReport });
    if (u.startsWith('https://08hwichemi.github.io/smartboard/')) return r.fulfill({ contentType: 'text/html; charset=utf-8', body: '<html><body>스마트보드<script>window.got=[];window.addEventListener("message",function(e){if(e.data&&e.data.__sbNeis==="reports")window.got.push(e.data.reports.map(function(r){return r.id;}));});</script></body></html>' });
    return r.abort();
  });
  const ex = await ctx.newPage(); await ex.goto('chrome://extensions'); await wait(800);
  const id = await ex.evaluate(() => [...document.querySelector('extensions-manager').shadowRoot.querySelector('extensions-item-list').shadowRoot.querySelectorAll('extensions-item')].map((e) => e.id)[0]);
  const status = async () => { const p = await ctx.newPage(); await p.goto('chrome-extension://' + id + '/popup.html'); await wait(300); const r = await p.evaluate(() => new Promise((res) => chrome.runtime.sendMessage({ t: 'status' }, res))); await p.close(); return r; };
  const query = async (neis) => { await neis.frame({ url: /crownixhtml/ }).evaluate(() => window.load()); await wait(900); };

  console.log('== 1. 스마트보드 탭이 열려 있으면 바로 넘어감');
  const sb = await ctx.newPage(); await sb.goto('https://08hwichemi.github.io/smartboard/'); await wait(500);
  const neis = await ctx.newPage(); await neis.goto('https://ice.neis.go.kr/jsp/main.jsp'); await wait(500);
  await query(neis);
  let got = await sb.evaluate(() => window.got);
  check('스마트보드가 보고서 하나를 받음', got.length >= 1 && got[got.length - 1].length === 1, got);
  let st = await status();
  check('확장: 기다리는 것 1개(3학년 10/22~10/27), 스마트보드 탭 1개', st.pending.length === 1 && st.pending[0].what === '3학년 10/22~10/27' && st.tabs === 1, st);
  const rid = got[got.length - 1][0];
  await sb.evaluate((i) => window.postMessage({ __sbNeis: 'ack', ids: [i] }, '*'), rid); await wait(400);
  st = await status();
  check('스마트보드가 확인(ack)하면 지워짐', st.pending.length === 0, st);

  console.log('== 2. 변경수업이 아닌 보고서는 무시');
  nextReport = report(3, '20261022', '20261027', false);
  await query(neis);
  st = await status();
  check('반별 조회 보고서는 안 잡음', st.pending.length === 0, st);

  console.log('== 3. 스마트보드 탭이 없을 때 → 나중에 열면 넘어감');
  await sb.close(); await wait(200);
  nextReport = report(1, '20261022', '20261028', true); await query(neis);
  nextReport = report(1, '20261022', '20261028', true); await query(neis); // 같은 학년·기간을 다시 조회
  nextReport = report(2, '20261022', '20261028', true); await query(neis);
  st = await status();
  check('탭이 없으면 보관: 1학년(새것 하나)·2학년 = 2개', st.pending.length === 2 && st.tabs === 0 && st.pending.map((x) => x.what).join() === '1학년 10/22~10/28,2학년 10/22~10/28', st);
  const sb2 = await ctx.newPage(); await sb2.goto('https://08hwichemi.github.io/smartboard/'); await wait(800);
  got = await sb2.evaluate(() => window.got);
  check('스마트보드를 열면 기다리던 두 개를 받음', got.length >= 1 && got[0].length === 2, got);

  await ctx.close();
  console.log(failures ? '\n실패 ' + failures + '개' : '\n모든 검사 통과');
  process.exit(failures ? 1 : 0);
})();
