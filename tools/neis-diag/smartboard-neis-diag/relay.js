// 확장 프로그램 쪽: 페이지에서 본 것을 이 컴퓨터의 확장 저장소에만 모은다(아무 데도 보내지 않음).
(function () {
  var q = [], timer = null;
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (e.source !== window || !d || d.__sbDiag !== true) return;
    q.push({ kind: d.kind, where: d.where, at: d.at, data: d.data });
    if (!timer) timer = setTimeout(flush, 800);
  });
  function flush() {
    timer = null; var add = q; q = [];
    chrome.storage.local.get({ log: [] }, function (o) {
      var log = o.log.concat(add);
      if (log.length > 4000) log = log.slice(log.length - 4000);
      chrome.storage.local.set({ log: log });
    });
  }
})();
