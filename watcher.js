// watcher.js - ARVX WA NEWS WATCHER v2 - Realtime, No Miss
import Parser from 'rss-parser';
import fs from 'fs';

const parser = new Parser({ headers: { 'User-Agent': 'Mozilla/5.0 ARVX-Watcher' } });
const SEEN_FILE = './seen_news.json';
let seen = new Set();
try { seen = new Set(JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'))); } catch {}

function saveSeen() { try { fs.writeFileSync(SEEN_FILE, JSON.stringify([...seen].slice(-1000))); } catch {} }

// SEMUA SUMBER - BIAR GAK ADA YANG KELEWAT
const FEEDS = [
  // 1. WABetaInfo - Sumber utama, paling cepet
  'https://wabetainfo.com/feed',
  'https://wabetainfo.com/category/android/feed/',
  'https://wabetainfo.com/category/ios/feed/',
  'https://wabetainfo.com/category/web-desktop/feed/',
  // 2. Resmi Meta / WhatsApp
  'https://blog.whatsapp.com/feed/',
  'https://about.fb.com/feed/',
  // 3. Google News - Nangkep SEMUA media di internet
  'https://news.google.com/rss/search?q=WhatsApp&hl=id-ID&gl=ID&ceid=ID:id',
  'https://news.google.com/rss/search?q=WhatsApp&hl=en-US&gl=US&ceid=US:en',
  'https://news.google.com/rss/search?q=WhatsApp+username+OR+Baileys+OR+Zaps+OR+Meta+AI&hl=en-US&gl=US&ceid=US:en',
  'https://news.google.com/rss/search?q=WABetaInfo&hl=en-US&gl=US&ceid=US:en',
  // 4. Tech Media
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

// Fungsi utama - dipanggil dari index.js
export async function checkNews(onNew) {
  let baru = 0;
  for (const url of FEEDS) {
    try {
      const feed = await parser.parseURL(url);
      for (const item of (feed.items || []).slice(0, 8)) {
        const id = item.guid || item.link;
        if (!id || seen.has(id)) continue;
        const text = ((item.title || '') + ' ' + (item.contentSnippet || '')).toLowerCase();
        // Filter: kalau dari Google News, wajib ada keyword. Kalau dari WABetaInfo, langsung lolos
        const isWBI = url.includes('wabetainfo');
        if (!isWBI && !KEYWORDS.some(k => text.includes(k))) continue;

        seen.add(id); saveSeen(); baru++;
        onNew({
          title: item.title || 'Update WhatsApp',
          link: item.link,
          date: item.pubDate ? new Date(item.pubDate).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) : '',
          snippet: (item.contentSnippet || '').slice(0, 300),
          source: url.includes('wabetainfo') ? 'WABetaInfo' : url.includes('news.google') ? 'Google News' : url.includes('whatsapp.com') ? 'Blog WhatsApp' : url.includes('about.fb') ? 'Meta Blog' : 'Tech Media'
        });
      }
    } catch (e) { console.log('[watcher skip]', url, e.message.slice(0, 80)); }
  }
  return baru;
}

export function getSeenCount() { return seen.size; }
