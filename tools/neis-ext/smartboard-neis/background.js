// 확장 프로그램의 두뇌.
// ① 자동 조회: 평일 8시 40분(설정)이 지났고 오늘 아직 안 했으면, 로그인된 나이스 탭에 "자동 조회"를 시킨다.
//    1분마다 알람으로 보고, 나이스에 로그인하는 순간(neis-auto.js의 neis-ready)에도 본다 — 8시 40분에 로그아웃돼 있었으면
//    로그인하자마자 한다. 실패하면 30분 뒤 알람이나 다음 로그인 때 다시.
//    조회 기간은 이번 주 월~금(스마트보드가 이번 주만 보여 줌). 오늘 이미 했어도 3시간 넘게 지나 나이스에 다시 로그인하면
//    한 번 더 한다(수업계가 낮에 나이스에서 바꾼 것 — 나이스는 한 시간쯤 안 쓰면 로그아웃되니 시각을 정하지 않고 로그인 때).
// ② 보고서 보관·전달: 받은 "전체시간표 (변경수업)" 보고서를 스마트보드가 확인(ack)할 때까지(최대 하루) 보관하고 열린 스마트보드 탭으로 넘긴다.
//    스마트보드 탭이 없으면(보드를 설치한 앱 창으로 쓰면 확장이 그 창을 못 찾음 — 10/23 사용자) 스마트보드를 "나이스 받는 창"(?neis=1)으로
//    뒤에서 몰래 열어 넘기고, 확인(ack)하면 닫는다. 3분 넘게 확인이 없으면(로그인 안 됨 등) 그 탭을 앞으로 꺼내 보여 준다.
//    자동 조회 중에 받은 것은 모았다가 끝나면 한꺼번에(auto 표시 — 스마트보드가 확인 없이 바로 넣음).
// 스마트보드 = 실제 주소 + main에 올리기 전 시험하는 미리 보기 주소(raw.githack.com의 브랜치)
const SB_URL = ['https://08hwichemi.github.io/smartboard/*', 'https://raw.githack.com/08hwichemi/smartboard/*'];
const NEIS_MAIN = 'https://*.neis.go.kr/jsp/main.jsp*';
const SB_HELPER_URL = 'https://08hwichemi.github.io/smartboard/?neis=1';
const HELPER_WAIT_MS = 3 * 60 * 1000;
const KEEP_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 30 * 60 * 1000;
const RUN_MAX_MS = 3 * 60 * 1000; // 이만큼 단계 소식이 없으면 멈춘 것으로 본다
const DEFAULT_AUTO = { on: true, time: '08:40' };
const AGAIN_MS = 3 * 60 * 60 * 1000; // 이만큼 지나 다시 로그인하면 한 번 더

function ymd(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
// 이번 주 월요일(일요일이면 지난 월요일 — 스마트보드 getCurrentWeekDates와 같게)
function mondayOf(d) { const wd = d.getDay(); return addDays(d, wd === 0 ? -6 : 1 - wd); }
function vaOf(xml) { const va = {}; xml.replace(/<VA key="(\$\d)">([^<]*)<\/VA>/g, function (_, k, v) { va[k] = v; return _; }); return va; }
function summary(xml) {
  const va = vaOf(xml), md = function (s) { return s && s.length === 8 ? (+s.slice(4, 6)) + '/' + (+s.slice(6, 8)) : ''; };
  return (va.$4 ? va.$4 + '학년 ' : '') + md(va.$6) + '~' + md(va.$7);
}
async function load() {
  const o = await chrome.storage.local.get({ pending: [], history: [], auto: DEFAULT_AUTO, lastAutoDate: '', lastAutoAt: 0, lastTryAt: 0, running: null, lastRun: null, lastReports: [], helper: null });
  const now = Date.now(); o.pending = o.pending.filter(function (r) { return now - r.at < KEEP_MS; });
  if (o.running && now - o.running.at > RUN_MAX_MS) o.running = null; // 멈춘 채 남은 표시는 버린다
  return o;
}
async function save(o) { await chrome.storage.local.set({ pending: o.pending, history: o.history.slice(-20), auto: o.auto, lastAutoDate: o.lastAutoDate, lastAutoAt: o.lastAutoAt, lastTryAt: o.lastTryAt, helper: o.helper, running: o.running, lastRun: o.lastRun, lastReports: o.lastReports.slice(-6) }); }
async function badge(o) {
  const bad = o.lastRun && !o.lastRun.ok && o.lastRun.date === ymd(new Date()) && o.lastAutoDate !== o.lastRun.date;
  await chrome.action.setBadgeText({ text: bad ? '!' : (o.pending.length ? String(o.pending.length) : '') });
  await chrome.action.setBadgeBackgroundColor({ color: bad ? '#E5484D' : '#E8590C' });
}
async function sbTabs() { return chrome.tabs.query({ url: SB_URL }); }
async function tell(msg) { let n = 0; for (const t of await sbTabs()) { try { await chrome.tabs.sendMessage(t.id, msg); n++; } catch (e) {} } return n; }
async function push(o) {
  if (!o.pending.length) return 0;
  const n = await tell({ t: 'reports', reports: o.pending });
  if (!n) await openHelper(o);
  return n;
}
// 스마트보드 탭이 없을 때: 나이스 탭이 있는 창에 스마트보드를 뒤에서(보이지 않게) 연다 — 열리면 sb-relay가 pull로 받아 간다
async function openHelper(o) {
  if (o.helper) { try { await chrome.tabs.get(o.helper.id); return; } catch (e) { o.helper = null; } }
  const neis = (await chrome.tabs.query({ url: NEIS_MAIN }))[0];
  try {
    const t = await chrome.tabs.create({ url: SB_HELPER_URL, active: false, windowId: neis ? neis.windowId : undefined });
    o.helper = { id: t.id, at: Date.now(), shown: false };
  } catch (e) { o.helper = null; }
  await save(o);
}
// 다 넣었으면 닫고, 오래 확인이 없으면 앞으로 꺼내 보여 준다(로그인이 필요할 수 있음)
async function checkHelper(o) {
  if (!o.helper) return;
  let alive = true;
  try { await chrome.tabs.get(o.helper.id); } catch (e) { alive = false; }
  if (alive && !o.pending.length) { try { await chrome.tabs.remove(o.helper.id); } catch (e) {} alive = false; }
  if (!alive) { o.helper = null; await save(o); return; }
  if (!o.helper.shown && Date.now() - o.helper.at > HELPER_WAIT_MS) {
    try { const t = await chrome.tabs.update(o.helper.id, { active: true }); await chrome.windows.update(t.windowId, { focused: true }); } catch (e) {}
    o.helper.shown = true; await save(o);
  }
}

// ---- 자동 조회 ----
async function maybeRun(reason) {
  const o = await load();
  const now = new Date();
  if (reason !== 'now') {
    if (!o.auto.on || o.running) return;
    if (o.lastAutoDate === ymd(now) && !(reason === 'login' && Date.now() - o.lastAutoAt >= AGAIN_MS)) return; // 오늘 했음(3시간 지나 다시 로그인하면 한 번 더)
    const wd = now.getDay(), hm = o.auto.time.split(':');
    if (wd < 1 || wd > 5 || now.getHours() * 60 + now.getMinutes() < (+hm[0]) * 60 + (+hm[1])) return;
    if (reason === 'tick' && Date.now() - o.lastTryAt < RETRY_MS) return; // 실패한 뒤엔 30분 쉬었다가(로그인하면 바로)
  } else if (o.running) return;
  const tabs = await chrome.tabs.query({ url: NEIS_MAIN });
  if (!tabs.length) return; // 나이스가 안 열려 있음 — 로그인하면 neis-ready로 다시 온다
  const run = Date.now();
  o.running = { run: run, at: run, reason: reason }; o.lastTryAt = run; o.lastReports = [];
  await save(o);
  const mon = mondayOf(now), from = ymd(mon), to = ymd(addDays(mon, 4));
  try {
    await chrome.tabs.sendMessage(tabs[0].id, { t: 'autoQuery', run: run, from: from, to: to, grades: [1, 2, 3] }, { frameId: 0 });
  } catch (e) {
    o.running = null; o.lastRun = { at: run, date: ymd(now), ok: false, reason: reason, steps: [{ s: '✗ 나이스 탭에 연결하지 못함(탭을 새로 고침하거나 다시 로그인해 주세요)' }] };
    await save(o); await badge(o);
  }
}
// 설치·업데이트하면 이미 열린 나이스·스마트보드 탭에도 붙인다(새로 고침하지 않아도 되게)
async function attachOpenTabs() {
  for (const t of await chrome.tabs.query({ url: 'https://*.neis.go.kr/*' })) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: t.id, allFrames: true }, files: ['neis-hook.js'], world: 'MAIN' });
      await chrome.scripting.executeScript({ target: { tabId: t.id, allFrames: true }, files: ['neis-relay.js'] });
      await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['neis-auto.js'] });
    } catch (e) {}
  }
  for (const t of await sbTabs()) { try { await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['sb-relay.js'] }); } catch (e) {} }
}
chrome.runtime.onInstalled.addListener(function () { chrome.alarms.create('tick', { periodInMinutes: 1 }); attachOpenTabs(); });
chrome.runtime.onStartup.addListener(function () { chrome.alarms.create('tick', { periodInMinutes: 1 }); });
chrome.alarms.onAlarm.addListener(async function (a) { if (a.name !== 'tick') return; await checkHelper(await load()); maybeRun('tick'); });
chrome.tabs.onRemoved.addListener(async function (id) { const o = await load(); if (o.helper && o.helper.id === id) { o.helper = null; await save(o); } });

chrome.runtime.onMessage.addListener(function (m, sender, reply) {
  if (m && m.t === 'sleep') { setTimeout(function () { reply({ ok: true }); }, Math.min(+m.ms || 0, 10000)); return true; } // neis-auto.js 기다리기(가려진 창에서도 늦춰지지 않게)
  (async function () {
    const o = await load();
    if (m.t === 'report') {
      const r = { id: Date.now() + '-' + Math.random().toString(36).slice(2, 8), at: Date.now(), xml: m.xml, what: summary(m.xml), grade: +(vaOf(m.xml).$4 || 0), auto: !!o.running };
      o.pending = o.pending.filter(function (x) { return x.what !== r.what; }).concat([r]); // 같은 학년·기간을 다시 조회하면 새것만
      o.history.push({ at: r.at, what: r.what, auto: r.auto });
      o.lastReports = o.lastReports.filter(function (x) { return x.what !== r.what; }).concat([{ at: r.at, what: r.what, xml: r.xml }]); // 분석용 사본(스마트보드가 확인해도 남김)
      await save(o); await badge(o);
      if (!o.running) await push(o); // 자동 조회 중이면 끝날 때 한꺼번에
      reply({ ok: true });
    } else if (m.t === 'autoStep') {
      if (o.running && o.running.run === m.run) { o.running.step = m.s; o.running.at = Date.now(); await save(o); } // 단계가 진행되는 동안은 멈춘 것으로 보지 않음
      reply({ ok: true });
    } else if (m.t === 'autoStop') {
      const tabs = await chrome.tabs.query({ url: NEIS_MAIN });
      for (const t of tabs) { try { await chrome.tabs.sendMessage(t.id, { t: 'autoStop' }, { frameId: 0 }); } catch (e) {} }
      if (o.running) { o.lastRun = { at: Date.now(), date: ymd(new Date()), ok: false, grades: [], steps: [{ s: '✗ 멈춤(팝업에서 멈추기)' + (o.running.step ? ' — 마지막 단계: ' + o.running.step : '') }] }; o.running = null; await save(o); await badge(o); }
      reply({ ok: true });
    } else if (m.t === 'reportSince') {
      reply({ ok: o.pending.some(function (x) { return x.at >= m.since && x.grade === m.grade; }) });
    } else if (m.t === 'neis-ready') {
      reply({ ok: true });
      await maybeRun('login');
    } else if (m.t === 'autoDone') {
      const today = ymd(new Date());
      o.running = null;
      o.lastRun = { at: Date.now(), date: today, ok: m.ok, grades: m.grades, steps: m.steps };
      if (m.ok) { o.lastAutoDate = today; o.lastAutoAt = Date.now(); }
      await save(o); await badge(o);
      await push(o);
      if (!m.ok) await tell({ t: 'status', ok: false, msg: '나이스 변경수업 자동 조회를 끝내지 못했어요' + (m.grades.length ? '(' + m.grades.join('·') + '학년만 받음)' : '') + '. 크롬 오른쪽 위 확장 프로그램 아이콘에서 이유를 볼 수 있어요.' });
      reply({ ok: true });
    } else if (m.t === 'pull') {
      reply({ reports: o.running ? [] : o.pending });
    } else if (m.t === 'ack') {
      o.pending = o.pending.filter(function (x) { return (m.ids || []).indexOf(x.id) < 0; });
      await save(o); await badge(o); reply({ ok: true });
      if (o.helper && !o.pending.length) setTimeout(async function () { await checkHelper(await load()); }, 1500); // 나이스 받는 창은 다 넣었으면 닫음
    } else if (m.t === 'status') {
      reply({ pending: o.pending.map(function (x) { return { at: x.at, what: x.what, auto: x.auto }; }), history: o.history.slice(-5), tabs: (await sbTabs()).length, helper: o.helper, neisTabs: (await chrome.tabs.query({ url: NEIS_MAIN })).length, auto: o.auto, lastAutoDate: o.lastAutoDate, running: o.running, lastRun: o.lastRun });
    } else if (m.t === 'setAuto') {
      o.auto = Object.assign({}, o.auto, m.auto); await save(o); reply({ ok: true });
    } else if (m.t === 'runNow') {
      reply({ ok: true }); await maybeRun('now');
    } else if (m.t === 'resetToday') { // 시험용: 오늘 한 기록·기다리는 보고서를 지워 처음 켠 것처럼
      o.lastAutoDate = ''; o.lastAutoAt = 0; o.lastRun = null; o.lastTryAt = 0; o.running = null; o.pending = [];
      await save(o); await badge(o); reply({ ok: true });
    } else if (m.t === 'lastReports') {
      reply({ reports: o.lastReports });
    } else if (m.t === 'resend') {
      reply({ sent: await push(o) });
    } else if (m.t === 'clear') {
      o.pending = []; await save(o); await badge(o); reply({ ok: true });
    }
  })();
  return true;
});
