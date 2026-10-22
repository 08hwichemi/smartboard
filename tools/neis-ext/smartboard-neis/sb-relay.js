// 스마트보드 탭(확장 프로그램 쪽): 받은 보고서를 스마트보드 화면에 넘기고, 스마트보드가 확인(ack)하면 background에 알린다.
(function () {
  function give(reports) { if (reports && reports.length) window.postMessage({ __sbNeis: 'reports', reports: reports }, '*'); }
  chrome.runtime.onMessage.addListener(function (m) { if (m && m.t === 'reports') give(m.reports); });
  chrome.runtime.sendMessage({ t: 'pull' }, function (r) { void chrome.runtime.lastError; if (r) give(r.reports); });
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (e.source !== window || !d || d.__sbNeis !== 'ack' || !Array.isArray(d.ids)) return;
    try { chrome.runtime.sendMessage({ t: 'ack', ids: d.ids }); } catch (err) {}
  });
})();
