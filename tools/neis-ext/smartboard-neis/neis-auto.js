// 나이스 화면(맨 위 창, /jsp/main.jsp): ① 로그인돼 메뉴가 보이면 background에 "준비됨"을 알리고
// ② background가 "자동 조회"를 보내면 사람이 누르듯 화면 단추를 눌러
//    교과담임 → 시간표관리 → 전체시간표조회 → 변경수업조회 → 일자(지난주 ~ 3주 뒤) → 학년 1·2·3 차례로 조회한다.
//    보고서는 neis-hook.js가 잡아 background로 보낸다. 단계마다 기록을 남기고, 못 찾은 단계는 그 근처 화면 정보를 함께 보낸다.
(function () {
  if (window.top !== window || !/\/jsp\/main\.jsp/.test(location.pathname) || window.__sbNeisAuto) return;
  window.__sbNeisAuto = true;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const shown = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const txt = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  function all(sel) { return Array.prototype.filter.call(document.querySelectorAll(sel), shown); }
  async function waitFor(fn, ms) { const end = Date.now() + (ms || 15000); for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) return null; await sleep(250); } }
  // eXBuilder6 단추는 마우스 누름·뗌으로 동작하는 것이 있어 사람이 누를 때의 이벤트를 차례로 보낸다
  function press(el) {
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect(), o = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
    ['pointerover', 'mouseover', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(function (t) {
      el.dispatchEvent(t.indexOf('pointer') === 0 ? new PointerEvent(t, Object.assign({ pointerType: 'mouse', isPrimary: true }, o)) : new MouseEvent(t, o));
    });
  }
  function snap(list) { return list.slice(0, 15).map(function (el) { return (el.outerHTML || '').slice(0, 400); }); }

  // ① 로그인 감지
  waitFor(function () { return all('.cl-navigationbar-content').length > 0; }, 60000).then(function (ok) {
    if (ok) try { chrome.runtime.sendMessage({ t: 'neis-ready' }); } catch (e) {}
  });

  // ---- 화면 찾기 ----
  const gradeBox = function () { return all('[aria-label^="학년,"]')[0] || null; };
  const searchBtn = function () { return all('.btn-i-search[aria-label="조회"], .btn-i-search').filter(function (e) { return /조회/.test(txt(e) + (e.getAttribute('aria-label') || '')); })[0] || null; };
  const screenOpen = function () { return gradeBox() && searchBtn() && all('*').some(function (e) { return e.children.length === 0 && txt(e) === '변경수업조회'; }) ? true : null; };
  const byTitle = function (t) { return all('[title="' + t + '"]'); };
  async function openScreen(log) {
    if (screenOpen()) { log('화면이 이미 열려 있음'); return true; }
    const tab = byTitle('전체시간표조회').filter(function (e) { return !/sidenavigation/.test(e.className); })[0];
    if (tab) { press(tab); log('아래 탭에서 전체시간표조회'); if (await waitFor(screenOpen, 8000)) return true; }
    let side = byTitle('전체시간표조회').filter(function (e) { return /sidenavigation/.test(e.className); })[0];
    if (!side) {
      const top = all('.cl-navigationbar-content').filter(function (e) { return /^교과담임/.test(txt(e)); })[0];
      if (!top) { log('✗ 위 메뉴 "교과담임"을 못 찾음', snap(all('.cl-navigationbar-content'))); return false; }
      press(top); log('위 메뉴 교과담임');
      side = await waitFor(function () { return byTitle('전체시간표조회').filter(function (e) { return /sidenavigation/.test(e.className); })[0]; }, 8000);
      if (!side) {
        const folder = byTitle('시간표관리')[0];
        if (folder) { press(folder); log('왼쪽 메뉴 시간표관리 펼침'); }
        side = await waitFor(function () { return byTitle('전체시간표조회').filter(function (e) { return /sidenavigation/.test(e.className); })[0]; }, 8000);
      }
      if (!side) { log('✗ 왼쪽 메뉴 "전체시간표조회"를 못 찾음', snap(all('.cl-sidenavigation-item, [class*="sidenavigation"]'))); return false; }
    }
    press(side); log('왼쪽 메뉴 전체시간표조회');
    if (await waitFor(screenOpen, 20000)) return true;
    log('✗ 전체시간표조회 화면이 열리지 않음(학년 칸·조회 단추·변경수업조회 중 못 찾은 것 있음)', { grade: !!gradeBox(), search: !!searchBtn() });
    return false;
  }
  // 동그라미 고르기: 글자 "변경수업조회"가 든 가장 작은 칸 → 그 위의 radio 묶음 항목을 누른다
  async function pickChangeRadio(log) {
    const label = all('*').filter(function (e) { return e.children.length === 0 && txt(e) === '변경수업조회'; })[0];
    if (!label) { log('✗ "변경수업조회"를 못 찾음'); return false; }
    const item = label.closest('[role="radio"], .cl-radiobutton-item, [class*="radio-item"], [class*="radiobutton"] > *') || label;
    const on = function () { const it = label.closest('[role="radio"], .cl-radiobutton-item, [class*="radio-item"]') || label.parentElement; return it && (it.getAttribute('aria-checked') === 'true' || /cl-checked|cl-selected/.test(it.className)); };
    if (on()) { log('변경수업조회 이미 골라져 있음'); return true; }
    press(item);
    if (await waitFor(on, 3000)) { log('변경수업조회 고름'); return true; }
    press(label);
    if (await waitFor(on, 3000)) { log('변경수업조회 고름(글자 눌러서)'); return true; }
    log('? 변경수업조회가 골라졌는지 확인 못 함(그대로 진행)', snap([item, label.parentElement, label.parentElement && label.parentElement.parentElement].filter(Boolean)));
    return true;
  }
  // 일자: "검색시작일 하루빼기 / 하루더하기" 단추로 지금 값에서 목표 날짜까지
  const parseYmd = function (v) { const m = /(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})/.exec(v || ''); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; };
  async function setDate(which, target, log) {
    const inputs = all('input[aria-label="일자"]');
    const input = inputs[which === '시작' ? 0 : 1];
    if (!input) { log('✗ 일자 칸을 못 찾음', snap(inputs)); return false; }
    const label = which === '시작' ? '검색시작일' : '검색종료일';
    for (let guard = 0; guard < 120; guard++) {
      const cur = parseYmd(input.value);
      if (!cur) { log('✗ ' + which + ' 일자 값을 못 읽음: ' + input.value); return false; }
      const diff = Math.round((target - cur) / 86400000);
      if (diff === 0) { log(which + ' 일자 ' + input.value); return true; }
      const btn = all('[aria-label="' + label + (diff > 0 ? ' 하루더하기' : ' 하루빼기') + '"]')[0];
      if (!btn) { log('✗ "' + label + (diff > 0 ? ' 하루더하기' : ' 하루빼기') + '" 단추를 못 찾음'); return false; }
      const before = input.value;
      press(btn);
      if (!(await waitFor(function () { return input.value !== before; }, 2000))) { log('✗ ' + which + ' 일자가 바뀌지 않음(' + before + ')'); return false; }
    }
    log('✗ ' + which + ' 일자를 맞추지 못함'); return false;
  }
  // 학년 고르기: 콤보를 눌러 펼친 목록에서 그 숫자 → 안 되면 키보드 ↑↓
  const gradeNow = function () { const b = gradeBox(); const m = b && /학년,\s*(\d+)/.exec(b.getAttribute('aria-label') || ''); return m ? +m[1] : null; };
  async function setGrade(g, log) {
    if (gradeNow() === g) return true;
    const box = gradeBox(); const combo = box.closest('[class*="combobox"]') || box.parentElement || box;
    press(combo);
    const opt = await waitFor(function () {
      return all('[role="option"], [class*="listbox-item"], [class*="combobox-item"], [class*="cl-list-item"], .cl-item').filter(function (e) { return txt(e) === String(g); })[0];
    }, 3000);
    if (opt) { press(opt); if (await waitFor(function () { return gradeNow() === g; }, 3000)) { log(g + '학년 고름'); return true; } }
    const popup = all('[role="listbox"], [class*="listbox"], [class*="combobox-list"], [class*="popup"]');
    // 키보드: 콤보에 초점을 두고 ↑↓
    const focusEl = combo.querySelector('input') || combo;
    try { focusEl.focus(); } catch (e) {}
    for (let i = 0; i < 6 && gradeNow() !== g; i++) {
      const key = (gradeNow() || 0) < g ? 'ArrowDown' : 'ArrowUp';
      [focusEl, document.activeElement].forEach(function (t) { if (t) { t.dispatchEvent(new KeyboardEvent('keydown', { key: key, code: key, keyCode: key === 'ArrowDown' ? 40 : 38, bubbles: true })); t.dispatchEvent(new KeyboardEvent('keyup', { key: key, code: key, keyCode: key === 'ArrowDown' ? 40 : 38, bubbles: true })); } });
      await sleep(300);
    }
    try { document.activeElement && document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true })); } catch (e) {}
    if (await waitFor(function () { return gradeNow() === g; }, 2000)) { log(g + '학년 고름(키보드)'); return true; }
    log('✗ ' + g + '학년을 고르지 못함', { combo: snap([combo]), popup: snap(popup), options: snap(all('[role="option"], [class*="item"]').filter(function (e) { return /^\d$/.test(txt(e)); })) });
    return false;
  }
  function ask(m) { return new Promise(function (res) { try { chrome.runtime.sendMessage(m, function (r) { void chrome.runtime.lastError; res(r); }); } catch (e) { res(null); } }); }
  async function query(g, log) {
    if (!(await setGrade(g, log))) return false;
    const since = Date.now();
    press(searchBtn()); log(g + '학년 조회');
    let got = false;
    for (const end = Date.now() + 60000; !got && Date.now() < end;) {
      const r = await ask({ t: 'reportSince', since: since, grade: g });
      if (r && r.ok) got = true; else await sleep(700);
    }
    if (!got) { log('✗ ' + g + '학년 보고서가 오지 않음(1분)'); return false; }
    log(g + '학년 보고서 받음');
    return true;
  }
  chrome.runtime.onMessage.addListener(function (m, sender, reply) {
    if (!m || m.t !== 'autoQuery') return;
    reply({ started: true });
    (async function () {
      const steps = [], log = function (s, info) { steps.push(info ? { s: s, info: info } : { s: s }); };
      let ok = false, grades = [];
      try {
        const from = new Date(m.from + 'T00:00:00'), to = new Date(m.to + 'T00:00:00');
        if (await openScreen(log) && await pickChangeRadio(log) && await setDate('시작', from, log) && await setDate('끝', to, log)) {
          ok = true;
          for (const g of m.grades) { if (await query(g, log)) grades.push(g); else ok = false; }
        }
      } catch (e) { log('✗ 오류: ' + (e && e.message ? e.message : e)); ok = false; }
      try { chrome.runtime.sendMessage({ t: 'autoDone', run: m.run, ok: ok, grades: grades, steps: steps }); } catch (e) {}
    })();
  });
})();
