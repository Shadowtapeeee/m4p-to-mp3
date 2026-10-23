'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { DatabaseSync } = require('node:sqlite');
const { Bot, InputFile, GrammyError } = require('grammy');

// ─── Config ──────────────────────────────────────────────────────────────────

try { process.loadEnvFile?.(); } catch { /* .env is optional: Docker passes vars via --env-file */ }

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('BOT_TOKEN is not set');
  process.exit(1);
}

const ADMIN_IDS = (process.env.ADMIN_IDS || '')
  .split(',').map((s) => Number(s.trim())).filter(Boolean);
const DB_PATH = process.env.DB_PATH || './data/bot.db';
const EMOJI_PACK = process.env.EMOJI_PACK || 'FaceEmoji';
const BOT_API_ROOT = (process.env.BOT_API_ROOT || 'https://api.telegram.org').replace(/\/+$/, '');
const LOCAL_API = BOT_API_ROOT !== 'https://api.telegram.org';
// The public Bot API can't serve files over 20 MB; a local Bot API server can go up to 2 GB.
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB) || (LOCAL_API ? 2000 : 20);
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT) || 2;
const FFMPEG_TIMEOUT = (Number(process.env.FFMPEG_TIMEOUT_SEC) || 600) * 1000;
const TMP_ROOT = path.join(os.tmpdir(), 'm4p-bot');

// ─── Formats ─────────────────────────────────────────────────────────────────

const FORMATS = {
  mp3:  { label: 'MP3',  ext: 'mp3',  lossy: true,  cover: true,  audio: true,
          args: (br) => ['-c:a', 'libmp3lame', '-b:a', `${br}k`, '-id3v2_version', '3', '-write_id3v1', '1'] },
  m4a:  { label: 'M4A',  ext: 'm4a',  lossy: true,  cover: true,  audio: true,
          args: (br) => ['-c:a', 'aac', '-b:a', `${br}k`, '-movflags', '+faststart'] },
  flac: { label: 'FLAC', ext: 'flac', lossy: false, cover: true,  audio: false,
          args: () => ['-c:a', 'flac', '-compression_level', '8'] },
  wav:  { label: 'WAV',  ext: 'wav',  lossy: false, cover: false, audio: false,
          args: () => ['-c:a', 'pcm_s16le'] },
  ogg:  { label: 'OGG',  ext: 'ogg',  lossy: true,  cover: false, audio: false,
          // Vorbis rejects some fixed bitrates (e.g. 320k mono), so map to VBR quality instead.
          args: (br) => ['-c:a', 'libvorbis', '-q:a', String({ 128: 4, 192: 6, 256: 8, 320: 9 }[br] ?? 6)] },
  opus: { label: 'OPUS', ext: 'opus', lossy: true,  cover: false, audio: false,
          args: (br) => ['-c:a', 'libopus', '-b:a', `${Math.min(br, 256)}k`, '-vbr', 'on'] },
};
const BITRATES = [128, 192, 256, 320];
const INPUT_EXTS = new Set([
  'm4p', 'm4a', 'm4b', 'mp4', 'aac', 'mp3', 'flac', 'wav', 'ogg', 'oga', 'opus',
  'wma', 'aiff', 'aif', 'alac', 'ape', 'wv', 'webm', 'mka', 'amr', 'ac3',
]);

// ─── Premium emoji ───────────────────────────────────────────────────────────

// Base set: fixed IDs from the shared premium collection.
const ICON = {
  settings: '5870982283724328568', profile: '5870994129244131212', people: '5870772616305839506',
  file: '5870528606328852614', smile: '5870764288364252592', growth: '5870930636742595124',
  stats: '5870921681735781843', home: '5873147866364514353', lock: '6037249452824072506',
  megaphone: '6039422865189638057', check: '5870633910337015697', cross: '5870657884844462243',
  pencil: '5870676941614354370', trash: '5870875489362513438', clip: '6039451237743595514',
  link: '5769289093221454192', info: '6028435952299413210', bot: '6030400221232501136',
  eye: '6037397706505195857', send: '5963103826075456248', download: '6039802767931871481',
  bell: '6039486778597970865', clock: '5983150113483134607', party: '6041731551845159060',
  media: '6035128606563241721', box: '5884479287171485878', calendar: '5890937706803894250',
  tag: '5886285355279193209', hourglass: '5775896410780079073', brush: '6050679691004612757',
  format: '5778479949572738874', code: '5940433880585605708', loading: '5345906554510012647',
};
const ICON_CHAR = {
  settings: '⚙️', profile: '👤', people: '👥', file: '📁', smile: '🙂', growth: '📊', stats: '📊',
  home: '🏘', lock: '🔒', megaphone: '📣', check: '✅', cross: '❌', pencil: '🖋', trash: '🗑',
  clip: '📎', link: '🔗', info: 'ℹ️', bot: '🤖', eye: '👁', send: '⬆️', download: '⬇️', bell: '🔔',
  clock: '⏰', party: '🎉', media: '🖼', box: '📦', calendar: '📅', tag: '🏷', hourglass: '🕓',
  brush: '🖌', format: '↔️', code: '🔨', loading: '🔄',
};

// Face moods, resolved at startup from the EMOJI_PACK set (t.me/addemoji/FaceEmoji).
// Each mood lists the base emoji we'd like, in order of preference.
const FACE_WANT = {
  hello: ['😊', '🙂', '😀', '😃', '😄', '☺️', '👋'],
  cool:  ['😎', '🤩', '🥳', '😁', '😏'],
  happy: ['🥳', '😍', '🤩', '😁', '😄', '😆'],
  sad:   ['😢', '😭', '😔', '😞', '☹️', '🙁', '😟', '🥺'],
  think: ['🤔', '🧐', '🤨', '😐'],
  wow:   ['😮', '😲', '🤯', '😳', '😱'],
  wait:  ['😴', '🙄', '😪', '😌', '🫠'],
  angry: ['😡', '😠', '🤬', '😤'],
  nerd:  ['🤓', '🧐', '😎'],
  shh:   ['🤫', '🤐', '😶', '😬'],
};
// Used until (or if) the pack can't be loaded.
const FACE = Object.fromEntries(Object.keys(FACE_WANT).map((k) => [k, { id: ICON.smile, char: '🙂' }]));

async function loadFacePack(api) {
  try {
    const set = await api.getStickerSet(EMOJI_PACK);
    const stickers = set.stickers.filter((s) => s.custom_emoji_id);
    if (!stickers.length) throw new Error('pack has no custom emoji');
    const byChar = new Map();
    for (const s of stickers) {
      const key = (s.emoji || '').replace(/️/g, '');
      if (key && !byChar.has(key)) byChar.set(key, s);
    }
    Object.keys(FACE_WANT).forEach((mood, i) => {
      const hit = FACE_WANT[mood].map((c) => byChar.get(c.replace(/️/g, ''))).find(Boolean)
        || stickers[i % stickers.length];
      FACE[mood] = { id: hit.custom_emoji_id, char: hit.emoji || '🙂' };
    });
    console.log(`Loaded ${stickers.length} emoji from "${EMOJI_PACK}"`);
  } catch (e) {
    console.warn(`Could not load emoji pack "${EMOJI_PACK}": ${e.message}. Using fallback icons.`);
  }
}

const tg = (id, char) => `<tg-emoji emoji-id="${id}">${char}</tg-emoji>`;
const ic = (name) => tg(ICON[name], ICON_CHAR[name]);
const face = (mood) => tg(FACE[mood].id, FACE[mood].char);

// ─── Keyboard helpers ────────────────────────────────────────────────────────

/** Inline button. Text never contains regular emoji: icons go through icon_custom_emoji_id. */
function btn(text, data, { icon, style, url } = {}) {
  const b = { text };
  if (url) b.url = url; else b.callback_data = data;
  if (icon) b.icon_custom_emoji_id = ICON[icon] || icon;
  if (style) b.style = style; // 'primary' (blue) | 'success' (green) | 'danger' (red)
  return b;
}
const kb = (...rows) => ({ inline_keyboard: rows.filter((r) => r && r.length) });
const backBtn = (to = 'm:main') => btn('◁ Назад', to);

// ─── Database ────────────────────────────────────────────────────────────────

fs.mkdirSync(path.dirname(path.resolve(DB_PATH)), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY,
    username    TEXT,
    first_name  TEXT,
    format      TEXT    NOT NULL DEFAULT 'mp3',
    bitrate     INTEGER NOT NULL DEFAULT 320,
    blocked     INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS conversions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL,
    file_name   TEXT,
    in_ext      TEXT,
    out_format  TEXT,
    in_size     INTEGER,
    out_size    INTEGER,
    status      TEXT    NOT NULL,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_conv_user ON conversions(user_id);
`);

const q = {
  upsertUser: db.prepare(`
    INSERT INTO users (id, username, first_name) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET username = excluded.username, first_name = excluded.first_name, blocked = 0`),
  getUser: db.prepare('SELECT * FROM users WHERE id = ?'),
  setFormat: db.prepare('UPDATE users SET format = ? WHERE id = ?'),
  setBitrate: db.prepare('UPDATE users SET bitrate = ? WHERE id = ?'),
  setBlocked: db.prepare('UPDATE users SET blocked = 1 WHERE id = ?'),
  addConv: db.prepare(`
    INSERT INTO conversions (user_id, file_name, in_ext, out_format, in_size, out_size, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)`),
  userStats: db.prepare(`
    SELECT COUNT(*) AS total,
           COALESCE(SUM(in_size), 0) AS bytes
    FROM conversions WHERE user_id = ? AND status = 'ok'`),
  userFav: db.prepare(`
    SELECT out_format, COUNT(*) AS n FROM conversions
    WHERE user_id = ? AND status = 'ok' GROUP BY out_format ORDER BY n DESC LIMIT 1`),
  userLast: db.prepare(`
    SELECT file_name, out_format, created_at FROM conversions
    WHERE user_id = ? AND status = 'ok' ORDER BY id DESC LIMIT 5`),
  globalStats: db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM users) AS users,
      (SELECT COUNT(*) FROM users WHERE blocked = 0) AS active,
      (SELECT COUNT(*) FROM users WHERE created_at >= unixepoch() - 86400) AS new_today,
      (SELECT COUNT(*) FROM conversions WHERE status = 'ok') AS ok,
      (SELECT COUNT(*) FROM conversions WHERE status = 'ok' AND created_at >= unixepoch() - 86400) AS ok_today,
      (SELECT COUNT(*) FROM conversions WHERE status = 'drm') AS drm,
      (SELECT COUNT(*) FROM conversions WHERE status = 'error') AS errors,
      (SELECT COALESCE(SUM(in_size), 0) FROM conversions WHERE status = 'ok') AS bytes`),
  activeUsers: db.prepare('SELECT id FROM users WHERE blocked = 0'),
};

function touchUser(from) {
  q.upsertUser.run(from.id, from.username ?? null, from.first_name ?? null);
  return q.getUser.get(from.id);
}

// ─── Utils ───────────────────────────────────────────────────────────────────

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const isAdmin = (id) => ADMIN_IDS.includes(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fmtSize(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
function fmtDuration(sec) {
  const s = Math.round(sec || 0);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function fmtDate(unix) {
  return new Date(unix * 1000).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
function formatLine(u) {
  const f = FORMATS[u.format];
  return f.lossy ? `${f.label} · ${u.bitrate} kbps` : `${f.label} · без потерь`;
}

async function safeEdit(ctx, text, reply_markup) {
  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup, link_preview_options: { is_disabled: true } });
  } catch (e) {
    if (e instanceof GrammyError && e.description.includes('message is not modified')) return;
    // The message is too old or was a media message — send a fresh one instead.
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup, link_preview_options: { is_disabled: true } });
  }
}

/** Minimal semaphore so ffmpeg doesn't eat every core. */
let running = 0;
const waiters = [];
async function acquire() {
  if (running < MAX_CONCURRENT) { running++; return; }
  await new Promise((r) => waiters.push(r));
  running++;
}
function release() {
  running--;
  const next = waiters.shift();
  if (next) next();
}

function run(cmd, args, timeout = FFMPEG_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err = (err + d).slice(-8000); });
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('timeout')); }, timeout);
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    p.on('close', (code) => {
      clearTimeout(t);
      if (code === 0) resolve(out);
      else reject(Object.assign(new Error(`${cmd} exited with ${code}`), { stderr: err }));
    });
  });
}

// ─── Media pipeline ──────────────────────────────────────────────────────────

class DrmError extends Error {}

/**
 * FairPlay-protected files (Apple Music, old iTunes purchases) carry a `sinf`
 * box with a `drms`/`enca`/`drmi` sample entry. We only detect it to tell the
 * user why the file can't be processed — the bot does not remove DRM.
 */
async function hasFairPlay(file, probe) {
  const tags = (probe.streams || []).map((s) => s.codec_tag_string);
  if (tags.some((t) => ['drms', 'drmi', 'enca', 'encv'].includes(t))) return true;

  const { size } = await fsp.stat(file);
  const fh = await fsp.open(file, 'r');
  try {
    const chunk = 4 * 1024 * 1024;
    const parts = size <= chunk * 2 ? [[0, size]] : [[0, chunk], [size - chunk, chunk]];
    for (const [pos, len] of parts) {
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, pos);
      if (buf.includes('sinf') && (buf.includes('drms') || buf.includes('enca') || buf.includes('drmi'))) return true;
    }
  } finally {
    await fh.close();
  }
  return false;
}

async function ffprobe(file) {
  const out = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], 60000);
  return JSON.parse(out);
}

function pickTag(probe, key) {
  const fromFormat = probe.format?.tags || {};
  const fromStream = (probe.streams || []).find((s) => s.codec_type === 'audio')?.tags || {};
  const all = { ...fromStream, ...fromFormat };
  const hit = Object.keys(all).find((k) => k.toLowerCase() === key);
  return hit ? all[hit] : undefined;
}

async function downloadTelegramFile(api, fileId, dest) {
  const file = await api.getFile(fileId);
  // A local Bot API server in --local mode returns an absolute path on its own disk.
  if (LOCAL_API && path.isAbsolute(file.file_path) && fs.existsSync(file.file_path)) {
    await fsp.copyFile(file.file_path, dest);
    return;
  }
  const res = await fetch(`${BOT_API_ROOT}/file/bot${BOT_TOKEN}/${file.file_path}`);
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
}

async function convert(input, outFile, fmtKey, bitrate, probe) {
  const f = FORMATS[fmtKey];
  const hasCover = f.cover && (probe.streams || []).some((s) => s.codec_type === 'video' && s.disposition?.attached_pic);
  const args = ['-hide_banner', '-y', '-i', input, '-map', '0:a:0'];
  if (hasCover) args.push('-map', '0:v:0', '-c:v', 'copy', '-disposition:v:0', 'attached_pic');
  args.push('-map_metadata', '0', ...f.args(bitrate), outFile);
  await run('ffmpeg', args);
}

async function extractThumb(input, probe, dest) {
  if (!(probe.streams || []).some((s) => s.codec_type === 'video')) return null;
  try {
    await run('ffmpeg', ['-hide_banner', '-y', '-i', input, '-an', '-map', '0:v:0', '-frames:v', '1',
      '-vf', 'scale=320:320:force_original_aspect_ratio=decrease', dest], 30000);
    return dest;
  } catch {
    return null;
  }
}

// ─── Screens ─────────────────────────────────────────────────────────────────

function mainScreen(u) {
  const { total } = q.userStats.get(u.id);
  const text =
    `<b>${face('hello')} Аудио-конвертер</b>\n\n` +
    `Пришли трек файлом — верну его в нужном формате с тегами и обложкой.\n\n` +
    `${ic('format')} Формат: <b>${formatLine(u)}</b>\n` +
    `${ic('stats')} Конвертаций: <b>${total}</b>`;
  return {
    text,
    markup: kb(
      [btn('Конвертировать', 'm:convert', { icon: 'send', style: 'success' })],
      [btn('Формат и качество', 'm:settings', { icon: 'settings', style: 'primary' })],
      [btn('Профиль', 'm:profile', { icon: 'profile' }), btn('Помощь', 'm:help', { icon: 'info' })],
      isAdmin(u.id) ? [btn('Админ-панель', 'm:admin', { icon: 'lock', style: 'danger' })] : null,
    ),
  };
}

function convertScreen(u) {
  return {
    text:
      `<b>${ic('send')} Отправь аудиофайл</b>\n\n` +
      `Сконвертирую в <b>${formatLine(u)}</b>.\n\n` +
      `${ic('clip')} Подойдёт аудио, документ или голосовое\n` +
      `${ic('box')} Максимум <b>${MAX_FILE_MB} MB</b>`,
    markup: kb(
      [btn('Сменить формат', 'm:settings', { icon: 'format', style: 'primary' })],
      [backBtn()],
    ),
  };
}

function settingsScreen(u) {
  const f = FORMATS[u.format];
  const fmtBtn = (k) => (k === u.format
    ? btn(FORMATS[k].label, 'noop', { icon: 'check', style: 'success' })
    : btn(FORMATS[k].label, `set:fmt:${k}`));
  const brBtn = (b) => (b === u.bitrate
    ? btn(String(b), 'noop', { icon: 'check', style: 'primary' })
    : btn(String(b), `set:br:${b}`));
  return {
    text:
      `<b>${ic('settings')} Формат и качество</b>\n\n` +
      `${ic('file')} Формат: <b>${f.label}</b>\n` +
      (f.lossy
        ? `${ic('growth')} Битрейт: <b>${u.bitrate} kbps</b>`
        : `${ic('growth')} Битрейт: <b>без потерь</b>, исходное качество`) +
      `\n\n<i>Обложка и теги сохраняются в MP3, M4A и FLAC.</i>`,
    markup: kb(
      ['mp3', 'm4a', 'flac'].map(fmtBtn),
      ['wav', 'ogg', 'opus'].map(fmtBtn),
      f.lossy ? BITRATES.map(brBtn) : null,
      [backBtn()],
    ),
  };
}

function profileScreen(u) {
  const st = q.userStats.get(u.id);
  const fav = q.userFav.get(u.id);
  const last = q.userLast.all(u.id);
  const history = last.length
    ? last.map((r) => `${ic('file')} <code>${esc(String(r.file_name).slice(0, 40))}</code> → ${FORMATS[r.out_format]?.label || r.out_format}`).join('\n')
    : `<i>Пока пусто — пришли первый трек.</i>`;
  return {
    text:
      `<b>${face('nerd')} Профиль</b>\n\n` +
      `${ic('profile')} ID: <code>${u.id}</code>\n` +
      `${ic('calendar')} С нами с <b>${fmtDate(u.created_at)}</b>\n` +
      `${ic('stats')} Конвертаций: <b>${st.total}</b>\n` +
      `${ic('box')} Обработано: <b>${fmtSize(st.bytes)}</b>\n` +
      `${ic('tag')} Любимый формат: <b>${fav ? FORMATS[fav.out_format]?.label : '—'}</b>\n\n` +
      `<b>Последние</b>\n${history}`,
    markup: kb([backBtn()]),
  };
}

function helpScreen() {
  return {
    text:
      `<b>${ic('info')} Как это работает</b>\n\n` +
      `1. Выбери формат и битрейт\n` +
      `2. Пришли трек — аудио или документом\n` +
      `3. Получи готовый файл с тегами и обложкой\n\n` +
      `<b>${ic('format')} Форматы</b>\n` +
      `На входе: M4A, AAC, ALAC, FLAC, WAV, OGG, OPUS, WMA, AIFF и др.\n` +
      `На выходе: MP3, M4A, FLAC, WAV, OGG, OPUS\n\n` +
      `<b>${ic('lock')} Про M4P из Apple Music</b>\n` +
      `Треки Apple Music и старые покупки iTunes защищены FairPlay DRM — ` +
      `такие файлы бот не конвертирует и честно об этом скажет. ` +
      `Покупки iTunes Store после 2009 года идут в M4A без DRM: их можно конвертировать свободно.\n\n` +
      `${ic('box')} Лимит файла: <b>${MAX_FILE_MB} MB</b>`,
    markup: kb([backBtn()]),
  };
}

function adminScreen() {
  const s = q.globalStats.get();
  return {
    text:
      `<b>${ic('lock')} Админ-панель</b>\n\n` +
      `${ic('people')} Пользователей: <b>${s.users}</b> · активных <b>${s.active}</b>\n` +
      `${ic('growth')} Новых за сутки: <b>${s.new_today}</b>\n\n` +
      `${ic('check')} Конвертаций: <b>${s.ok}</b> · за сутки <b>${s.ok_today}</b>\n` +
      `${ic('lock')} Отклонено (DRM): <b>${s.drm}</b>\n` +
      `${ic('cross')} Ошибок: <b>${s.errors}</b>\n` +
      `${ic('box')} Обработано: <b>${fmtSize(s.bytes)}</b>\n\n` +
      `${ic('loading')} В работе: <b>${running}</b> · в очереди <b>${waiters.length}</b>`,
    markup: kb(
      [btn('Рассылка', 'adm:bc', { icon: 'megaphone', style: 'primary' })],
      [btn('Обновить', 'm:admin', { icon: 'loading' })],
      [backBtn()],
    ),
  };
}

// ─── Bot ─────────────────────────────────────────────────────────────────────

const bot = new Bot(BOT_TOKEN, { client: { apiRoot: BOT_API_ROOT } });

const busy = new Set();          // users with a conversion in flight
const lastInput = new Map();     // userId -> { fileId, name, size } for quick re-convert
const awaitingBroadcast = new Set();

bot.use(async (ctx, next) => {
  if (ctx.chat && ctx.chat.type !== 'private') return; // the bot works in private chats only
  if (ctx.from) ctx.user = touchUser(ctx.from);
  await next();
});

bot.command('start', async (ctx) => {
  awaitingBroadcast.delete(ctx.from.id);
  const s = mainScreen(ctx.user);
  await ctx.reply(s.text, { parse_mode: 'HTML', reply_markup: s.markup });
});

bot.command('settings', async (ctx) => {
  const s = settingsScreen(ctx.user);
  await ctx.reply(s.text, { parse_mode: 'HTML', reply_markup: s.markup });
});

bot.command('help', async (ctx) => {
  const s = helpScreen();
  await ctx.reply(s.text, { parse_mode: 'HTML', reply_markup: s.markup });
});

const screens = {
  main: mainScreen,
  convert: convertScreen,
  settings: settingsScreen,
  profile: profileScreen,
  help: helpScreen,
  admin: adminScreen,
};

bot.callbackQuery(/^m:(\w+)$/, async (ctx) => {
  const name = ctx.match[1];
  if (name === 'admin' && !isAdmin(ctx.from.id)) {
    return ctx.answerCallbackQuery({ text: 'Нет доступа', show_alert: true });
  }
  awaitingBroadcast.delete(ctx.from.id);
  const s = screens[name]?.(ctx.user);
  if (!s) return ctx.answerCallbackQuery();
  await safeEdit(ctx, s.text, s.markup);
  await ctx.answerCallbackQuery();
});

bot.callbackQuery(/^set:fmt:(\w+)$/, async (ctx) => {
  const fmt = ctx.match[1];
  if (!FORMATS[fmt]) return ctx.answerCallbackQuery();
  q.setFormat.run(fmt, ctx.from.id);
  const s = settingsScreen(q.getUser.get(ctx.from.id));
  await safeEdit(ctx, s.text, s.markup);
  await ctx.answerCallbackQuery({ text: `Формат: ${FORMATS[fmt].label}` });
});

bot.callbackQuery(/^set:br:(\d+)$/, async (ctx) => {
  const br = Number(ctx.match[1]);
  if (!BITRATES.includes(br)) return ctx.answerCallbackQuery();
  q.setBitrate.run(br, ctx.from.id);
  const s = settingsScreen(q.getUser.get(ctx.from.id));
  await safeEdit(ctx, s.text, s.markup);
  await ctx.answerCallbackQuery({ text: `Битрейт: ${br} kbps` });
});

bot.callbackQuery('noop', (ctx) => ctx.answerCallbackQuery({ text: 'Уже выбрано' }));

// Quick re-convert of the last uploaded file into another format.
bot.callbackQuery(/^re:(\w+)$/, async (ctx) => {
  const fmt = ctx.match[1];
  const src = lastInput.get(ctx.from.id);
  if (!FORMATS[fmt] || !src) {
    return ctx.answerCallbackQuery({ text: 'Исходник устарел — пришли файл ещё раз', show_alert: true });
  }
  await ctx.answerCallbackQuery();
  await processFile(ctx, src, fmt);
});

// ─── Admin: broadcast ────────────────────────────────────────────────────────

bot.callbackQuery('adm:bc', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCallbackQuery({ text: 'Нет доступа', show_alert: true });
  awaitingBroadcast.add(ctx.from.id);
  await safeEdit(ctx,
    `<b>${ic('megaphone')} Рассылка</b>\n\nОтправь сообщение, которое получат все пользователи. ` +
    `Подойдёт текст, фото, видео или файл — сообщение будет скопировано как есть.`,
    kb([btn('Отмена', 'm:admin', { icon: 'cross', style: 'danger' })]));
  await ctx.answerCallbackQuery();
});

async function runBroadcast(ctx) {
  awaitingBroadcast.delete(ctx.from.id);
  const ids = q.activeUsers.all().map((r) => r.id);
  const status = await ctx.reply(`<b>${ic('loading')} Рассылка запущена</b>\n\nПолучателей: <b>${ids.length}</b>`,
    { parse_mode: 'HTML' });
  let ok = 0;
  let fail = 0;
  for (const id of ids) {
    try {
      await ctx.api.copyMessage(id, ctx.chat.id, ctx.message.message_id);
      ok++;
    } catch (e) {
      fail++;
      if (e instanceof GrammyError && e.error_code === 403) q.setBlocked.run(id);
      if (e instanceof GrammyError && e.error_code === 429) await sleep((e.parameters?.retry_after || 1) * 1000);
    }
    await sleep(40); // stay well under ~30 msg/s
  }
  await ctx.api.editMessageText(ctx.chat.id, status.message_id,
    `<b>${face('cool')} Рассылка завершена</b>\n\n${ic('check')} Доставлено: <b>${ok}</b>\n${ic('cross')} Не доставлено: <b>${fail}</b>`,
    { parse_mode: 'HTML', reply_markup: kb([btn('В админ-панель', 'm:admin', { icon: 'lock', style: 'primary' })]) });
}

// ─── Conversion ──────────────────────────────────────────────────────────────

function resultKeyboard(fmt) {
  const others = Object.keys(FORMATS).filter((k) => k !== fmt).slice(0, 3);
  return kb(
    others.map((k) => btn(FORMATS[k].label, `re:${k}`, { icon: 'format' })),
    [btn('Меню', 'm:main', { icon: 'home', style: 'primary' })],
  );
}

async function processFile(ctx, src, fmtOverride) {
  const userId = ctx.from.id;
  const u = q.getUser.get(userId);
  const fmt = fmtOverride || u.format;
  const f = FORMATS[fmt];
  const inExt = (path.extname(src.name).slice(1) || 'bin').toLowerCase();
  const baseName = path.basename(src.name, path.extname(src.name)) || 'audio';

  if (busy.has(userId)) {
    return ctx.reply(`<b>${face('wait')} Подожди немного</b>\n\nПредыдущий файл ещё в работе.`, { parse_mode: 'HTML' });
  }
  if (src.size && src.size > MAX_FILE_MB * 1024 * 1024) {
    return ctx.reply(
      `<b>${face('wow')} Файл слишком большой</b>\n\n${fmtSize(src.size)} — максимум <b>${MAX_FILE_MB} MB</b>.`,
      { parse_mode: 'HTML', reply_markup: kb([btn('Меню', 'm:main', { icon: 'home' })]) });
  }

  busy.add(userId);
  lastInput.set(userId, src);
  const status = await ctx.reply(
    `<b>${ic('loading')} В очереди…</b>\n\n${ic('file')} <code>${esc(src.name)}</code> → <b>${f.label}</b>`,
    { parse_mode: 'HTML' });
  const setStatus = (text, reply_markup) => ctx.api
    .editMessageText(ctx.chat.id, status.message_id, text, { parse_mode: 'HTML', reply_markup })
    .catch(() => {});

  const dir = path.join(TMP_ROOT, crypto.randomUUID());
  await fsp.mkdir(dir, { recursive: true });
  const input = path.join(dir, `input.${inExt}`);
  const output = path.join(dir, `${baseName}.${f.ext}`.replace(/[\/\\]/g, '_'));

  await acquire();
  try {
    await setStatus(`<b>${ic('download')} Скачиваю…</b>\n\n${ic('file')} <code>${esc(src.name)}</code>`);
    await downloadTelegramFile(ctx.api, src.fileId, input);

    await setStatus(`<b>${face('think')} Анализирую…</b>\n\n${ic('file')} <code>${esc(src.name)}</code>`);
    let probe;
    try {
      probe = await ffprobe(input);
    } catch {
      probe = { streams: [], format: {} };
    }
    if (await hasFairPlay(input, probe)) throw new DrmError();
    if (!(probe.streams || []).some((s) => s.codec_type === 'audio')) throw new Error('no audio stream');

    await setStatus(`<b>${ic('loading')} Конвертирую в ${f.label}…</b>\n\n${ic('file')} <code>${esc(src.name)}</code>`);
    await convert(input, output, fmt, u.bitrate, probe);

    const outSize = (await fsp.stat(output)).size;
    const title = pickTag(probe, 'title') || baseName;
    const performer = pickTag(probe, 'artist') || pickTag(probe, 'album_artist');
    const duration = Number(probe.format?.duration) || 0;
    const quality = f.lossy ? `${fmt === 'opus' ? Math.min(u.bitrate, 256) : u.bitrate} kbps` : 'без потерь';

    await setStatus(`<b>${ic('send')} Отправляю…</b>\n\n${ic('file')} <code>${esc(path.basename(output))}</code>`);
    const caption =
      `<b>${face('cool')} Готово</b>\n\n` +
      `${ic('format')} ${inExt.toUpperCase()} → <b>${f.label}</b> · ${quality}\n` +
      `${ic('box')} ${fmtSize(src.size || 0)} → <b>${fmtSize(outSize)}</b>` +
      (duration ? `\n${ic('clock')} ${fmtDuration(duration)}` : '');
    const opts = { caption, parse_mode: 'HTML', reply_markup: resultKeyboard(fmt) };

    if (outSize > (LOCAL_API ? 2000 : 50) * 1024 * 1024) throw new Error('result too large to upload');

    if (f.audio) {
      const thumb = await extractThumb(input, probe, path.join(dir, 'thumb.jpg'));
      await ctx.replyWithAudio(new InputFile(output, path.basename(output)), {
        ...opts,
        title,
        performer,
        duration: Math.round(duration) || undefined,
        thumbnail: thumb ? new InputFile(thumb) : undefined,
      });
    } else {
      await ctx.replyWithDocument(new InputFile(output, path.basename(output)), opts);
    }

    await ctx.api.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});
    q.addConv.run(userId, src.name, inExt, fmt, src.size || 0, outSize, 'ok');
  } catch (e) {
    if (e instanceof DrmError) {
      q.addConv.run(userId, src.name, inExt, fmt, src.size || 0, 0, 'drm');
      lastInput.delete(userId);
      await setStatus(
        `<b>${face('sad')} Файл защищён DRM</b>\n\n` +
        `<code>${esc(src.name)}</code> зашифрован FairPlay — так защищены треки Apple Music. ` +
        `Снимать защиту бот не умеет и не будет.\n\n` +
        `${ic('info')} Покупки в iTunes Store приходят в M4A без DRM — такой файл я сконвертирую.`,
        kb([btn('Помощь', 'm:help', { icon: 'info' }), btn('Меню', 'm:main', { icon: 'home', style: 'primary' })]));
    } else {
      console.error('Conversion failed:', e.message, e.stderr ? `\n${e.stderr.slice(-1500)}` : '');
      q.addConv.run(userId, src.name, inExt, fmt, src.size || 0, 0, 'error');
      const reason = e.message === 'no audio stream'
        ? 'В файле не нашлось аудиодорожки.'
        : e.message === 'timeout'
          ? 'Конвертация заняла слишком много времени.'
          : 'Не получилось обработать файл. Возможно, он повреждён или формат не поддерживается.';
      await setStatus(`<b>${face('sad')} Ошибка</b>\n\n${reason}`,
        kb([btn('Повторить', `re:${fmt}`, { icon: 'loading', style: 'primary' }), btn('Меню', 'm:main', { icon: 'home' })]));
    }
  } finally {
    release();
    busy.delete(userId);
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

bot.on('message', async (ctx, next) => {
  if (awaitingBroadcast.has(ctx.from.id) && isAdmin(ctx.from.id)) return runBroadcast(ctx);
  await next();
});

bot.on('message:audio', (ctx) => {
  const a = ctx.message.audio;
  const name = a.file_name || `${[a.performer, a.title].filter(Boolean).join(' - ') || 'audio'}.${(a.mime_type || 'audio/mpeg').split('/')[1]}`;
  return processFile(ctx, { fileId: a.file_id, name, size: a.file_size });
});

bot.on('message:voice', (ctx) => {
  const v = ctx.message.voice;
  return processFile(ctx, { fileId: v.file_id, name: `voice_${ctx.message.message_id}.ogg`, size: v.file_size });
});

bot.on('message:document', (ctx) => {
  const d = ctx.message.document;
  const name = d.file_name || 'file';
  const ext = path.extname(name).slice(1).toLowerCase();
  if (!INPUT_EXTS.has(ext) && !(d.mime_type || '').startsWith('audio/')) {
    return ctx.reply(
      `<b>${face('think')} Это не похоже на аудио</b>\n\nПришли файл M4A, FLAC, WAV, OGG и т.п.`,
      { parse_mode: 'HTML', reply_markup: kb([btn('Помощь', 'm:help', { icon: 'info' })]) });
  }
  return processFile(ctx, { fileId: d.file_id, name, size: d.file_size });
});

bot.on('message', async (ctx) => {
  const s = mainScreen(ctx.user);
  await ctx.reply(s.text, { parse_mode: 'HTML', reply_markup: s.markup });
});

bot.catch((err) => {
  console.error(`Update ${err.ctx?.update?.update_id} failed:`, err.error);
});

// ─── Start ───────────────────────────────────────────────────────────────────

async function main() {
  await fsp.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
  await fsp.mkdir(TMP_ROOT, { recursive: true });
  await loadFacePack(bot.api);
  await bot.api.setMyCommands([
    { command: 'start', description: 'Главное меню' },
    { command: 'settings', description: 'Формат и качество' },
    { command: 'help', description: 'Помощь' },
  ]).catch((e) => console.warn('setMyCommands failed:', e.message));

  const stop = () => bot.stop();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  await bot.start({
    allowed_updates: ['message', 'callback_query'],
    onStart: (me) => console.log(`@${me.username} is running`),
  });
}

if (require.main === module) {
  main().catch((e) => {
    console.error('Fatal:', e.message);
    process.exit(1);
  });
}

module.exports = { ffprobe, hasFairPlay, convert, extractThumb, pickTag, FORMATS, screens, touchUser, q };
