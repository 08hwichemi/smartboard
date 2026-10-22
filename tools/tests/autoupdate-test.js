// 🔄 새 판 저절로 받기: 막 켰을 때(아무것도 안 만졌으면) 바로, 다음 날엔 1분 안 만졌을 때 새로고침하고,
// 같은 날 쓰는 중이거나 글을 쓰는 중이면 띠만 띄우는지 확인한다. 같은 코드라 서버가 없는 개인판(lite.html)으로 돌린다.
// 실행: cd tools/tests && NODE_PATH=/opt/node22/lib/node_modules node autoupdate-test.js
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(ROOT, process.env.HTML_PATH || 'lite.html'), 'utf8');
const BUILD_ID = (/var BUILD_ID = '([^']+)'/.exec(html) || [])[1] || 'x';
const m = /^(.*\.)(\d+)$/.exec(BUILD_ID);
const NEWER = m ? m[1] + (Number(m[2]) + 1) : BUILD_ID + '1';
const OLDER = m ? m[1] + Math.max(0, Number(m[2]) - 1) : 'x';

let failures = 0;
function check(label, cond, detail) {
  console.log((cond ? '  ✅ ' : '  ❌ ') + label + (cond ? '' : '  → ' + JSON.stringify(detail)));
  if (!cond) failures++;
}
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const SETTINGS = JSON.stringify({ name: '김하늘', setupDone: true, gradeCount: 3, classCount: 10 });

let serverVer = BUILD_ID;
async function openPage(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  const navs = [];
  page.on('framenavigated', f => { if (f === page.mainFrame()) navs.push(f.url()); });
  await page.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith('http://app.test/')) {
      if (url.includes('version.txt')) return route.fulfill({ body: serverVer, contentType: 'text/plain' });
      if (url.includes('lite.html')) return route.fulfill({ body: html, contentType: 'text/html; charset=utf-8' });
      return route.fulfill({ status: 404, body: '' });
    }
    return route.abort();
  });
  await page.addInitScript((s) => { localStorage.setItem('lite:lite-settings', s); localStorage.setItem('lite:device-lite-banner-snooze', new Date().toISOString().slice(0, 10)); }, SETTINGS);
  return { page, ctx, navs };
}
async function ready(page) { await page.waitForFunction(() => typeof syncAppStarted !== 'undefined' && syncAppStarted === true, null, { timeout: 15000 }); }
const barShown = (page) => page.evaluate(() => !document.getElementById('updateBar').hidden);

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }).catch(() => chromium.launch());

  console.log('== 1. 막 켰을 때 새 판이 있으면 바로 새로고침(한 번만)');
  serverVer = NEWER;
  let { page, ctx, navs } = await openPage(browser);
  await page.goto('http://app.test/lite.html');
  await page.waitForURL(/\?v=/, { timeout: 8000 }).catch(() => {});
  check('?v=새 판 주소로 다시 열림', page.url().endsWith('?v=' + encodeURIComponent(NEWER)), navs);
  await ready(page); await wait(2500);
  // 다시 열어도 화면 판은 그대로(캐시가 아직 옛 화면을 주는 경우) → 또 새로고침하거나 띠를 띄우지 않음
  check('같은 판으로 또 새로고침하지 않음(되풀이 없음)', navs.length === 2, navs);
  check('되풀이 막을 때 띠도 안 띄움', !(await barShown(page)));
  await ctx.close();

  console.log('== 2. 판 번호가 아니거나 옛 판이면 저절로 안 바꿈(띠만)');
  for (const v of ['x', OLDER]) {
    serverVer = v;
    ({ page, ctx, navs } = await openPage(browser));
    await page.goto('http://app.test/lite.html'); await ready(page); await wait(1500);
    check('version.txt = ' + v + ' → 새로고침 없음, 띠는 뜸', navs.length === 1 && await barShown(page), { navs, bar: await barShown(page) });
    await ctx.close();
  }

  console.log('== 3. 같은 날 쓰는 중에 새 판이 올라오면 띠만');
  serverVer = BUILD_ID;
  ({ page, ctx, navs } = await openPage(browser));
  await page.goto('http://app.test/lite.html'); await ready(page); await wait(800);
  check('처음엔 띠 없음', !(await barShown(page)));
  await page.mouse.click(700, 500);
  serverVer = NEWER;
  await page.evaluate(() => checkForUpdate()); await wait(1200);
  check('만진 뒤 새 판 → 띠만, 새로고침 안 함', await barShown(page) && navs.length === 1, { navs });
  check('띠 글: 다음에 켤 때 저절로', (await page.textContent('#updateBarText')).includes('저절로'));
  // 연 지 2분이 지난 것으로(만지지 않았어도) — 같은 날이면 그대로
  await page.evaluate(() => { PAGE_OPENED_AT = Date.now() - 10 * 60 * 1000; lastUserInputAt = 0; return maybeAutoReload(); }); await wait(800);
  check('같은 날, 연 지 오래면 안 만졌어도 띠만', navs.length === 1, navs);

  console.log('== 4. 다음 날(컴퓨터를 안 끄고 둠): 1분 안 만졌으면 새로고침, 쓰는 중이면 미룸');
  await page.evaluate(() => { PAGE_OPENED_DAY = 'Thu Jan 01 1970'; lastUserInputAt = Date.now() - 10 * 1000; return maybeAutoReload(); }); await wait(800);
  check('방금 만졌으면 미룸', navs.length === 1, navs);
  await page.evaluate(() => { const t = document.createElement('textarea'); t.id = 'au-ta'; document.body.appendChild(t); t.focus(); lastUserInputAt = Date.now() - 5 * 60 * 1000; return maybeAutoReload(); }); await wait(800);
  check('입력 칸에 커서가 있으면 미룸', navs.length === 1, navs);
  await page.evaluate(() => { document.getElementById('au-ta').blur(); dutyEditMode = true; window.dutyHasUnsaved = function() { return true; }; return maybeAutoReload(); }); await wait(800);
  check('저장 안 한 감독표가 있으면 미룸', navs.length === 1, navs);
  await page.evaluate(() => { dutyEditMode = false; }); // 1분 주기 검사가 저절로 새로고침하는지
  await page.evaluate(() => maybeAutoReload());
  await page.waitForURL(/\?v=/, { timeout: 8000 }).catch(() => {});
  check('다 비면 새 판으로 새로고침', page.url().endsWith('?v=' + encodeURIComponent(NEWER)), navs);
  await ctx.close();

  await browser.close();
  console.log(failures ? '\n실패 ' + failures + '개' : '\n모든 검사 통과');
  process.exit(failures ? 1 : 0);
})();
