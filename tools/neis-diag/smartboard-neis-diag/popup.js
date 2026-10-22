function show() {
  chrome.storage.local.get({ log: [] }, function (o) {
    var c = { resp: 0, hit: 0, body: 0, canvas: 0, canvasOther: 0, dom: 0 };
    o.log.forEach(function (r) {
      if (r.kind === 'resp') { c.resp++; if (r.data.hit) c.hit++; }
      else if (r.kind === 'canvas') c.canvas += r.data.length;
      else if (r.kind === 'canvasOther') c.canvasOther += r.data;
      else if (c[r.kind] != null) c[r.kind]++;
    });
    document.getElementById('s').textContent =
      '받은 자료 ' + c.resp + '개 (시간표 글자 든 것 ' + c.hit + '개)\n' +
      '캔버스에 찍은 시간표 글자 ' + c.canvas + '개 (그 밖 ' + c.canvasOther + '개)\n' +
      (c.hit || c.canvas ? '✅ 잡혔어요! 저장해서 보내 주세요.' : '아직 없어요 — 변경수업조회에서 조회를 눌러 보세요.');
  });
}
document.getElementById('save').onclick = function () {
  chrome.storage.local.get({ log: [] }, function (o) {
    var blob = new Blob([JSON.stringify({ version: '0.1', savedAt: new Date().toISOString(), log: o.log }, null, 1)], { type: 'application/json' });
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = '나이스진단_' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.json'; a.click();
  });
};
document.getElementById('clear').onclick = function () { chrome.storage.local.set({ log: [] }, show); };
show();
