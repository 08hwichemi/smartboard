// 나이스 화면(확장 프로그램 쪽): neis-hook.js가 잡은 보고서를 background.js로 보낸다.
window.addEventListener('message', function (e) {
  var d = e.data;
  if (e.source !== window || !d || d.__sbNeisCap !== true || typeof d.xml !== 'string') return;
  try { chrome.runtime.sendMessage({ t: 'report', xml: d.xml }); } catch (err) {}
});
