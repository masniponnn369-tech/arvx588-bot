import 'dotenv/config';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, downloadContentFromMessage } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import NodeCache from 'node-cache';
import sharp from 'sharp';
import webp from 'node-webpmux';
import { fileTypeFromBuffer } from 'file-type';
import axios from 'axios';
import * as cheerio from 'cheerio';
import yaml from 'js-yaml';
import fs from 'fs';
import path from 'path';

// ============ CONFIG ============
const CONFIG_PATH = path.resolve('./config.yml');
const cfg = yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8'));
const BOT_NUMBER = String(process.env.BOT_NUMBER || cfg.owner.bot_number || '').replace(/[^0-9]/g, '');
const OWNER_NUMBER = String(process.env.OWNER_NUMBER || cfg.owner.number || '').replace(/[^0-9]/g, '');
const OWNER_JID = `${OWNER_NUMBER}@s.whatsapp.net`;
const PREFIX = process.env.PREFIX || cfg.bot.prefix || '.';
const GROUP_LINK = cfg.group.invite_link || '';
const WHITELIST_CODE = cfg.group.whitelist_invite_code || '';
const CHANNEL_JID = process.env.CHANNEL_JID || cfg.group.channel_jid || ''; // isi JID Channel ARVX kalau ada, contoh: 120207xxx@newsletter
const USE_PAIRING_CODE = process.env.USE_PAIRING_CODE !== 'false';
const logger = pino({ level: 'silent' });
const groupCache = new NodeCache({ stdTTL: 300, useClones: false });
const msgRetryCounterCache = new NodeCache({ stdTTL: 600, useClones: false });
const spamTracker = new NodeCache({ stdTTL: 5, checkperiod: 2 });
const raidTracker = new NodeCache({ stdTTL: 10, checkperiod: 2 });
const messageStore = new NodeCache({ stdTTL: 3600, useClones: false });
const cooldown = new NodeCache({ stdTTL: 2, checkperiod: 1 });
const reactionTracker = new NodeCache({ stdTTL: 60, checkperiod: 5 });
const reactionLog = new Map(); // 18 Anti-Hapus Reaksi
const pollStore = new Map(); // 25-26 Poll
const muteUntil = new Map(); // 5 Auto-Mute 5 menit

// ============ DB ============
const DB_PATH = path.resolve('./database.json');
function loadDB() {
  if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, JSON.stringify({ global: { dmLog: true }, groups: {}, intros: {}, pendingIntros: {}, warns: {}, blacklist: {}, disabled: {}, polls: {}, events: {}, scheduled: [], usernames: {}, verifCodes: {}, reports: [], channelPosts: [] }, null, 2));
  const p = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
  p.global ??= { dmLog: true }; p.pendingIntros ??= {}; p.warns ??= {}; p.blacklist ??= {}; p.disabled ??= {}; p.polls ??= {}; p.events ??= {}; p.scheduled ??= []; p.usernames ??= {}; p.verifCodes ??= {}; p.reports ??= []; p.channelPosts ??= [];
  return p;
}
function saveDB(d) { try { fs.writeFileSync(DB_PATH, JSON.stringify(d, null, 2)); } catch {} }
let db = loadDB();
function getGroupSettings(gid) {
  if (!db.groups[gid]) { db.groups[gid] = { ...cfg.defense_defaults, antiAll: true, antiEdit: true, antiViewOnce: true, antiZap: true, antiStickerSpam: true, antiFakeAdmin: true, antiImpersonasi: true, scamCheck: true, antiPromosi: true, antiDisappearing: true, antiHapusReaksi: true, antiPollPalsu: true, smartText: true, welcome: true, antilink: true, antispam: true, antivirtex: true, antitag: true, antidelete: true, antiraid: true, autokickintro: true }; saveDB(db); }
  const s = db.groups[gid];
  for (const k of ['antiAll','antiEdit','antiViewOnce','antiZap','antiStickerSpam','antiFakeAdmin','antiImpersonasi','scamCheck','antiPromosi','antiDisappearing','antiHapusReaksi','antiPollPalsu','smartText']) if (s[k] === undefined) s[k] = true;
  // HAPUS KATA KOTOR: paksa mati, admin asli yang handle
  delete s.antitoxic; delete s.badwords;
  return s;
}
const isBotDisabled = (gid) => !!db.disabled?.[gid];

// ============ FIX JID 2026: LID + PN ============
function normalizeJid(x) { if (!x) return ''; if (typeof x === 'string') return x; if (typeof x === 'object') return String(x.id || x.jid || x.author || x.participant || ''); return String(x); }
function pnOf(jid) { const s = normalizeJid(jid); if (!s) return ''; if (s.endsWith('@lid')) return s; return s.split('@')[0].split(':')[0] + '@s.whatsapp.net'; }
function numOf(jid) { return normalizeJid(jid).split('@')[0].split(':')[0]; }
function mentionsOf(j) { return (Array.isArray(j) ? j : [j]).map(normalizeJid).filter(Boolean); }
function isParticipantAdmin(parts, jid) {
  const tn = numOf(jid);
  return (parts || []).some(p => { const pid = normalizeJid(p.id || p.jid); const adm = p.admin === 'admin' || p.admin === 'superadmin'; if (!adm) return false; return pid === normalizeJid(jid) || numOf(pid) === tn || (p.lid && numOf(p.lid) === tn) || (p.pn && numOf(p.pn) === tn); });
}
async function safeSend(sock, jid, content, opts) { try { return await sock.sendMessage(normalizeJid(jid), content, opts); } catch (e) { console.log('[safeSend]', e.message); return null; } }
async function sendOwnerLog(sock, groupName, title, targetNum, detail) { if (!db.global.dmLog) return; try { const w = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }); await safeSend(sock, OWNER_JID, { text: `🛡️ *ARVX 588 LOG*\nGrup: ${groupName}\nTindakan: ${title}\nTarget: +${targetNum}\nDetail: ${detail}\nWaktu: ${w} WIB` }); } catch {} }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const INTRO_CARD_TEXT = `『  𝐈𝐍𝐓𝐑𝐎 𝐂𝐀𝐑𝐃 — 𝐀𝐑𝐕𝐗 588  』\nWelcome to ARVX 588.\n━━━━━━━━━━━━━━\nNama :\nUmur :\nGender :\nAsal :\nTag admin :\nKode Verif : ketik ${PREFIX}verif [kode]\n━━━━━━━━━━━━━━\n📸 Kirim poto 1× liat ( bebas)\nLink grup : ${GROUP_LINK}`;
async function downloadMedia(msg, type) { const s = await downloadContentFromMessage(msg, type); let b = Buffer.from([]); for await (const c of s) b = Buffer.concat([b, c]); return b; }
async function createSticker(buf, pack = 'ARVX 588', author = 'ARVX') {
  const webpBuf = await sharp(buf, { failOn: 'error' }).resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).webp({ quality: 80 }).toBuffer();
  const img = new webp.Image(); await img.load(webpBuf);
  const exifAttr = Buffer.from([0x49,0x49,0x2A,0x00,0x08,0x00,0x00,0x00,0x01,0x00,0x41,0x57,0x07,0x00,0x00,0x00,0x00,0x00,0x16,0x00,0x00,0x00]);
  const jb = Buffer.from(JSON.stringify({ 'sticker-pack-id': 'com.arvx588', 'sticker-pack-name': pack, 'sticker-pack-publisher': author, 'emojis': ['🛡️','🔥'] }), 'utf-8');
  const exif = Buffer.concat([exifAttr, jb]); exif.writeUIntLE(jb.length, 14, 4); img.exif = exif; return await img.save(null);
}
// 37 Username Key: bikin kode verif 6 digit
function makeVerifCode() { return String(Math.floor(100000 + Math.random() * 900000)); }
function isSimilarUsername(a, b) { // arvx588 vs arvx588_ / arvx588.
  if (!a || !b) return false; const x = a.toLowerCase().replace(/[^a-z0-9]/g, ''); const y = b.toLowerCase().replace(/[^a-z0-9]/g, ''); return x === y && a.toLowerCase() !== b.toLowerCase();
}

// ============ WARN / KICK ============
async function handleViolation(sock, gid, gname, senderRaw, snum, msgKey, reason, isBotAdmin, instant = false) {
  const sender = normalizeJid(senderRaw);
  if (isBotAdmin && msgKey) { try { await sock.sendMessage(gid, { delete: msgKey }); } catch {} }
  if (!db.warns[gid]) db.warns[gid] = {}; db.warns[gid][snum] ??= 0;
  const maxWarn = cfg.thresholds?.max_warn || 3;
  if (instant) {
    if (isBotAdmin) { await safeSend(sock, gid, { text: `🚨 *EKSEKUSI SEKETIKA*\n👤 @${snum}\n⚠️ ${reason}\n🔨 Dikick otomatis.`, mentions: [sender] }); try { await sock.groupParticipantsUpdate(gid, [sender], 'remove'); } catch { try { await sock.groupParticipantsUpdate(gid, [pnOf(sender)], 'remove'); } catch {} } await sendOwnerLog(sock, gname, 'INSTANT KICK', snum, reason); }
    return;
  }
  db.warns[gid][snum] += 1; const cur = db.warns[gid][snum]; saveDB(db);
  if (cur >= maxWarn) {
    db.warns[gid][snum] = 0; saveDB(db);
    if (isBotAdmin) { await safeSend(sock, gid, { text: `⛔ *WARN ${maxWarn}/${maxWarn} — AUTO KICK*\n👤 @${snum}\n📌 ${reason}`, mentions: [sender] }); try { await sock.groupParticipantsUpdate(gid, [sender], 'remove'); } catch { try { await sock.groupParticipantsUpdate(gid, [pnOf(sender)], 'remove'); } catch {} } await sendOwnerLog(sock, gname, 'AUTO-KICK', snum, reason); }
    else await safeSend(sock, gid, { text: `⚠️ @${snum} udah ${maxWarn}/${maxWarn} warn (${reason}), tapi bot belum Admin.`, mentions: [sender] });
  } else { await safeSend(sock, gid, { text: `🛡️ *WARNING (${cur}/${maxWarn})*\n👤 @${snum}\n⚠️ ${reason}\n_Warn ke-${maxWarn} = auto kick._`, mentions: [sender] }); await sendOwnerLog(sock, gname, `WARNING ${cur}/${maxWarn}`, snum, reason); }
}
function scamScoreFor(num) { let sc = 0; const why = []; if (!num.startsWith('62')) { sc += 2; why.push('Kode negara bukan +62'); } if (num.length < 10) { sc += 2; why.push('Nomor pendek / mencurigakan'); } return { score: sc, why: why.join(', ') || 'Normal' }; }

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('./session');
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({ version, logger, auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) }, msgRetryCounterCache, cachedGroupMetadata: async (jid) => groupCache.get(jid), generateHighQualityLinkPreview: false, syncFullHistory: false, markOnlineOnConnect: true });
  // 38 Anti-Ban: delay antar kirim massal + reconnect halus
  const origSend = sock.sendMessage.bind(sock);
  sock.sendMessage = async (...a) => { await sleep(250); return origSend(...a); };
  if (USE_PAIRING_CODE && !sock.authState.creds.registered) setTimeout(async () => { try { const code = await sock.requestPairingCode(BOT_NUMBER); console.log(`\n🔑 PAIRING: ${code}\n`); } catch (e) { console.log('Pairing gagal:', e.message); } }, 3000);
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', (u) => { const { connection, lastDisconnect } = u; if (connection === 'close') { const sc = new Boom(lastDisconnect?.error)?.output?.statusCode; if (sc !== DisconnectReason.loggedOut) setTimeout(startBot, 5000); else console.log('Logout. Hapus ./session'); } else if (connection === 'open') console.log(`✅ ARVX 588 aktif ${BOT_NUMBER}`); });

  // Interval: auto-kick intro + jadwal + event reminder + channel status tiruan
  setInterval(async () => {
    const now = Date.now(); const limitMs = (cfg.group.intro_timeout_hours || 24) * 3600 * 1000;
    for (const [gid, pend] of Object.entries(db.pendingIntros)) {
      const s = getGroupSettings(gid); if (!s.autokickintro) continue;
      for (const [num, joinedAt] of Object.entries(pend)) {
        if (db.intros[gid]?.[num]) { delete db.pendingIntros[gid][num]; saveDB(db); continue; }
        if (now - joinedAt >= limitMs) { const t = `${num}@s.whatsapp.net`; try { const meta = groupCache.get(gid) || await sock.groupMetadata(gid); await safeSend(sock, gid, { text: `⏰ *WAKTU INTRO HABIS*\n@${num} dikick otomatis.`, mentions: [t] }); await sock.groupParticipantsUpdate(gid, [t], 'remove'); } catch {} delete db.pendingIntros[gid][num]; saveDB(db); }
      }
    }
    for (const job of [...(db.scheduled || [])]) if (Date.now() >= job.at) { await safeSend(sock, job.groupId, { text: `⏰ *JADWAL PESAN ARVX*\n${job.text}` }); db.scheduled = db.scheduled.filter(x => x.id !== job.id); saveDB(db); }
    // 30 Event Reminder: H-1 jam / H-1 hari (cek tiap interval, kirim sekali)
    for (const [gid, evs] of Object.entries(db.events || {})) for (const ev of evs) { if (!ev.reminded && ev.at && Date.now() >= ev.at - 3600 * 1000 && Date.now() < ev.at) { ev.reminded = true; saveDB(db); await safeSend(sock, gid, { text: `📅 *REMINDER EVENT - 1 JAM LAGI*\n🎯 ${ev.title}\n🕐 ${ev.when}\nSiap-siap!` }); } }
    // 35 Channel Status tiruan tiap 24 jam (kirim ke grup + log channel)
    if (db.channelPosts?.length) { const last = db.channelPosts[db.channelPosts.length - 1]; if (Date.now() - last.at > 24 * 3600 * 1000) { /* placeholder: admin bisa .channelpost buat update baru */ } }
  }, 30 * 1000);
  sock.ev.on('groups.update', async ([ev]) => { if (!ev?.id) return; try { const m = await sock.groupMetadata(ev.id); groupCache.set(ev.id, m); } catch {} });

  // ============ 20-21-34 GROUP PARTICIPANTS ============
  sock.ev.on('group-participants.update', async (anu) => {
    try {
      const gid = normalizeJid(anu.id); if (isBotDisabled(gid)) return;
      const settings = getGroupSettings(gid);
      const metadata = await sock.groupMetadata(gid).catch(() => null); if (!metadata) return;
      groupCache.set(gid, metadata); const gname = metadata.subject || 'ARVX 588';
      const botJid = sock.user?.id ? normalizeJid(sock.user.id) : '';
      const isBotAdmin = isParticipantAdmin(metadata.participants, botJid) || isParticipantAdmin(metadata.participants, `${BOT_NUMBER}@s.whatsapp.net`);
      const parts = (anu.participants || []).map(normalizeJid).filter(Boolean);
      if (anu.action === 'add') {
        if (settings.antiraid && isBotAdmin) { const cur = (raidTracker.get(gid) || 0) + parts.length; raidTracker.set(gid, cur); if (cur >= (cfg.thresholds?.raid_max_joins || 5) && !settings.lockdown) { settings.lockdown = true; saveDB(db); try { await sock.groupSettingUpdate(gid, 'announcement'); } catch {} await safeSend(sock, gid, { text: `🚨 *ANTI-RAID LOCKDOWN*\n${cur} akun masuk barengan. Ketik *${PREFIX}lockdown off*` }); } }
        for (const participant of parts) {
          const userNum = numOf(participant); if (!userNum) continue;
          if (db.blacklist[gid]?.[userNum]) { if (isBotAdmin) { await safeSend(sock, gid, { text: `⛔ *BLACKLIST*\n@${userNum} diblokir permanen.`, mentions: [participant] }); try { await sock.groupParticipantsUpdate(gid, [participant], 'remove'); } catch { try { await sock.groupParticipantsUpdate(gid, [pnOf(participant)], 'remove'); } catch {} } } continue; }
          // 37 Verif code baru
          const code = makeVerifCode(); db.verifCodes[gid] ??= {}; db.verifCodes[gid][userNum] = code; saveDB(db);
          db.pendingIntros[gid] ??= {}; db.pendingIntros[gid][userNum] = Date.now(); saveDB(db);
          // 10 Scam Check
          if (settings.scamCheck) { const { score, why } = scamScoreFor(userNum); if (score >= 2) await safeSend(sock, gid, { text: `⚠️ *SCAM CHECK*\n👤 @${userNum}\n🔍 ${why}\nAdmin pantau!`, mentions: [participant] }); }
          // 8 Anti-Fake Admin: cek tag palsu di metadata (kalau ada tag admin tapi bukan admin)
          if (settings.antiFakeAdmin) { const p = metadata.participants.find(x => normalizeJid(x.id || x.jid) === participant); if (p?.tag && /admin|owner/i.test(p.tag) && !isParticipantAdmin(metadata.participants, participant)) await safeSend(sock, gid, { text: `⚠️ @${userNum} pake tag "${p.tag}" tapi BUKAN admin!`, mentions: [participant] }); }
          if (settings.welcome) await safeSend(sock, gid, { text: `Halo @${userNum}! 👋\nKode verif kamu: *${code}*\nKetik *${PREFIX}verif ${code}* setelah isi intro.\n\n${INTRO_CARD_TEXT}`, mentions: [participant] });
        }
      } else if (anu.action === 'remove' || anu.action === 'leave') {
        for (const participant of parts) { const userNum = numOf(participant); if (db.pendingIntros[gid]?.[userNum]) { delete db.pendingIntros[gid][userNum]; saveDB(db); } await safeSend(sock, gid, { text: `👋 Selamat tinggal @${userNum}! Semoga betah di luar sana!`, mentions: [participant] }); }
      } else if (anu.action === 'promote' || anu.action === 'demote') {
        for (const participant of parts) await sendOwnerLog(sock, gname, anu.action.toUpperCase(), numOf(participant), 'Perubahan admin di grup');
      }
    } catch (e) { console.error('group-participants:', e.message); }
  });

  // ============ 18 REAKSI: LOG + ANTI-HAPUS REAKSI + 7 STICKER SPAM ============
  sock.ev.on('messages.reaction', async (reactions) => {
    try {
      for (const r of reactions) {
        const gid = normalizeJid(r.key.remoteJid); if (!gid.endsWith('@g.us')) continue; if (isBotDisabled(gid)) continue;
        const s = getGroupSettings(gid); const sender = normalizeJid(r.key.participant || '');
        const emoji = r.reaction?.text || '';
        const key = `${gid}_${numOf(sender)}_${r.key.id}`;
        if (!emoji) { // reaksi dihapus
          const old = reactionLog.get(key); if (old && s.antiHapusReaksi) await safeSend(sock, gid, { text: `🗑️ *ANTI-HAPUS REAKSI*\n👤 @${numOf(sender)} ngehapus reaksi "${old}"`, mentions: [sender] });
          reactionLog.delete(key); continue;
        }
        reactionLog.set(key, emoji);
        // 7 Anti-Sticker Spam: >10 reaksi dalam 60 detik
        if (s.antiStickerSpam) { const rk = `${gid}_${numOf(sender)}`; const c = (reactionTracker.get(rk) || 0) + 1; reactionTracker.set(rk, c); if (c > 10) { reactionTracker.del(rk); const meta = groupCache.get(gid); const isBotAdm = isParticipantAdmin(meta?.participants || [], sock.user?.id || ''); await handleViolation(sock, gid, meta?.subject || 'ARVX', sender, numOf(sender), null, 'Spam reaksi / stiker', isBotAdm, false); } }
        // 27 Hitung reaksi terbanyak buat .topreact
        db.reacts ??= {}; db.reacts[gid] ??= {}; db.reacts[gid][emoji] = (db.reacts[gid][emoji] || 0) + 1; saveDB(db);
      }
    } catch (e) { console.log('reaction:', e.message); }
  });

  // ============ 25-26 POLL UPDATE ============
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    try {
      if (type !== 'notify') return;
      for (const m of messages) {
        if (!m?.message) continue;
        if (m.key.fromMe) continue; // FIX LOOP
        if (m.key.remoteJid === 'status@broadcast') continue;
        const from=normalizeJid(m.key.remoteJid);
        const isGroup=from.endsWith('@g.us');
        const settings=isGroup?getGroupSettings(from):null;

        // FIX .on: kasih jalan buat .on meskipun bot lagi OFF
        const bodyAwal = m.message.conversation || m.message.extendedTextMessage?.text || '';
        const isOnCmd = bodyAwal.trim().toLowerCase() === `${PREFIX}on` || bodyAwal.trim().toLowerCase() === '.on';
        if(isGroup && isBotDisabled(from) && !isOnCmd) continue; // kalau bukan .on, baru diem
        
        // 17 Anti-Disappearing: deteksi pesan ephemeral (pesan ilang)
        const isEphemeral = !!m.message.ephemeralMessage || !!m.message.viewOnceMessageV2 || m.message.conversation?.length === 0;
        if (isGroup && settings?.antiDisappearing && m.message.ephemeralMessage) { await safeSend(sock, from, { text: `⏳ *DISAPPEARING TERDETEKSI*\nAda pesan yang bakal ilang otomatis. Bukti bisa hilang, admin harap pantau.` }); }

        // Anti-Delete REVOKE
        if (isGroup && m.message.protocolMessage?.type === 0) {
          if (settings?.antidelete) {
            const delId = m.message.protocolMessage.key?.id; const cached = messageStore.get(delId);
            if (cached && !cached.isAdmin) {
              if (cached.media) { try { await safeSend(sock, from, { [cached.mediaType]: cached.media, caption: `👁️ *ANTI-DELETE MEDIA*\n👤 @${cached.senderNumber}` }); } catch { await safeSend(sock, from, { text: `👁️ Media dari @${cached.senderNumber} dihapus (gagal dibuka)` }); } }
              else await safeSend(sock, from, { text: `👁️ *ANTI-DELETE*\n👤 @${cached.senderNumber}\n💬 "${cached.text}"`, mentions: [cached.sender] });
              // 13 Anti-Delete dokumen/stiker/VN: text fallback
              if (cached.docType) await safeSend(sock, from, { text: `👁️ *ANTI-DELETE ${cached.docType.toUpperCase()}*\n👤 @${cached.senderNumber}\nFile: ${cached.fileName || '-'}` });
            }
          }
          continue;
        }
        // 14 Anti-Edit
        const edited = m.message.editedMessage?.message || m.message.protocolMessage?.editedMessage?.message;
        if (isGroup && edited && settings?.antiEdit) {
          const orig = messageStore.get(m.key.id);
          const newText = edited.conversation || edited.extendedTextMessage?.text || '(media diedit)';
          if (orig && orig.text !== newText) await safeSend(sock, from, { text: `✏️ *ANTI-EDIT*\n👤 @${orig.senderNumber}\nDari: "${orig.text}"\nJadi: "${newText}"`, mentions: [orig.sender] });
          continue;
        }
        // 15-16 Anti-ViewOnce + Anti-Zaps
        const vo = m.message.viewOnceMessageV2?.message || m.message.viewOnceMessage?.message;
        const isZap = !!m.message.instantMessage || m.message.viewOnceMessageV2?.message?.instantMessage;
        if (isGroup && vo && (settings?.antiViewOnce || settings?.antiZap)) {
          const senderTmp = normalizeJid(m.key.participant || m.participant || '');
          try {
            if (vo.imageMessage) { const buf = await downloadMedia(vo.imageMessage, 'image'); await safeSend(sock, from, { image: buf, caption: `👁️ *${isZap ? 'ANTI-ZAPS' : 'ANTI-VIEWONCE'}*\n👤 @${numOf(senderTmp)}` }); }
            else if (vo.videoMessage) { const buf = await downloadMedia(vo.videoMessage, 'video'); await safeSend(sock, from, { video: buf, caption: `👁️ *${isZap ? 'ANTI-ZAPS' : 'ANTI-VIEWONCE'}*\n👤 @${numOf(senderTmp)}` }); }
            else if (vo.conversation || vo.extendedTextMessage?.text) await safeSend(sock, from, { text: `👁️ *ANTI-VIEWONCE TEKS*\n👤 @${numOf(senderTmp)}\n💬 "${vo.conversation || vo.extendedTextMessage?.text}"` });
            else if (vo.audioMessage) { const buf = await downloadMedia(vo.audioMessage, 'audio'); await safeSend(sock, from, { audio: buf, mimetype: 'audio/ogg; codecs=opus', ptt: true }); }
          } catch { await safeSend(sock, from, { text: `👁️ Ada pesan 1x liat dari @${numOf(senderTmp)} tapi gagal dibuka.` }); }
          continue;
        }
        // 26 Poll Result Palsu: pollUpdate / pollCreation
        if (m.message.pollUpdateMessage) {
          const pollId = m.message.pollUpdateMessage.pollCreationMessageKey?.id || 'poll';
          pollStore.set(pollId, (pollStore.get(pollId) || 0) + 1);
          continue;
        }
        if (m.message.pollCreationMessage) {
          const pollId = m.key.id; pollStore.set(pollId, 0);
          if (settings?.antiPollPalsu) { /* poll asli dari Baileys punya pollCreationMessageKey yang valid, poll palsu biasanya cuma teks */ }
          continue;
        }

        const sender = normalizeJid(isGroup ? (m.key.participant || m.participant || '') : from); if (!sender) continue;
        const senderNumber = numOf(sender);
        const isOwner = senderNumber === OWNER_NUMBER;
        const body = m.message.conversation || m.message.extendedTextMessage?.text || m.message.imageMessage?.caption || m.message.videoMessage?.caption || '';
        // 5 Auto-Mute: kalau masih di-mute, hapus pesannya
        if (isGroup && muteUntil.get(`${from}_${senderNumber}`) && Date.now() < muteUntil.get(`${from}_${senderNumber}`)) { try { await sock.sendMessage(from, { delete: m.key }); } catch {} continue; }
        const groupMetadata = isGroup ? (groupCache.get(from) || await sock.groupMetadata(from).catch(() => null)) : null;
        if (groupMetadata) groupCache.set(from, groupMetadata);
        const groupName = groupMetadata?.subject || 'ARVX 588';
        const participants = groupMetadata?.participants || [];
        const isAdmin = isParticipantAdmin(participants, sender);
        const botJid = sock.user?.id ? normalizeJid(sock.user.id) : '';
        const isBotAdmin = isParticipantAdmin(participants, botJid) || isParticipantAdmin(participants, `${BOT_NUMBER}@s.whatsapp.net`);

        // Simpan Anti-Delete lengkap: teks + media + VN + stiker + dokumen
        if (isGroup && m.key.id) {
          const entry = { sender, senderNumber, text: body, isAdmin: isAdmin || isOwner, media: null, mediaType: null, docType: null, fileName: null };
          try {
            if (m.message.imageMessage) { entry.media = await downloadMedia(m.message.imageMessage, 'image'); entry.mediaType = 'image'; }
            else if (m.message.videoMessage) { entry.media = await downloadMedia(m.message.videoMessage, 'video'); entry.mediaType = 'video'; }
            else if (m.message.audioMessage) { entry.media = await downloadMedia(m.message.audioMessage, 'audio'); entry.mediaType = 'audio'; entry.docType = 'VN'; }
            else if (m.message.stickerMessage) { entry.media = await downloadMedia(m.message.stickerMessage, 'sticker'); entry.mediaType = 'sticker'; entry.docType = 'STIKER'; }
            else if (m.message.documentMessage) { entry.media = await downloadMedia(m.message.documentMessage, 'document'); entry.mediaType = 'document'; entry.docType = 'DOKUMEN'; entry.fileName = m.message.documentMessage.fileName || ''; }
          } catch {}
          messageStore.set(m.key.id, entry);
        }
        if (m.pushName && senderNumber) { db.usernames[senderNumber] = m.pushName; saveDB(db); }
        // 9 Anti-Impersonasi username mirip
        if (isGroup && settings?.antiImpersonasi && m.pushName) {
          const ownerName = db.usernames[OWNER_NUMBER] || 'ARVX';
          if (isSimilarUsername(m.pushName, 'ARVX 588') || isSimilarUsername(m.pushName, ownerName)) { if (!isAdmin && !isOwner) await safeSend(sock, from, { text: `⚠️ @${senderNumber} pake nama mirip admin/owner (${m.pushName}). Cek nomornya!`, mentions: [sender] }); }
        }

        const coolKey = `${from}_${senderNumber}`;
        const isCommand = body.startsWith(PREFIX);

        if (isGroup && !isAdmin && !isOwner) {
          if (cooldown.get(coolKey) && !isCommand) continue;
          if (settings.antivirtex && body.length > (cfg.thresholds?.virtex_max_chars || 4000)) { await handleViolation(sock, from, groupName, sender, senderNumber, m.key, 'Virtex / Teks Crash >4000 karakter', isBotAdmin, true); continue; }
          if (settings.antispam) { const sk = `${from}_${senderNumber}`; const c = (spamTracker.get(sk) || 0) + 1; spamTracker.set(sk, c); if (c > (cfg.thresholds?.spam_max_messages || 5)) { spamTracker.del(sk); muteUntil.set(sk, Date.now() + 5 * 60 * 1000); await handleViolation(sock, from, groupName, sender, senderNumber, m.key, 'Spam / Flood - Auto Mute 5 menit', isBotAdmin, false); continue; } }
          const mentioned = mentionsOf(m.message.extendedTextMessage?.contextInfo?.mentionedJid || []);
          // 1 Anti-@all: teks @all ATAU mention semua member
          if (settings.antiAll && (body.toLowerCase().includes('@all') || (mentioned.length >= Math.max(1, participants.length - 1) && participants.length > 5))) { await handleViolation(sock, from, groupName, sender, senderNumber, m.key, 'Spam @all / Tag Semua', isBotAdmin, false); continue; }
          // 2 Anti-Tagall / Hidetag
          if (settings.antitag && mentioned.length > (cfg.thresholds?.max_mentions || 5)) { await handleViolation(sock, from, groupName, sender, senderNumber, m.key, 'Tag Massal / Hidetag', isBotAdmin, false); continue; }
          // 3-4 Anti-Link + Anti-Link Call Palsu
          if (settings.antilink) {
            const isCallLink = /call\.whatsapp\.com/i.test(body);
            const linkRe = /(whatsapp\.com|t\.me\/|telegram\.me\/|discord\.gg\/|bit\.ly\/|https?:\/\/)/i;
            if (isCallLink) { await handleViolation(sock, from, groupName, sender, senderNumber, m.key, 'Link Call Palsu - hanya admin boleh share call link', isBotAdmin, false); continue; }
            if (linkRe.test(body) && !body.includes(WHITELIST_CODE)) { await handleViolation(sock, from, groupName, sender, senderNumber, m.key, 'Kirim Link / Promosi Luar', isBotAdmin, false); continue; }
          }
          // 12 Anti-Promosi / Jualan
          if (settings.antiPromosi && /(promo|diskon|join grup|slot|gacor|jual|open order|ready stock|dijual)/i.test(body)) { await handleViolation(sock, from, groupName, sender, senderNumber, m.key, 'Promosi / Jualan tanpa izin', isBotAdmin, false); continue; }
          // 8 Anti-Fake Admin teks
          if (settings.antiFakeAdmin && /saya admin|gue admin|aku owner|admin arxv/i.test(body)) await safeSend(sock, from, { text: `⚠️ @${senderNumber} ngaku admin, tapi sistem: BUKAN ADMIN.`, mentions: [sender] });
          // 32 Smart Text Actions: extract nomor / tanggal / email
          if (settings.smartText) {
            const phone = body.match(/\+?\d{10,15}/)?.[0]; const email = body.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i)?.[0]; const date = body.match(/\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}|\d{1,2} (jan|feb|mar|apr|mei|jun|jul|agu|sep|okt|nov|des)[a-z]* \d{4}/i)?.[0];
            if ((phone || email || date) && body.length > 20 && !isCommand) { /* simpan diam-diam, admin bisa .smart */ db.smart ??= {}; db.smart[from] ??= []; db.smart[from].push({ by: senderNumber, phone: phone || '-', email: email || '-', date: date || '-', text: body.slice(0, 80), at: Date.now() }); saveDB(db); }
          }
          cooldown.set(coolKey, 1);
        }

        // Intro detector
        if (isGroup && body.includes('𝐈𝐍𝐓𝐑𝐎 𝐂𝐀𝐑𝐃') && body.includes('Nama :')) {
          if (cooldown.get(`intro_${coolKey}`)) continue; cooldown.set(`intro_${coolKey}`, 1);
          const nama = body.match(/Nama\s*:\s*(.+)/i)?.[1]?.trim() || ''; const umur = body.match(/Umur\s*:\s*(.+)/i)?.[1]?.trim() || ''; const gender = body.match(/Gender\s*:\s*(.+)/i)?.[1]?.trim() || ''; const asal = body.match(/Asal\s*:\s*(.+)/i)?.[1]?.trim() || '';
          if (!nama || !umur || !gender || !asal) await safeSend(sock, from, { text: `⚠️ @${senderNumber}, intro belum lengkap!`, mentions: [sender] }, { quoted: m });
          else { db.intros[from] ??= {}; db.intros[from][senderNumber] = { nama, umur, gender, asal, waktu: new Date().toLocaleString('id-ID') }; if (db.pendingIntros[from]?.[senderNumber]) delete db.pendingIntros[from][senderNumber]; saveDB(db); await safeSend(sock, from, { text: `✅ *INTRO DITERIMA*\nNama: ${nama} | Umur: ${umur} | Gender: ${gender} | Asal: ${asal}\nSelamat bergabung @${senderNumber}! Sekarang ketik *${PREFIX}verif [kode]*`, mentions: [sender] }, { quoted: m }); }
          continue;
        }

        if (!isCommand) continue;
        const args = body.slice(PREFIX.length).trim().split(/\s+/); const command = args.shift().toLowerCase(); const text = args.join(' ');
        const getTarget = () => { const men = mentionsOf(m.message.extendedTextMessage?.contextInfo?.mentionedJid || []); const q = normalizeJid(m.message.extendedTextMessage?.contextInfo?.participant || ''); return men[0] || q || ''; };

        switch (command) {
          case 'off': { if (!isGroup) break; if (!isAdmin && !isOwner) { await safeSend(sock, from, { text: '❌ Khusus Admin!' }, { quoted: m }); break; } db.disabled[from] = true; saveDB(db); await safeSend(sock, from, { text: '🔴 Bot dimatiin di grup ini. Ketik *.on* buat nyalain lagi.' }); break; }
          case 'on': { if (!isGroup) break; if (!isAdmin && !isOwner) { await safeSend(sock, from, { text: '❌ Khusus Admin!' }, { quoted: m }); break; } delete db.disabled[from]; saveDB(db); await safeSend(sock, from, { text: '🟢 Bot nyala lagi!' }); break; }
          case 'verif': { // 37 Username Key
            if (!isGroup) break; const expect = db.verifCodes[from]?.[senderNumber]; if (!expect) { await safeSend(sock, from, { text: 'Kamu belum punya kode verif. Keluar-masuk lagi biar dapet kode.' }, { quoted: m }); break; }
            if (text.trim() === String(expect)) { db.intros[from] ??= {}; db.intros[from][senderNumber] = { ...(db.intros[from][senderNumber] || {}), verified: true, verifiedAt: Date.now() }; saveDB(db); await safeSend(sock, from, { text: `✅ *VERIFIKASI BERHASIL*\n@${senderNumber} resmi terverifikasi ARVX 588!`, mentions: [sender] }, { quoted: m }); } else await safeSend(sock, from, { text: '❌ Kode salah! Cek kode di pesan welcome.' }, { quoted: m }); break;
          }
          case 'menu': case 'help': {
            // 28 Interactive Buttons: Baileys interactiveMessage - fallback teks kalau gagal
            const menuText = `╭━━━ ARVX 588 - FULL 38 FITUR ━━━╮\n👤 @${senderNumber}\n\n📋 MEMBER\n${PREFIX}intro | ${PREFIX}listintro | ${PREFIX}cekintro | ${PREFIX}verif [kode] | ${PREFIX}linkgrup\n${PREFIX}s | ${PREFIX}steks [teks] | ${PREFIX}rvo | ${PREFIX}cekweb [link] | ${PREFIX}ai [tanya]\n${PREFIX}poll [judul] | opsi1,opsi2 | ${PREFIX}hasilpoll | ${PREFIX}topreact | ${PREFIX}smart\n${PREFIX}pin [teks] | ${PREFIX}event [judul] | [tanggal] | ${PREFIX}jadwal [detik] [pesan]\n${PREFIX}scamcek @user | ${PREFIX}cekadmin @user | ${PREFIX}report [alasan]\n${PREFIX}off | ${PREFIX}on\n\n🛡️ ADMIN\n${PREFIX}defense | ${PREFIX}lockdown on/off | ${PREFIX}lock / ${PREFIX}unlock | ${PREFIX}onlyadmin\n${PREFIX}ban | ${PREFIX}unban | ${PREFIX}listban | ${PREFIX}warn | ${PREFIX}resetwarn\n${PREFIX}kick | ${PREFIX}promote | ${PREFIX}demote | ${PREFIX}grup buka/tutup\n${PREFIX}tagall | ${PREFIX}hidetag | ${PREFIX}kickunverified | ${PREFIX}resetlink\n${PREFIX}channelpost [pesan] | ${PREFIX}communitykick @user\n⚙️ ${PREFIX}antilink/antispam/antivirtex/antitag/antidelete/antiraid/antiall/antiedit/antiviewonce/antizap/antistickerspam/antifakeadmin/antiimpersonasi/scamcheck/antipromosi/antidisappearing/antihapusreaksi/antipollpalsu/smarttext on/off\n📝 Kata kotor: DIMATIKAN - admin asli yang handle.`;
            try { await sock.sendMessage(from, { text: menuText, mentions: [sender] }, { quoted: m }); } catch { await safeSend(sock, from, { text: menuText }, { quoted: m }); }
            break;
          }
          case 'defense': {
            if (!isGroup) break; if (!isAdmin && !isOwner) { await safeSend(sock, from, { text: '❌ Khusus Admin!' }, { quoted: m }); break; }
            const s = getGroupSettings(from); const ic = v => v ? '🟢 ON' : '🔴 OFF';
            await safeSend(sock, from, { text: `🛡️ *DEFENSE PANEL - 38 FITUR*\nBot: ${isBotDisabled(from) ? '🔴 OFF' : '🟢 ON'} | Lockdown: ${ic(s.lockdown)}\nAntiLink: ${ic(s.antilink)} | AntiSpam: ${ic(s.antispam)} | AntiVirtex: ${ic(s.antivirtex)}\nAntiTag: ${ic(s.antitag)} | Anti@All: ${ic(s.antiAll)} | AntiPromosi: ${ic(s.antiPromosi)}\nAntiDelete: ${ic(s.antidelete)} | AntiEdit: ${ic(s.antiEdit)} | AntiViewOnce: ${ic(s.antiViewOnce)}\nAntiZap: ${ic(s.antiZap)} | AntiStickerSpam: ${ic(s.antiStickerSpam)}\nAntiFakeAdmin: ${ic(s.antiFakeAdmin)} | AntiImpersonasi: ${ic(s.antiImpersonasi)}\nScamCheck: ${ic(s.scamCheck)} | AntiDisappearing: ${ic(s.antiDisappearing)}\nAntiHapusReaksi: ${ic(s.antiHapusReaksi)} | AntiPollPalsu: ${ic(s.antiPollPalsu)}\nSmartText: ${ic(s.smartText)} | AntiRaid: ${ic(s.antiraid)} | Welcome: ${ic(s.welcome)}\nKata Kotor: ❌ DIMATIKAN (admin handle)\nBlacklist: ${Object.keys(db.blacklist[from] || {}).length} | Reports: ${(db.reports || []).filter(r => r.group === from).length}` }, { quoted: m }); break;
          }
          case 'antilink': case 'antispam': case 'antivirtex': case 'antitag': case 'antiraid': case 'antidelete': case 'autokickintro': case 'welcome': case 'antiall': case 'antiedit': case 'antiviewonce': case 'antizap': case 'antistickerspam': case 'antifakeadmin': case 'antiimpersonasi': case 'scamcheck': case 'antipromosi': case 'antidisappearing': case 'antihapusreaksi': case 'antipollpalsu': case 'smarttext': {
            if (!isGroup) break; if (!isAdmin && !isOwner) { await safeSend(sock, from, { text: '❌ Khusus Admin!' }, { quoted: m }); break; }
            const s = getGroupSettings(from);
            if (text === 'on') { s[command] = true; saveDB(db); await safeSend(sock, from, { text: `🛡️ ${command} ON` }, { quoted: m }); }
            else if (text === 'off') { s[command] = false; saveDB(db); await safeSend(sock, from, { text: `⚠️ ${command} OFF` }, { quoted: m }); }
            else await safeSend(sock, from, { text: `${command}: ${s[command] ? '🟢 ON' : '🔴 OFF'}` }, { quoted: m }); break;
          }
          case 'dmlog': { if (!isOwner && !isAdmin) break; if (text === 'on') { db.global.dmLog = true; saveDB(db); await safeSend(sock, from, { text: '✅ DM Log ON' }, { quoted: m }); } else if (text === 'off') { db.global.dmLog = false; saveDB(db); await safeSend(sock, from, { text: '⚠️ DM Log OFF' }, { quoted: m }); } else await safeSend(sock, from, { text: `DM Log: ${db.global.dmLog ? 'ON' : 'OFF'}` }, { quoted: m }); break; }
          case 'report': case 'lapor': { // 21 Send For Admin Review
            if (!isGroup) break; const admins = (participants || []).filter(p => p.admin === 'admin' || p.admin === 'superadmin').map(p => normalizeJid(p.id || p.jid)).filter(Boolean);
            const q = m.message.extendedTextMessage?.contextInfo; const reportedText = q?.quotedMessage?.conversation || q?.quotedMessage?.extendedTextMessage?.text || text || '(tanpa teks)';
            db.reports.push({ group: from, by: senderNumber, text: reportedText, at: Date.now(), reason: text }); saveDB(db);
            await safeSend(sock, from, { text: `📩 *LAPORAN DITERIMA*\nDari: @${senderNumber}\nIsi yang dilaporin: "${reportedText}"\nAdmin akan cek!`, mentions: [...admins, sender] });
            await sendOwnerLog(sock, groupName, 'REPORT MEMBER', senderNumber, reportedText.slice(0, 100)); break;
          }
          case 'lock': case 'lockdown': { // 22 Group Permissions Manager
            if (!isGroup) break; if (!isAdmin && !isOwner) break; if (!isBotAdmin) { await safeSend(sock, from, { text: '❌ Bot belum Admin!' }, { quoted: m }); break; }
            const s = getGroupSettings(from); if (text === 'off') { s.lockdown = false; saveDB(db); try { await sock.groupSettingUpdate(from, 'not_announcement'); } catch {} await safeSend(sock, from, { text: '✅ LOCKDOWN OFF' }); break; }
            s.lockdown = true; s.antilink = s.antispam = s.antivirtex = s.antitag = s.antiraid = s.antiAll = s.antiPromosi = true; saveDB(db); try { await sock.groupSettingUpdate(from, 'announcement'); } catch {} await safeSend(sock, from, { text: '🚨 LOCKDOWN ON - Grup dikunci + semua perisai max.' }); break;
          }
          case 'unlock': { if (!isGroup) break; if (!isAdmin && !isOwner) break; const s = getGroupSettings(from); s.lockdown = false; saveDB(db); try { await sock.groupSettingUpdate(from, 'not_announcement'); } catch {} await safeSend(sock, from, { text: '✅ Grup dibuka.' }); break; }
          case 'onlyadmin': { if (!isGroup) break; if (!isAdmin && !isOwner) break; if (!isBotAdmin) { await safeSend(sock, from, { text: '❌ Bot belum Admin!' }, { quoted: m }); break; } try { await sock.groupSettingUpdate(from, 'announcement'); } catch {} await safeSend(sock, from, { text: '🔒 Mode Only Admin: cuma admin bisa chat.' }); break; }
          case 'resetlink': { // 23 Reset Invite Link
            if (!isGroup) break; if (!isAdmin && !isOwner) break; if (!isBotAdmin) { await safeSend(sock, from, { text: '❌ Bot belum Admin!' }, { quoted: m }); break; }
            try { const code = await sock.groupRevokeInvite(from); const link = `https://chat.whatsapp.com/${code}`; await safeSend(sock, from, { text: `🔗 *LINK BARU ARVX 588*\n${link}\nLink lama udah gak berlaku!` }); await sendOwnerLog(sock, groupName, 'RESET LINK', senderNumber, link); } catch (e) { await safeSend(sock, from, { text: `Reset link gagal: ${e.message}. Pastikan bot admin.` }, { quoted: m }); } break;
          }
          case 'ban': { if (!isGroup) break; if (!isAdmin && !isOwner) break; if (!isBotAdmin) { await safeSend(sock, from, { text: '❌ Bot belum Admin!' }, { quoted: m }); break; } const target = getTarget(); if (!target) { await safeSend(sock, from, { text: `Tag member! ${PREFIX}ban @user alasan` }, { quoted: m }); break; } const tn = numOf(target); if (tn === OWNER_NUMBER) { await safeSend(sock, from, { text: '❌ Tidak bisa ban Owner!' }, { quoted: m }); break; } const reason = text.replace(/@\d+/g, '').trim() || 'Blacklist admin'; db.blacklist[from] ??= {}; db.blacklist[from][tn] = { reason, by: senderNumber, date: new Date().toLocaleString('id-ID') }; saveDB(db); await safeSend(sock, from, { text: `🔨 *BLACKLIST*\n@${tn}\nAlasan: ${reason}`, mentions: [target] }); try { await sock.groupParticipantsUpdate(from, [target], 'remove'); } catch { try { await sock.groupParticipantsUpdate(from, [pnOf(target)], 'remove'); } catch {} } break; }
          case 'unban': { if (!isGroup) break; if (!isAdmin && !isOwner) break; const n = text.replace(/[^0-9]/g, ''); if (!n) { await safeSend(sock, from, { text: `Contoh: ${PREFIX}unban 628xxx` }, { quoted: m }); break; } if (db.blacklist[from]?.[n]) { delete db.blacklist[from][n]; saveDB(db); await safeSend(sock, from, { text: `✅ +${n} di-unban.` }, { quoted: m }); } else await safeSend(sock, from, { text: 'Nomor tidak ada di blacklist.' }, { quoted: m }); break; }
          case 'listban': { if (!isGroup) break; const bans = Object.entries(db.blacklist[from] || {}); if (!bans.length) { await safeSend(sock, from, { text: '✅ Blacklist kosong.' }, { quoted: m }); break; } let t = `🚫 *BLACKLIST (${bans.length})*\n`; bans.forEach(([n, i], idx) => t += `${idx + 1}. +${n} — ${i.reason}\n`); await safeSend(sock, from, { text: t }, { quoted: m }); break; }
          case 'addword': case 'delword': { // DIMATIKAN: kata kotor di-handle admin asli
            await safeSend(sock, from, { text: `❌ Fitur kata kotor DIMATIKAN.\nKata kasar / toxic sekarang di-handle langsung sama admin asli, bukan bot.` }, { quoted: m }); break;
          }
          case 'warn': { if (!isGroup) break; if (!isAdmin && !isOwner) break; const t = getTarget(); if (!t) { await safeSend(sock, from, { text: 'Tag / balas member!' }, { quoted: m }); break; } await handleViolation(sock, from, groupName, t, numOf(t), null, `Warn manual oleh +${senderNumber}`, isBotAdmin, false); break; }
          case 'resetwarn': { if (!isGroup) break; if (!isAdmin && !isOwner) break; const t = getTarget(); if (!t) { await safeSend(sock, from, { text: 'Tag member!' }, { quoted: m }); break; } if (db.warns[from]) db.warns[from][numOf(t)] = 0; saveDB(db); await safeSend(sock, from, { text: `✅ Warn @${numOf(t)} reset 0.`, mentions: [t] }, { quoted: m }); break; }
          case 'kickunverified': { if (!isGroup) break; if (!isAdmin && !isOwner) break; if (!isBotAdmin) { await safeSend(sock, from, { text: '❌ Bot belum Admin!' }, { quoted: m }); break; } const pend = db.pendingIntros[from] || {}; const unv = Object.keys(pend).filter(n => !db.intros[from]?.[n]); if (!unv.length) { await safeSend(sock, from, { text: '✅ Tidak ada yang belum intro.' }, { quoted: m }); break; } const targets = unv.map(n => `${n}@s.whatsapp.net`); await safeSend(sock, from, { text: `🧹 Kick ${targets.length} belum intro...`, mentions: targets }); try { await sock.groupParticipantsUpdate(from, targets, 'remove'); } catch {} unv.forEach(n => delete db.pendingIntros[from][n]); saveDB(db); break; }
          case 'intro': { await safeSend(sock, from, { text: INTRO_CARD_TEXT }, { quoted: m }); break; }
          case 'linkgrup': { await safeSend(sock, from, { text: `🔗 Link ARVX 588:\n${GROUP_LINK}` }, { quoted: m }); break; }
          case 'listintro': { if (!isGroup) break; const list = db.intros[from] || {}; const ent = Object.entries(list); if (!ent.length) { await safeSend(sock, from, { text: 'Belum ada yang intro.' }, { quoted: m }); break; } let t = `📑 *INTRO (${ent.length})*\n`; ent.forEach(([n, i], idx) => t += `${idx + 1}. ${i.nama || '-'} (${i.umur || '-'}/${i.gender || '-'}) — ${i.asal || '-'} ${i.verified ? '✅' : '❌'} [@${n}]\n`); await safeSend(sock, from, { text: t, mentions: ent.map(([n]) => `${n}@s.whatsapp.net`) }, { quoted: m }); break; }
          case 'cekintro': { if (!isGroup) break; if (!isAdmin && !isOwner) break; const pend = db.pendingIntros[from] || {}; const unv = Object.keys(pend).filter(n => !db.intros[from]?.[n]); if (!unv.length) { await safeSend(sock, from, { text: '✅ Semua udah intro!' }, { quoted: m }); break; } let t = `⏳ *BELUM INTRO (${unv.length})*\n`; unv.forEach((n, i) => t += `${i + 1}. @${n}\n`); await safeSend(sock, from, { text: t, mentions: unv.map(n => `${n}@s.whatsapp.net`) }, { quoted: m }); break; }
          case 's': case 'stiker': case 'sticker': { const quoted = m.message.extendedTextMessage?.contextInfo?.quotedMessage; const targetImg = m.message.imageMessage || quoted?.imageMessage; if (!targetImg) { await safeSend(sock, from, { text: `Balas gambar pake ${PREFIX}s` }, { quoted: m }); break; } try { const buf = await downloadMedia(targetImg, 'image'); const det = await fileTypeFromBuffer(buf); if (!det?.mime.startsWith('image/')) { await safeSend(sock, from, { text: 'Bukan gambar.' }, { quoted: m }); break; } const st = await createSticker(buf); await safeSend(sock, from, { sticker: st }, { quoted: m }); } catch { await safeSend(sock, from, { text: 'Gagal bikin stiker.' }, { quoted: m }); } break; }
          case 'stickerteks': case 'steks': { if (!text) { await safeSend(sock, from, { text: `Contoh: ${PREFIX}steks HALO ARVX` }, { quoted: m }); break; } try { const svg = `<svg width="512" height="512" xmlns="http://www.w3.org/2000/svg"><rect width="512" height="512" fill="#111"/><text x="256" y="256" font-size="72" font-weight="bold" fill="white" text-anchor="middle" font-family="sans-serif">${text.slice(0, 20).replace(/[<>&"]/g, '')}</text></svg>`; const st = await createSticker(Buffer.from(svg), 'ARVX Teks', 'ARVX'); await safeSend(sock, from, { sticker: st }, { quoted: m }); } catch { await safeSend(sock, from, { text: 'Gagal bikin stiker teks.' }, { quoted: m }); } break; }
          case 'rvo': case 'readviewonce': { const quoted = m.message.extendedTextMessage?.contextInfo?.quotedMessage; const vo = quoted?.viewOnceMessageV2?.message || quoted?.viewOnceMessage?.message || quoted; const img = vo?.imageMessage; const vid = vo?.videoMessage; const txt = vo?.conversation || vo?.extendedTextMessage?.text; try { if (img) { const buf = await downloadMedia(img, 'image'); await safeSend(sock, from, { image: buf, caption: img.caption || '📸 ViewOnce dibuka' }, { quoted: m }); } else if (vid) { const buf = await downloadMedia(vid, 'video'); await safeSend(sock, from, { video: buf, caption: vid.caption || '🎥 ViewOnce dibuka' }, { quoted: m }); } else if (txt) await safeSend(sock, from, { text: `👁️ *VIEWONCE TEKS*\n"${txt}"` }, { quoted: m }); else await safeSend(sock, from, { text: `Balas foto/video/teks 1x liat pake ${PREFIX}rvo` }, { quoted: m }); } catch { await safeSend(sock, from, { text: 'Gagal buka media 1x liat. Mungkin udah kedaluwarsa.' }, { quoted: m }); } break; }
          case 'cekweb': { if (!text?.startsWith('http')) { await safeSend(sock, from, { text: `Contoh: ${PREFIX}cekweb https://github.com` }, { quoted: m }); break; } try { const r = await axios.get(text, { timeout: 8000 }); const $ = cheerio.load(r.data); await safeSend(sock, from, { text: `🌐 *INFO LINK*\nJudul: ${$('title').text().trim() || '-'}\nDeskripsi: ${$('meta[name="description"]').attr('content') || '-'}` }, { quoted: m }); } catch { await safeSend(sock, from, { text: 'Gagal ambil info URL.' }, { quoted: m }); } break; }
          case 'ai': { if (!text) { await safeSend(sock, from, { text: `Contoh: ${PREFIX}ai apa itu ARVX` }, { quoted: m }); break; } await safeSend(sock, from, { text: `🤖 *ARVX AI*\nQ: ${text}\nA: Gue bot ARVX 588. Ketik *${PREFIX}menu* buat liat semua fitur. Untuk jawaban AI beneran, pasang API key AI di kode bagian case 'ai'.` }, { quoted: m }); break; }
          case 'scamcek': { const t = getTarget(); if (!t) { await safeSend(sock, from, { text: 'Tag member!' }, { quoted: m }); break; } const { score, why } = scamScoreFor(numOf(t)); await safeSend(sock, from, { text: `🔍 *SCAM CHECK*\n👤 @${numOf(t)}\n📊 Skor: ${score}/5\n📝 ${why}\n${score >= 2 ? '⚠️ MENCURIGAKAN' : '✅ Aman'}`, mentions: [t] }, { quoted: m }); break; }
          case 'cekadmin': { const t = getTarget(); if (!t) { await safeSend(sock, from, { text: 'Tag member!' }, { quoted: m }); break; } const real = isParticipantAdmin(participants, t); await safeSend(sock, from, { text: real ? `✅ @${numOf(t)} BENERAN ADMIN.` : `❌ @${numOf(t)} BUKAN ADMIN!`, mentions: [t] }, { quoted: m }); break; }
          case 'smart': { // 32 Smart Text Actions
            const smart = (db.smart?.[from] || []).slice(-5); if (!smart.length) { await safeSend(sock, from, { text: 'Belum ada nomor / tanggal / email yang ke-detect.' }, { quoted: m }); break; } let t = `🧠 *SMART TEXT TERAKHIR*\n`; smart.forEach((x, i) => t += `${i + 1}. @${x.by} | HP: ${x.phone} | Email: ${x.email} | Tgl: ${x.date}\n`); await safeSend(sock, from, { text: t }, { quoted: m }); break;
          }
          case 'topreact': { // 27 Reaksi terbanyak
            const reacts = db.reacts?.[from] || {}; const ent = Object.entries(reacts).sort((a, b) => b[1] - a[1]).slice(0, 5); if (!ent.length) { await safeSend(sock, from, { text: 'Belum ada reaksi.' }, { quoted: m }); break; } let t = `🏆 *TOP REAKSI*\n`; ent.forEach(([e, c], i) => t += `${i + 1}. ${e} — ${c}x\n`); await safeSend(sock, from, { text: t }, { quoted: m }); break;
          }
          case 'pin': {
            if (!isGroup) break; if (!isAdmin && !isOwner) { await safeSend(sock, from, { text: '❌ Khusus Admin!' }, { quoted: m }); break; }
            const q = m.message.extendedTextMessage?.contextInfo; if (!q?.quotedMessage && !text) { await safeSend(sock, from, { text: `Balas pesan yang mau di-pin / ${PREFIX}pin [teks]` }, { quoted: m }); break; }
            try { if (q?.quotedMessage && q.stanzaId) { await sock.sendMessage(from, { pin: { type: 1, time: 0, key: { remoteJid: from, id: q.stanzaId, fromMe: false } } }); await safeSend(sock, from, { text: '📌 Di-pin selamanya!' }, { quoted: m }); } else { const sent = await safeSend(sock, from, { text: `📌 *PIN SELAMANYA*\n${text}` }); if (sent?.key) try { await sock.sendMessage(from, { pin: { type: 1, time: 0, key: sent.key } }); } catch {} } } catch (e) { await safeSend(sock, from, { text: `Pin gagal: ${e.message}. Pastikan bot admin.` }, { quoted: m }); } break;
          }
          case 'poll': {
            if (!isGroup) break; if (!isAdmin && !isOwner) { await safeSend(sock, from, { text: '❌ Khusus Admin!' }, { quoted: m }); break; }
            const parts = text.split('|'); const title = (parts[0] || '').trim(); const opts = (parts[1] || '').split(',').map(s => s.trim()).filter(Boolean);
            if (!title || opts.length < 2) { await safeSend(sock, from, { text: `Contoh: ${PREFIX}poll Mabar kapan? | Malam ini, Besok, Weekend` }, { quoted: m }); break; }
            try { const sent = await sock.sendMessage(from, { poll: { name: `📊 ${title}`, values: opts.slice(0, 10), selectableCount: 1 } }); db.polls[from] ??= {}; db.polls[from][sent.key.id] = { title, opts, by: senderNumber, at: Date.now(), votes: {} }; saveDB(db); await safeSend(sock, from, { text: `✅ Poll dibuat! Cek hasil pake *${PREFIX}hasilpoll*` }); } catch (e) { await safeSend(sock, from, { text: `Poll gagal: ${e.message}` }, { quoted: m }); } break;
          }
          case 'hasilpoll': { // 25 Hasil poll + 26 deteksi poll palsu
            if (!isGroup) break; const polls = db.polls[from] || {}; const ids = Object.keys(polls); if (!ids.length) { await safeSend(sock, from, { text: 'Belum ada poll dari bot.' }, { quoted: m }); break; } const last = polls[ids[ids.length - 1]]; const totalVotes = Object.keys(last.votes || {}).length; await safeSend(sock, from, { text: `📊 *HASIL POLL*\n🎯 ${last.title}\nOpsi: ${last.opts.join(' | ')}\nVote tercatat di bot: ${totalVotes}\n⚠️ Kalau ada yang kirim screenshot hasil poll beda, itu POLL PALSU - patokan cuma hasil dari bot ini.` }, { quoted: m }); break;
          }
          case 'event': {
            if (!isGroup) break; if (!isAdmin && !isOwner) { await safeSend(sock, from, { text: '❌ Khusus Admin!' }, { quoted: m }); break; }
            const parts = text.split('|'); const title = (parts[0] || '').trim(); const when = (parts[1] || '').trim() || 'Segera'; if (!title) { await safeSend(sock, from, { text: `Contoh: ${PREFIX}event Mabar ARVX | Sabtu 20.00` }, { quoted: m }); break; }
            // Parse tanggal sederhana: kalau ada angka jam, jadikan reminder 1 jam sebelum (default +24 jam)
            const at = Date.now() + 24 * 3600 * 1000; db.events[from] ??= []; db.events[from].push({ title, when, by: senderNumber, at, reminded: false }); saveDB(db);
            await safeSend(sock, from, { text: `📅 *EVENT ARVX 588*\n🎯 ${title}\n🕐 ${when}\n✅ RSVP pake reaksi 👍\nBot bakal reminder otomatis 1 jam sebelum.` }); break;
          }
          case 'jadwal': { if (!isGroup) break; if (!isAdmin && !isOwner) { await safeSend(sock, from, { text: '❌ Khusus Admin!' }, { quoted: m }); break; } const sec = parseInt(args[0] || '0', 10); const msg = args.slice(1).join(' '); if (!sec || !msg) { await safeSend(sock, from, { text: `Contoh: ${PREFIX}jadwal 60 Halo mabar yuk!` }, { quoted: m }); break; } db.scheduled.push({ id: Date.now() + '_' + Math.random(), groupId: from, text: msg, at: Date.now() + sec * 1000 }); saveDB(db); await safeSend(sock, from, { text: `⏰ Dijadwalkan dalam ${sec} detik.` }, { quoted: m }); break; }
          case 'channelpost': case 'channel': { // 33 Channel + 35 Channel Status tiruan
            if (!isGroup) break; if (!isAdmin && !isOwner) { await safeSend(sock, from, { text: '❌ Khusus Admin!' }, { quoted: m }); break; } if (!text) { await safeSend(sock, from, { text: `Contoh: ${PREFIX}channelpost Pengumuman penting ARVX!` }, { quoted: m }); break; }
            db.channelPosts.push({ group: from, text, at: Date.now(), by: senderNumber }); saveDB(db);
            let posted = false; if (CHANNEL_JID) { try { await sock.sendMessage(CHANNEL_JID, { text: `📢 *ARVX 588 CHANNEL*\n${text}` }); posted = true; } catch (e) { console.log('Channel post gagal:', e.message); } }
            await safeSend(sock, from, { text: posted ? `✅ Udah di-post ke Channel!` : `📢 *CHANNEL STATUS (TIRUAN)*\n${text}\n_Isi CHANNEL_JID di config biar beneran ke-post ke Channel WA._` }); break;
          }
          case 'communitykick': { // 34 Community Manager: kick dari semua grup yang bot pegang
            if (!isAdmin && !isOwner) { await safeSend(sock, from, { text: '❌ Khusus Admin!' }, { quoted: m }); break; } const t = getTarget(); if (!t) { await safeSend(sock, from, { text: 'Tag member!' }, { quoted: m }); break; }
            const allGroups = Object.keys(db.groups); let kicked = 0; for (const gid of allGroups) { try { const meta = groupCache.get(gid) || await sock.groupMetadata(gid).catch(() => null); if (!meta) continue; const isAdm = isParticipantAdmin(meta.participants, sock.user?.id || ''); if (!isAdm) continue; const exists = meta.participants.some(p => normalizeJid(p.id || p.jid) === t || numOf(p.id || p.jid) === numOf(t)); if (!exists) continue; await sock.groupParticipantsUpdate(gid, [t], 'remove'); kicked++; } catch {} }
            await safeSend(sock, from, { text: `🌐 *COMMUNITY KICK*\n@${numOf(t)} dikick dari ${kicked} grup ARVX.`, mentions: [t] }); break;
          }
          case 'hidetag': { if (!isGroup) break; if (!isAdmin && !isOwner) { await safeSend(sock, from, { text: '❌ Khusus Admin!' }, { quoted: m }); break; } const members = (groupMetadata?.participants || []).map(p => normalizeJid(p.id || p.jid)).filter(Boolean).slice(0, 100); await safeSend(sock, from, { text: text || '📢 Pengumuman Admin ARVX 588', mentions: members }); break; }
          case 'tagall': { if (!isGroup) break; if (!isAdmin && !isOwner) { await safeSend(sock, from, { text: '❌ Khusus Admin!' }, { quoted: m }); break; } const members = (groupMetadata?.participants || []).map(p => normalizeJid(p.id || p.jid)).filter(Boolean).slice(0, 100); let t = `📢 *TAG ALL — ARVX 588*\nPesan: ${text || '-'}\n\n`; members.forEach(j => t += `• @${numOf(j)}\n`); await safeSend(sock, from, { text: t, mentions: members }, { quoted: m }); break; }
          case 'kick': { if (!isGroup) break; if (!isAdmin && !isOwner) break; if (!isBotAdmin) { await safeSend(sock, from, { text: '❌ Bot belum Admin!' }, { quoted: m }); break; } const targets = mentionsOf(m.message.extendedTextMessage?.contextInfo?.mentionedJid || []); const q = normalizeJid(m.message.extendedTextMessage?.contextInfo?.participant || ''); const final = targets.length ? targets : (q ? [q] : []); if (!final.length) { await safeSend(sock, from, { text: 'Tag / balas member!' }, { quoted: m }); break; } for (const tg of final) { if (numOf(tg) === OWNER_NUMBER) continue; try { await sock.groupParticipantsUpdate(from, [tg], 'remove'); } catch { try { await sock.groupParticipantsUpdate(from, [pnOf(tg)], 'remove'); } catch {} } } await safeSend(sock, from, { text: '✅ Member dikeluarkan.' }, { quoted: m }); break; }
          case 'promote': case 'demote': { if (!isGroup) break; if (!isAdmin && !isOwner) break; if (!isBotAdmin) { await safeSend(sock, from, { text: '❌ Bot belum Admin!' }, { quoted: m }); break; } const targets = mentionsOf(m.message.extendedTextMessage?.contextInfo?.mentionedJid || []); const q = normalizeJid(m.message.extendedTextMessage?.contextInfo?.participant || ''); const final = targets.length ? targets : (q ? [q] : []); if (!final.length) { await safeSend(sock, from, { text: 'Tag member!' }, { quoted: m }); break; } for (const tg of final) { try { await sock.groupParticipantsUpdate(from, [tg], command); } catch {} } await safeSend(sock, from, { text: `✅ ${command} berhasil.` }, { quoted: m }); break; }
          case 'grup': case 'group': { if (!isGroup) break; if (!isAdmin && !isOwner) break; if (!isBotAdmin) { await safeSend(sock, from, { text: '❌ Bot belum Admin!' }, { quoted: m }); break; } if (text === 'buka') { try { await sock.groupSettingUpdate(from, 'not_announcement'); } catch {} await safeSend(sock, from, { text: '🔓 Grup DIBUKA.' }, { quoted: m }); } else if (text === 'tutup') { try { await sock.groupSettingUpdate(from, 'announcement'); } catch {} await safeSend(sock, from, { text: '🔒 Grup DITUTUP.' }, { quoted: m }); } else await safeSend(sock, from, { text: `Pakai: ${PREFIX}grup buka/tutup` }, { quoted: m }); break; }
        }
      }
    } catch (e) { console.error('[messages.upsert]', e.message); }
  });
}
startBot();
