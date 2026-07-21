#!/usr/bin/env node
/*
 * fetch-holdings.js
 * 국내 전 종목 ETF의 보유종목(Top10)·섹터/자산 구성·운용보수 등을 Naver에서 수집해
 * data/holdings.json 으로 저장한다. GitHub Actions에서 매일 실행된다.
 *
 * Naver 엔드포인트는 CORS 헤더가 없어 브라우저에서 직접 못 부르므로,
 * 서버(Actions)에서 미리 받아 같은 도메인 정적 JSON으로 커밋 → 앱은 CORS 없이 읽는다.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const iconv = tryRequireIconv();

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36';
const LIST_URL = 'https://finance.naver.com/api/sise/etfItemList.nhn';
const detailUrl = (code) => `https://m.stock.naver.com/api/stock/${code}/etfAnalysis`;
const CONCURRENCY = 8;
const OUT = path.join(__dirname, '..', 'data', 'holdings.json');

function tryRequireIconv() {
  try { return require('iconv-lite'); } catch { return null; }
}

// etfItemList는 EUC-KR로 내려온다. iconv-lite가 없으면 TextDecoder(euc-kr) 시도.
async function fetchEtfList() {
  const res = await fetch(LIST_URL, { headers: { 'User-Agent': UA } });
  const buf = Buffer.from(await res.arrayBuffer());
  let text;
  if (iconv) text = iconv.decode(buf, 'euc-kr');
  else {
    try { text = new TextDecoder('euc-kr').decode(buf); }
    catch { text = buf.toString('utf-8'); }
  }
  const json = JSON.parse(text);
  const list = json?.result?.etfItemList || [];
  return list.map((x) => ({ code: String(x.itemcode), name: x.itemname })).filter((x) => /^\d{6}$/.test(x.code));
}

const pctNum = (v) => {
  if (v === null || v === undefined) return null;
  const n = parseFloat(String(v).replace('%', '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

async function fetchDetail(code) {
  try {
    const res = await fetch(detailUrl(code), { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
    if (!res.ok) return null;
    const d = await res.json();
    const top10 = (d.etfTop10MajorConstituentAssets || []).map((a) => ({
      code: a.itemCode || null,
      name: a.itemName || '',
      weight: pctNum(a.etfWeight),
    })).filter((a) => a.name);
    const sectors = (d.sectorPortfolioList || []).map((s) => ({ code: s.detailTypeCode, weight: s.weight })).filter((s) => s.code);
    const assets = (d.assetPortfolioList || []).map((s) => ({ code: s.detailTypeCode, weight: s.weight })).filter((s) => s.code);
    const countries = (d.countryPortfolioList || []).map((s) => ({ code: s.detailTypeCode, weight: s.weight })).filter((s) => s.code);
    // 의미 있는 데이터가 하나도 없으면 스킵
    if (!top10.length && !sectors.length && !assets.length) return null;
    return {
      name: d.itemName || '',
      issuer: d.issuerName || null,
      baseIndex: d.etfBaseIndex || null,
      fee: (d.totalFee ?? null),
      marketValue: d.marketValue || null,
      listedDate: d.listedDate || null,
      top10, sectors, assets, countries,
    };
  } catch {
    return null;
  }
}

async function runPool(items, concurrency, worker, onTick) {
  let idx = 0, done = 0;
  const results = new Array(items.length);
  async function next() {
    while (idx < items.length) {
      const my = idx++;
      results[my] = await worker(items[my], my);
      done++;
      if (onTick && done % 50 === 0) onTick(done, items.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, next));
  return results;
}

(async () => {
  console.log('Fetching ETF list…');
  const list = await fetchEtfList();
  console.log(`ETF list: ${list.length} items`);
  if (list.length === 0) { console.error('Empty ETF list — aborting to avoid clobbering holdings.json'); process.exit(1); }

  const details = await runPool(list, CONCURRENCY, (item) => fetchDetail(item.code),
    (done, total) => console.log(`  fetched ${done}/${total}`));

  const data = {};
  let ok = 0;
  list.forEach((item, i) => {
    const d = details[i];
    if (d) { data[item.code] = d; ok++; }
  });

  if (ok === 0) { console.error('No holdings fetched — aborting to keep existing file'); process.exit(1); }

  const payload = {
    updatedAt: new Date().toISOString(),
    source: 'Naver Finance ETF Analysis',
    count: ok,
    data,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload));
  console.log(`Wrote ${OUT}: ${ok}/${list.length} ETFs with holdings (${(fs.statSync(OUT).size / 1e6).toFixed(2)} MB)`);
})();
