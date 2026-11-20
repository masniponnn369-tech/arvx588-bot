import 'dotenv/config';
import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    downloadContentFromMessage
} from '@whiskeysockets/baileys';
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

// ================= MEMUAT KONFIGURASI YAML =================
const CONFIG_PATH = path.resolve('./config.yml');
const cfg = yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8'));

const BOT_NUMBER = (process.env.BOT_NUMBER || cfg.owner.bot_number).replace(/[^0-9]/g, '');
const OWNER_NUMBER = (process.env.OWNER_NUMBER || cfg.owner.number).replace(/[^0-9]/g, '');
const OWNER_JID = `${OWNER_NUMBER}@s.whatsapp.net`;
const PREFIX = process.env.PREFIX || cfg.bot.prefix || '.';
const GROUP_LINK = cfg.group.invite_link;
const WHITELIST_CODE = cfg.group.whitelist_invite_code;
const USE_PAIRING_CODE = process.env.USE_PAIRING_CODE !== 'false';

const logger = pino({ level: 'silent' });
const groupCache = new NodeCache({ stdTTL: 300, useClones: false });
const msgRetryCounterCache = new NodeCache({ stdTTL: 600, useClones: false });

// Cache Memori Cepat untuk Anti-Spam, Anti-Raid, & Anti-Delete
const spamTracker = new NodeCache({ stdTTL: cfg.thresholds.spam_window_sec || 5, checkperiod: 2 });
const raidTracker = new NodeCache({ stdTTL: 10, checkperiod: 2 });
const messageStore = new NodeCache({ stdTTL: 600, useClones: false }); // Simpan pesan 10 menit untuk Anti-Delete

// ================= DATABASE LOKAL & BLACKLIST =================
const DB_PATH = path.resolve('./database.json');

function loadDB() {
    if (!fs.existsSync(DB_PATH)) {
        fs.writeFileSync(DB_PATH, JSON.stringify({
            global: { dmLog: cfg.owner.dm_security_log ?? true },
            groups: {},
            intros: {},
            pendingIntros: {},
            warns: {},
            blacklist: {}
        }, null, 2));
    }
    const parsed = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
    if (!parsed.global) parsed.global = { dmLog: true };
    if (!parsed.pendingIntros) parsed.pendingIntros = {};
    if (!parsed.warns) parsed.warns = {};
    if (!parsed.blacklist) parsed.blacklist = {};
    return parsed;
}

function saveDB(data) {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}
let db = loadDB();

function getGroupSettings(groupId) {
    if (!db.groups[groupId]) {
        db.groups[groupId] = {
            ...cfg.defense_defaults,
            badwords: [...(cfg.default_badwords || [])]
        };
        saveDB(db);
    }
    return db.groups[groupId];
}

// ================= LAPORAN OTOMATIS KE WA PRIBADI OWNER =================
async function sendOwnerLog(sock, groupName, actionTitle, targetNum, detail) {
    if (!db.global.dmLog) return;
    try {
        const waktu = new Date().toLocaleString('id-ID', { timeZone: cfg.bot.timezone || 'Asia/Jakarta' });
        const logText = `🛡️ *ARVX 588 SECURITY LOG*\n━━━━━━━━━━━━━━━━━━━━\n• *Grup:* ${groupName}\n• *Tindakan:* ${actionTitle}\n• *Target:* +${targetNum}\n• *Detail:* ${detail}\n• *Waktu:* ${waktu} WIB`;
        await sock.sendMessage(OWNER_JID, { text: logText });
    } catch (err) {
        console.error('Gagal mengirim log ke Owner:', err.message);
    }
}

// ================= TEMPLATE INTRO CARD ARVX 588 =================
const INTRO_CARD_TEXT = `『  𝐈𝐍𝐓𝐑𝐎 𝐂𝐀𝐑𝐃 — 𝐀𝐑𝐕𝐗 588  』

Welcome to ARVX 588.

━━━━━━━━━━━━━━
Nama :
Umur :
Gender :
Asal :
Tag admin :
━━━━━━━━━━━━━━
📸 Kirim poto 1× liat ( bebas)
nih yg baru masuk link grupnya : ${GROUP_LINK}`;

// ================= HELPER MEDIA & STIKER (SHARP 0.35.5 + WEBPMUX) =================
async function downloadMedia(message, type) {
    const stream = await downloadContentFromMessage(message, type);
    let buffer = Buffer.from([]);
    for await (const chunk of stream) {
        buffer = Buffer.concat([buffer, chunk]);
    }
    return buffer;
}

async function createSticker(imageBuffer, packname = 'ARVX 588', author = 'Defense Bot') {
    const webpBuffer = await sharp(imageBuffer, { failOn: 'error' })
        .resize(512, 512, {
            fit: 'contain',
            background: { r: 0, g: 0, b: 0, alpha: 0 }
        })
        .webp({ quality: 80 })
        .toBuffer();

    const img = new webp.Image();
    await img.load(webpBuffer);

    const exifAttr = Buffer.from([
        0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00,
        0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x16, 0x00, 0x00, 0x00
    ]);
    const jsonPayload = JSON.stringify({
        'sticker-pack-id': 'com.arvx588.defense',
        'sticker-pack-name': packname,
        'sticker-pack-publisher': author,
        'emojis': ['🛡️', '🔥']
    });
    const jsonBuffer = Buffer.from(jsonPayload, 'utf-8');
    const exif = Buffer.concat([exifAttr, jsonBuffer]);
    exif.writeUIntLE(jsonBuffer.length, 14, 4);

    img.exif = exif;
    return await img.save(null);
}

// ================= HELPER EKSEKUSI PELANGGARAN & WARN =================
async function handleViolation(sock, groupId, groupName, senderJid, senderNumber, msgKey, reason, isBotAdmin, instantKick = false) {
    if (isBotAdmin && msgKey) {
        try {
            await sock.sendMessage(groupId, { delete: msgKey });
        } catch {}
    }

    if (!db.warns[groupId]) db.warns[groupId] = {};
    if (!db.warns[groupId][senderNumber]) db.warns[groupId][senderNumber] = 0;

    const maxWarn = cfg.thresholds.max_warn || 3;

    if (instantKick) {
        if (isBotAdmin) {
            await sock.sendMessage(groupId, {
                text: `🚨 *ARVX DEFENSE — EKSEKUSI SEKETIKA*\n👤 *Target:* @${senderNumber}\n⚠️ *Pelanggaran Berat:* ${reason}\n🔨 *Status:* Dikeluarkan otomatis dari grup.`,
                mentions: [senderJid]
            });
            await sock.groupParticipantsUpdate(groupId, [senderJid], 'remove');
            await sendOwnerLog(sock, groupName, 'INSTANT KICK', senderNumber, reason);
        }
        return;
    }

    db.warns[groupId][senderNumber] += 1;
    const currentWarn = db.warns[groupId][senderNumber];
    saveDB(db);

    if (currentWarn >= maxWarn) {
        db.warns[groupId][senderNumber] = 0;
        saveDB(db);
        if (isBotAdmin) {
            await sock.sendMessage(groupId, {
                text: `⛔ *BATAS PERINGATAN TERLAMPAUI (${maxWarn}/${maxWarn})*\n👤 *Member:* @${senderNumber}\n📌 *Pelanggaran Terakhir:* ${reason}\n🔨 *Tindakan:* Auto-Kick oleh Sistem Pertahanan ARVX 588.`,
                mentions: [senderJid]
            });
            await sock.groupParticipantsUpdate(groupId, [senderJid], 'remove');
            await sendOwnerLog(sock, groupName, `AUTO-KICK (${maxWarn}/${maxWarn} WARN)`, senderNumber, reason);
        } else {
            await sock.sendMessage(groupId, {
                text: `⚠️ @${senderNumber} telah mencapai *${maxWarn}/${maxWarn} Peringatan* (${reason}), namun bot belum menjadi Admin untuk mengeluarkan member.`,
                mentions: [senderJid]
            });
        }
    } else {
        await sock.sendMessage(groupId, {
            text: `🛡️ *ARVX DEFENSE WARNING (${currentWarn}/${maxWarn})*\n👤 *Member:* @${senderNumber}\n⚠️ *Alasan:* ${reason}\n_Peringatan ke-${maxWarn} akan otomatis mengeluarkan Anda dari grup._`,
            mentions: [senderJid]
        });
        await sendOwnerLog(sock, groupName, `WARNING (${currentWarn}/${maxWarn})`, senderNumber, reason);
    }
}

// ================= KONEKSI UTAMA BAILEYS V7 =================
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('./session');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger)
        },
        msgRetryCounterCache,
        cachedGroupMetadata: async (jid) => groupCache.get(jid),
        generateHighQualityLinkPreview: false,
        syncFullHistory: false,
        markOnlineOnConnect: true
    });

    if (USE_PAIRING_CODE && !sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(BOT_NUMBER);
                console.log(`\n========================================`);
                console.log(`🔑 KODE PAIRING WA (${BOT_NUMBER}): ${code}`);
                console.log(`Masukkan kode ini di HP Bot -> Perangkat Tertaut`);
                console.log(`========================================\n`);
            } catch (err) {
                console.error('Gagal meminta Pairing Code:', err);
            }
        }, 3000);
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                setTimeout(startBot, 3000);
            } else {
                console.log('Sesi logout. Hapus folder ./session dan jalankan ulang.');
            }
        } else if (connection === 'open') {
            console.log(`✅ Bot Ultimate Defense ARVX 588 aktif sebagai ${BOT_NUMBER}!`);
        }
    });

    // Penjadwalan Pengecekan Auto-Kick Member Belum Intro (Setiap 30 menit)
    setInterval(async () => {
        const now = Date.now();
        const limitMs = (cfg.group.intro_timeout_hours || 24) * 60 * 60 * 1000;

for (const [groupId, pendingUsers] of Object.entries(db.pendingIntros)) {
const settings = getGroupSettings(groupId);
if (!settings.autokickintro) continue;
for (const [userNum, joinedAt] of Object.entries(pendingUsers)) {
if (db.intros[groupId]?.[userNum]) {
delete db.pendingIntros[groupId][userNum];
saveDB(db);
continue;
}
if (now - joinedAt >= limitMs) {
const targetJid = ${userNum}@s.whatsapp.net;
try {
const meta = groupCache.get(groupId) || await sock.groupMetadata(groupId);
await sock.sendMessage(groupId, {
text: ⏰ *WAKTU INTRO HABIS (${cfg.group.intro_timeout_hours} JAM)*\nMaaf @${userNum}, Anda belum mengisi *Intro Card ARVX 588*. Sistem mengeluarkan Anda secara otomatis.,
mentions: [targetJid]
});
await sock.groupParticipantsUpdate(groupId, [targetJid], 'remove');
await sendOwnerLog(sock, meta.subject || groupId, 'AUTO-KICK BELUM INTRO', userNum, Tidak mengisi intro dalam ${cfg.group.intro_timeout_hours} jam);
} catch {}
delete db.pendingIntros[groupId][userNum];
saveDB(db);
}
}
}
}, 30 * 60 * 1000);
// Update Cache Metadata Grup
sock.ev.on('groups.update', async ([event]) => {
if (!event?.id) return;
try {
const metadata = await sock.groupMetadata(event.id);
groupCache.set(event.id, metadata);
} catch {}
});
// Event Member Masuk / Keluar Grup (Blacklist Guard + Anti-Raid + Welcome Intro)
sock.ev.on('group-participants.update', async (anu) => {
const groupId = anu.id;
const settings = getGroupSettings(groupId);
try {
const metadata = await sock.groupMetadata(groupId);
groupCache.set(groupId, metadata);
const groupName = metadata.subject || 'ARVX 588';
const botIdClean = sock.user.id.split(':') + '@s.whatsapp.net';
const isBotAdmin = metadata.participants.some(p => (p.id === botIdClean || p.id.startsWith(BOT_NUMBER)) && (p.admin === 'admin' || p.admin === 'superadmin'));
if (anu.action === 'add') {
// 1. Cek Anti-Raid (Banyak akun masuk serentak dalam 10 detik)
if (settings.antiraid && isBotAdmin) {
const currentJoins = (raidTracker.get(groupId) || 0) + anu.participants.length;
raidTracker.set(groupId, currentJoins);
if (currentJoins >= (cfg.thresholds.raid_max_joins || 5) && !settings.lockdown) {
settings.lockdown = true;
saveDB(db);
await sock.groupSettingUpdate(groupId, 'announcement');
await sock.sendMessage(groupId, {
text: 🚨 *ANTI-RAID AKTIF — LOCKDOWN OTOMATIS!*\nTerdeteksi lonjakan member masuk secara bersamaan. Grup dikunci otomatis demi keamanan. Admin dapat membuka kembali dengan *${PREFIX}lockdown off*.
});
await sendOwnerLog(sock, groupName, 'ANTI-RAID LOCKDOWN', 'Sistem', ${currentJoins} akun masuk dalam 10 detik);
}
}
for (const participant of anu.participants) {
const userNum = participant.split('@').split(':');
// 2. Cek Blacklist Permanen (Langsung Kick jika masuk daftar Ban!)
if (db.blacklist[groupId]?.[userNum]) {
const banReason = db.blacklist[groupId][userNum].reason || 'Masuk daftar Blacklist Permanen';
if (isBotAdmin) {
await sock.sendMessage(groupId, {
text: ⛔ *BLACKLIST GUARD*\nNomor @${userNum} telah diblokir permanen dari grup ini.\n*Alasan:* ${banReason},
mentions: [participant]
});
await sock.groupParticipantsUpdate(groupId, [participant], 'remove');
await sendOwnerLog(sock, groupName, 'BLACKLIST AUTO-KICK', userNum, Mencoba masuk kembali (${banReason}));
}
continue;
}
// 3. Catat waktu masuk untuk pantauan Intro
if (!db.pendingIntros[groupId]) db.pendingIntros[groupId] = {};
db.pendingIntros[groupId][userNum] = Date.now();
saveDB(db);
// 4. Kirim Kartu Intro ARVX 588
if (settings.welcome) {
const welcomeMsg = Halo @${userNum}! 👋\nSilakan salin & isi form di bawah ini ya:\n\n${INTRO_CARD_TEXT};
await sock.sendMessage(groupId, {
text: welcomeMsg,
mentions: [participant]
});
}
}
} else if (anu.action === 'remove') {
for (const participant of anu.participants) {
const userNum = participant.split('@').split(':');
if (db.pendingIntros[groupId]?.[userNum]) {
delete db.pendingIntros[groupId][userNum];
saveDB(db);
}
}
}
} catch (err) {
console.error('Error group-participants.update:', err);
}
});
// ================= HANDLER PESAN, ANTI-DELETE, & PERTAHANAN =================
sock.ev.on('messages.upsert', async ({ messages, type }) => {
if (type !== 'notify') return;
const m = messages;
if (!m?.message) return;
const from = m.key.remoteJid;
const isGroup = from.endsWith('@g.us');
// Deteksi Anti-Delete (ProtocolMessage type 0 = REVOKE)
if (isGroup && m.message.protocolMessage?.type === 0) {
const settings = getGroupSettings(from);
if (settings.antidelete) {
const deletedId = m.message.protocolMessage.key?.id;
const cachedMsg = messageStore.get(deletedId);
if (cachedMsg && !cachedMsg.isAdmin) {
await sock.sendMessage(from, {
text: 👁️ *ANTI-DELETE TERDETEKSI*\n👤 *Pengirim:* @${cachedMsg.senderNumber}\n💬 *Isi Pesan yang Dihapus:*\n"${cachedMsg.text}",
mentions: [cachedMsg.sender]
});
}
}
return;
}
if (m.key.fromMe) return;
const sender = isGroup ? (m.key.participant || m.participant) : from;
const senderNumber = sender.split('@').split(':');
const isOwner = senderNumber === OWNER_NUMBER || sender === OWNER_JID;
const body =
m.message.conversation ||
m.message.extendedTextMessage?.text ||
m.message.imageMessage?.caption ||
m.message.videoMessage?.caption ||
'';
let groupMetadata = null;
let groupName = 'ARVX 588';
let isAdmin = false;
let isBotAdmin = false;
if (isGroup) {
groupMetadata = groupCache.get(from);
if (!groupMetadata) {
groupMetadata = await sock.groupMetadata(from);
groupCache.set(from, groupMetadata);
}
groupName = groupMetadata.subject || 'ARVX 588';
const botIdClean = sock.user.id.split(':') + '@s.whatsapp.net';
const participants = groupMetadata.participants || [];
isAdmin = participants.some(p => (p.id === sender || p.jid === sender) && (p.admin === 'admin' || p.admin === 'superadmin'));
isBotAdmin = participants.some(p => (p.id === botIdClean || p.id.startsWith(BOT_NUMBER)) && (p.admin === 'admin' || p.admin === 'superadmin'));
// Simpan pesan teks ke cache Anti-Delete
if (body && m.key.id) {
messageStore.set(m.key.id, {
sender,
senderNumber,
text: body,
isAdmin: isAdmin || isOwner
});
}
}
// ================= PERISAI PERTAHANAN OTOMATIS (NON-ADMIN & NON-OWNER) =================
if (isGroup && !isAdmin && !isOwner) {
const settings = getGroupSettings(from);
// Lapis 1: Anti-Virtex / Bug Crash Text
if (settings.antivirtex && body.length > (cfg.thresholds.virtex_max_chars || 3500)) {
await handleViolation(sock, from, groupName, sender, senderNumber, m.key, 'Mengirim Pesan Virtex / Teks Crash Raksasa', isBotAdmin, true);
return;
}
// Lapis 2: Anti-Spam / Anti-Flood
if (settings.antispam) {
const spamKey = ${from}_${senderNumber};
const count = (spamTracker.get(spamKey) || 0) + 1;
spamTracker.set(spamKey, count);
if (count > (cfg.thresholds.spam_max_messages || 5)) {
spamTracker.del(spamKey);
await handleViolation(sock, from, groupName, sender, senderNumber, m.key, 'Spam / Flooding Chat Berlebihan', isBotAdmin, false);
return;
}
}
// Lapis 3: Anti-Link Grup WA, Channel, Telegram, & Tautan Luar
if (settings.antilink) {
const linkRegex = /(whatsapp.com|whatsapp.com|t.me/|telegram.me/|discord.gg/|https?://)/i;
if (linkRegex.test(body) && !body.includes(WHITELIST_CODE)) {
await handleViolation(sock, from, groupName, sender, senderNumber, m.key, 'Mengirim Tautan / Promosi Luar Tanpa Izin', isBotAdmin, false);
return;
}
}
// Lapis 4: Anti-TagAll / Hidetag Liar
const mentionedJids = m.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
if (settings.antitag && mentionedJids.length > (cfg.thresholds.max_mentions || 5)) {
await handleViolation(sock, from, groupName, sender, senderNumber, m.key, 'Melakukan Tag Massal / Hidetag Tanpa Izin Admin', isBotAdmin, false);
return;
}
// Lapis 5: Anti-Toxic & Badword Filter
if (settings.antitoxic && body.length > 0) {
const lowerBody = body.toLowerCase();
const foundBadword = settings.badwords.find(word => {
const regex = new RegExp(\\b${word}\\b, 'i');
return regex.test(lowerBody);
});
if (foundBadword) {
await handleViolation(sock, from, groupName, sender, senderNumber, m.key, Menggunakan Kata Terlarang ("${foundBadword}"), isBotAdmin, false);
return;
}
}
}
// ================= DETEKSI PENGISIAN INTRO CARD ARVX 588 =================
if (isGroup && body.includes('𝐈𝐍𝐓𝐑𝐎 𝐂𝐀𝐑𝐃') && body.includes('Nama :')) {
const nama = body.match(/Nama\s*:\s*(.+)/i)?.?.trim() || '';
const umur = body.match(/Umur\s*:\s*(.+)/i)?.?.trim() || '';
const gender = body.match(/Gender\s*:\s*(.+)/i)?.?.trim() || '';
const asal = body.match(/Asal\s*:\s*(.+)/i)?.?.trim() || '';
if (!nama || !umur || !gender || !asal) {
await sock.sendMessage(from, {
text: ⚠️ @${senderNumber}, form intro kamu belum lengkap! Pastikan *Nama, Umur, Gender, dan Asal* sudah diisi semua ya.,
mentions: [sender]
}, { quoted: m });
} else {
if (!db.intros[from]) db.intros[from] = {};
db.intros[from][senderNumber] = {
nama,
umur,
gender,
asal,
waktu: new Date().toLocaleString('id-ID', { timeZone: cfg.bot.timezone || 'Asia/Jakarta' })
};
if (db.pendingIntros[from]?.[senderNumber]) {
delete db.pendingIntros[from][senderNumber];
}
saveDB(db);
await sock.sendMessage(from, {
text: ✅ *INTRO DITERIMA — ARVX 588*\n\n• *Nama:* ${nama}\n• *Umur:* ${umur}\n• *Gender:* ${gender}\n• *Asal:* ${asal}\n\nSelamat bergabung resmi di grup, @${senderNumber}! Jangan lupa kirim foto 1× lihat kalau belum ya 📸,
mentions: [sender]
}, { quoted: m });
}
return;
}
// ================= COMMAND HANDLER =================
if (!body.startsWith(PREFIX)) return;
const args = body.slice(PREFIX.length).trim().split(/\s+/);
const command = args.shift().toLowerCase();
const text = args.join(' ');
switch (command) {
case 'menu':
case 'help': {
const menuText = `╭━━━『 ARVX 588 ULTIMATE BOT 』━━━╮
│ 👤 User: @${senderNumber}
│ 👑 Owner: +${OWNER_NUMBER}
╰━━━━━━━━━━━━━━━━━━━━━━━━━╯
📋 FITUR INTRO & MEMBER
• ${PREFIX}intro — Tampilkan kartu intro ARVX 588
• ${PREFIX}listintro — Daftar member yang sudah intro
• ${PREFIX}cekintro — Cek member baru yang belum intro
• ${PREFIX}linkgrup — Ambil link resmi grup ARVX 588
🛠️ FITUR MEDIA & UTILITAS
• ${PREFIX}s / ${PREFIX}stiker — Ubah gambar jadi stiker HD
• ${PREFIX}rvo — Buka ulang foto/video 1× lihat (reply pesan)
• ${PREFIX}cekweb  — Cek judul & deskripsi link web
🛡️ PERTAHANAN MUTAKHIR (KHUSUS ADMIN)
• ${PREFIX}defense — Panel status semua perisai & log
• ${PREFIX}lockdown on/off — Mode darurat (kunci grup + full perisai)
• ${PREFIX}ban @user [alasan] — Kick & Blacklist permanen
• ${PREFIX}unban  — Hapus nomor dari daftar blacklist
• ${PREFIX}listban — Lihat daftar nomor yang di-blacklist
• ${PREFIX}warn @user — Beri peringatan manual (3× = Kick)
• ${PREFIX}resetwarn @user — Reset peringatan member ke 0
• ${PREFIX}kickunverified — Keluarkan semua member baru yang belum intro
⚙️ PENGATURAN PERISAI OTOMATIS (ADMIN)
• ${PREFIX}antilink on/off — Anti-tautan luar
• ${PREFIX}antispam on/off — Anti-flood chat
• ${PREFIX}antivirtex on/off — Anti-teks crash/virtex
• ${PREFIX}antitoxic on/off — Filter kata terlarang
• ${PREFIX}antitag on/off — Anti-tag massal liar
• ${PREFIX}antidelete on/off — Tangkap pesan yang dihapus
• ${PREFIX}antiraid on/off — Auto-lockdown jika diserbu akun serentak
• ${PREFIX}autokickintro on/off — Auto-kick belum intro >24 jam
• ${PREFIX}dmlog on/off — Laporan keamanan ke WA pribadi Owner
• ${PREFIX}addword / ${PREFIX}delword  — Kelola daftar kata terlarang
👮 KONTROL GRUP (KHUSUS ADMIN)
• ${PREFIX}hidetag  — Tag semua tanpa terlihat
• ${PREFIX}tagall  — Tag semua anggota grup
• ${PREFIX}kick / ${PREFIX}promote / ${PREFIX}demote @user
• ${PREFIX}grup buka / tutup — Buka atau kunci chat grup`;
await sock.sendMessage(from, { text: menuText, mentions: [sender] }, { quoted: m });
break;
}
// ================= PANEL PERTAHANAN & BLACKLIST =================
case 'defense':
case 'pertahanan': {
if (!isGroup) return;
if (!isAdmin && !isOwner) return sock.sendMessage(from, { text: '❌ Khusus Admin Grup!' }, { quoted: m });
const s = getGroupSettings(from);
const icon = (v) => v ? '🟢 ON' : '🔴 OFF';
const banCount = Object.keys(db.blacklist[from] || {}).length;
const panel = `🛡️ ARVX 588 — ULTIMATE DEFENSE PANEL
• Mode Lockdown: ${icon(s.lockdown)}
• DM Log ke Owner: ${icon(db.global.dmLog)}
• Auto-Welcome Intro: ${icon(s.welcome)}
• Anti-Link Universal: ${icon(s.antilink)}
• Anti-Spam / Flood: ${icon(s.antispam)}
• Anti-Virtex / Bug: ${icon(s.antivirtex)}
• Anti-Toxic (${s.badwords.length} kata): ${icon(s.antitoxic)}
• Anti-Tag Massal: ${icon(s.antitag)}
• Anti-Raid Serbuan: ${icon(s.antiraid)}
• Anti-Delete Pesan: ${icon(s.antidelete)}
• Auto-Kick Belum Intro (24j): ${icon(s.autokickintro)}
• Total Blacklist Permanen: ${banCount} nomor
Ketik ${PREFIX}<nama_fitur> on/off untuk mengatur secara manual.`;
await sock.sendMessage(from, { text: panel }, { quoted: m });
break;
}
case 'dmlog': {
if (!isOwner && !isAdmin) return sock.sendMessage(from, { text: '❌ Khusus Owner/Admin!' }, { quoted: m });
if (text === 'on') {
db.global.dmLog = true;
saveDB(db);
await sock.sendMessage(from, { text: ✅ Laporan keamanan otomatis ke WA Owner (+${OWNER_NUMBER}) *DIAKTIFKAN*. }, { quoted: m });
} else if (text === 'off') {
db.global.dmLog = false;
saveDB(db);
await sock.sendMessage(from, { text: '⚠️ Laporan keamanan otomatis ke WA Owner DINONAKTIFKAN.' }, { quoted: m });
} else {
await sock.sendMessage(from, { text: Status DM Log: ${db.global.dmLog ? '🟢 ON' : '🔴 OFF'} }, { quoted: m });
}
break;
}
case 'ban': {
if (!isGroup) return;
if (!isAdmin && !isOwner) return sock.sendMessage(from, { text: '❌ Khusus Admin Grup!' }, { quoted: m });
if (!isBotAdmin) return sock.sendMessage(from, { text: '❌ Jadikan bot Admin terlebih dahulu!' }, { quoted: m });
const mentioned = m.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
const quotedUser = m.message.extendedTextMessage?.contextInfo?.participant;
const target = mentioned || quotedUser;
if (!target) return sock.sendMessage(from, { text: Tag atau balas pesan member! Contoh: *${PREFIX}ban @user Rusuh* }, { quoted: m });
const targetNum = target.split('@').split(':');
if (targetNum === OWNER_NUMBER) return sock.sendMessage(from, { text: '❌ Tidak bisa memblokir Owner!' }, { quoted: m });
const reason = text.replace(/@\d+/g, '').trim() || 'Diblokir permanen oleh Admin';
if (!db.blacklist[from]) db.blacklist[from] = {};
db.blacklist[from][targetNum] = {
reason,
by: senderNumber,
date: new Date().toLocaleString('id-ID', { timeZone: cfg.bot.timezone || 'Asia/Jakarta' })
};
saveDB(db);
await sock.sendMessage(from, {
text: 🔨 *BLACKLIST PERMANEN*\n👤 *Target:* @${targetNum}\n📌 *Alasan:* ${reason}\n_Nomor ini tidak akan bisa masuk kembali ke grup ini._,
mentions: [target]
});
await sock.groupParticipantsUpdate(from, [target], 'remove');
await sendOwnerLog(sock, groupName, 'MANUAL BAN (BLACKLIST)', targetNum, Oleh +${senderNumber} | Alasan: ${reason});
break;
}
case 'unban': {
if (!isGroup) return;
if (!isAdmin && !isOwner) return sock.sendMessage(from, { text: '❌ Khusus Admin Grup!' }, { quoted: m });
const cleanNum = text.replace(/[^0-9]/g, '');
if (!cleanNum) return sock.sendMessage(from, { text: Masukkan nomor yang ingin di-unban! Contoh: *${PREFIX}unban 628123456789* }, { quoted: m });
if (db.blacklist[from]?.[cleanNum]) {
delete db.blacklist[from][cleanNum];
saveDB(db);
await sock.sendMessage(from, { text: ✅ Nomor *+${cleanNum}* telah dihapus dari daftar Blacklist grup ini. }, { quoted: m });
await sendOwnerLog(sock, groupName, 'UNBAN BLACKLIST', cleanNum, Dihapus oleh +${senderNumber});
} else {
await sock.sendMessage(from, { text: Nomor *+${cleanNum}* tidak ditemukan di daftar Blacklist. }, { quoted: m });
}
break;
}
case 'listban': {
if (!isGroup) return;
if (!isAdmin && !isOwner) return sock.sendMessage(from, { text: '❌ Khusus Admin Grup!' }, { quoted: m });
const bans = Object.entries(db.blacklist[from] || {});
if (bans.length === 0) return sock.sendMessage(from, { text: '✅ Daftar Blacklist grup ini kosong.' }, { quoted: m });
let txt = 🚫 *DAFTAR BLACKLIST PERMANEN — ${groupName} (${bans.length})*\n\n;
bans.forEach(([num, info], i) => {
txt += ${i + 1}. *+${num}* — _${info.reason}_ (${info.date})\n;
});
await sock.sendMessage(from, { text: txt }, { quoted: m });
break;
}
case 'lockdown': {
if (!isGroup) return;
if (!isAdmin && !isOwner) return sock.sendMessage(from, { text: '❌ Khusus Admin Grup!' }, { quoted: m });
if (!isBotAdmin) return sock.sendMessage(from, { text: '❌ Jadikan bot Admin terlebih dahulu!' }, { quoted: m });
const s = getGroupSettings(from);
if (text === 'on') {
s.lockdown = true;
s.antilink = true;
s.antispam = true;
s.antivirtex = true;
s.antitoxic = true;
s.antitag = true;
s.antiraid = true;
saveDB(db);
await sock.groupSettingUpdate(from, 'announcement');
await sock.sendMessage(from, {
text: '🚨 MODE LOCKDOWN DIAKTIFKAN!\nGrup dikunci (hanya admin yang bisa chat) dan seluruh sistem pertahanan telah disetel ke level maksimum.'
});
await sendOwnerLog(sock, groupName, 'MODE LOCKDOWN ON', 'Grup', Diaktifkan manual oleh +${senderNumber});
} else if (text === 'off') {
s.lockdown = false;
saveDB(db);
await sock.groupSettingUpdate(from, 'not_announcement');
await sock.sendMessage(from, { text: '✅ MODE LOCKDOWN DINONAKTIFKAN.\nGrup dibuka kembali untuk seluruh member.' });
await sendOwnerLog(sock, groupName, 'MODE LOCKDOWN OFF', 'Grup', Dinonaktifkan manual oleh +${senderNumber});
} else {
await sock.sendMessage(from, { text: Gunakan: *${PREFIX}lockdown on* atau *${PREFIX}lockdown off* }, { quoted: m });
}
break;
}
case 'antilink':
case 'antispam':
case 'antivirtex':
case 'antitoxic':
case 'antitag':
case 'antiraid':
case 'antidelete':
case 'autokickintro':
case 'welcome': {
if (!isGroup) return;
if (!isAdmin && !isOwner) return sock.sendMessage(from, { text: '❌ Khusus Admin Grup!' }, { quoted: m });
const s = getGroupSettings(from);
if (text === 'on') {
s[command] = true;
saveDB(db);
await sock.sendMessage(from, { text: 🛡️ Pertahanan *${command}* berhasil *DIAKTIFKAN*. }, { quoted: m });
} else if (text === 'off') {
s[command] = false;
saveDB(db);
await sock.sendMessage(from, { text: ⚠️ Pertahanan *${command}* telah *DINONAKTIFKAN*. }, { quoted: m });
} else {
await sock.sendMessage(from, { text: Status *${command}*: ${s[command] ? '🟢 ON' : '🔴 OFF'}\nUbah: *${PREFIX}${command} on/off* }, { quoted: m });
}
break;
}
case 'addword': {
if (!isGroup) return;
if (!isAdmin && !isOwner) return sock.sendMessage(from, { text: '❌ Khusus Admin Grup!' }, { quoted: m });
if (!text) return sock.sendMessage(from, { text: Contoh: *${PREFIX}addword kasar* }, { quoted: m });
const s = getGroupSettings(from);
const word = text.toLowerCase().trim();
if (!s.badwords.includes(word)) {
s.badwords.push(word);
saveDB(db);
}
await sock.sendMessage(from, { text: ✅ Kata *"${word}"* ditambahkan ke filter Anti-Toxic. }, { quoted: m });
break;
}
case 'delword': {
if (!isGroup) return;
if (!isAdmin && !isOwner) return sock.sendMessage(from, { text: '❌ Khusus Admin Grup!' }, { quoted: m });
if (!text) return sock.sendMessage(from, { text: Contoh: *${PREFIX}delword kasar* }, { quoted: m });
const s = getGroupSettings(from);
const word = text.toLowerCase().trim();
s.badwords = s.badwords.filter(w => w !== word);
saveDB(db);
await sock.sendMessage(from, { text: ✅ Kata *"${word}"* dihapus dari filter Anti-Toxic. }, { quoted: m });
break;
}
case 'warn': {
if (!isGroup) return;
if (!isAdmin && !isOwner) return sock.sendMessage(from, { text: '❌ Khusus Admin Grup!' }, { quoted: m });
const mentioned = m.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
const quotedUser = m.message.extendedTextMessage?.contextInfo?.participant;
const target = mentioned || quotedUser;
if (!target) return sock.sendMessage(from, { text: 'Tag atau balas pesan member yang ingin diberi peringatan.' }, { quoted: m });
const targetNum = target.split('@').split(':');
await handleViolation(sock, from, groupName, target, targetNum, null, Peringatan Manual oleh Admin (+${senderNumber}), isBotAdmin, false);
break;
}
case 'resetwarn': {
if (!isGroup) return;
if (!isAdmin && !isOwner) return sock.sendMessage(from, { text: '❌ Khusus Admin Grup!' }, { quoted: m });
const mentioned = m.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
const quotedUser = m.message.extendedTextMessage?.contextInfo?.participant;
const target = mentioned || quotedUser;
if (!target) return sock.sendMessage(from, { text: 'Tag atau balas pesan member.' }, { quoted: m });
const targetNum = target.split('@').split(':');
if (db.warns[from]) db.warns[from][targetNum] = 0;
saveDB(db);
await sock.sendMessage(from, {
text: ✅ Peringatan untuk @${targetNum} telah di-reset menjadi *0/${cfg.thresholds.max_warn || 3}*.,
mentions: [target]
}, { quoted: m });
break;
}
case 'kickunverified': {
if (!isGroup) return;
if (!isAdmin && !isOwner) return sock.sendMessage(from, { text: '❌ Khusus Admin Grup!' }, { quoted: m });
if (!isBotAdmin) return sock.sendMessage(from, { text: '❌ Jadikan bot Admin terlebih dahulu!' }, { quoted: m });
const pending = db.pendingIntros[from] || {};
const unverified = Object.keys(pending).filter(num => !db.intros[from]?.[num]);
if (unverified.length === 0) return sock.sendMessage(from, { text: '✅ Tidak ada member baru yang belum intro.' }, { quoted: m });
const targets = unverified.map(num => ${num}@s.whatsapp.net);
await sock.sendMessage(from, {
text: 🧹 *PEMBERSIHAN MEMBER BELUM INTRO*\nMengeluarkan ${targets.length} member yang belum mengisi kartu intro ARVX 588...,
mentions: targets
});
await sock.groupParticipantsUpdate(from, targets, 'remove');
unverified.forEach(num => delete db.pendingIntros[from][num]);
saveDB(db);
await sendOwnerLog(sock, groupName, 'KICK UNVERIFIED INTRO', ${targets.length} Member, Pembersihan manual oleh +${senderNumber});
break;
}
// ================= FITUR INTRO & UTILITAS =================
case 'intro': {
await sock.sendMessage(from, { text: INTRO_CARD_TEXT }, { quoted: m });
break;
}
case 'linkgrup': {
await sock.sendMessage(from, { text: 🔗 *Link Resmi Grup ARVX 588:*\n${GROUP_LINK} }, { quoted: m });
break;
}
case 'listintro': {
if (!isGroup) return;
const list = db.intros[from] || {};
const entries = Object.entries(list);
if (entries.length === 0) return sock.sendMessage(from, { text: 'Belum ada data member yang mengisi kartu intro.' }, { quoted: m });
let teks = 📑 *DAFTAR MEMBER INTRO — ARVX 588 (${entries.length})*\n\n;
entries.forEach(([num, info], idx) => {
teks += ${idx + 1}. *${info.nama}* (${info.umur} th / ${info.gender}) — ${info.asal} [@${num}]\n;
});
await sock.sendMessage(from, {
text: teks,
mentions: entries.map(([num]) => ${num}@s.whatsapp.net)
}, { quoted: m });
break;
}
case 'cekintro': {
if (!isGroup) return;
if (!isAdmin && !isOwner) return sock.sendMessage(from, { text: '❌ Khusus Admin Grup!' }, { quoted: m });
const pending = db.pendingIntros[from] || {};
const unverified = Object.keys(pending).filter(num => !db.intros[from]?.[num]);
if (unverified.length === 0) return sock.sendMessage(from, { text: '✅ Semua member baru yang tercatat sudah mengisi kartu intro!' }, { quoted: m });
let teks = ⏳ *MEMBER BARU BELUM INTRO (${unverified.length}):*\n\n;
unverified.forEach((num, i) => { teks += ${i + 1}. @${num}\n; });
teks += \n_Admin dapat mengetik *${PREFIX}kickunverified* untuk mengeluarkan semua sekaligus._;
await sock.sendMessage(from, {
text: teks,
mentions: unverified.map(num => ${num}@s.whatsapp.net)
}, { quoted: m });
break;
}
case 's':
case 'stiker':
case 'sticker': {
const quoted = m.message.extendedTextMessage?.contextInfo?.quotedMessage;
const targetImg = m.message.imageMessage || quoted?.imageMessage;
if (!targetImg) return sock.sendMessage(from, { text: Kirim atau balas gambar dengan perintah *${PREFIX}s* }, { quoted: m });
try {
const buffer = await downloadMedia(targetImg, 'image');
const detected = await fileTypeFromBuffer(buffer);
if (!detected || !detected.mime.startsWith('image/')) return sock.sendMessage(from, { text: 'Format file tidak didukung.' }, { quoted: m });
const stickerBuf = await createSticker(buffer, 'ARVX 588', 'ARVX Defense');
await sock.sendMessage(from, { sticker: stickerBuf }, { quoted: m });
} catch {
await sock.sendMessage(from, { text: 'Gagal membuat stiker.' }, { quoted: m });
}
break;
}
case 'rvo':
case 'readviewonce': {
const quoted = m.message.extendedTextMessage?.contextInfo?.quotedMessage;
const viewOnceMsg = quoted?.viewOnceMessageV2?.message || quoted?.viewOnceMessage?.message || quoted;
const imgMsg = viewOnceMsg?.imageMessage;
const vidMsg = viewOnceMsg?.videoMessage;
if (!imgMsg && !vidMsg) return sock.sendMessage(from, { text: Balas pesan foto/video 1× lihat dengan *${PREFIX}rvo* }, { quoted: m });
try {
if (imgMsg) {
const buf = await downloadMedia(imgMsg, 'image');
await sock.sendMessage(from, { image: buf, caption: imgMsg.caption || '📸 Media 1× lihat dibuka' }, { quoted: m });
} else if (vidMsg) {
const buf = await downloadMedia(vidMsg, 'video');
await sock.sendMessage(from, { video: buf, caption: vidMsg.caption || '🎥 Video 1× lihat dibuka' }, { quoted: m });
}
} catch {
await sock.sendMessage(from, { text: 'Gagal membuka media 1× lihat.' }, { quoted: m });
}
break;
}
case 'cekweb': {
if (!text || !text.startsWith('http')) return sock.sendMessage(from, { text: Contoh: *${PREFIX}cekweb https://github.com* }, { quoted: m });
try {
const res = await axios.get(text, { timeout: 8000 });
const $ = cheerio.load(res.data);
const title = $('title').text().trim() || 'Tanpa Judul';
const desc = $('meta[name="description"]').attr('content') || 'Tidak ada deskripsi.';
await sock.sendMessage(from, { text: 🌐 *INFO TAUTAN*\n• *Judul:* ${title}\n• *Deskripsi:* ${desc} }, { quoted: m });
} catch {
await sock.sendMessage(from, { text: 'Gagal mengambil informasi dari URL tersebut.' }, { quoted: m });
}
break;
}
// ================= KONTROL ADMIN GRUP =================
case 'hidetag': {
if (!isGroup) return;
if (!isAdmin && !isOwner) return sock.sendMessage(from, { text: '❌ Khusus Admin Grup!' }, { quoted: m });
const members = groupMetadata.participants.map(p => p.id);
await sock.sendMessage(from, { text: text || '📢 Pengumuman Admin ARVX 588', mentions: members });
break;
}
case 'tagall': {
if (!isGroup) return;
if (!isAdmin && !isOwner) return sock.sendMessage(from, { text: '❌ Khusus Admin Grup!' }, { quoted: m });
const members = groupMetadata.participants.map(p => p.id);
let tagText = 📢 *TAG ALL — ARVX 588*\nPesan: ${text || '-'}\n\n;
members.forEach((jid) => { tagText += • @${jid.split('@')}\n; });
await sock.sendMessage(from, { text: tagText, mentions: members }, { quoted: m });
break;
}
case 'kick': {
if (!isGroup) return;
if (!isAdmin && !isOwner) return sock.sendMessage(from, { text: '❌ Khusus Admin Grup!' }, { quoted: m });
if (!isBotAdmin) return sock.sendMessage(from, { text: '❌ Jadikan bot Admin terlebih dahulu!' }, { quoted: m });
const mentioned = m.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
const quotedUser = m.message.extendedTextMessage?.contextInfo?.participant;
const targets = mentioned.length ? mentioned : (quotedUser ? [quotedUser] : []);
if (!targets.length) return sock.sendMessage(from, { text: 'Tag atau balas pesan member yang ingin dikeluarkan.' }, { quoted: m });
await sock.groupParticipantsUpdate(from, targets, 'remove');
await sock.sendMessage(from, { text: '✅ Member berhasil dikeluarkan dari grup.' }, { quoted: m });
break;
}
case 'promote':
case 'demote': {
if (!isGroup) return;
if (!isAdmin && !isOwner) return sock.sendMessage(from, { text: '❌ Khusus Admin Grup!' }, { quoted: m });
if (!isBotAdmin) return sock.sendMessage(from, { text: '❌ Jadikan bot Admin terlebih dahulu!' }, { quoted: m });
const mentioned = m.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
const quotedUser = m.message.extendedTextMessage?.contextInfo?.participant;
const targets = mentioned.length ? mentioned : (quotedUser ? [quotedUser] : []);
if (!targets.length) return sock.sendMessage(from, { text: 'Tag atau balas pesan member.' }, { quoted: m });
await sock.groupParticipantsUpdate(from, targets, command);
await sock.sendMessage(from, { text: ✅ Berhasil melakukan *${command}* pada member tersebut. }, { quoted: m });
break;
}
case 'grup':
case 'group': {
if (!isGroup) return;
if (!isAdmin && !isOwner) return sock.sendMessage(from, { text: '❌ Khusus Admin Grup!' }, { quoted: m });
if (!isBotAdmin) return sock.sendMessage(from, { text: '❌ Jadikan bot Admin terlebih dahulu!' }, { quoted: m });
if (text === 'buka') {
await sock.groupSettingUpdate(from, 'not_announcement');
await sock.sendMessage(from, { text: '🔓 Grup telah DIBUKA.' }, { quoted: m });
} else if (text === 'tutup') {
await sock.groupSettingUpdate(from, 'announcement');
await sock.sendMessage(from, { text: '🔒 Grup telah DITUTUP.' }, { quoted: m });
} else {
await sock.sendMessage(from, { text: Gunakan: *${PREFIX}grup buka* atau *${PREFIX}grup tutup* }, { quoted: m });
}
break;
}
}
});
}
startBot();
