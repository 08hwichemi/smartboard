// 학교 홈페이지(bg.icehs.kr) "행사일정"을 달마다 받아 스마트보드에 넘긴다(11/9 사용자: 나이스 학사일정보다 홈페이지 행사일정이 더 다양함).
// 홈페이지 메인 화면이 쓰는 내부 주소(POST /getCnts.do, date=YYYYMM → [{sdate, edate, subject, deptNM}])를 그대로 부른다.
// 브라우저에서 바로 부르면 홈페이지가 다른 사이트를 허용하지 않아(CORS) 막히므로 이 함수가 대신 받는다. 로그인 필요 없음(verify_jwt=false).
// 부르는 법: GET /functions/v1/school-events?from=202609&to=202702 (최대 15달) → { events: [{ s:'2026-11-19', e:'2026-11-19', t:'대학수학능력시험일' }], ok: [...], failed: [...] }
const SITE = 'https://bg.icehs.kr';
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };

function months(from: string, to: string): string[] {
  const out: string[] = [];
  let y = +from.slice(0, 4), m = +from.slice(4, 6);
  const ty = +to.slice(0, 4), tm = +to.slice(4, 6);
  while ((y < ty || (y === ty && m <= tm)) && out.length < 15) {
    out.push(y + String(m).padStart(2, '0'));
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}
const ymd = (s: string) => /^\d{8}$/.test(s) ? s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8) : '';

async function fetchMonth(ym: string, cookie: string) {
  const r = await fetch(SITE + '/getCnts.do', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest', 'Referer': SITE + '/main.do', ...(cookie ? { Cookie: cookie } : {}) },
    body: 'date=' + ym,
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const data = JSON.parse(await r.text());
  if (!Array.isArray(data)) throw new Error('모양이 다름');
  return data;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const u = new URL(req.url);
  const now = new Date(Date.now() + 9 * 3600e3);
  const def = now.getUTCFullYear() + String(now.getUTCMonth() + 1).padStart(2, '0');
  const from = /^\d{6}$/.test(u.searchParams.get('from') || '') ? u.searchParams.get('from')! : def;
  const to = /^\d{6}$/.test(u.searchParams.get('to') || '') ? u.searchParams.get('to')! : from;
  let cookie = '';
  try { // 홈페이지가 세션 쿠키를 주면 같이 보낸다(없어도 되는 것 같지만 화면과 똑같이)
    const h = await fetch(SITE + '/main.do', { signal: AbortSignal.timeout(10000) });
    cookie = (h.headers.get('set-cookie') || '').split(/,(?=[^;]+=)/).map((c) => c.split(';')[0].trim()).filter(Boolean).join('; ');
    await h.body?.cancel();
  } catch (_) { /* 쿠키 없이 해 봄 */ }
  const events: { s: string; e: string; t: string }[] = [], ok: string[] = [], failed: { ym: string; why: string }[] = [];
  for (const ym of months(from, to)) {
    try {
      (await fetchMonth(ym, cookie)).forEach((x: { sdate?: string; edate?: string; subject?: string }) => {
        const s = ymd(String(x.sdate || '')), e = ymd(String(x.edate || x.sdate || '')), t = String(x.subject || '').trim();
        if (s && t && !events.some((v) => v.s === s && v.e === (e || s) && v.t === t)) events.push({ s, e: e || s, t });
      });
      ok.push(ym);
    } catch (err) { failed.push({ ym, why: String((err as Error)?.message || err).slice(0, 80) }); }
  }
  return new Response(JSON.stringify({ events, ok, failed }), {
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': failed.length ? 'no-store' : 'public, max-age=1800' },
  });
});
