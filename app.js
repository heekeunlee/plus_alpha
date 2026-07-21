'use strict';

/* ============================================================
   ETF LowVol Radar
   공공데이터포털(apis.data.go.kr) ETF 시세 API를 브라우저에서 직접 호출해
   저변동성 ETF의 연율화 변동성 / 최대낙폭(MDD) / 위험조정수익률을 계산하고
   변동성이 낮은 순으로 순위를 매긴다. 백엔드 없음, 순수 정적 파일.
   ============================================================ */

const BASE_URL = 'https://apis.data.go.kr/1160100/service/GetSecuritiesProductInfoService/getETFPriceInfo';
const LS_KEY = 'lowvol_apikey';
const LS_FAV = 'lowvol_favorites';

const TRADING_DAYS = 252;
// 순위/표시에 쓰는 변동성 윈도우(거래일 기준)
const VOL_WINDOWS = { v20: 20, v60: 60, v120: 120, v250: 250 };

// GitHub Actions가 매일 수집해 커밋하는 같은 도메인 보유종목 데이터 (CORS 불필요)
const HOLDINGS_URL = 'data/holdings.json';
let holdingsData = null;      // { updatedAt, count, data: { code: {...} } }
let holdingsPromise = null;

// Naver detailTypeCode → 한글 라벨
const SECTOR_LABELS = {
  IT: 'IT', FINANCIALS: '금융', INDUSTRIALS: '산업재', 'HEALTH CARE': '헬스케어', HEALTHCARE: '헬스케어',
  'CONSUMER DISCRETIONARY': '경기소비재', 'CONSUMER STAPLES': '필수소비재', MATERIALS: '소재',
  ENERGY: '에너지', UTILITIES: '유틸리티', 'COMMUNICATION SERVICES': '커뮤니케이션',
  'REAL ESTATE': '부동산', 'REAL_ESTATE': '부동산', TELECOM: '통신', ETC: '기타', OTHERS: '기타', OTHER: '기타',
};
const ASSET_LABELS = { EQUITY: '주식', BOND: '채권', CASH: '현금', DERIVATIVES: '파생', REIT: '리츠', COMMODITY: '원자재', OTHERS: '기타', OTHER: '기타', ETF: 'ETF', FUND: '펀드' };
const COUNTRY_LABELS = { KR: '한국', US: '미국', CN: '중국', JP: '일본', HK: '홍콩', EU: '유럽', VN: '베트남', IN: '인도', TW: '대만', OTHERS: '기타' };

async function loadHoldings() {
  if (holdingsData) return holdingsData;
  if (!holdingsPromise) {
    holdingsPromise = fetch(HOLDINGS_URL)
      .then(r => (r.ok ? r.json() : null))
      .then(j => { holdingsData = j; return j; })
      .catch(() => { holdingsData = null; return null; });
  }
  return holdingsPromise;
}

let analysisResults = [];   // 전체 계산 결과
let filteredResults = [];   // 검색 필터 적용 결과
let favorites = loadFavorites();
let sortState = { key: 'rankVol', dir: 'asc' };
let abortFlag = false;
let detailChart = null;
let currentDetail = null;

/* ---------- 유틸 ---------- */
const $ = (id) => document.getElementById(id);
const toArray = (items) => (items ? (Array.isArray(items) ? items : [items]) : []);
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const fmt = (v, d = 2) => (v === null || v === undefined || !Number.isFinite(v)) ? 'N/A' : v.toFixed(d);
const fmtInt = (v) => (v === null || v === undefined || !Number.isFinite(v)) ? 'N/A' : Math.round(v).toLocaleString('ko-KR');

function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}
function parseYmd(s) {
  return new Date(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)));
}
function loadFavorites() {
  try { return JSON.parse(localStorage.getItem(LS_FAV)) || []; } catch { return []; }
}
function saveFavorites() { localStorage.setItem(LS_FAV, JSON.stringify(favorites)); }

/* ---------- 카테고리 자동 분류 (이름 기반) ---------- */
function categorize(name) {
  const n = (name || '').replace(/\s/g, '');
  if (/(국고채|국채|회사채|통안|크레딧|채권|본드|Bond|장기채|단기채|중기채|IG|하이일드)/i.test(n)) {
    if (/(머니마켓|MMF|CD금리|SOFR|파킹|초단기|양도성|KOFR)/i.test(n)) return '단기/파킹';
    return '채권';
  }
  if (/(CD금리|KOFR|SOFR|파킹|머니마켓|MMF|초단기|양도성)/i.test(n)) return '단기/파킹';
  if (/(리츠|REIT|부동산|인프라)/i.test(n)) return '리츠/부동산';
  if (/(골드|금현물|은현물|원유|천연가스|구리|원자재|귀금속|Gold|Silver|농산물)/i.test(n)) return '원자재/금';
  if (/(고배당|배당|인컴|커버드콜|Dividend|리얼티|월배당|Income)/i.test(n)) return '배당/인컴';
  return '주식/기타';
}
function categoryMatch(cat, filter) {
  if (filter === 'all') return true;
  return cat === filter;
}

/* ---------- API 호출 ---------- */
// 특정 날짜의 전체 ETF 스냅샷 (페이지네이션)
async function fetchUniverse(apiKey, dateStr) {
  const NUM = 1000;
  const buildUrl = (pageNo) => `${BASE_URL}?${new URLSearchParams({
    serviceKey: apiKey, numOfRows: String(NUM), pageNo: String(pageNo),
    resultType: 'json', basDt: dateStr,
  })}`;
  const first = await fetch(buildUrl(1));
  if (!first.ok) throw new Error(`HTTP ${first.status}`);
  const firstData = await first.json();
  const firstItems = toArray(firstData?.response?.body?.items?.item);
  if (firstItems.length === 0) {
    const msg = firstData?.response?.header?.resultMsg;
    if (msg && msg !== 'NORMAL SERVICE.') throw new Error(msg);
    return null; // 휴장일 가능성
  }
  const totalCount = firstData?.response?.body?.totalCount || firstItems.length;
  const totalPages = Math.ceil(totalCount / NUM);
  const all = [...firstItems];
  if (totalPages > 1) {
    const rest = await Promise.all(
      Array.from({ length: totalPages - 1 }, (_, i) =>
        fetch(buildUrl(i + 2)).then(r => (r.ok ? r.json() : null)).catch(() => null))
    );
    for (const pd of rest) all.push(...toArray(pd?.response?.body?.items?.item));
  }
  return all;
}

// 기준일이 휴장일이면 직전 거래일까지 최대 7일 후퇴
async function fetchUniverseWithRetry(apiKey, startDate, maxRetries = 7) {
  const d = new Date(startDate);
  for (let i = 0; i < maxRetries; i++) {
    const dateStr = formatDate(d);
    const items = await fetchUniverse(apiKey, dateStr);
    if (items && items.length) return { items, dateStr };
    d.setDate(d.getDate() - 1);
  }
  return null;
}

// 개별 ETF 히스토리 (한 번의 호출로 최근 ~1년+ 커버)
async function fetchHistory(apiKey, isinCd, beginDate, endDate) {
  const url = `${BASE_URL}?${new URLSearchParams({
    serviceKey: apiKey, numOfRows: '1000', pageNo: '1', resultType: 'json',
    isinCd, beginBasDt: beginDate, endBasDt: endDate,
  })}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  const items = toArray(data?.response?.body?.items?.item);
  if (!items.length) return null;
  return items
    .map(it => ({ date: it.basDt, close: num(it.clpr) }))
    .filter(x => x.close !== null && x.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/* ---------- 지표 계산 ---------- */
// 연율화 변동성: 일간수익률 표준편차 * sqrt(252) * 100
function annualizedVol(closes) {
  if (closes.length < 3) return null;
  const rets = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0) rets.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  if (rets.length < 2) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance) * Math.sqrt(TRADING_DAYS) * 100;
}

function periodReturn(series, days) {
  const idx = series.length - 1 - days;
  if (idx < 0) return null;
  const past = series[idx].close, last = series[series.length - 1].close;
  if (!past) return null;
  return ((last - past) / past) * 100;
}

function maxDrawdown(series) {
  if (series.length < 2) return null;
  let peak = series[0].close, mdd = 0;
  for (const p of series) {
    if (p.close > peak) peak = p.close;
    const dd = (p.close - peak) / peak;
    if (dd < mdd) mdd = dd;
  }
  return mdd * 100; // 음수
}

// 30일 롤링 연율화 변동성 시계열 (상세 차트용)
function rollingVolSeries(series, window = 30) {
  const rets = [];
  for (let i = 1; i < series.length; i++) {
    const p = series[i - 1].close;
    rets.push({ date: series[i].date, r: p > 0 ? (series[i].close - p) / p : 0 });
  }
  const out = [];
  for (let i = window - 1; i < rets.length; i++) {
    const slice = rets.slice(i - window + 1, i + 1).map(x => x.r);
    const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
    const v = slice.reduce((s, r) => s + (r - mean) ** 2, 0) / (slice.length - 1);
    out.push({ date: rets[i].date, value: Math.sqrt(v) * Math.sqrt(TRADING_DAYS) * 100 });
  }
  return out;
}

function drawdownSeries(series) {
  let peak = series[0]?.close || 0;
  return series.map(p => {
    if (p.close > peak) peak = p.close;
    return { date: p.date, value: peak > 0 ? ((p.close - peak) / peak) * 100 : 0 };
  });
}

// 종목별 전체 지표 계산
function computeMetrics(snap, history) {
  const closes = history.map(h => h.close);
  const vols = {};
  for (const [k, w] of Object.entries(VOL_WINDOWS)) {
    vols[k] = annualizedVol(closes.slice(-Math.min(w + 1, closes.length)));
  }
  const ret1y = periodReturn(history, 250);
  const ret6m = periodReturn(history, 120);
  const ret3m = periodReturn(history, 60);
  const ret1m = periodReturn(history, 20);
  const mdd = maxDrawdown(history);
  // 위험조정 = 연수익률 / 연변동성 (1년 변동성 기준). 변동성 0/부족이면 null
  const vol1y = vols.v250;
  const riskAdj = (ret1y !== null && vol1y && vol1y > 0.01) ? (ret1y / vol1y) : null;
  return {
    ...snap, history,
    vols, ret1y, ret6m, ret3m, ret1m, mdd, riskAdj,
    dataPoints: history.length,
  };
}

/* ---------- 동시성 제한 러너 ---------- */
async function runLimited(items, limit, worker, onProgress) {
  const results = [];
  let idx = 0, done = 0;
  async function next() {
    while (idx < items.length && !abortFlag) {
      const my = idx++;
      const r = await worker(items[my], my);
      done++;
      onProgress(done, items.length);
      if (r) results.push(r);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, next));
  return results;
}

/* ---------- 메인 분석 ---------- */
async function runAnalysis() {
  const apiKey = $('apiKey').value.trim();
  if (!apiKey) { setStatus('서비스 키를 먼저 입력하세요.', 'err'); return; }

  abortFlag = false;
  setRunning(true);
  setStatus('ETF 목록 조회 중…', '');
  setProgress(0, 1, 'ETF 목록 조회 중…');

  const baseDateVal = $('baseDate').value;
  const baseDate = baseDateVal ? new Date(baseDateVal + 'T00:00:00') : new Date();

  let uni;
  try {
    uni = await fetchUniverseWithRetry(apiKey, baseDate);
  } catch (e) {
    setStatus('목록 조회 실패: ' + e.message + ' (키가 올바른지, 디코딩 키인지 확인하세요)', 'err');
    setRunning(false); return;
  }
  if (!uni) {
    setStatus('해당 기준일 근처에서 데이터를 찾지 못했습니다. 다른 날짜를 시도하세요.', 'err');
    setRunning(false); return;
  }

  const { items, dateStr } = uni;
  const minTrPrc = (num($('minTrPrc').value) || 0) * 1e8;   // 억원 → 원
  const minMktCap = (num($('minMktCap').value) || 0) * 1e8;
  const catFilter = $('catFilter').value;
  const maxCount = Math.max(10, num($('maxCount').value) || 120);

  // 스냅샷 정규화 + 필터
  let universe = items.map(it => {
    const cat = categorize(it.itmsNm);
    return {
      isinCd: it.isinCd,
      code: it.srtnCd,
      name: it.itmsNm,
      close: num(it.clpr),
      fltRt: num(it.fltRt),
      trPrc: num(it.trPrc),        // 거래대금(원)
      mktCap: num(it.mrktTotAmt),  // 시가총액(원)
      cat,
    };
  }).filter(x => x.isinCd && x.close);

  universe = universe.filter(x =>
    (x.trPrc === null || x.trPrc >= minTrPrc) &&
    (x.mktCap === null || x.mktCap >= minMktCap) &&
    categoryMatch(x.cat, catFilter)
  );
  // 시총 상위 N개만 히스토리 조회
  universe.sort((a, b) => (b.mktCap || 0) - (a.mktCap || 0));
  universe = universe.slice(0, maxCount);

  if (universe.length === 0) {
    setStatus('필터 조건에 맞는 ETF가 없습니다. 조건을 완화하세요.', 'err');
    setRunning(false); return;
  }

  // 히스토리 조회 기간: 기준일 기준 약 400일 전 ~ 기준일
  const endD = parseYmd(dateStr);
  const beginD = new Date(endD); beginD.setDate(beginD.getDate() - 400);
  const beginStr = formatDate(beginD), endStr = dateStr;

  setStatus(`기준일 ${dateStr} · ${universe.length}개 종목 히스토리 분석 중…`, '');

  const computed = await runLimited(universe, 6, async (snap) => {
    if (abortFlag) return null;
    const hist = await fetchHistory(apiKey, snap.isinCd, beginStr, endStr);
    if (!hist || hist.length < 25) return null; // 데이터 부족 제외
    return computeMetrics(snap, hist);
  }, (done, total) => {
    setProgress(done, total, `히스토리 분석 ${done}/${total}`);
  });

  if (abortFlag) { setStatus('중단되었습니다.', 'err'); setRunning(false); return; }

  // 총보수(운용보수)는 매일 수집된 보유종목 데이터(같은 도메인)에서 가져온다
  const hd = await loadHoldings();
  const feeOf = (code) => {
    const f = hd?.data?.[code]?.fee;
    return (f === null || f === undefined) ? null : +f;
  };

  // 순위 기준 변동성이 계산된 종목만
  const rankKey = $('rankWindow').value;
  analysisResults = computed
    .filter(r => r.vols[rankKey] !== null)
    .map(r => ({ ...r, rankVol: r.vols[rankKey], fee: feeOf(r.code) }));

  // 변동성 오름차순 랭킹
  analysisResults.sort((a, b) => a.rankVol - b.rankVol);
  analysisResults.forEach((r, i) => { r.rank = i + 1; });

  $('resultMeta').textContent =
    `기준일 ${parseYmd(dateStr).toLocaleDateString('ko-KR')} · ${analysisResults.length}종목 · ${winLabel(rankKey)} 변동성 오름차순`;
  setStatus(`✓ 완료: ${analysisResults.length}개 종목 분석`, 'ok');
  setRunning(false);
  sortState = { key: 'rankVol', dir: 'asc' };
  applySearchAndRender();
  renderFavorites();
}

function winLabel(k) {
  return { v20: '1개월', v60: '3개월', v120: '6개월', v250: '1년' }[k] || k;
}

/* ---------- 렌더링 ---------- */
const COLS = [
  { key: 'rank', label: '순위', align: 'left' },
  { key: 'name', label: '종목명', align: 'left' },
  { key: 'cat', label: '분류', align: 'left' },
  { key: 'close', label: '종가', fmt: r => fmtInt(r.close) },
  { key: 'fltRt', label: '등락률', fmt: r => pctCell(r.fltRt) },
  { key: 'rankVol', label: '변동성', fmt: r => volCell(r.rankVol), head: () => `변동성(${winLabel($('rankWindow').value)})` },
  { key: 'v20', label: '1M변', fmt: r => fmt(r.vols.v20) + '%' },
  { key: 'v120', label: '6M변', fmt: r => fmt(r.vols.v120) + '%' },
  { key: 'v250', label: '1Y변', fmt: r => fmt(r.vols.v250) + '%' },
  { key: 'mdd', label: 'MDD', fmt: r => r.mdd === null ? 'N/A' : `<span class="neg">${fmt(r.mdd)}%</span>` },
  { key: 'ret1m', label: '1개월', fmt: r => pctCell(r.ret1m) },
  { key: 'ret3m', label: '3개월', fmt: r => pctCell(r.ret3m) },
  { key: 'ret6m', label: '6개월', fmt: r => pctCell(r.ret6m) },
  { key: 'ret1y', label: '1년수익', fmt: r => pctCell(r.ret1y) },
  { key: 'riskAdj', label: '위험조정', fmt: r => r.riskAdj === null ? 'N/A' : `<span class="${r.riskAdj >= 0 ? 'pos' : 'neg'}">${fmt(r.riskAdj)}</span>` },
  { key: 'fee', label: '총보수', fmt: r => feeCell(r.fee) },
  { key: 'mktCap', label: '시총(억)', fmt: r => r.mktCap === null ? 'N/A' : fmtInt(r.mktCap / 1e8) },
  { key: 'trPrc', label: '거래대금(억)', fmt: r => r.trPrc === null ? 'N/A' : fmt(r.trPrc / 1e8, 1) },
  { key: 'fav', label: '★', align: 'left', nosort: true },
];

function pctCell(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return 'N/A';
  const c = v > 0 ? 'pos' : v < 0 ? 'neg' : '';
  const s = v > 0 ? '+' : '';
  return `<span class="${c}">${s}${fmt(v)}%</span>`;
}
function volCell(v) {
  if (v === null || v === undefined) return 'N/A';
  const cls = v <= 10 ? 'vol-low' : v <= 20 ? 'vol-mid' : 'vol-high';
  return `<span class="vol-cell ${cls}">${fmt(v)}%</span>`;
}
function feeCell(v) {
  if (v === null || v === undefined || !Number.isFinite(+v)) return 'N/A';
  return String(+(+v).toFixed(3)) + '%'; // 0.15% / 0.05% / 0.045% 처럼 불필요한 0 제거
}
function rankBadge(rank) {
  const cls = rank === 1 ? 'rank-1' : rank === 2 ? 'rank-2' : rank === 3 ? 'rank-3' : 'rank-n';
  return `<span class="rank-badge ${cls}">${rank}</span>`;
}

function buildHead(tableId) {
  const thead = document.querySelector(`#${tableId} thead`);
  thead.innerHTML = '<tr>' + COLS.map(c => {
    const label = c.head ? c.head() : c.label;
    const arrow = (!c.nosort && sortState.key === c.key) ? ` <span class="arrow">${sortState.dir === 'asc' ? '▲' : '▼'}</span>` : '';
    return `<th class="${c.align === 'left' ? 'left' : ''}" data-key="${c.key}" data-nosort="${c.nosort ? 1 : 0}">${label}${arrow}</th>`;
  }).join('') + '</tr>';
  thead.querySelectorAll('th').forEach(th => {
    if (th.dataset.nosort === '1') return;
    th.onclick = () => {
      const key = th.dataset.key;
      if (sortState.key === key) sortState.dir = sortState.dir === 'asc' ? 'desc' : 'asc';
      else sortState = { key, dir: (key === 'rankVol' || key === 'rank' || key === 'fee') ? 'asc' : 'desc' };
      applySearchAndRender();
    };
  });
}

function rowHtml(r) {
  const isFav = favorites.includes(r.isinCd);
  const tds = COLS.map(c => {
    if (c.key === 'rank') return `<td class="left">${rankBadge(r.rank)}</td>`;
    if (c.key === 'name') return `<td class="left name-cell">${escapeHtml(r.name)}<br><span class="code">${r.code || ''}</span></td>`;
    if (c.key === 'cat') return `<td class="left"><span class="tag">${r.cat}</span></td>`;
    if (c.key === 'fav') return `<td class="left"><span class="star ${isFav ? 'on' : ''}" data-fav="${r.isinCd}">${isFav ? '★' : '☆'}</span></td>`;
    return `<td>${c.fmt ? c.fmt(r) : (r[c.key] ?? 'N/A')}</td>`;
  }).join('');
  return `<tr data-isin="${r.isinCd}" class="${isFav ? 'fav-row' : ''}">${tds}</tr>`;
}

function sortResults(arr) {
  const { key, dir } = sortState;
  const mul = dir === 'asc' ? 1 : -1;
  return [...arr].sort((a, b) => {
    let av = key === 'rankVol' ? a.rankVol : (key.startsWith('v') && a.vols ? a.vols[key] : a[key]);
    let bv = key === 'rankVol' ? b.rankVol : (key.startsWith('v') && b.vols ? b.vols[key] : b[key]);
    if (typeof av === 'string' || key === 'name' || key === 'cat') {
      return String(av || '').localeCompare(String(bv || '')) * mul;
    }
    if (av === null || av === undefined) return 1;
    if (bv === null || bv === undefined) return -1;
    return (av - bv) * mul;
  });
}

function applySearchAndRender() {
  const q = $('searchBox').value.trim().toLowerCase();
  filteredResults = q
    ? analysisResults.filter(r => (r.name || '').toLowerCase().includes(q) || (r.code || '').includes(q))
    : analysisResults;
  renderResults();
}

function renderResults() {
  const empty = $('resultEmpty');
  const tbody = document.querySelector('#resultTable tbody');
  if (analysisResults.length === 0) {
    empty.style.display = 'block';
    document.querySelector('#resultTable thead').innerHTML = '';
    tbody.innerHTML = '';
    return;
  }
  empty.style.display = 'none';
  buildHead('resultTable');
  const rows = sortResults(filteredResults);
  tbody.innerHTML = rows.map(rowHtml).join('');
  wireRows(tbody);
}

function renderFavorites() {
  const card = $('favCard');
  const favData = analysisResults.filter(r => favorites.includes(r.isinCd));
  if (favorites.length === 0) { card.style.display = 'none'; return; }
  card.style.display = 'block';
  $('favCount').textContent = `${favorites.length}개`;
  const thead = document.querySelector('#favTable thead');
  thead.innerHTML = '<tr>' + COLS.map(c => `<th class="${c.align === 'left' ? 'left' : ''}">${c.head ? c.head() : c.label}</th>`).join('') + '</tr>';
  const tbody = document.querySelector('#favTable tbody');
  if (favData.length === 0) {
    tbody.innerHTML = `<tr><td colspan="${COLS.length}" class="empty" style="text-align:center;">관심종목이 이번 분석 결과에 없습니다. 분석을 실행하세요.</td></tr>`;
    return;
  }
  tbody.innerHTML = favData.map(rowHtml).join('');
  wireRows(tbody);
}

function wireRows(tbody) {
  tbody.querySelectorAll('.star').forEach(s => {
    s.onclick = (e) => { e.stopPropagation(); toggleFav(s.dataset.fav); };
  });
  tbody.querySelectorAll('tr[data-isin]').forEach(tr => {
    tr.onclick = () => openDetail(tr.dataset.isin);
  });
}

function toggleFav(isin) {
  const i = favorites.indexOf(isin);
  if (i >= 0) favorites.splice(i, 1); else favorites.push(isin);
  saveFavorites();
  applySearchAndRender();
  renderFavorites();
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- 상세 모달 & 차트 ---------- */
function openDetail(isin) {
  const r = analysisResults.find(x => x.isinCd === isin);
  if (!r) return;
  currentDetail = r;
  $('modalTitle').textContent = r.name;
  $('modalSub').textContent = `${r.code || ''} · ${r.isinCd} · ${r.cat} · 데이터 ${r.dataPoints}일`;
  const m = [
    ['순위', `${r.rank}위`],
    [`변동성(${winLabel($('rankWindow').value)})`, fmt(r.rankVol) + '%'],
    ['1년 변동성', fmt(r.vols.v250) + '%'],
    ['최대낙폭', r.mdd === null ? 'N/A' : fmt(r.mdd) + '%'],
    ['1년 수익률', r.ret1y === null ? 'N/A' : (r.ret1y > 0 ? '+' : '') + fmt(r.ret1y) + '%'],
    ['위험조정', r.riskAdj === null ? 'N/A' : fmt(r.riskAdj)],
    ['3개월 수익', r.ret3m === null ? 'N/A' : (r.ret3m > 0 ? '+' : '') + fmt(r.ret3m) + '%'],
    ['시가총액', r.mktCap === null ? 'N/A' : fmtInt(r.mktCap / 1e8) + '억'],
  ];
  $('modalMetrics').innerHTML = m.map(([k, v]) => {
    const cls = v.startsWith && (v.startsWith('+') ? 'pos' : v.startsWith('-') ? 'neg' : '');
    return `<div class="metric"><div class="k">${k}</div><div class="v ${cls}">${v}</div></div>`;
  }).join('');
  $('modalOverlay').classList.add('active');
  document.querySelectorAll('#chartTabs button').forEach(b => b.classList.toggle('active', b.dataset.chart === 'cum'));
  drawChart('cum');
  renderHoldings(r);
}

// 보유종목 & 구성 렌더링 (같은 도메인 holdings.json에서 조회)
async function renderHoldings(r) {
  const box = $('holdingsSection');
  box.innerHTML = '<div class="holdings-loading">보유종목 정보를 불러오는 중…</div>';
  const hd = await loadHoldings();
  if (!currentDetail || currentDetail.isinCd !== r.isinCd) return; // 그 사이 다른 종목 열림
  if (!hd || !hd.data) {
    box.innerHTML = '<div class="holdings-loading">보유종목 데이터를 불러올 수 없습니다. (data/holdings.json 미생성)</div>';
    return;
  }
  const h = hd.data[r.code];
  if (!h) {
    box.innerHTML = '<div class="holdings-loading">이 ETF의 보유종목 데이터가 아직 없습니다. (매일 자동 갱신)</div>';
    return;
  }
  const upd = hd.updatedAt ? new Date(hd.updatedAt).toLocaleDateString('ko-KR') : '';
  const facts = [];
  if (h.baseIndex) facts.push(`<div class="fact"><span>기초지수</span> <b>${escapeHtml(h.baseIndex)}</b></div>`);
  if (h.issuer) facts.push(`<div class="fact"><span>운용사</span> <b>${escapeHtml(h.issuer)}</b></div>`);
  if (h.fee !== null && h.fee !== undefined) facts.push(`<div class="fact"><span>총보수</span> <b>${h.fee}%</b></div>`);
  if (h.marketValue) facts.push(`<div class="fact"><span>순자산</span> <b>${escapeHtml(h.marketValue)}</b></div>`);
  if (h.listedDate) facts.push(`<div class="fact"><span>상장일</span> <b>${h.listedDate.replace(/(\d{4})(\d{2})(\d{2})/, '$1.$2.$3')}</b></div>`);

  const top10 = (h.top10 || []).slice(0, 10);
  const holdRows = top10.length
    ? top10.map(a => `<tr>
        <td class="hold-name">${escapeHtml(a.name)}${a.code ? `<span class="hold-code">${a.code}</span>` : ''}</td>
        <td class="wt">${a.weight === null || a.weight === undefined ? '-' : a.weight.toFixed(2) + '%'}</td>
      </tr>`).join('')
    : '<tr><td colspan="2" class="holdings-loading">구성종목 정보 없음</td></tr>';

  const bars = (list, labels) => {
    const items = (list || []).filter(x => x.weight > 0).slice(0, 6);
    if (!items.length) return '<div class="holdings-loading">정보 없음</div>';
    const max = Math.max(...items.map(x => x.weight), 1);
    return '<div class="bar-wrap">' + items.map(x => {
      const lbl = labels[x.code] || labels[(x.code || '').toUpperCase()] || x.code;
      return `<div class="bar-row">
        <span class="lbl">${escapeHtml(lbl)}</span>
        <span class="track"><span class="fill" style="width:${Math.max(3, (x.weight / max) * 100)}%"></span></span>
        <span class="pct">${x.weight.toFixed(1)}%</span>
      </div>`;
    }).join('') + '</div>';
  };

  const hasSector = (h.sectors || []).some(x => x.weight > 0);
  const breakdownTitle = hasSector ? '섹터 구성' : '자산 구성';
  const breakdownBars = hasSector ? bars(h.sectors, SECTOR_LABELS) : bars(h.assets, ASSET_LABELS);

  box.innerHTML = `
    <h4>📦 보유종목 & 구성 <span class="upd">기준 ${upd}</span></h4>
    ${facts.length ? `<div class="fact-row">${facts.join('')}</div>` : ''}
    <div class="cols-2">
      <div>
        <div style="font-size:13px;color:var(--muted);margin-bottom:6px;">상위 보유종목 (Top ${top10.length})</div>
        <table class="hold-table">${holdRows}</table>
      </div>
      <div>
        <div style="font-size:13px;color:var(--muted);margin-bottom:6px;">${breakdownTitle}</div>
        ${breakdownBars}
        ${hasSector && (h.assets || []).some(x => x.weight > 0) ? `<div style="font-size:13px;color:var(--muted);margin:14px 0 6px;">자산 구성</div>${bars(h.assets, ASSET_LABELS)}` : ''}
      </div>
    </div>`;
}

function closeDetail() {
  $('modalOverlay').classList.remove('active');
  if (detailChart) { detailChart.destroy(); detailChart = null; }
}

function drawChart(type) {
  const r = currentDetail;
  if (!r) return;
  const ctx = $('detailChart').getContext('2d');
  if (detailChart) { detailChart.destroy(); detailChart = null; }

  let labels = [], datasets = [], yTitle = '';
  const hist = r.history;
  const labelFmt = (d) => `${d.slice(4, 6)}/${d.slice(6, 8)}`;

  if (type === 'cum') {
    const base = hist[0].close;
    labels = hist.map(h => labelFmt(h.date));
    const data = hist.map(h => ((h.close - base) / base) * 100);
    datasets = [{ label: '누적수익률(%)', data, borderColor: '#ff5a5a', backgroundColor: 'rgba(255,90,90,0.12)', fill: true, pointRadius: 0, borderWidth: 2, tension: 0.15 }];
    yTitle = '%';
  } else if (type === 'price') {
    labels = hist.map(h => labelFmt(h.date));
    datasets = [{ label: '종가', data: hist.map(h => h.close), borderColor: '#38bdf8', backgroundColor: 'rgba(56,189,248,0.12)', fill: true, pointRadius: 0, borderWidth: 2, tension: 0.15 }];
    yTitle = '원';
  } else if (type === 'vol') {
    const rv = rollingVolSeries(hist, 30);
    labels = rv.map(x => labelFmt(x.date));
    datasets = [{ label: '30일 롤링 연율화 변동성(%)', data: rv.map(x => x.value), borderColor: '#fbbf24', backgroundColor: 'rgba(251,191,36,0.12)', fill: true, pointRadius: 0, borderWidth: 2, tension: 0.15 }];
    yTitle = '%';
  } else if (type === 'dd') {
    const dd = drawdownSeries(hist);
    labels = dd.map(x => labelFmt(x.date));
    datasets = [{ label: '낙폭(%)', data: dd.map(x => x.value), borderColor: '#4d90fe', backgroundColor: 'rgba(77,144,254,0.15)', fill: true, pointRadius: 0, borderWidth: 2, tension: 0.1 }];
    yTitle = '%';
  }

  detailChart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { labels: { color: '#e2e8f0' } } },
      scales: {
        x: { ticks: { color: '#94a3b8', maxTicksLimit: 10 }, grid: { color: 'rgba(51,65,85,0.4)' } },
        y: { ticks: { color: '#94a3b8' }, grid: { color: 'rgba(51,65,85,0.4)' }, title: { display: true, text: yTitle, color: '#94a3b8' } },
      },
    },
  });
}

/* ---------- CSV ---------- */
function exportCsv() {
  if (analysisResults.length === 0) { setStatus('내보낼 데이터가 없습니다.', 'err'); return; }
  const header = ['순위', '종목명', '코드', 'ISIN', '분류', '종가', '등락률(%)', '총보수(%)',
    '변동성_1M(%)', '변동성_3M(%)', '변동성_6M(%)', '변동성_1Y(%)', 'MDD(%)',
    '수익률_1M(%)', '수익률_3M(%)', '수익률_6M(%)', '수익률_1Y(%)', '위험조정', '시총(억)', '거래대금(억)'];
  const rows = sortResults(filteredResults).map(r => [
    r.rank, r.name, r.code, r.isinCd, r.cat, r.close, r.fltRt,
    (r.fee === null || r.fee === undefined) ? '' : +(+r.fee).toFixed(3),
    fmt(r.vols.v20), fmt(r.vols.v60), fmt(r.vols.v120), fmt(r.vols.v250), fmt(r.mdd),
    fmt(r.ret1m), fmt(r.ret3m), fmt(r.ret6m), fmt(r.ret1y),
    r.riskAdj === null ? '' : fmt(r.riskAdj),
    r.mktCap === null ? '' : Math.round(r.mktCap / 1e8),
    r.trPrc === null ? '' : fmt(r.trPrc / 1e8, 1),
  ]);
  const csv = [header, ...rows].map(row =>
    row.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `lowvol_etf_${formatDate(new Date())}.csv`;
  a.click(); URL.revokeObjectURL(url);
}

/* ---------- UI 상태 ---------- */
function setStatus(msg, cls) { const el = $('statusMsg'); el.textContent = msg; el.className = 'status ' + (cls || ''); }
function setProgress(done, total, text) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  $('progressFill').style.width = pct + '%';
  $('progressText').textContent = text || `${done}/${total}`;
}
function setRunning(on) {
  $('runBtn').disabled = on;
  $('stopBtn').style.display = on ? 'inline-block' : 'none';
  $('progressWrap').classList.toggle('active', on);
  if (!on) setTimeout(() => $('progressWrap').classList.remove('active'), 600);
}

/* ---------- 초기화 ---------- */
function init() {
  const savedKey = localStorage.getItem(LS_KEY);
  if (savedKey) { $('apiKey').value = savedKey; $('keySaved').style.display = 'inline'; }

  const today = new Date();
  $('baseDate').value = today.toISOString().slice(0, 10);
  $('baseDate').max = today.toISOString().slice(0, 10);

  $('saveKeyBtn').onclick = () => {
    const k = $('apiKey').value.trim();
    if (k) { localStorage.setItem(LS_KEY, k); $('keySaved').style.display = 'inline'; setStatus('서비스 키가 저장되었습니다.', 'ok'); }
  };
  $('runBtn').onclick = runAnalysis;
  $('stopBtn').onclick = () => { abortFlag = true; setStatus('중단 요청됨…', 'err'); };
  $('searchBox').oninput = applySearchAndRender;
  $('csvBtn').onclick = exportCsv;
  $('rankWindow').onchange = () => {
    if (analysisResults.length === 0) return;
    const rankKey = $('rankWindow').value;
    analysisResults = analysisResults
      .filter(r => r.vols[rankKey] !== null)
      .map(r => ({ ...r, rankVol: r.vols[rankKey] }))
      .sort((a, b) => a.rankVol - b.rankVol);
    analysisResults.forEach((r, i) => { r.rank = i + 1; });
    $('resultMeta').textContent = `${analysisResults.length}종목 · ${winLabel(rankKey)} 변동성 오름차순`;
    sortState = { key: 'rankVol', dir: 'asc' };
    applySearchAndRender(); renderFavorites();
  };

  $('modalClose').onclick = closeDetail;
  $('modalOverlay').onclick = (e) => { if (e.target === $('modalOverlay')) closeDetail(); };
  document.querySelectorAll('#chartTabs button').forEach(b => {
    b.onclick = () => {
      document.querySelectorAll('#chartTabs button').forEach(x => x.classList.remove('active'));
      b.classList.add('active'); drawChart(b.dataset.chart);
    };
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDetail(); });
}

document.addEventListener('DOMContentLoaded', init);
