// 확장 프로그램 쪽: 페이지에서 본 것을 이 컴퓨터의 확장 저장소에만 모은다(아무 데도 보내지 않음).
(function () {
  var q = [], timer = null;
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (e.source !== window || !d || d.__sbDiag !== true) return;
    q.push({ kind: d.kind, where: d.where, at: d.at, data: d.data });
    if (!timer) timer = setTimeout(flush, 800);
  });
  // 팝업의 "화면 구조 저장": 학년·조회 칸이 있는 화면에서 입력 칸·단추의 이름표만 적어 둔다(값을 바꾸거나 누르지 않음).
  chrome.runtime.onMessage.addListener(function (m) {
    if (m !== 'dumpForm' || !document.body) return;
    var txt = document.body.innerText || '';
    if (!/학년/.test(txt) || !/조회/.test(txt)) return;
    var out = [];
    document.querySelectorAll('select, input, button, a, [role="button"], [role="combobox"], [onclick], label').forEach(function (el) {
      if (out.length >= 600) return;
      var r = el.getBoundingClientRect(); if (!r.width && !r.height) return;
      out.push({ tag: el.tagName, id: el.id || '', cls: String(el.className || '').slice(0, 80), name: el.getAttribute('name') || '', type: el.getAttribute('type') || '',
        text: (el.innerText || '').trim().slice(0, 40), value: el.tagName === 'INPUT' || el.tagName === 'SELECT' ? String(el.value).slice(0, 40) : '',
        title: el.getAttribute('title') || '', aria: el.getAttribute('aria-label') || '', x: Math.round(r.left), y: Math.round(r.top) });
    });
    q.push({ kind: 'form', where: location.origin + location.pathname, at: Date.now(), data: out });
    flush();
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
