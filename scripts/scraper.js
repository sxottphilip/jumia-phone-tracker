/**
 * Jumia Nigeria Smartphone Price Tracker — Scraper
 *
 * Fetches the Jumia smartphones category (sorted lowest-price first),
 * filters to the ₦120k–250k range, visits each product page for full specs,
 * and writes out:
 *   data/phones.json      — current snapshot
 *   data/history.json     — per-phone price history
 *   data/last-run-log.json — run summary for debugging
 *
 * Uses the WebScraping.AI /html API endpoint (with JS rendering) for
 * listing pages and /ai/question for spec extraction from product pages.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const API_KEY = process.env.WEBSCRAPING_API_KEY;
if (!API_KEY) {
  console.error('FATAL: WEBSCRAPING_API_KEY environment variable is not set.');
  process.exit(1);
}

const API_BASE = 'api.webscraping.ai';
const LISTING_URL = 'https://www.jumia.com.ng/smartphones/';
const DATA_DIR = path.join(__dirname, '..', 'data');
const MIN_PRICE = 120000;
const MAX_PRICE = 250000;
const DELAY_MS = 1800;
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 2000;
const MAX_PAGES = 30;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function fetchHTML(url, opts = {}) {
  const params = new URLSearchParams({
    api_key: API_KEY, url, js: 'true',
    timeout: opts.timeout || 25000,
    proxy: opts.proxy || 'datacenter',
  });
  return new Promise((resolve, reject) => {
    const req = https.get(
      `https://${API_BASE}/html?${params.toString()}`,
      { timeout: 30000 },
      (res) => {
        let data = '';
        res.on('data', chunk => (data += chunk));
        res.on('end', () => {
          if (res.statusCode === 200) resolve(data);
          else reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
  });
}

function askQuestion(url, question) {
  const params = new URLSearchParams({
    api_key: API_KEY, url, question, js: 'true', timeout: '20000',
  });
  return new Promise((resolve, reject) => {
    const req = https.get(
      `https://${API_BASE}/ai/question?${params.toString()}`,
      { timeout: 25000 },
      (res) => {
        let data = '';
        res.on('data', chunk => (data += chunk));
        res.on('end', () => {
          if (res.statusCode === 200) resolve(data);
          else reject(new Error(`AI question HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('AI question timed out')); });
  });
}

async function retry(fn, label) {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      if (attempt > 0) {
        const wait = INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
        console.log(`  Retry ${attempt + 1}/${MAX_RETRIES} (${label}) — waiting ${wait}ms…`);
        await sleep(wait);
      }
      return await fn();
    } catch (err) {
      if (attempt === MAX_RETRIES - 1) throw err;
      console.warn(`  Attempt ${attempt + 1} failed (${label}): ${err.message}`);
    }
  }
}

function parsePrice(str) {
  if (!str) return NaN;
  return parseInt(str.replace(/[₦,\s]/g, ''), 10);
}

async function extractSpecs(productUrl) {
  const question = `Extract all technical specifications for this smartphone from the product page. Return ONLY a JSON object with these keys (use null if not found): display, resolution, ram, storage, battery, camera_rear, camera_front, processor, os, network, sim. Example: {"display":"6.9\" IPS LCD","ram":"6GB","storage":"128GB","battery":"5000mAh","camera_rear":"50MP","camera_front":"8MP","processor":"MediaTek Helio G85","os":"Android 15","network":"4G LTE","sim":"Dual SIM","resolution":"720x1640"}`;

  const rawAnswer = await retry(
    () => askQuestion(productUrl, question),
    `specs: ${productUrl.slice(0, 60)}…`,
  );

  let cleaned = rawAnswer.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }

  try {
    const specs = JSON.parse(cleaned);
    const keys = ['display','resolution','ram','storage','battery','camera_rear','camera_front','processor','os','network','sim'];
    for (const k of keys) { if (!(k in specs)) specs[k] = null; }
    return specs;
  } catch (err) {
    console.warn(`  Failed to parse specs JSON for ${productUrl}: ${err.message}`);
    return { display:null,resolution:null,ram:null,storage:null,battery:null,camera_rear:null,camera_front:null,processor:null,os:null,network:null,sim:null,_raw:rawAnswer.slice(0,500) };
  }
}

function parseListingHTML(html) {
  const products = [];
  const articleRegex = /<article\s[^>]*class="[^"]*prd[^"]*"[^>]*>[\s\S]*?<\/article>/gi;
  const articles = html.match(articleRegex) || [];

  for (const articleStr of articles) {
    try {
      const nameMatch = articleStr.match(/<h3[^>]*class="[^"]*name[^"]*"[^>]*>([\s\S]*?)<\/h3>/i);
      if (!nameMatch) continue;
      const name = nameMatch[1].replace(/<[^>]+>/g, '').trim();

      const priceMatch = articleStr.match(/<div[^>]*class="[^"]*prc[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
      if (!priceMatch) continue;
      const price = parsePrice(priceMatch[1].replace(/<[^>]+>/g, '').trim());
      if (isNaN(price)) continue;

      const urlMatch = articleStr.match(/<a[^>]*href="(\/[^"]+)"/i);
      const productPath = urlMatch ? urlMatch[1] : null;
      if (!productPath || !productPath.includes('/')) continue;
      const productUrl = productPath.startsWith('http') ? productPath : `https://www.jumia.com.ng${productPath}`;

      const imgMatch = articleStr.match(/<img[^>]*data-src="([^"]+)"/i) || articleStr.match(/<img[^>]*src="([^"]+)"/i);
      products.push({ name, price, productUrl, imageUrl: imgMatch ? imgMatch[1] : null });
    } catch (e) { /* skip malformed */ }
  }

  // Fallback: broader extraction
  if (products.length === 0) {
    const priceRegex = /₦\s*[\d,]+/g;
    const linkRegex = /<a[^>]*href="(\/[^"]*-\d+\.html)"[^>]*>/gi;
    const prices = []; let pm;
    while ((pm = priceRegex.exec(html)) !== null) {
      const val = parsePrice(pm[0]);
      if (!isNaN(val)) prices.push({ price: val, index: pm.index });
    }
    const links = []; let lm;
    while ((lm = linkRegex.exec(html)) !== null) {
      links.push({ url: `https://www.jumia.com.ng${lm[1]}`, index: lm.index });
    }
    for (const p of prices) {
      const preceding = [...links].reverse().find(l => l.index < p.index);
      if (!preceding) continue;
      const beforeSection = html.slice(Math.max(0, p.index - 300), p.index);
      const nameMatch = beforeSection.match(/<h3[^>]*class="[^"]*name[^"]*"[^>]*>([\s\S]*?)<\/h3>/i) || beforeSection.match(/>([^<]{10,80})<\/a>/i);
      const name = nameMatch ? nameMatch[1].replace(/<[^>]+>/g, '').trim() : 'Unknown Phone';
      const imgMatch = beforeSection.match(/<img[^>]*data-src="([^"]+)"/i) || beforeSection.match(/<img[^>]*src="([^"]+)"/i);
      products.push({ name, price: p.price, productUrl: preceding.url, imageUrl: imgMatch ? imgMatch[1] : null });
    }
  }
  return products;
}

function hasMorePages(html, currentPage) {
  const paginationMatch = html.match(/aria-label="Page\s+(\d+)"/gi);
  if (paginationMatch) {
    const pages = paginationMatch.map(m => { const n = m.match(/\d+/); return n ? parseInt(n[0]) : 0; });
    return currentPage < Math.max(...pages, currentPage);
  }
  return /next/i.test(html) && /page/i.test(html);
}

async function scrapeAll() {
  const startTime = new Date();
  console.log(`\n=== Jumia Phone Tracker — Starting scrape at ${startTime.toISOString()} ===\n`);

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  console.log('-- Phase 1: Scanning listing pages (₦120k–250k) --\n');
  let allCandidates = [];
  let seenUrls = new Set();
  let stoppedEarly = false;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const pageUrl = `${LISTING_URL}?page=${page}&sort=lowest-price`;
    console.log(`Page ${page}: ${pageUrl}`);
    let html;
    try {
      html = await retry(() => fetchHTML(pageUrl), `listing page ${page}`);
    } catch (err) {
      console.error(`  Failed to fetch page ${page}: ${err.message}`);
      break;
    }
    if (html.length < 2000 || !/smartphone/i.test(html)) {
      console.warn(`  Page ${page} returned suspicious content (${html.length} chars).`);
      if (page === 1) console.error('  Page 1 looks invalid — possible IP block or site structure change.');
      break;
    }

    const products = parseListingHTML(html);
    console.log(`  Found ${products.length} products`);
    let newCandidates = 0, lowestOnPage = Infinity, highestOnPage = -Infinity;

    for (const p of products) {
      lowestOnPage = Math.min(lowestOnPage, p.price);
      highestOnPage = Math.max(highestOnPage, p.price);
      if (p.price >= MIN_PRICE && p.price <= MAX_PRICE) {
        const urlKey = p.productUrl.split('?')[0];
        if (!seenUrls.has(urlKey)) { seenUrls.add(urlKey); allCandidates.push(p); newCandidates++; }
      }
    }
    console.log(`    Prices: ₦${lowestOnPage.toLocaleString()} – ₦${highestOnPage.toLocaleString()}`);
    console.log(`    New in range: ${newCandidates} | Total: ${allCandidates.length}`);

    if (lowestOnPage > MAX_PRICE) {
      console.log(`  Lowest on page (₦${lowestOnPage.toLocaleString()}) > ₦250k — stopping.`);
      stoppedEarly = true; break;
    }
    if (!hasMorePages(html, page)) { console.log('  No more pages.'); break; }
    await sleep(DELAY_MS);
  }

  console.log(`\n-- Phase 1 complete: ${allCandidates.length} candidates --\n`);

  if (allCandidates.length === 0) {
    const log = { timestamp: new Date().toISOString(), status: 'WARNING', message: 'No products parsed — check selectors.', candidatesFound: 0, specsSucceeded: 0, specsFailed: 0 };
    writeJSON('last-run-log.json', log);
    console.log('WARNING: No products found. Existing data files preserved.');
    return;
  }

  console.log(`-- Phase 2: Extracting specs for ${allCandidates.length} candidates --\n`);
  let specsSucceeded = 0, specsFailed = 0;
  const results = [];

  for (let i = 0; i < allCandidates.length; i++) {
    const c = allCandidates[i];
    console.log(`[${i + 1}/${allCandidates.length}] ${c.name.slice(0, 50)}`);
    let specs = null;
    try {
      specs = await extractSpecs(c.productUrl);
      specsSucceeded++;
      console.log('  Specs OK');
    } catch (err) {
      specsFailed++;
      console.warn(`  Specs failed: ${err.message}`);
      specs = { display:null,resolution:null,ram:null,storage:null,battery:null,camera_rear:null,camera_front:null,processor:null,os:null,network:null,sim:null,_error:err.message };
    }
    results.push({ name:c.name, price:c.price, productUrl:c.productUrl, imageUrl:c.imageUrl, specs, scrapedAt:new Date().toISOString() });
    if (i < allCandidates.length - 1) await sleep(DELAY_MS);
  }

  console.log(`\n-- Phase 2 complete: ${specsSucceeded} OK, ${specsFailed} failed --\n`);
  console.log('-- Phase 3: Writing output files --\n');

  writeJSON('phones.json', { generatedAt: new Date().toISOString(), priceRange: { min: MIN_PRICE, max: MAX_PRICE }, totalPhones: results.length, phones: results });
  console.log(`  data/phones.json — ${results.length} phones`);

  const history = updateHistory(results);
  writeJSON('history.json', history);
  console.log(`  data/history.json — ${Object.keys(history.phones).length} phones tracked`);

  const elapsed = Math.round((new Date() - startTime) / 1000);
  writeJSON('last-run-log.json', { timestamp: new Date().toISOString(), status: 'SUCCESS', elapsedSeconds: elapsed, candidatesFound: allCandidates.length, specsSucceeded, specsFailed, totalWritten: results.length });
  console.log(`  data/last-run-log.json`);
  console.log(`\n=== Scrape complete in ${elapsed}s ===\n`);
}

function loadExistingJSON(filename) {
  const fp = path.join(DATA_DIR, filename);
  if (!fs.existsSync(fp)) return null;
  try { return JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch { return null; }
}

function writeJSON(filename, data) {
  fs.writeFileSync(path.join(DATA_DIR, filename), JSON.stringify(data, null, 2), 'utf-8');
}

function updateHistory(phones) {
  let history = loadExistingJSON('history.json');
  if (!history || !history.phones) {
    history = { description: 'Price history for tracked phones.', lastUpdated: new Date().toISOString(), phones: {} };
  }
  const today = new Date().toISOString().split('T')[0];
  for (const phone of phones) {
    const key = normalizeKey(phone.name);
    if (!history.phones[key]) {
      history.phones[key] = { name: phone.name, productUrl: phone.productUrl, imageUrl: phone.imageUrl, priceHistory: [] };
    }
    const hist = history.phones[key];
    if (phone.imageUrl) hist.imageUrl = phone.imageUrl;
    if (phone.productUrl) hist.productUrl = phone.productUrl;
    const lastEntry = hist.priceHistory[hist.priceHistory.length - 1];
    if (!lastEntry || lastEntry.price !== phone.price || lastEntry.date !== today) {
      hist.priceHistory.push({ date: today, price: phone.price, scrapedAt: phone.scrapedAt });
    }
  }
  history.lastUpdated = new Date().toISOString();
  return history;
}

function normalizeKey(name) {
  return name.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, '-').replace(/(\d+)gb\s*ram/i, '$1gb').replace(/(\d+)gb\s*rom/i, '$1gb').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}

scrapeAll().catch(err => {
  console.error('\n=== FATAL ERROR ===');
  console.error(err);
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    writeJSON('last-run-log.json', { timestamp: new Date().toISOString(), status: 'FATAL', error: err.message });
  } catch (_) {}
  process.exit(1);
});
