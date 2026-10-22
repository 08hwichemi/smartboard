function t(at) { const d = new Date(at); return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }
function show() {
  chrome.runtime.sendMessage({ t: 'status' }, function (r) {
    if (!r) return;
    const lines = [];
    lines.push(r.pending.length ? '⏳ 스마트보드가 아직 확인 안 한 조회 ' + r.pending.length + '개\n' + r.pending.map(function (x) { return '  · ' + x.what + ' (' + t(x.at) + ')'; }).join('\n') : '✅ 기다리는 것 없음');
    lines.push(r.tabs ? '스마트보드 탭 ' + r.tabs + '개 열려 있음' : '⚠️ 스마트보드 탭이 없어요 — 열면 넘어가요');
    if (r.history.length) lines.push('최근 조회: ' + r.history.slice().reverse().map(function (h) { return h.what + ' ' + t(h.at); }).join(', '));
    document.getElementById('s').textContent = lines.join('\n\n');
  });
}
document.getElementById('resend').onclick = function () { chrome.runtime.sendMessage({ t: 'resend' }, function () { setTimeout(show, 300); }); };
document.getElementById('open').onclick = function () { chrome.tabs.create({ url: 'https://08hwichemi.github.io/smartboard/' }); };
document.getElementById('clear').onclick = function () { chrome.runtime.sendMessage({ t: 'clear' }, show); };
show();
