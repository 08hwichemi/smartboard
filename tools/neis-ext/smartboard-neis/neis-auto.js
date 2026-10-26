// 나이스 화면(맨 위 창 — 주소 /jsp/main.jsp 또는 다시 로그인한 뒤 첫 주소): ① 로그인돼 메뉴가 보이면 background에 "준비됨"을 알리고
// ② background가 "자동 조회"를 보내면 사람이 누르듯 화면 단추를 눌러
//    교과담임(큰 메뉴판) → 시간표관리 → 왼쪽 메뉴 전체시간표조회 → 변경수업조회 → 일자(이번 주 월~금) → 학년 1·2·3 차례로 조회한다.
// ③ 로그인 남은 시간이 10분 이하면 "연장"을 누른다(아래).
//    보고서는 neis-hook.js가 잡아 background로 보낸다. 단계마다 기록을 남기고, 못 찾은 단계는 그 근처 화면 정보를 함께 보낸다.
(function () {
  if (window.top !== window || /^(open|www)\./.test(location.hostname)) return; // 나이스 맨 위 창(주소가 /jsp/main.jsp든 첫 주소든)
  // 확장을 업데이트하면 예전 판은 연결이 끊긴 채 남는다 — 살아 있는 판이 이미 있을 때만 건너뛴다
  try { if (!chrome.runtime || !chrome.runtime.id) return; } catch (e) { return; } // 확장을 새로 고치는 순간의 끊긴 판은 조용히 빠짐
  // 붙을 때마다 세대 번호를 올리고 가장 새 판만 일한다(10/26: 예전 판이 "살아 있음" 표시만 남기고 답을 못 해, 다시 붙여도
  // 새 판이 그냥 빠져 1시간 넘게 "답없음"이었음 → 이제 background가 다시 붙이면 새 판이 맡는다)
  const myGen = (window.__sbNeisGen || 0) + 1;
  window.__sbNeisGen = myGen;
  const current = function () { return window.__sbNeisGen === myGen; };
  // 기다리기는 확장 프로그램 본체(background)가 재고 끝나면 깨워 준다 — 나이스 창이 최소화되거나 다른 창에 가려져 5분 넘게 안 보이면
  // 크롬이 그 화면의 setTimeout을 1분에 한 번꼴로 늦춰 아침 자동 조회가 멈춘 것처럼 됨(10/23). 메시지 답은 늦추지 않는다.
  const sleep = (ms) => new Promise((r) => {
    let done = false; const fin = function () { if (!done) { done = true; r(); } };
    try { chrome.runtime.sendMessage({ t: 'sleep', ms: ms }, function () { void chrome.runtime.lastError; fin(); }); } catch (e) {}
    setTimeout(fin, ms + 3000); // 본체가 답을 못 하면(확장을 다시 불러온 직후 등) 이 화면 시계로
  });
  const shown = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const txt = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  function all(sel) { return Array.prototype.filter.call(document.querySelectorAll(sel), shown); }
  let cancelled = false; // 팝업의 "■ 멈추기"
  async function waitFor(fn, ms) { const end = Date.now() + (ms || 15000); for (;;) { if (cancelled) return null; const v = fn(); if (v) return v; if (Date.now() > end) return null; await sleep(250); } }
  // 글자가 꼭 맞는 칸 찾기: 화면의 글자 조각(text node)만 훑어 그 부모 칸을 고른다.
  // (칸마다 innerText를 읽으면 나이스처럼 칸이 수만 개인 화면에선 몇 분씩 걸려 멈춘 것처럼 됨 — 1.3에서 겪음)
  function textEls(t) {
    const out = [], w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const v = n.nodeValue; if (v.length > t.length + 20 || v.indexOf(t) < 0) continue;
      if (v.replace(/\s+/g, ' ').trim() === t && n.parentElement && shown(n.parentElement) && out.indexOf(n.parentElement) < 0) out.push(n.parentElement);
    }
    return out;
  }
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
  const screenOpen = function () { return gradeBox() && searchBtn() && textEls('변경수업조회').length ? true : null; };
  const byTitle = function (t) { return all('[title="' + t + '"]'); };
  const byText = textEls; // 메뉴판 항목처럼 title이 없는 것
  const sideLeaf = function () {
    return byTitle('전체시간표조회').filter(function (e) { return /sidenavigation/.test(e.className); })[0] ||
      all('.cl-sidenavigation-item, [class*="sidenavigation"] a').filter(function (e) { return /^전체시간표조회/.test(txt(e)); })[0] || null;
  };
  async function openScreen(log) {
    if (screenOpen()) { log('화면이 이미 열려 있음'); return true; }
    const tab = byTitle('전체시간표조회').filter(function (e) { return !/sidenavigation/.test(e.className); })[0];
    if (tab) { press(tab); log('아래 탭에서 전체시간표조회'); if (await waitFor(screenOpen, 8000)) return true; }
    let side = sideLeaf();
    if (!side) {
      // 위 메뉴 "교과담임" → 펼쳐지는 큰 메뉴판의 "시간표관리"(교육과정 아래) → 왼쪽 메뉴가 생김
      const top = all('.cl-navigationbar-content').filter(function (e) { return /^교과담임/.test(txt(e)); })[0];
      if (!top) { log('✗ 위 메뉴 "교과담임"을 못 찾음', snap(all('.cl-navigationbar-content'))); return false; }
      // 메뉴판 항목엔 눈에 안 보이는 안내 글("… 1단계 메뉴항목")이 붙어 있을 수 있어 글자 조각 → 안 되면 "시간표관리"로 시작하는 메뉴 항목
      const notSide = function (e) { return !e.closest('.cl-sidenavigation, [class*="sidenavigation"]'); };
      const mega = function () {
        return byText('시간표관리').filter(notSide)[0] ||
          all('a, [data-role="menuitem"], [role="menuitem"]').filter(function (e) { return notSide(e) && /^시간표관리(\s|$)/.test((e.textContent || '').replace(/\s+/g, ' ').trim()); })[0];
      };
      if (!mega()) { press(top); log('위 메뉴 교과담임'); }
      side = await waitFor(function () { return sideLeaf() || (mega() ? 'mega' : null); }, 8000);
      if (side === 'mega') {
        press(mega()); log('메뉴판 시간표관리');
        side = await waitFor(sideLeaf, 10000);
      }
      if (!side) {
        const folder = byTitle('시간표관리').filter(function (e) { return !notSide(e); })[0] || byText('시간표관리').filter(function (e) { return !notSide(e); })[0];
        if (folder) { press(folder); log('왼쪽 메뉴 시간표관리 펼침'); side = await waitFor(sideLeaf, 8000); }
      }
      if (!side) { log('✗ 왼쪽 메뉴 "전체시간표조회"를 못 찾음', { menu: snap(byText('시간표관리')), side: snap(all('.cl-sidenavigation-item, [class*="sidenavigation"]')) }); return false; }
    }
    press(side); log('왼쪽 메뉴 전체시간표조회');
    if (await waitFor(screenOpen, 20000)) return true;
    log('✗ 전체시간표조회 화면이 열리지 않음(학년 칸·조회 단추·변경수업조회 중 못 찾은 것 있음)', { grade: !!gradeBox(), search: !!searchBtn() });
    return false;
  }
  // 동그라미 고르기: 글자 "변경수업조회"가 든 가장 작은 칸 → 그 위의 radio 묶음 항목을 누른다
  async function pickChangeRadio(log) {
    const label = textEls('변경수업조회')[0];
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
  // ③ 나이스 로그인 자동 연장(10/23 사용자 — 교사 자리 PC라 괜찮음, background가 평일 7:30~18:00에만 1분마다 물음, 팝업에서 끌 수 있음):
  //    나이스 연장 창("접속유지시간이 10분 남았습니다 … [연장] [종료]")이 보이거나 머리의 남은 시간이 10분 이하면 [연장]을 누른다([종료]는 안 누름).
  // 남은 시간: 나이스는 "09분 56초"를 글자 조각 여러 개(숫자·분·초)로 나눠 쓸 수 있어 "초" 조각에서 위로 몇 칸 올라가며 합쳐 읽는다
  // 화면에 "○○분 ○○초"가 여러 개면(10/23: 팝업 숫자가 머리 시간과 9분이나 달랐음) 모두 찾아 가장 적게 남은 것을 쓴다 → { sec, count }
  function remainSec() {
    const re = /^\s*(\d+)\s*분\s*(\d+)\s*초\s*$/, seen = [], vals = [];
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (n.nodeValue.indexOf('초') < 0) continue;
      for (let el = n.parentElement, k = 0; el && k < 4; el = el.parentElement, k++) {
        const v = el.textContent || '';
        if (v.length > 30) break;
        const m = re.exec(v);
        if (m && shown(el)) { if (seen.indexOf(el) < 0) { seen.push(el); vals.push(+m[1] * 60 + +m[2]); } break; }
      }
    }
    return { sec: vals.length ? Math.min.apply(null, vals) : null, count: vals.length };
  }
  // 나이스 연장 창(남은 10분에 뜸): "접속유지시간이 10분 남았습니다 … 접속시간을 연장하시겠습니까? [연장] [종료]"
  function extendDialogShown() {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (/접속유지시간|접속시간을\s*연장/.test(n.nodeValue) && n.parentElement && shown(n.parentElement)) return true;
    }
    return false;
  }
  function extendBtn() {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (/^\s*(로그인\s*)?(시간\s*)?연장(하기)?\s*$/.test(n.nodeValue) && n.parentElement && shown(n.parentElement)) return n.parentElement;
    }
    // 글자 없이 그림만 있는 단추(머리의 남은 시간 옆 등): 이름표(aria-label·title)로
    return all('[aria-label*="연장"], [title*="연장"]')[0] || null;
  }
  // 연장 창이 떠 있으면 남은 시간을 못 읽어도 바로 누르고, 아니면 남은 시간이 10분 이하일 때만 연장 단추를 찾는다
  function keepAlive() {
    const dlg = extendDialogShown(), r = remainSec(), left = r.sec;
    const hidden = document.hidden; // 기록용: 화면이 안 보이는 상태(최소화·가려짐·화면 잠김)였는지
    if (!dlg && (left == null || left > 600)) return { left: left, found: r.count, pressed: false, hidden: hidden };
    const btn = extendBtn();
    if (!btn) return { left: left, found: r.count, pressed: false, noButton: true, dialog: dlg, hidden: hidden };
    press(btn);
    return { left: left, found: r.count, pressed: true, dialog: dlg, hidden: hidden };
  }

  chrome.runtime.onMessage.addListener(function (m, sender, reply) {
    if (!current()) return; // 더 새 판이 붙었으면 그쪽이 답함
    if (m && m.t === 'keepAlive') { try { reply(keepAlive()); } catch (e) { reply({ err: String(e && e.message || e).slice(0, 80) }); } return; }
    if (m && m.t === 'autoStop') { cancelled = true; reply({ ok: true }); return; }
    if (!m || m.t !== 'autoQuery') return;
    reply({ started: true });
    (async function () {
      const steps = [], log = function (s, info) { steps.push(info ? { s: s, info: info } : { s: s }); try { chrome.runtime.sendMessage({ t: 'autoStep', run: m.run, s: s }); } catch (e) {} };
      cancelled = false;
      let ok = false, grades = [];
      try {
        const from = new Date(m.from + 'T00:00:00'), to = new Date(m.to + 'T00:00:00');
        if (await openScreen(log) && await pickChangeRadio(log) && await setDate('시작', from, log) && await setDate('끝', to, log)) {
          ok = true;
          for (const g of m.grades) { if (await query(g, log)) grades.push(g); else ok = false; }
        }
      } catch (e) { log('✗ 오류: ' + (e && e.message ? e.message : e)); ok = false; }
      if (cancelled) { log('✗ 멈춤(팝업에서 멈추기)'); ok = false; }
      try { chrome.runtime.sendMessage({ t: 'autoDone', run: m.run, ok: ok, grades: grades, steps: steps }); } catch (e) {}
    })();
  });
})();
