// 스마트보드 탭(확장 프로그램 쪽): 받은 보고서·자동 조회 결과를 스마트보드 화면에 넘기고, 스마트보드가 확인(ack)하면 background에 알린다.
(function () {
  // 확장 프로그램을 새로 고치는 순간엔 예전 판의 연결(chrome.runtime)이 끊겨 있다 — 그때는 조용히 빠진다(새 판이 다시 붙음).
  // 같은 탭에 두 번 붙지 않게(열린 탭에 다시 붙이기 + 새로 열 때 자동으로 붙기) 살아 있는 판이 있으면 건너뛴다.
  try { if (!chrome.runtime || !chrome.runtime.id) return; } catch (e) { return; }
  if (window.__sbRelay && window.__sbRelay()) return;
  window.__sbRelay = function () { try { return !!chrome.runtime.id; } catch (e) { return false; } };
  function give(reports) { if (reports && reports.length) window.postMessage({ __sbNeis: 'reports', reports: reports }, '*'); }
  chrome.runtime.onMessage.addListener(function (m) {
    if (m && m.t === 'reports') give(m.reports);
    if (m && m.t === 'status') window.postMessage({ __sbNeis: 'status', ok: m.ok, msg: m.msg }, '*');
  });
  chrome.runtime.sendMessage({ t: 'pull' }, function (r) { void chrome.runtime.lastError; if (r) give(r.reports); });
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (e.source !== window || !d || d.__sbNeis !== 'ack' || !Array.isArray(d.ids)) return;
    try { chrome.runtime.sendMessage({ t: 'ack', ids: d.ids }); } catch (err) {}
  });
})();
