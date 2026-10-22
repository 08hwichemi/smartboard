// 받은 보고서를 잠시 보관하고(스마트보드가 확인할 때까지, 최대 하루), 열린 스마트보드 탭으로 넘긴다.
// 스마트보드 탭이 없으면 나중에 열 때 sb-relay.js가 가져간다.
const SB_URL = 'https://08hwichemi.github.io/smartboard/*';
const KEEP_MS = 24 * 60 * 60 * 1000;
function summary(xml) {
  const va = {}; xml.replace(/<VA key="(\$\d)">([^<]*)<\/VA>/g, function (_, k, v) { va[k] = v; return _; });
  const md = function (s) { return s && s.length === 8 ? (+s.slice(4, 6)) + '/' + (+s.slice(6, 8)) : ''; };
  return (va.$4 ? va.$4 + '학년 ' : '') + md(va.$6) + '~' + md(va.$7);
}
async function load() { const o = await chrome.storage.local.get({ pending: [], history: [] }); const now = Date.now(); o.pending = o.pending.filter(function (r) { return now - r.at < KEEP_MS; }); return o; }
async function save(o) { await chrome.storage.local.set({ pending: o.pending, history: o.history.slice(-20) }); }
async function badge(o) { await chrome.action.setBadgeText({ text: o.pending.length ? String(o.pending.length) : '' }); await chrome.action.setBadgeBackgroundColor({ color: '#E8590C' }); }
async function push(reports) {
  const tabs = await chrome.tabs.query({ url: SB_URL });
  let sent = 0;
  for (const t of tabs) { try { await chrome.tabs.sendMessage(t.id, { t: 'reports', reports: reports }); sent++; } catch (e) {} }
  return sent;
}
chrome.runtime.onMessage.addListener(function (m, sender, reply) {
  (async function () {
    const o = await load();
    if (m.t === 'report') {
      const r = { id: Date.now() + '-' + Math.random().toString(36).slice(2, 8), at: Date.now(), xml: m.xml, what: summary(m.xml) };
      o.pending = o.pending.filter(function (x) { return x.what !== r.what; }).concat([r]); // 같은 학년·기간을 다시 조회하면 새것만
      o.history.push({ at: r.at, what: r.what, sent: 0 });
      await save(o); await badge(o);
      const sent = await push(o.pending);
      o.history[o.history.length - 1].sent = sent; await save(o);
      reply({ ok: true });
    } else if (m.t === 'pull') {
      reply({ reports: o.pending });
    } else if (m.t === 'ack') {
      o.pending = o.pending.filter(function (x) { return (m.ids || []).indexOf(x.id) < 0; });
      await save(o); await badge(o); reply({ ok: true });
    } else if (m.t === 'status') {
      const tabs = await chrome.tabs.query({ url: SB_URL });
      reply({ pending: o.pending.map(function (x) { return { at: x.at, what: x.what }; }), history: o.history.slice(-5), tabs: tabs.length });
    } else if (m.t === 'resend') {
      reply({ sent: await push(o.pending) });
    } else if (m.t === 'clear') {
      o.pending = []; await save(o); await badge(o); reply({ ok: true });
    }
  })();
  return true;
});
