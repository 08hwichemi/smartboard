// 확장 프로그램의 두뇌.
// ① 자동 조회: 평일 8시 40분(설정)이 지났고 오늘 아직 안 했으면, 로그인된 나이스 탭에 "자동 조회"를 시킨다.
//    1분마다 알람으로 보고, 나이스에 로그인하는 순간(neis-auto.js의 neis-ready)에도 본다 — 8시 40분에 로그아웃돼 있었으면
//    로그인하자마자 한다. 실패하면 30분 뒤 알람이나 다음 로그인 때 다시.
// ② 보고서 보관·전달: 받은 "전체시간표 (변경수업)" 보고서를 스마트보드가 확인(ack)할 때까지(최대 하루) 보관하고 열린 스마트보드 탭으로 넘긴다.
//    자동 조회 중에 받은 것은 모았다가 끝나면 한꺼번에(auto 표시 — 스마트보드가 확인 없이 바로 넣음).
// 스마트보드 = 실제 주소 + main에 올리기 전 시험하는 미리 보기 주소(raw.githack.com의 브랜치)
const SB_URL = ['https://08hwichemi.github.io/smartboard/*', 'https://raw.githack.com/08hwichemi/smartboard/*'];
const NEIS_MAIN = 'https://*.neis.go.kr/jsp/main.jsp*';
const KEEP_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 30 * 60 * 1000;
const RUN_MAX_MS = 3 * 60 * 1000; // 이만큼 단계 소식이 없으면 멈춘 것으로 본다
const DEFAULT_AUTO = { on: true, time: '08:40' };

function ymd(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function vaOf(xml) { const va = {}; xml.replace(/<VA key="(\$\d)">([^<]*)<\/VA>/g, function (_, k, v) { va[k] = v; return _; }); return va; }
function summary(xml) {
  const va = vaOf(xml), md = function (s) { return s && s.length === 8 ? (+s.slice(4, 6)) + '/' + (+s.slice(6, 8)) : ''; };
  return (va.$4 ? va.$4 + '학년 ' : '') + md(va.$6) + '~' + md(va.$7);
}
async function load() {
  const o = await chrome.storage.local.get({ pending: [], history: [], auto: DEFAULT_AUTO, lastAutoDate: '', lastTryAt: 0, running: null, lastRun: null });
  const now = Date.now(); o.pending = o.pending.filter(function (r) { return now - r.at < KEEP_MS; });
  if (o.running && now - o.running.at > RUN_MAX_MS) o.running = null; // 멈춘 채 남은 표시는 버린다
  return o;
}
async function save(o) { await chrome.storage.local.set({ pending: o.pending, history: o.history.slice(-20), auto: o.auto, lastAutoDate: o.lastAutoDate, lastTryAt: o.lastTryAt, running: o.running, lastRun: o.lastRun }); }
async function badge(o) {
  const bad = o.lastRun && !o.lastRun.ok && o.lastRun.date === ymd(new Date()) && o.lastAutoDate !== o.lastRun.date;
  await chrome.action.setBadgeText({ text: bad ? '!' : (o.pending.length ? String(o.pending.length) : '') });
  await chrome.action.setBadgeBackgroundColor({ color: bad ? '#E5484D' : '#E8590C' });
}
async function sbTabs() { return chrome.tabs.query({ url: SB_URL }); }
async function tell(msg) { let n = 0; for (const t of await sbTabs()) { try { await chrome.tabs.sendMessage(t.id, msg); n++; } catch (e) {} } return n; }
async function push(o) { return o.pending.length ? tell({ t: 'reports', reports: o.pending }) : 0; }

// ---- 자동 조회 ----
async function maybeRun(reason) {
  const o = await load();
  const now = new Date();
  if (reason !== 'now') {
    if (!o.auto.on || o.running || o.lastAutoDate === ymd(now)) return;
    const wd = now.getDay(), hm = o.auto.time.split(':');
    if (wd < 1 || wd > 5 || now.getHours() * 60 + now.getMinutes() < (+hm[0]) * 60 + (+hm[1])) return;
    if (reason === 'tick' && Date.now() - o.lastTryAt < RETRY_MS) return; // 실패한 뒤엔 30분 쉬었다가(로그인하면 바로)
  } else if (o.running) return;
  const tabs = await chrome.tabs.query({ url: NEIS_MAIN });
  if (!tabs.length) return; // 나이스가 안 열려 있음 — 로그인하면 neis-ready로 다시 온다
  const run = Date.now();
  o.running = { run: run, at: run, reason: reason }; o.lastTryAt = run;
  await save(o);
  const from = ymd(addDays(now, -7)), to = ymd(addDays(now, 21));
  try {
    await chrome.tabs.sendMessage(tabs[0].id, { t: 'autoQuery', run: run, from: from, to: to, grades: [1, 2, 3] }, { frameId: 0 });
  } catch (e) {
    o.running = null; o.lastRun = { at: run, date: ymd(now), ok: false, reason: reason, steps: [{ s: '✗ 나이스 탭에 연결하지 못함(탭을 새로 고침하거나 다시 로그인해 주세요)' }] };
    await save(o); await badge(o);
  }
}
chrome.runtime.onInstalled.addListener(function () { chrome.alarms.create('tick', { periodInMinutes: 1 }); });
chrome.runtime.onStartup.addListener(function () { chrome.alarms.create('tick', { periodInMinutes: 1 }); });
chrome.alarms.onAlarm.addListener(function (a) { if (a.name === 'tick') maybeRun('tick'); });

chrome.runtime.onMessage.addListener(function (m, sender, reply) {
  (async function () {
    const o = await load();
    if (m.t === 'report') {
      const r = { id: Date.now() + '-' + Math.random().toString(36).slice(2, 8), at: Date.now(), xml: m.xml, what: summary(m.xml), grade: +(vaOf(m.xml).$4 || 0), auto: !!o.running };
      o.pending = o.pending.filter(function (x) { return x.what !== r.what; }).concat([r]); // 같은 학년·기간을 다시 조회하면 새것만
      o.history.push({ at: r.at, what: r.what, auto: r.auto });
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
      if (m.ok) o.lastAutoDate = today;
      await save(o); await badge(o);
      await push(o);
      if (!m.ok) await tell({ t: 'status', ok: false, msg: '나이스 변경수업 자동 조회를 끝내지 못했어요' + (m.grades.length ? '(' + m.grades.join('·') + '학년만 받음)' : '') + '. 크롬 오른쪽 위 확장 프로그램 아이콘에서 이유를 볼 수 있어요.' });
      reply({ ok: true });
    } else if (m.t === 'pull') {
      reply({ reports: o.running ? [] : o.pending });
    } else if (m.t === 'ack') {
      o.pending = o.pending.filter(function (x) { return (m.ids || []).indexOf(x.id) < 0; });
      await save(o); await badge(o); reply({ ok: true });
    } else if (m.t === 'status') {
      reply({ pending: o.pending.map(function (x) { return { at: x.at, what: x.what, auto: x.auto }; }), history: o.history.slice(-5), tabs: (await sbTabs()).length, neisTabs: (await chrome.tabs.query({ url: NEIS_MAIN })).length, auto: o.auto, lastAutoDate: o.lastAutoDate, running: o.running, lastRun: o.lastRun });
    } else if (m.t === 'setAuto') {
      o.auto = Object.assign({}, o.auto, m.auto); await save(o); reply({ ok: true });
    } else if (m.t === 'runNow') {
      reply({ ok: true }); await maybeRun('now');
    } else if (m.t === 'resend') {
      reply({ sent: await push(o) });
    } else if (m.t === 'clear') {
      o.pending = []; await save(o); await badge(o); reply({ ok: true });
    }
  })();
  return true;
});
