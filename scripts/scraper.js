/**
 * Jumia Nigeria Smartphone Price Tracker — Scraper
 * Uses WebScraping.AI API: /text for listings (stealth proxy), /html + cheerio for specs.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const API_KEY = process.env.WEBSCRAPING_API_KEY;
if (!API_KEY) { console.error('FATAL: WEBSCRAPING_API_KEY not set.'); process.exit(1); }

const API_BASE = 'api.webscraping.ai';
const LISTING_URL = 'https://www.jumia.com.ng/smartphones/';
const DATA_DIR = path.join(__dirname, '..', 'data');
const MIN_PRICE = 120000;
const MAX_PRICE = 250000;
const DELAY_MS = 1800;
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 2000;
const MAX_PAGES = 30;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function callAPI(endpoint, qp = {}) {
  const qs = new URLSearchParams({ api_key: API_KEY, ...qp }).toString();
  return new Promise((resolve, reject) => {
    const req = https.get(`https://${API_BASE}/${endpoint}?${qs}`, { timeout: 35000 }, (res) => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => {
        res.statusCode === 200 ? resolve(d) : reject(new Error(`HTTP ${res.statusCode}: ${d.slice(0,300)}`));
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function fetchListingText(url, page) {
  return callAPI('text', { url: `${url}?page=${page}&sort=lowest-price`, js: 'true', timeout: '30000', proxy: 'stealth' });
}

function fetchProductHTML(url) {
  return callAPI('html', { url, js: 'true', timeout: '25000', proxy: 'stealth' });
}

async function retry(fn, label) {
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      if (i > 0) { const w = INITIAL_BACKOFF_MS * Math.pow(2, i - 1); console.log(`  Retry ${i+1}/${MAX_RETRIES} (${label}) — ${w}ms…`); await sleep(w); }
      return await fn();
    } catch (err) { if (i === MAX_RETRIES - 1) throw err; console.warn(`  Attempt ${i+1} failed (${label}): ${err.message}`); }
  }
}

function parsePrice(str) { return str ? parseInt(str.replace(/[₦,\s]/g, ''), 10) : NaN; }

function parseListingText(text) {
  const products = [];
  const re = /\[\s*\n([^\]]+?)\n\s*₦\s*([\d,]+)\s*\n(?:[\d]+%\s*\n)?\s*\]\(([^)]+)\)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const name = m[1].replace(/\n\s*/g, ' ').trim();
    const price = parseInt(m[2].replace(/,/g, ''), 10);
    const slug = m[3];
    if (isNaN(price) || !slug || !name) continue;
    products.push({ name, price, productUrl: slug.startsWith('http') ? slug : `https://www.jumia.com.ng${slug}`, imageUrl: null });
  }
  return products;
}

function hasMorePages() { return true; }

function extractSpecsFromHTML(html) {
  const $ = require('cheerio').load(html);
  const specs = {};
  $('table').each((i, t) => {
    $(t).find('tr').each((j, r) => {
      const cells = $(r).find('td, th');
      if (cells.length >= 2) {
        const k = $(cells[0]).text().trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z_]/g, '');
        const v = $(cells[1]).text().trim();
        if (k && v && k.length < 40) specs[k] = v;
      }
    });
  });
  if (Object.keys(specs).length === 0) {
    $('li, .spec-item, .-pvxs, .-pts').each((i, el) => {
      const t = $(el).text().trim();
      const m = t.match(/^(.+?)[:\s]{2,}(.+)$/);
      if (m) { const k = m[1].toLowerCase().replace(/\s+/g, '_').replace(/[^a-z_]/g, ''); specs[k] = m[2].trim(); }
    });
  }
  const km = {
    display: ['display','screen_size','screen','display_size'],
    ram: ['ram','memory','internal_memory','ram_size'],
    storage: ['storage','rom','internal_storage','storage_capacity'],
    battery: ['battery','battery_capacity'],
    camera_rear: ['camera_rear','rear_camera','main_camera','back_camera','camera'],
    camera_front: ['camera_front','front_camera','selfie_camera'],
    processor: ['processor','cpu','chipset'],
    os: ['os','operating_system','android_version'],
    network: ['network','connectivity','network_type'],
    sim: ['sim','sim_type'],
    resolution: ['resolution','screen_resolution'],
  };
  const result = {};
  for (const [tgt, keys] of Object.entries(km)) {
    let found = null;
    for (const k of keys) { if (specs[k]) { found = specs[k]; break; } }
    result[tgt] = found;
  }
  return result;
}

async function extractSpecsAI(url) {
  const q = 'Extract key specs from this phone page as JSON. Keys: display, resolution, ram, storage, battery, camera_rear, camera_front, processor, os, network, sim. Use null if unknown. Return ONLY JSON.';
  const raw = await retry(() => callAPI('ai/question', { url, question: q, js: 'true', timeout: '25000', proxy: 'stealth' }), `specs: ${url.slice(0,60)}…`);
  let c = raw.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/i,'');
  const b1 = c.indexOf('{'), b2 = c.lastIndexOf('}');
  if (b1 !== -1 && b2 > b1) c = c.slice(b1, b2 + 1);
  try {
    const s = JSON.parse(c);
    ['display','resolution','ram','storage','battery','camera_rear','camera_front','processor','os','network','sim'].forEach(k => { if (!(k in s)) s[k] = null; });
    return s;
  } catch(e) {
    console.warn(`  JSON parse failed: ${e.message}`);
    return { display:null,resolution:null,ram:null,storage:null,battery:null,camera_rear:null,camera_front:null,processor:null,os:null,network:null,sim:null,_raw:raw.slice(0,300) };
  }
}

async function scrapeAll() {
  const st = new Date();
  console.log(`\n=== Jumia Phone Tracker — ${st.toISOString()} ===\n`);
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  console.log('-- Phase 1: Scanning listing pages (₦120k–250k) --\n');
  let all = [], seen = new Set(), stopped = false;

  for (let p = 1; p <= MAX_PAGES; p++) {
    console.log(`Page ${p}…`);
    let text;
    try { text = await retry(() => fetchListingText(LISTING_URL, p), `listing page ${p}`); }
    catch(e) { console.error(`  Failed: ${e.message}`); break; }
    if (text.length < 500 || !/₦/.test(text)) {
      console.warn(`  Suspicious content (${text.length} chars).`);
      if (p === 1) console.error('  Page 1 invalid — possible block.');
      break;
    }
    const prods = parseListingText(text);
    console.log(`  ${prods.length} products`);
    let nc = 0, lo = Infinity, hi = -Infinity;
    for (const pr of prods) {
      lo = Math.min(lo, pr.price); hi = Math.max(hi, pr.price);
      if (pr.price >= MIN_PRICE && pr.price <= MAX_PRICE) {
        const uk = pr.productUrl.split('?')[0];
        if (!seen.has(uk)) { seen.add(uk); all.push(pr); nc++; }
      }
    }
    console.log(`    ₦${lo.toLocaleString()} – ₦${hi.toLocaleString()} | +${nc} | total=${all.length}`);
    if (lo > MAX_PRICE) { console.log(`  Lowest > ₦250k — stopping.`); stopped = true; break; }
    if (!hasMorePages(text)) { console.log('  No more pages.'); break; }
    await sleep(DELAY_MS);
  }

  console.log(`\n-- Phase 1 done: ${all.length} candidates --\n`);

  if (all.length === 0) {
    writeJSON('last-run-log.json', { timestamp: new Date().toISOString(), status: 'WARNING', message: 'No products parsed — check selectors.', candidatesFound: 0, specsSucceeded: 0, specsFailed: 0 });
    console.log('WARNING: No products found.');
    return;
  }

  console.log(`-- Phase 2: Extracting specs for ${all.length} candidates --\n`);
  let ok = 0, fail = 0;
  const results = [];

  for (let i = 0; i < all.length; i++) {
    const c = all[i];
    console.log(`[${i+1}/${all.length}] ${c.name.slice(0,50)}`);
    let specs;
    try {
      const html = await retry(() => fetchProductHTML(c.productUrl), `product: ${c.name.slice(0,40)}`);
      specs = extractSpecsFromHTML(html);
      const hasS = Object.values(specs).some(v => v !== null);
      if (!hasS) { console.log('    cheerio found nothing, trying AI…'); specs = await extractSpecsAI(c.productUrl); }
      const imgM = html.match(/<img[^>]*data-src="([^"]+)"/i) || html.match(/<img[^>]*src="(https?:\/\/[^"]*\.(?:jpg|jpeg|png|webp)[^"]*)"/i);
      if (imgM) c.imageUrl = imgM[1];
      ok++;
      console.log(`  Specs OK (${Object.values(specs).filter(v=>v!==null).length} fields)`);
    } catch(e) {
      fail++;
      console.warn(`  Failed: ${e.message}`);
      specs = { display:null,resolution:null,ram:null,storage:null,battery:null,camera_rear:null,camera_front:null,processor:null,os:null,network:null,sim:null,_error:e.message };
    }
    results.push({ name:c.name, price:c.price, productUrl:c.productUrl, imageUrl:c.imageUrl, specs, scrapedAt:new Date().toISOString() });
    if (i < all.length - 1) await sleep(DELAY_MS);
  }

  console.log(`\n-- Phase 2 done: ${ok} OK, ${fail} failed --\n`);
  console.log('-- Phase 3: Writing output --\n');

  writeJSON('phones.json', { generatedAt: new Date().toISOString(), priceRange: { min: MIN_PRICE, max: MAX_PRICE }, totalPhones: results.length, phones: results });
  console.log(`  data/phones.json — ${results.length} phones`);

  const history = updateHistory(results);
  writeJSON('history.json', history);
  console.log(`  data/history.json — ${Object.keys(history.phones).length} tracked`);

  const elapsed = Math.round((new Date() - st) / 1000);
  writeJSON('last-run-log.json', { timestamp: new Date().toISOString(), status: 'SUCCESS', elapsedSeconds: elapsed, candidatesFound: all.length, specsSucceeded: ok, specsFailed: fail, totalWritten: results.length });
  console.log(`  data/last-run-log.json`);
  console.log(`\n=== Complete in ${elapsed}s ===\n`);
}

function loadExistingJSON(fn) {
  const fp = path.join(DATA_DIR, fn);
  if (!fs.existsSync(fp)) return null;
  try { return JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch { return null; }
}

function writeJSON(fn, d) { fs.writeFileSync(path.join(DATA_DIR, fn), JSON.stringify(d, null, 2), 'utf-8'); }

function updateHistory(phones) {
  let h = loadExistingJSON('history.json');
  if (!h || !h.phones) h = { description: 'Price history for tracked phones.', lastUpdated: new Date().toISOString(), phones: {} };
  const today = new Date().toISOString().split('T')[0];
  for (const p of phones) {
    const k = p.name.toLowerCase().replace(/[^a-z0-9\s]/g,'').replace(/\s+/g,'-').replace(/(\d+)gb\s*ram/i,'$1gb').replace(/(\d+)gb\s*rom/i,'$1gb').replace(/-+/g,'-').replace(/^-|-$/g,'').slice(0,80);
    if (!h.phones[k]) h.phones[k] = { name:p.name, productUrl:p.productUrl, imageUrl:p.imageUrl, priceHistory:[] };
    const hi = h.phones[k];
    if (p.imageUrl) hi.imageUrl = p.imageUrl;
    const last = hi.priceHistory[hi.priceHistory.length-1];
    if (!last || last.price !== p.price || last.date !== today) hi.priceHistory.push({ date:today, price:p.price, scrapedAt:p.scrapedAt });
  }
  h.lastUpdated = new Date().toISOString();
  return h;
}

scrapeAll().catch(err => {
  console.error('\n=== FATAL ==='); console.error(err);
  try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); writeJSON('last-run-log.json', { timestamp: new Date().toISOString(), status: 'FATAL', error: err.message }); } catch(_) {}
  process.exit(1);
});
