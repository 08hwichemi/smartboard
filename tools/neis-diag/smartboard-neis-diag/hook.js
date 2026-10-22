// 나이스 화면 안(페이지 쪽)에서 돈다: 서버에서 받은 자료와 뷰어가 글자를 그리는 순간을 옆에서 본다. 바꾸는 것은 없다.
(function () {
  if (window.__sbDiagHooked) return; window.__sbDiagHooked = true;
  var KW = /보강|교시|변경수업|수업변경|교체|시간표/;
  var MAX_BODY = 3 * 1024 * 1024;
  var where = location.origin + location.pathname;
  function send(kind, data) { try { window.postMessage({ __sbDiag: true, kind: kind, where: where, at: Date.now(), data: data }, '*'); } catch (e) {} }
  function look(url, type, body) {
    var len = body == null ? -1 : body.length;
    send('resp', { url: String(url).slice(0, 300), type: type || '', len: len, hit: !!(body && KW.test(body)) });
    if (body && len <= MAX_BODY && KW.test(body)) send('body', { url: String(url).slice(0, 300), type: type || '', body: body });
  }
  function bufText(buf) { try { return new TextDecoder('utf-8').decode(buf); } catch (e) { return null; } }
  // fetch
  var of = window.fetch;
  if (of) window.fetch = function () {
    var args = arguments;
    return of.apply(this, args).then(function (res) {
      try {
        var url = res.url || (args[0] && args[0].url) || args[0];
        var ct = res.headers.get('content-type') || '';
        res.clone().arrayBuffer().then(function (b) { look(url, ct, bufText(b)); }).catch(function () {});
      } catch (e) {}
      return res;
    });
  };
  // XMLHttpRequest
  var oOpen = XMLHttpRequest.prototype.open, oSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__sbUrl = u; return oOpen.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function () {
    var x = this;
    x.addEventListener('load', function () {
      try {
        var ct = x.getResponseHeader('content-type') || '', b = null;
        if (x.responseType === '' || x.responseType === 'text') b = x.responseText;
        else if (x.responseType === 'json') b = JSON.stringify(x.response);
        else if (x.responseType === 'arraybuffer' && x.response) b = bufText(x.response);
        else if (x.responseType === 'document' && x.response) b = new XMLSerializer().serializeToString(x.response);
        look(x.responseURL || x.__sbUrl, ct + ' [' + (x.responseType || 'text') + ']', b);
      } catch (e) {}
    });
    return oSend.apply(this, arguments);
  };
  // 캔버스에 글자를 찍는 순간(보고서가 그림처럼 그려질 때)
  var buf = [], total = 0;
  function hookText(proto, name) {
    var o = proto && proto[name]; if (!o) return;
    proto[name] = function (t, x, y) {
      try {
        if (total < 30000 && t != null && String(t).trim()) {
          var m = this.getTransform ? this.getTransform() : null;
          buf.push([String(t), Math.round(x), Math.round(y), m ? Math.round(m.e) : 0, m ? Math.round(m.f) : 0, m ? +m.a.toFixed(3) : 1, this.canvas && this.canvas.width || 0]);
          total++;
        }
      } catch (e) {}
      return o.apply(this, arguments);
    };
  }
  hookText(window.CanvasRenderingContext2D && CanvasRenderingContext2D.prototype, 'fillText');
  hookText(window.CanvasRenderingContext2D && CanvasRenderingContext2D.prototype, 'strokeText');
  setInterval(function () { if (buf.length) { var b = buf; buf = []; if (KW.test(b.map(function (r) { return r[0]; }).join(' '))) send('canvas', b); else send('canvasOther', b.length); } }, 1000);
  // 화면 안 SVG 글자·그림 수(뷰어가 어떤 방식으로 그리는지)
  setInterval(function () {
    try {
      var svgT = document.querySelectorAll('svg text').length, cv = document.querySelectorAll('canvas').length, im = document.querySelectorAll('img').length;
      if (svgT || cv) send('dom', { svgText: svgT, canvas: cv, img: im, hasKwText: KW.test(document.body ? document.body.innerText : '') });
    } catch (e) {}
  }, 5000);
})();
