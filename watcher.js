// ===== ARVX WATCHER v3 - WA NEWS + BAILEYS UPDATE =====
// WA: WABetaInfo + GSMArena + SheetWA (bebas iklan, gak ke-block)
// BAILEYS: GitHub Releases + Commits resmi WhiskeySockets (Atom feed, resmi, no ads)

import fs from 'fs';

const SEEN_FILE = './seen_news.json';
const CACHE_MS = 15 * 60 * 1000;

const FEEDS_WA = [
   { name: 'WABetaInfo Android', url: 'https://wabetainfo.com/category/android/feed/', weight: 90 },
  { name: 'WABetaInfo iOS', url: 'https://wabetainfo.com/category/ios/feed/', weight: 90 },
  { name: 'WABetaInfo News', url: 'https://wabetainfo.com/category/news/feed/', weight: 85 },
  { name: 'Gadgets360 WhatsApp', url: 'https://www.gadgets360.com/tags/whatsapp/rss', weight: 60 },
];

// ===== FEED BAILEYS - RESMI, AMAN, GAK ADA IKLAN, GAK KE-BLOCK =====
const FEEDS_BAILEYS = [
  // Ini feed resmi GitHub, format Atom, 100% aman, gak ada iklan
  { name: 'Baileys Releases', url: 'https://github.com/WhiskeySockets/Baileys/releases.atom', weight: 100 },
  { name: 'Baileys Commits', url: 'https://github.com/WhiskeySockets/Baileys/commits/master.atom', weight: 80 },
];

const BAD_WORDS = ['sponsored','advertisement','promo code','giveaway','discount code','buy now','coupon','casino','slot gacor','judi','togel','crypto giveaway','airdrop'];
function isValidWANews(n) {
  if (n.source.includes('WABetaInfo') || n.source.includes('SheetWA')) return true;
  const t = n.title.toLowerCase();
  return t.includes('whatsapp') || t.includes('wa beta') || t.includes('meta') || t.includes('wabetainfo');
}
function isBad(t='', s='') { const x = (t+' '+s).toLowerCase(); return BAD_WORDS.some(w => x.includes(w)); }
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

// ===== FUNGSI BUAT .wanews =====
export async function fetchWANewsAll(limit=5) {
  const all = await fetchAllFrom(FEEDS_WA, cacheWA);
  return all.slice(0, limit);
}
export async function getLatestNews() {
  const l = await fetchWANewsAll(1); return l[0] || null;
}

// ===== FUNGSI BARU BUAT .baileys =====
export async function fetchBaileysNews(limit=5) {
  const all = await fetchAllFrom(FEEDS_BAILEYS, cacheBaileys);
  // Filter cuma yang penting: release / fix / security, buang commit receh
  const important = all.filter(n => /release|v6\.|v7\.|fix|security|chore\(release\)|breaking|CVE|GHSA/i.test(n.title) || n.source.includes('Releases'));
  return (important.length ? important : all).slice(0, limit);
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

export default { fetchWANewsAll, getLatestNews, fetchBaileysNews, checkNews };
