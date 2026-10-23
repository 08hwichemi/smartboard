function t(at) { const d = new Date(at); return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }
function ymd(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
let last = null;
function show() {
  chrome.runtime.sendMessage({ t: 'status' }, function (r) {
    if (!r) return;
    last = r;
    document.getElementById('on').checked = !!r.auto.on;
    document.getElementById('keep').checked = r.auto.keepLogin !== false;
    if (document.activeElement !== document.getElementById('time')) document.getElementById('time').value = r.auto.time;
    const today = ymd(new Date()), a = [];
    if (r.running) a.push('⏳ 지금 나이스에서 조회하는 중…' + (r.running.step ? '\n   지금 단계: ' + r.running.step : '\n   (나이스 화면을 고르는 중)'));
    else if (r.lastRun && r.lastRun.date === today && !r.lastRun.ok) a.push('❌ 마지막 자동 조회 실패(' + t(r.lastRun.at) + ') — ' + ((r.lastRun.steps || []).filter(function (s) { return /^✗/.test(s.s); }).map(function (s) { return s.s; })[0] || '') + (r.lastAutoDate === today ? '\n(오늘 아침 조회는 끝났어요)' : '\n30분 뒤나 다음 나이스 로그인 때 다시 해요.'));
    else if (r.lastAutoDate === today) a.push('✅ 오늘 자동 조회 끝(' + (r.lastRun ? t(r.lastRun.at) : '') + ') — 3시간 지나 나이스에 다시 로그인하면 한 번 더 해요.');
    else a.push('아직 오늘 자동 조회 전 — ' + (r.auto.on ? '평일 ' + r.auto.time + ' 이후 나이스가 로그인돼 있으면 해요.' : '꺼져 있어요.'));
    a.push(r.neisTabs ? '나이스 탭 열려 있음' : '나이스 탭 없음(로그인하면 시작)');
    if (r.auto.keepLogin !== false && r.keepCheck && r.keepCheck.neis) {
      const k = r.keepCheck, mm = function (x) { return Math.floor(x / 60) + '분 ' + (x % 60) + '초'; };
      const line = function (c, name, more) {
        if (!c.tabs) return name + ' 탭 없음';
        if (c.noReply && c.left == null) return name + ' 화면이 답이 없음(새로 고침해 주세요)';
        if (c.pressed) return name + ' 연장 누름';
        if (c.noButton) return name + ' 연장할 때인데 단추를 못 찾음';
        return c.left != null ? name + ' 남은 시간 ' + mm(c.left) + (more && c.found > 1 ? '(시간 글자 ' + c.found + '개 중 가장 적은 것)' : '') : name + ' 남은 시간을 못 읽음' + (more ? '(연장 창이 뜨면 바로 눌러요)' : '');
      };
      a.push('🕒 로그인 연장 확인(' + t(k.at) + ')\n   ' + line(k.neis, '나이스', true) + '\n   ' + line(k.portal || {}, '업무포털', false));
    }
    if (r.lastKeep) a.push(r.lastKeep.pressed ? '🔄 ' + (r.lastKeep.who || '나이스') + ' 로그인 연장함(' + t(r.lastKeep.at) + ')' : '⚠️ ' + (r.lastKeep.who || '나이스') + ' 남은 시간이 적은데 연장 단추를 못 찾음(' + t(r.lastKeep.at) + ')');
    document.getElementById('auto').textContent = a.join('\n');
    document.getElementById('stop').style.display = r.running ? '' : 'none';
    const lines = [];
    lines.push(r.pending.length ? '⏳ 스마트보드가 아직 확인 안 한 조회 ' + r.pending.length + '개\n' + r.pending.map(function (x) { return '  · ' + x.what + (x.auto ? ' (자동)' : '') + ' ' + t(x.at); }).join('\n') : '스마트보드로 넘길 것 없음');
    if (r.helper && r.pending.length) lines.push(r.helper.shown ? '⚠️ 뒤에서 연 스마트보드 탭이 아직 못 넣었어요 — 그 탭에서 로그인돼 있는지 봐 주세요' : '스마트보드를 뒤에서 열어 넣는 중이에요(다 넣으면 저절로 닫혀요)');
    else if (r.pending.length) lines.push(r.tabs ? '스마트보드 탭 ' + r.tabs + '개 열려 있음' : '스마트보드 탭이 없으면 뒤에서 열어 넣어요');
    document.getElementById('s').textContent = lines.join('\n');
  });
}
document.getElementById('keep').onchange = function () { chrome.runtime.sendMessage({ t: 'setAuto', auto: { keepLogin: this.checked } }, show); };
document.getElementById('on').onchange = function () { chrome.runtime.sendMessage({ t: 'setAuto', auto: { on: this.checked } }, show); };
document.getElementById('time').onchange = function () { if (/^\d\d:\d\d$/.test(this.value)) chrome.runtime.sendMessage({ t: 'setAuto', auto: { time: this.value } }, show); };
document.getElementById('stop').onclick = function () { chrome.runtime.sendMessage({ t: 'autoStop' }, function () { setTimeout(show, 300); }); };
document.getElementById('reset').onclick = function () { if (confirm('오늘 자동 조회 기록과 기다리는 보고서를 지울까요?\n(나이스에 다시 로그인하면 처음 켠 것처럼 자동 조회해요)')) chrome.runtime.sendMessage({ t: 'resetToday' }, show); };
document.getElementById('now').onclick = function () { chrome.runtime.sendMessage({ t: 'runNow' }, function () { setTimeout(show, 500); }); };
document.getElementById('log').onclick = function () {
  const blob = new Blob([JSON.stringify({ savedAt: new Date().toISOString(), lastRun: last && last.lastRun, auto: last && last.auto, history: last && last.history }, null, 1)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = '나이스자동조회_' + ymd(new Date()) + '.json'; a.click();
};
document.getElementById('reports').onclick = function () {
  chrome.runtime.sendMessage({ t: 'lastReports' }, function (r) {
    if (!r || !r.reports || !r.reports.length) { alert('남아 있는 보고서가 없어요. 자동 조회를 한 번 한 뒤 눌러 주세요.'); return; }
    const blob = new Blob([JSON.stringify({ savedAt: new Date().toISOString(), reports: r.reports }, null, 1)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = '나이스보고서_' + ymd(new Date()) + '.json'; a.click();
  });
};
document.getElementById('resend').onclick = function () { chrome.runtime.sendMessage({ t: 'resend' }, function () { setTimeout(show, 300); }); };
document.getElementById('open').onclick = function () { chrome.tabs.create({ url: 'https://08hwichemi.github.io/smartboard/' }); };
show(); setInterval(show, 2000);
