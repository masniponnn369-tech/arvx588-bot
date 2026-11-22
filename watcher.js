// watcher.js - ARVX WA NEWS WATCHER v4 - MODE PERINTAH, NO AUTO SPAM
import axios from 'axios';
import fs from 'fs';

const SEEN_FILE = './seen_news.json';
let seen = new Set();
try { seen = new Set(JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'))); } catch {}

function saveSeen() { try { fs.writeFileSync(SEEN_FILE, JSON.stringify([...seen].slice(-1000))); } catch {} }

const FEEDS = [
  'https://wabetainfo.com/feed',
  'https://wabetainfo.com/category/android/feed/',
  'https://wabetainfo.com/category/ios/feed/',
  'https://blog.whatsapp.com/',
  'https://about.fb.com/feed/',
  'https://news.google.com/rss/search?q=WhatsApp&hl=id-ID&gl=ID&ceid=ID:id',
  'https://news.google.com/rss/search?q=WhatsApp&hl=en-US&gl=US&ceid=US:en',
  'https://techcrunch.com/tag/whatsapp/feed/',
  'https://9to5google.com/feed/',
  'https://9to5mac.com/feed/',
];

const KEYWORDS = [
  'whatsapp', 'wabetainfo', 'baileys', 'zaps', 'instants', 'username', 'bsuid',
  'channel', 'newsletter', 'meta ai', 'view once', 'restricted chat', 'advanced chat',
  'poll', 'sticker', 'status', 'group', 'community', 'call', 'web calling',
  'privacy', 'backup', 'theme', 'live photo', 'event', 'mention'
];

function getTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  if (!m) return '';
  return m[1].replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '').trim();
}

function parseRSS(xml) {
  if (!xml || typeof xml !== 'string') return [];
  let rawItems = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map(m => m[1]);
  if (rawItems.length === 0) rawItems = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)].map(m => m[1]);
  return rawItems.map(b => {
    let link = getTag(b, 'link');
    if (!link) {
      const lm = b.match(/<link[^>]*href="([^"]+)"/i);
      if (lm) link = lm[1];
    }
    return {
      title: getTag(b, 'title'),
      link: link,
      guid: getTag(b, 'guid') || getTag(b, 'id') || link,
      pubDate: getTag(b, 'pubDate') || getTag(b, 'published') || getTag(b, 'updated'),
      contentSnippet: getTag(b, 'description') || getTag(b, 'summary') || getTag(b, 'content')
    };
  });
}

// Buat nyatet doang pas start, GAK NGIRIM
export async function checkNews(onNew) {
  let baru = 0;
  for (const url of FEEDS) {
    try {
      const r = await axios.get(url, { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0 ARVX-Watcher' } });
      const items = parseRSS(r.data);
      for (const item of items.slice(0, 8)) {
        const id = item.guid || item.link;
        if (!id || seen.has(id)) continue;
        const text = ((item.title || '') + ' ' + (item.contentSnippet || '')).toLowerCase();
        const isWBI = url.includes('wabetainfo');
        if (!isWBI && !KEYWORDS.some(k => text.includes(k))) continue;
        seen.add(id); saveSeen(); baru++;
        // KALAU onNew ADA, baru kirim. Kalau gak ada, cuma nyatet doang.
        if (onNew) {
          onNew({
            title: item.title || 'Update WhatsApp',
            link: item.link,
            date: item.pubDate ? new Date(item.pubDate).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) : '',
            snippet: (item.contentSnippet || '').slice(0, 300),
            source: url.includes('wabetainfo') ? 'WABetaInfo' : url.includes('news.google') ? 'Google News' : url.includes('whatsapp.com') ? 'Blog WhatsApp' : url.includes('about.fb') ? 'Meta Blog' : 'Tech Media'
          });
        }
      }
    } catch (e) { console.log('[watcher skip]', url, e.message.slice(0, 80)); }
  }
  return baru;
}

// BARU - Buat perintah .news, ambil 1 berita TERBARU aja
export async function getLatestNews() {
  let all = [];
  for (const url of FEEDS) {
    try {
      const r = await axios.get(url, { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0 ARVX-Watcher' } });
      const items = parseRSS(r.data);
      for (const item of items.slice(0, 5)) {
        const text = ((item.title || '') + ' ' + (item.contentSnippet || '')).toLowerCase();
        const isWBI = url.includes('wabetainfo');
        if (!isWBI && !KEYWORDS.some(k => text.includes(k))) continue;
        all.push({
          title: item.title || 'Update WhatsApp',
          link: item.link,
          date: item.pubDate ? new Date(item.pubDate).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) : '',
          snippet: (item.contentSnippet || '').slice(0, 300),
          source: url.includes('wabetainfo') ? 'WABetaInfo' : url.includes('news.google') ? 'Google News' : url.includes('whatsapp.com') ? 'Blog WhatsApp' : url.includes('about.fb') ? 'Meta Blog' : 'Tech Media',
          pubTime: new Date(item.pubDate || 0).getTime()
        });
      }
    } catch {}
  }
  // Urutin dari yang paling baru
  all.sort((a, b) => b.pubTime - a.pubTime);
  // Buang yang duplikat judulnya
  const seenTitle = new Set();
  all = all.filter(n => { const k = n.title.toLowerCase().slice(0, 40); if (seenTitle.has(k)) return false; seenTitle.add(k); return true; });
  return all.slice(0, 5); // Ambil 5 teratas aja
}

export function getSeenCount() { return seen.size; }
