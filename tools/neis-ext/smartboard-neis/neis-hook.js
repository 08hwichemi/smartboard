// 나이스 화면 안(페이지 쪽): 보고서 뷰어(크라운릭스)가 서버에서 받는 보고서 자료 중 "전체시간표 (변경수업)"만 골라
// 옆의 neis-relay.js로 넘긴다. 받은 자료를 그대로 둘 뿐 나이스 화면·요청은 바꾸지 않는다.
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
