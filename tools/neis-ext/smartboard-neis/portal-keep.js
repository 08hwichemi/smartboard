// 업무포털 화면(확장 프로그램 쪽): 위쪽 "59:58후에 로그아웃됩니다. ↻"의 남은 시간이 10분 이하면 ↻(시간 연장)를 누른다(10/23 사용자).
// background가 평일 7:30~18:00에만 1분마다 묻는다(나이스 연장과 같이, 팝업에서 끌 수 있음). 남은 시간을 못 읽거나 단추가 없으면 안 누름.
(function () {
  if (window.top !== window) return;
  try { if (!chrome.runtime || !chrome.runtime.id) return; } catch (e) { return; }
  if (window.__sbPortal && window.__sbPortal()) return;
  window.__sbPortal = function () { try { return !!chrome.runtime.id; } catch (e) { return false; } };
  const shown = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  // "59:58후에 로그아웃됩니다." — 글자 조각이 나뉘어 있을 수 있어 "로그아웃" 조각에서 위로 몇 칸 올라가며 합쳐 읽는다 → { sec, box }
  function remain() {
    const re = /(\d+)\s*:\s*(\d+)\s*후에\s*로그아웃/;
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (n.nodeValue.indexOf('로그아웃') < 0) continue;
      for (let el = n.parentElement, k = 0; el && k < 4; el = el.parentElement, k++) {
        const v = (el.textContent || '').replace(/\s+/g, ' ');
        if (v.length > 80) break;
        const m = re.exec(v);
        if (m && shown(el)) return { sec: +m[1] * 60 + +m[2], box: el };
      }
    }
    return { sec: null, box: null };
  }
  // ↻ 단추: 남은 시간 글자 바로 뒤(같은 줄)의 단추·링크·그림 — 이름표에 "연장"이 있으면 그것부터
  function refreshBtn(box) {
    const named = Array.prototype.filter.call(document.querySelectorAll('[title*="연장"], [aria-label*="연장"], [alt*="연장"]'), shown)[0];
    if (named) return named;
    for (let el = box, k = 0; el && k < 3; el = el.parentElement, k++) {
      const c = Array.prototype.filter.call(el.querySelectorAll('button, a, [role="button"], img, svg'), function (x) { return shown(x) && !/로그아웃/.test(x.textContent || '') && (box.compareDocumentPosition(x) & Node.DOCUMENT_POSITION_FOLLOWING || box.contains(x)); })[0];
      if (c) return c.closest('button, a, [role="button"]') || c;
    }
    return null;
  }
  function press(el) {
    const r = el.getBoundingClientRect(), o = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
    ['pointerover', 'mouseover', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(function (t) {
      el.dispatchEvent(t.indexOf('pointer') === 0 ? new PointerEvent(t, Object.assign({ pointerType: 'mouse', isPrimary: true }, o)) : new MouseEvent(t, o));
    });
  }
  chrome.runtime.onMessage.addListener(function (m, sender, reply) {
    if (!m || m.t !== 'keepAlive') return;
    const r = remain();
    if (r.sec == null || r.sec > 600) { reply({ left: r.sec, pressed: false }); return; }
    const b = refreshBtn(r.box);
    if (!b) { reply({ left: r.sec, pressed: false, noButton: true }); return; }
    press(b);
    reply({ left: r.sec, pressed: true });
  });
})();
