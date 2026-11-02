const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { Server } = require('socket.io');
const pool = require('./db');

const SECRET = process.env.JWT_SECRET || 'anarchy-archives-2026-segredo-secreto-alterado';
const PORT = process.env.PORT || 3000;
fs.mkdirSync(path.join(__dirname, 'uploads'), { recursive: true });

// ---------------- Helpers assíncronos para PostgreSQL ----------------
const run = async (text, params = []) => pool.query(text, params);
const get = async (text, params = []) => {
  const r = await pool.query(text, params);
  return r.rows[0] || null;
};
const all = async (text, params = []) => {
  const r = await pool.query(text, params);
  return r.rows;
};
const num = async (s, ...a) => {
  const r = await pool.query(s, a);
  return Number(r.rows[0]?.n || 0);
};

// ---------------- Inicialização do banco (cria tabelas se não existirem) ----------------
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users(
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      name TEXT DEFAULT '',
      bio TEXT DEFAULT '',
      avatar TEXT,
      private INTEGER DEFAULT 0,
      verified INTEGER DEFAULT 0,
      verified_color TEXT DEFAULT '',
      song_title TEXT DEFAULT '',
      song_artist TEXT DEFAULT '',
      song_url TEXT DEFAULT '',
      song_art TEXT DEFAULT '',
      song_start INTEGER DEFAULT 0,
      song_dur INTEGER DEFAULT 0,
      username_change_count INTEGER DEFAULT 0,
      last_username_change INTEGER DEFAULT 0,
      deactivated INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS follows(
      follower INTEGER,
      followee INTEGER,
      status TEXT,
      PRIMARY KEY(follower, followee)
    );
    CREATE TABLE IF NOT EXISTS blocked_users(
      blocker INTEGER,
      blocked INTEGER,
      PRIMARY KEY(blocker, blocked)
    );
    CREATE TABLE IF NOT EXISTS pinned_chats(
      user_id INTEGER,
      peer_id INTEGER,
      pinned_at INTEGER NOT NULL,
      PRIMARY KEY(user_id, peer_id)
    );
    CREATE TABLE IF NOT EXISTS posts(
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      caption TEXT DEFAULT '',
      media TEXT,
      type TEXT,
      repost_of INTEGER,
      created INTEGER NOT NULL,
      song_preview TEXT DEFAULT '',
      song_duration INTEGER DEFAULT 0,
      deleted INTEGER DEFAULT 0,
      edited_at INTEGER DEFAULT 0,
      pinned INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS likes(
      user_id INTEGER,
      post_id INTEGER,
      PRIMARY KEY(user_id, post_id)
    );
    CREATE TABLE IF NOT EXISTS comments(
      id SERIAL PRIMARY KEY,
      post_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      text TEXT NOT NULL,
      created INTEGER NOT NULL,
      edited_at INTEGER DEFAULT 0,
      deleted INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS stories(
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      media TEXT,
      type TEXT,
      created INTEGER NOT NULL,
      expires_at INTEGER DEFAULT 0,
      mentions TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS story_views(
      id SERIAL PRIMARY KEY,
      story_id INTEGER,
      viewer_id INTEGER,
      viewed_at INTEGER NOT NULL,
      is_unique INTEGER DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS story_reactions(
      id SERIAL PRIMARY KEY,
      story_id INTEGER,
      user_id INTEGER,
      type TEXT NOT NULL,
      text TEXT DEFAULT '',
      created INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages(
      id SERIAL PRIMARY KEY,
      from_id INTEGER NOT NULL,
      to_id INTEGER NOT NULL,
      text TEXT DEFAULT '',
      post_id INTEGER,
      media TEXT,
      type TEXT,
      created INTEGER NOT NULL,
      edited_at INTEGER DEFAULT 0,
      deleted INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS tags(
      post_id INTEGER,
      user_id INTEGER,
      PRIMARY KEY(post_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS notifs(
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      actor_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      post_id INTEGER,
      story_id INTEGER,
      created INTEGER NOT NULL,
      seen INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS chat_reads(
      user_id INTEGER,
      peer_id INTEGER,
      last_read INTEGER NOT NULL,
      PRIMARY KEY(user_id, peer_id)
    );
  `);

  // Adicionar colunas se faltarem (PostgreSQL suporta ADD COLUMN IF NOT EXISTS)
  const addCol = async (table, col, def
Build · Nemotron 3.5 Super VL 120B A12B · 37.7s · 217.1 tok/s
+Thought · 12.7s
// complete initDb (PostgreSQL version)
const addCol = async (table, col, def) => {
  try {
    await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col} ${def};`);
  } catch { /* column already exists */ }
};

await addCol('users', 'username_change_count', 'INTEGER DEFAULT 0');
await addCol('users', 'last_username_change', 'INTEGER DEFAULT 0');
await addCol('users', 'verified_color', "TEXT DEFAULT ''");
await addCol('users', 'song_start', 'INTEGER DEFAULT 0');
await addCol('users', 'song_dur', 'INTEGER DEFAULT 0');
await addCol('users', 'deactivated', 'INTEGER DEFAULT 0');
await addCol('posts', 'song_preview', "TEXT DEFAULT ''");
await addCol('posts', 'song_duration', 'INTEGER DEFAULT 0');
await addCol('posts', 'deleted', 'INTEGER DEFAULT 0');
await addCol('posts', 'edited_at', 'INTEGER DEFAULT 0');
await addCol('posts', 'pinned', 'INTEGER DEFAULT 0');
await addCol('comments', 'edited_at', 'INTEGER DEFAULT 0');
await addCol('comments', 'deleted', 'INTEGER DEFAULT 0');
await addCol('stories', 'expires_at', 'INTEGER DEFAULT 0');
await addCol('stories', 'mentions', "TEXT DEFAULT ''");
await addCol('messages', 'media', 'TEXT DEFAULT \'\'');
await addCol('messages', 'type', 'TEXT DEFAULT \'\'');
await addCol('messages', 'edited_at', 'INTEGER DEFAULT 0');
await addCol('messages', 'deleted', 'INTEGER DEFAULT 0');
await addCol('notifs', 'story_id', 'INTEGER');
await addCol('notifs', 'text', "TEXT DEFAULT ''");

// cleanup comments
try {
  await pool.query("UPDATE comments SET text=substr(text,1,length(text)-10) WHERE edited_at>0 AND text LIKE '% (editado)'");
} catch {}
try {
  await pool.query("DELETE FROM notifs WHERE type='story_view'");
} catch {}

initDb().catch(console.error);
// file-type helpers (unchanged logic, no DB needed)
const EXT = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov', 'video/x-m4v': '.m4v',
  'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/x-mp3': '.mp3', 'audio/mpeg3': '.mp3', 'audio/x-mpeg-3': '.mp3',
  'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a', 'audio/m4a': '.m4a', 'audio/mp4a-latm': '.m4a',
  'audio/aac': '.aac', 'audio/x-aac': '.aac',
  'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/wave': '.wav', 'audio/vnd.wave': '.wav',
  'audio/ogg': '.ogg', 'audio/oga': '.oga', 'audio/opus': '.opus', 'audio/webm': '.weba',
  'audio/flac': '.flac', 'audio/x-flac': '.flac',
  'audio/amr': '.amr', 'audio/x-ms-wma': '.wma', 'audio/wma': '.wma',
  'audio/aiff': '.aiff', 'audio/x-aiff': '.aiff', 'audio/basic': '.au',
  'audio/midi': '.mid', 'audio/x-midi': '.mid', 'audio/mid': '.mid',
  'audio/3gpp': '.3gp', 'audio/3gpp2': '.3g2', 'audio/x-caf': '.caf', 'audio/x-matroska': '.mka',
};
const AUDIO_EXT = { '.mp3': 1, '.m4a': 1, '.m4b': 1, '.aac': 1, '.wav': 1, '.ogg': 1, '.oga': 1, '.opus': 1, '.weba': 1, '.flac': 1, '.amr': 1, '.wma': 1, '.aiff': 1, '.aif': 1, '.au': 1, '.mid': 1, '.midi': 1, '.3gp': 1, '.3g2': 1, '.caf': 1, '.mka': 1, '.mp2': 1, '.mpga': 1 };
const VIDEO_EXT = { '.mp4': 1, '.webm': 1, '.mov': 1, '.m4v': 1, '.avi': 1, '.mkv': 1 };
const NAME_EXT = { '.jpg': 1, '.jpeg': 1, '.png': 1, '.webp': 1, '.gif': 1, '.mp4': 1, '.webm': 1, '.mov': 1, '.m4v': 1, '.avi': 1, '.mkv': 1, ...AUDIO_EXT };
const nameExt = (f) => {
  const e = path.extname(String((f && f.originalname) || '')).toLowerCase();
  return NAME_EXT[e] ? e : '';
};
const extFor = (f) => {
  const ne = nameExt(f);
  if (AUDIO_EXT[ne]) return ne;
  const m = String((f && f.mimetype) || '').toLowerCase();
  if (EXT[m]) return EXT[m];
  if (m.startsWith('audio/')) {
    let sub = m.slice(6).split(';')[0].replace(/^x-/, '').replace(/[^a-z0-9]/g, '');
    if (sub === 'mpeg' || sub === 'mp3') sub = 'mp3';
    else if (sub === 'mp4' || sub === 'mp4a' || sub === 'm4a') sub = 'm4a';
    const guess = '.' + sub;
    if (AUDIO_EXT[guess]) return guess;
  }
  return ne || '.bin';
};
const allowed = (f) => {
  const m = String((f && f.mimetype) || '').toLowerCase();
  return !!EXT[m] || m.startsWith('audio/') || !!nameExt(f);
};
const kind = (f) => {
  const e = extFor(f);
  const m = String((f && f.mimetype) || '').toLowerCase();
  if (AUDIO_EXT[e] || m.startsWith('audio/')) return 'audio';
  if (VIDEO_EXT[e] || m.startsWith('video/')) return 'video';
  return 'image';
};
const up = multer({
  storage: multer.diskStorage({
    destination: path.join(__dirname, 'uploads'),
    filename: (r, f, cb) => cb(null, crypto.randomBytes(12).toString('hex') + extFor(f)),
  }),
  limits: { fileSize: 60 * 1024 * 1024 },
  fileFilter: (r, f, cb) => cb(null, allowed(f)),
});
const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const sign = (u) => jwt.sign({ id: u.id, username: u.username }, SECRET, { expiresIn: '30d' });

const auth = async (req, res, next) => {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    const decoded = jwt.verify(token, SECRET);
    req.user = decoded;

    const acc = await get('SELECT deactivated FROM users WHERE id=$1', [decoded.id]);
    if (!acc) return res.status(401).json({ error: 'Sessão expirada.' });
    if (acc.deactivated) return res.status(401).json({ error: 'Esta conta está desativada. Entre novamente para reativá-la.' });

    next();
  } catch {
    res.status(401).json({ error: 'Faça login para continuar.' });
  }
};

// ---------- Conta ----------

app.post('/api/register', async (req, res) => {
  const { username, password } = req.body || {};
  const un = (username || '').toLowerCase();
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(un)) return res.status(400).json({ error: 'Usuário: 3 a 20 letras, números ou _.' });
  if ((password || '').length < 6) return res.status(400).json({ error: 'A senha precisa ter 6 ou mais caracteres.' });

  try {
    const hash = await bcrypt.hash(password, 10);
    const r = await run(
      'INSERT INTO users(username,password,name) VALUES($1,$2,$3) RETURNING id',
      [un, hash, un]
    );
    const id = Number(r.rows[0].id);
    res.json({ token: sign({ id, username: un }) });
  } catch {
    res.status(409).json({ error: 'Esse nome de usuário já existe.' });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  const u = await get('SELECT * FROM users WHERE username=$1', [(username || '').toLowerCase()]);
  if (!u || !bcrypt.compareSync(password || '', u.password)) return res.status(401).json({ error: 'Usuário ou senha incorretos.' });

  if (u.deactivated) await run('UPDATE users SET deactivated=0 WHERE id=$1', [u.id]);

  res.json({ token: sign(u) });
});

app.get('/api/me', auth, async (req, res) => {
  const u = await get(
    'SELECT id,username,name,bio,avatar,private,verified,verified_color,song_title,song_artist,song_url,song_art,song_start,song_dur FROM users WHERE id=$1',
    [req.user.id]
  );
  u ? res.json(u) : res.status(401).json({ error: 'Sessão expirada.' });
});

app.put('/api/me', auth, up.single('avatar'), async (req, res) => {
  const b = req.body, me = req.user.id;
  const vc = String(b.verified_color || '').trim();
  const vcolor = /^#[0-9a-f]{6}$/i.test(vc) ? vc.toLowerCase() : '';
  const segStart = Math.max(0, Math.min(3600, parseInt(b.song_start, 10) || 0));
  const segDur = Math.max(0, Math.min(300, parseInt(b.song_dur, 10) || 0));

  await run(
    'UPDATE users SET name=$1,bio=$2,private=$3,song_title=$4,song_artist=$5,song_url=$6,song_art=$7,verified_color=$8,song_start=$9,song_dur=$10 WHERE id=$11',
    [(b.name || '').slice(0, 40), (b.bio || '').slice(0, 150), b.private === '1' ? 1 : 0,
     (b.song_title || '').slice(0, 100), (b.song_artist || '').slice(0, 100), httpsOnly(b.song_url),
     httpsOnly(b.song_art), vcolor, segStart, segDur, me]
  );

  if (req.file && kind(req.file) === 'image') {
    await run('UPDATE users SET avatar=$1 WHERE id=$2', ['/uploads/' + req.file.filename, me]);
  }

  const u = await get(
    'SELECT id,username,name,bio,avatar,private,verified,verified_color,song_title,song_artist,song_url,song_art,song_start,song_dur FROM users WHERE id=$1',
    [me]
  );
  res.json(u);
});

app.post('/api/verify', auth, async (req, res) => {
  await run('UPDATE users SET verified=1-verified WHERE id=$1', [req.user.id]);
  const u = await get(
    'SELECT id,username,name,bio,avatar,private,verified,verified_color,song_title,song_artist,song_url,song_art,song_start,song_dur FROM users WHERE id=$1',
    [req.user.id]
  );
  res.json(u);
});

app.get('/api/badge-colors', auth, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const rows = await all("SELECT LOWER(username) AS username, verified_color FROM users WHERE verified=1 AND verified_color<>''");
  res.json(rows);
});