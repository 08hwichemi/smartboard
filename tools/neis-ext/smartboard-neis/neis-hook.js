// 나이스 화면 안(페이지 쪽): 보고서 뷰어(크라운릭스)가 서버에서 받는 보고서 자료 중 "전체시간표 (변경수업)"만 골라
// 옆의 neis-relay.js로 넘긴다. 받은 자료를 그대로 둘 뿐 나이스 화면·요청은 바꾸지 않는다.
// ① 숨은 창에서도 나이스가 멈추지 않게: 나이스는 창이 안 보이면(최소화·다른 창에 가려짐·화면보호기) 남은 시간 표시·연장 창·메뉴 열기를
//    멈춘다(10/26·27 기록 — 숨은 동안 "53분"에서 안 줄다가 보이자 43분, 연장 창이 안 떠 로그아웃, 8:41 자동 조회는 메뉴가 안 열려 실패).
//    그래서 나이스 쪽에는 늘 "보이는 중"이라고 알려 주고(document.hidden·visibilityState, visibilitychange 숨김), 실제로 숨었을 때
//    크롬이 멈춰 두는 requestAnimationFrame은 setTimeout으로 대신 돌린다. 확장 쪽(neis-auto.js)은 따로 된 세계라 실제 상태를 그대로 본다.
(function () {
  if (window.__sbNeisVis || /^(open|www)\./.test(location.hostname)) return; window.__sbNeisVis = true;
  var D = Document.prototype, hd = Object.getOwnPropertyDescriptor(D, 'hidden');
  function realHidden() { try { return !!(hd && hd.get.call(document)); } catch (e) { return false; } }
  function fake(name, v) { try { Object.defineProperty(D, name, { configurable: true, enumerable: true, get: function () { return v; } }); } catch (e) {} }
  fake('hidden', false); fake('visibilityState', 'visible');
  if ('webkitHidden' in D) fake('webkitHidden', false);
  if ('webkitVisibilityState' in D) fake('webkitVisibilityState', 'visible');
  var oRAF = window.requestAnimationFrame, oCAF = window.cancelAnimationFrame;
  if (!oRAF || !oCAF) return;
  var seq = 0, jobs = {};
  function fire(id, ts) { var j = jobs[id]; if (!j) return; delete jobs[id]; j.cb(ts); }
  function byTimer(id, j) { j.t = setTimeout(function () { fire(id, performance.now()); }, 16); }
  window.requestAnimationFrame = function (cb) {
    var id = ++seq, j = jobs[id] = { cb: cb };
    if (realHidden()) byTimer(id, j); else j.r = oRAF.call(window, function (ts) { fire(id, ts); });
    return id;
  };
  window.cancelAnimationFrame = function (id) {
    var j = jobs[id]; if (!j) return; delete jobs[id];
    if (j.t) clearTimeout(j.t); if (j.r) oCAF.call(window, j.r);
  };
  function onVis(e) {
    e.stopImmediatePropagation(); // 나이스 쪽은 숨은 걸 모르게
    if (!realHidden()) return;
    for (var id in jobs) { var j = jobs[id]; if (j.r && !j.t) { oCAF.call(window, j.r); j.r = 0; byTimer(id, j); } } // 숨기 직전에 걸어 둔 것도 멈추지 않게
  }
  window.addEventListener('visibilitychange', onVis, true);
  window.addEventListener('webkitvisibilitychange', onVis, true);
})();

// ② 보고서 받기
(function () {
  if (window.__sbNeisHooked) return; window.__sbNeisHooked = true;
  function pass(url, body) {
    if (!body || String(url).indexOf('/report/') < 0 || body.indexOf('<MML') < 0 || body.indexOf('변경수업') < 0) return;
    try { window.postMessage({ __sbNeisCap: true, xml: body }, '*'); } catch (e) {}
  }
  var of = window.fetch;
  if (of) window.fetch = function () {
    var args = arguments;
    return of.apply(this, args).then(function (res) {
      try { var url = res.url || (args[0] && args[0].url) || args[0]; if (String(url).indexOf('/report/') >= 0) res.clone().text().then(function (t) { pass(url, t); }).catch(function () {}); } catch (e) {}
      return res;
    });
  };
  var oOpen = XMLHttpRequest.prototype.open, oSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__sbUrl = u; return oOpen.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function () {
    var x = this;
    x.addEventListener('load', function () {
      try {
        var url = x.responseURL || x.__sbUrl || '';
        if (String(url).indexOf('/report/') < 0) return;
        var t = null;
        if (x.responseType === '' || x.responseType === 'text') t = x.responseText;
        else if (x.responseType === 'arraybuffer' && x.response) t = new TextDecoder('utf-8').decode(x.response);
        else if (x.responseType === 'document' && x.response) t = new XMLSerializer().serializeToString(x.response);
        pass(url, t);
      } catch (e) {}
    });
    return oSend.apply(this, arguments);
  };
})();
