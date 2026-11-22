// ===== ARVX WATCHER v5 - WA + 【entity-BAILEYS¦canonical_name=BAILEYS】 + SEMUA LIBRARY =====
// WA: 11 feed aktif, 22 Nov 2026
// 【entity-BAILEYS¦canonical_name=BAILEYS】: 【entity-GitHub¦canonical_name=GitHub】 Releases resmi
// LIBS: 11 feed update library dari package.json lu

import fs from 'fs';

const SEEN_FILE = './seen_news.json';
const CACHE_MS = 15 * 60 * 1000;

// ===== FEED WA - UDAH DICEK SATU-SATU, AKTIF 22 NOV 2026 =====
const FEEDS_WA = [
  { name: 'WABetaInfo', url: 'https://wabetainfo.com/feed/', weight: 100 },
  { name: 'WABetaInfo Android', url: 'https://wabetainfo.com/category/android/feed/', weight: 95 },
  { name: 'WABetaInfo iOS', url: 'https://wabetainfo.com/category/ios/feed/', weight: 95 },
  { name: 'WABetaInfo News', url: 'https://wabetainfo.com/category/news/feed/', weight: 90 },
  { name: 'AllBetaInfo', url: 'https://allbetainfo.com/feed/', weight: 90 },
  { name: 'YTECHB', url: 'https://ytechb.com/feed/', weight: 70 },
  { name: 'Phandroid', url: 'https://phandroid.com/feed/', weight: 65 },
  { name: 'Ubergizmo', url: 'https://ubergizmo.com/feed/', weight: 60 },
  { name: 'Dataconomy', url: 'https://dataconomy.com/feed/', weight: 60 },
  { name: '9to5Mac', url: 'https://9to5mac.com/feed/', weight: 60 },
  { name: 'Android Authority', url: 'https://www.androidauthority.com/feed/', weight: 55 },
];

// ===== FEED 【entity-BAILEYS¦canonical_name=BAILEYS】 - RESMI =====
const FEEDS_BAILEYS = [
  { name: 'BAILEYS Releases', url: 'https://github.com/WhiskeySockets/Baileys/releases.atom', weight: 100 },
  { name: 'BAILEYS Commits', url: 'https://github.com/WhiskeySockets/Baileys/commits/master.atom', weight: 80 },
];

// ===== FEED SEMUA LIBRARY LU - DARI PACKAGE.JSON - RESMI, GAK ADA IKLAN, GAK KE-BLOCK =====
// Semua pake GitHub Releases Atom, karena library ini gak punya RSS blog
const FEEDS_LIBS = [
  { name: 'Baileys', url: 'https://github.com/WhiskeySockets/Baileys/releases.atom' },
  { name: 'Boom', url: 'https://github.com/hapijs/boom/releases.atom' },
  { name: 'Axios', url: 'https://github.com/axios/axios/releases.atom' },
  { name: 'Cheerio', url: 'https://github.com/cheeriojs/cheerio/releases.atom' },
  { name: 'Dotenv', url: 'https://github.com/motdotla/dotenv/releases.atom' },
  { name: 'File-Type', url: 'https://github.com/sindresorhus/file-type/releases.atom' },
  { name: 'JS-YAML', url: 'https://github.com/nodeca/js-yaml/releases.atom' },
  { name: 'Node-Cache', url: 'https://github.com/node-cache/node-cache/releases.atom' },
  { name: 'Pino', url: 'https://github.com/pinojs/pino/releases.atom' },
  { name: 'QRCode-Terminal', url: 'https://github.com/gtanner/qrcode-terminal/releases.atom' },
  { name: 'Sharp', url: 'https://github.com/lovell/sharp/releases.atom' },
  // Node-Webpmux gak dimasukin ke feed, repo-nya gak punya releases.atom yang stabil
  // Cek manual di https://www.npmjs.com/package/node-webpmux
];

// ===== WEBSITE RESMI SEMUA LIBRARY LU - BUAT PERINTAH .lib =====
// Ini yang tadi gue cari di seluruh internet, yang aktif, gak ke-block
export const LIB_WEBSITES = [
  { lib: '@whiskeysockets/baileys', versi: '6.7.24', web: 'https://baileys.wiki', github: 'https://github.com/WhiskeySockets/Baileys', npm: 'https://www.npmjs.com/package/@whiskeysockets/baileys' },
  { lib: '@hapi/boom', versi: '10.0.1', web: 'https://hapi.dev', github: 'https://github.com/hapijs/boom', npm: 'https://www.npmjs.com/package/@hapi/boom' },
  { lib: '【entity-axios¦canonical_name=Axios】', versi: '1.21.1', web: 'https://axios-http.com', 【entity-github¦canonical_name=GitHub】: 'https://github.com/axios/axios', npm: 'https://www.npmjs.com/package/axios' },
  { lib: 'cheerio', versi: '1.2.0', web: 'https://cheerio.js.org', 【entity-github¦canonical_name=GitHub】: 'https://github.com/cheeriojs/cheerio', npm: 'https://www.npmjs.com/package/cheerio' },
  { lib: 'dotenv', versi: '18.0.10', web: 'https://github.com/motdotla/dotenv', 【entity-github¦canonical_name=GitHub】: 'https://github.com/motdotla/dotenv', npm: 'https://www.npmjs.com/package/dotenv' },
  { lib: 'file-type', versi: '22.3.0', web: 'https://github.com/sindresorhus/file-type', 【entity-github¦canonical_name=GitHub】: 'https://github.com/sindresorhus/file-type', npm: 'https://www.npmjs.com/package/file-type' },
  { lib: 'js-yaml', versi: '4.1.0', web: 'https://github.com/nodeca/js-yaml', github: 'https://github.com/nodeca/js-yaml', npm: 'https://www.npmjs.com/package/js-yaml' },
  { lib: 'node-cache', versi: '5.1.2', web: 'https://github.com/node-cache/node-cache', github: 'https://github.com/node-cache/node-cache', npm: 'https://www.npmjs.com/package/node-cache' },
  { lib: 'node-webpmux', versi: '^3.2.0', web: 'https://www.npmjs.com/package/node-webpmux', 【entity-github¦canonical_name=GitHub】: 'https://www.npmjs.com/package/node-webpmux', npm: 'https://www.npmjs.com/package/node-webpmux' },
  { lib: 'pino', versi: '10.4.0', web: 'https://getpino.io', 【entity-github¦canonical_name=GitHub】: 'https://github.com/pinojs/pino', npm: 'https://www.npmjs.com/package/pino' },
  { lib: 'qrcode-terminal', versi: '0.12.0', web: 'https://github.com/gtanner/qrcode-terminal', 【entity-github¦canonical_name=GitHub】: 'https://github.com/gtanner/qrcode-terminal', npm: 'https://www.npmjs.com/package/qrcode-terminal' },
  { lib: 'sharp', versi: '0.35.5', web: 'https://sharp.pixelplumbing.com', 【entity-github¦canonical_name=GitHub】: 'https://github.com/lovell/sharp', npm: 'https://www.npmjs.com/package/sharp' },
];

const BAD_WORDS = ['sponsored','advertisement','promo code','giveaway','discount code','buy now','coupon','casino','slot gacor','judi','togel','crypto giveaway','airdrop'];
function isBad(t='', s='') { const x = (t+' '+s).toLowerCase(); return BAD_WORDS.some(w => x.includes(w)); }

function isValidWANews(n) {
  if (n.source.includes('WABetaInfo') || n.source.includes('AllBetaInfo')) return true;
  const t = (n.title + ' ' + n.snippet).toLowerCase();
  if (!t.includes('whatsapp') && !t.includes('wa beta') && !t.includes('wabetainfo') && !t.includes('meta ai')) return false;
  if (t.includes('xiaomi') || t.includes('jio') || t.includes('earbuds') || t.includes('pixel 9') || t.includes('samsung galaxy s') && !t.includes('whatsapp')) return false;
  return true;
}

function loadSeen() { try { return JSON.parse(fs.readFileSync(SEEN_FILE,'utf8')); } catch { return []; } }
function saveSeen(a) { try { fs.writeFileSync(SEEN_FILE, JSON.stringify(a.slice(-200))); } catch {} }
function decodeHtml(s='') { return s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#039;/g,"'").replace(/&apos;/g,"'").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').trim(); }
function stripHtml(s='') { return decodeHtml(s).replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim(); }

function parseRSS(xml='', sourceName='') {
  const items = [];
  const blocks = [...xml.matchAll(/<(?:item|entry)>([\s\S]*?)<\/(?:item|entry)>/gi)].map(m=>m[1]);
  for (const b of blocks) {
    const get = (tag) => { const m = b.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`,'i')); return m ? decodeHtml(m[1]) : ''; };
    const title = stripHtml(get('title'));
    let link = get('link');
    if (!link || link.includes('<')) { const lm = b.match(/<link[^>]*href=["']([^"']+)["']/i); if (lm) link = lm[1]; }
    const desc = stripHtml(get('description') || get('summary') || get('content:encoded') || get('content') || '');
    const date = get('pubDate') || get('published') || get('updated') || '';
    if (!title || !link) continue;
    if (isBad(title, desc)) continue;
    items.push({ title, link: link.trim(), snippet: desc.slice(0,220)+(desc.length>220?'...':''), date: date ? new Date(date).toLocaleString('id-ID',{timeZone:'Asia/Jakarta'}) : '', source: sourceName, _ts: date ? new Date(date).getTime() : Date.now() });
  }
  return items;
}

async function fetchFeed(feed) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(()=>ctrl.abort(), 10000);
    const res = await fetch(feed.url, { signal: ctrl.signal, headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
      'Referer': 'https://www.google.com/',
      'Cache-Control': 'no-cache',
    }});
    clearTimeout(t);
    if (!res.ok) { console.log(`[watcher skip] ${feed.url} HTTP ${res.status}`); return []; }
    return parseRSS(await res.text(), feed.name);
  } catch(e) { console.log(`[watcher skip] ${feed.url} ${e.message}`); return []; }
}

let cacheWA = { at: 0, data: [] };
let cacheBaileys = { at: 0, data: [] };
let cacheLibs = { at: 0, data: [] };

async function fetchAllFrom(feeds, cacheObj) {
  if (Date.now() - cacheObj.at < CACHE_MS && cacheObj.data.length) return cacheObj.data;
  const res = await Promise.all(feeds.map(f=>fetchFeed(f)));
  let all = res.flat();
  const seen = new Map();
  for (const n of all) {
    const key = n.title.toLowerCase().replace(/[^a-z0-9 ]/g,'').trim().slice(0,80);
    if (!seen.has(key)) seen.set(key, n);
  }
  all = [...seen.values()].filter(n => {
    if (feeds === FEEDS_WA) return isValidWANews(n);
    return true;
  }).sort((a,b)=>b._ts-a._ts);
  cacheObj.at = Date.now(); cacheObj.data = all;
  return all;
}

export async function fetchWANewsAll(limit=5) {
  const all = await fetchAllFrom(FEEDS_WA, cacheWA);
  return all.slice(0, limit);
}
export async function getLatestNews() {
  const l = await fetchWANewsAll(1); return l[0] || null;
}
export async function fetchBaileysNews(limit=5) {
  const all = await fetchAllFrom(FEEDS_BAILEYS, cacheBaileys);
  const important = all.filter(n => /release|v6\.|v7\.|fix|security|chore\(release\)|breaking|CVE|GHSA/i.test(n.title) || n.source.includes('Releases'));
  return (important.length ? important : all).slice(0, limit);
}

// ===== FUNGSI BARU - BUAT .lib =====
export async function fetchLibsNews(limit=12) {
  const all = await fetchAllFrom(FEEDS_LIBS, cacheLibs);
  return all.slice(0, limit);
}

export async function checkNews(onNew=null) {
  const seen = loadSeen(); const set = new Set(seen);
  const all = await fetchWANewsAll(20);
  const fresh = [];
  for (const n of all) {
    if (!set.has(n.link)) { set.add(n.link); fresh.push(n); if (onNew) { try { await onNew(n); } catch {} await new Promise(r=>setTimeout(r,1000)); } }
  }
  if (seen.length===0 && fresh.length>0) { console.log(`[watcher] start, nyatet ${fresh.length} berita lama, gak dikirim`); saveSeen([...set]); return []; }
  if (fresh.length) saveSeen([...set]);
  return fresh;
}
export default { fetchWANewsAll, getLatestNews, fetchBaileysNews, fetchLibsNews, LIB_WEBSITES, checkNews };
