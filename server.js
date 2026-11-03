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
// Contas autorizadas a usar GIF como foto de perfil (usada na migração e no servidor).
const GIF_AVATAR_USERS = new Set(
  (process.env.GIF_USERS || 'anarchy,scorppionn,horuswrld')
    .split(',')
    .map((s) => s.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean)
);
fs.mkdirSync(path.join(__dirname, 'uploads'), { recursive: true });

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
  const params = a.length === 1 && Array.isArray(a[0]) ? a[0] : a;
  const r = await pool.query(s, params);
  return Number(r.rows[0]?.n || 0);
};

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
      last_username_change BIGINT DEFAULT 0,
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
      pinned_at BIGINT NOT NULL,
      PRIMARY KEY(user_id, peer_id)
    );
    CREATE TABLE IF NOT EXISTS posts(
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      caption TEXT DEFAULT '',
      media TEXT,
      type TEXT,
      repost_of INTEGER,
      created BIGINT NOT NULL,
      song_preview TEXT DEFAULT '',
      song_duration INTEGER DEFAULT 0,
      deleted INTEGER DEFAULT 0,
      edited_at BIGINT DEFAULT 0,
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
      created BIGINT NOT NULL,
      edited_at BIGINT DEFAULT 0,
      deleted INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS stories(
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      media TEXT,
      type TEXT,
      created BIGINT NOT NULL,
      expires_at BIGINT DEFAULT 0,
      mentions TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS story_views(
      id SERIAL PRIMARY KEY,
      story_id INTEGER,
      viewer_id INTEGER,
      viewed_at BIGINT NOT NULL,
      is_unique INTEGER DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS story_reactions(
      id SERIAL PRIMARY KEY,
      story_id INTEGER,
      user_id INTEGER,
      type TEXT NOT NULL,
      text TEXT DEFAULT '',
      created BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages(
      id SERIAL PRIMARY KEY,
      from_id INTEGER NOT NULL,
      to_id INTEGER NOT NULL,
      text TEXT DEFAULT '',
      post_id INTEGER,
      media TEXT,
      type TEXT,
      created BIGINT NOT NULL,
      edited_at BIGINT DEFAULT 0,
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
      created BIGINT NOT NULL,
      seen INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS chat_reads(
      user_id INTEGER,
      peer_id INTEGER,
      last_read BIGINT NOT NULL,
      PRIMARY KEY(user_id, peer_id)
    );
  `);

  const addCol = async (table, col, def) => {
    try {
      await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col} ${def};`);
    } catch {}
  };

  await addCol('users', 'username_change_count', 'INTEGER DEFAULT 0');
  await addCol('users', 'last_username_change', 'BIGINT DEFAULT 0');
  await addCol('users', 'verified_color', "TEXT DEFAULT ''");
  await addCol('users', 'song_start', 'INTEGER DEFAULT 0');
  await addCol('users', 'song_dur', 'INTEGER DEFAULT 0');
  await addCol('users', 'deactivated', 'INTEGER DEFAULT 0');
  await addCol('users', 'gif_avatar', 'INTEGER DEFAULT 0');
  await addCol('posts', 'song_preview', "TEXT DEFAULT ''");
  await addCol('posts', 'song_duration', 'INTEGER DEFAULT 0');
  await addCol('posts', 'deleted', 'INTEGER DEFAULT 0');
  await addCol('posts', 'edited_at', 'BIGINT DEFAULT 0');
  await addCol('posts', 'pinned', 'INTEGER DEFAULT 0');
  await addCol('comments', 'edited_at', 'BIGINT DEFAULT 0');
  await addCol('comments', 'deleted', 'INTEGER DEFAULT 0');
  await addCol('stories', 'expires_at', 'BIGINT DEFAULT 0');
  await addCol('stories', 'mentions', "TEXT DEFAULT ''");
  await addCol('messages', 'media', 'TEXT DEFAULT \'\'');
  await addCol('messages', 'type', 'TEXT DEFAULT \'\'');
  await addCol('messages', 'edited_at', 'BIGINT DEFAULT 0');
  await addCol('messages', 'deleted', 'INTEGER DEFAULT 0');
  await addCol('notifs', 'story_id', 'INTEGER');
  await addCol('notifs', 'text', "TEXT DEFAULT ''");

  // Concede permissão de GIF para as três contas autorizadas, uma vez por conta.
  // A lista de usernames já concedidos fica em app_settings para não herdar para alguém que registro depois do mesmo nome.
  try {
    await pool.query('CREATE TABLE IF NOT EXISTS app_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const seedKey = 'gif_granted_v1';
    const existing = await pool.query('SELECT value FROM app_settings WHERE key=$1 LIMIT 1', [seedKey]);
    let granted = [];
    if (existing.rows.length && existing.rows[0].value) {
      try { granted = JSON.parse(existing.rows[0].value) || []; } catch { granted = String(existing.rows[0].value).split(','); }
    }
    const grantedSet = new Set(granted.map((u) => String(u).toLowerCase()));
    const wanted = [...GIF_AVATAR_USERS];
    const rows = await pool.query('SELECT LOWER(username) AS u FROM users WHERE LOWER(username) = ANY($1)', [wanted]);
    const nowGrant = rows.rows.map((r) => r.u).filter((u) => !grantedSet.has(u));
    if (nowGrant.length) {
      await pool.query('UPDATE users SET gif_avatar=1 WHERE LOWER(username) = ANY($1)', [nowGrant]);
      nowGrant.forEach((u) => grantedSet.add(u));
      const value = JSON.stringify([...grantedSet].sort());
      await pool.query('INSERT INTO app_settings(key,value) VALUES($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2', [seedKey, value]);
    }
  } catch (e) {
    console.error('[migração] gif_avatar:', e.message);
  }

  // Migração: timestamps em milissegundos (Date.now()) não cabem em INTEGER (32 bits).
  // CREATE TABLE IF NOT EXISTS não altera tabelas que já existem, então é preciso
  // converter as colunas em bancos antigos. ALTER COLUMN TYPE é idempotente.
  const bigintCols = [
    ['users', 'last_username_change'],
    ['pinned_chats', 'pinned_at'],
    ['posts', 'created'], ['posts', 'edited_at'],
    ['comments', 'created'], ['comments', 'edited_at'],
    ['stories', 'created'], ['stories', 'expires_at'],
    ['story_views', 'viewed_at'],
    ['story_reactions', 'created'],
    ['messages', 'created'], ['messages', 'edited_at'],
    ['notifs', 'created'],
    ['chat_reads', 'last_read'],
  ];
  for (const [table, col] of bigintCols) {
    try {
      await pool.query(`ALTER TABLE ${table} ALTER COLUMN ${col} TYPE BIGINT`);
    } catch (e) {
      console.error(`[migração] ${table}.${col}:`, e.message);
    }
  }

  try {
    await pool.query("UPDATE comments SET text=substr(text,1,length(text)-10) WHERE edited_at>0 AND text LIKE '% (editado)'");
  } catch {}
  try {
    await pool.query("DELETE FROM notifs WHERE type='story_view'");
  } catch {}
}

initDb().catch(console.error);
const httpsOnly = (s) => (/^https:\/\//.test(s || '') ? s : '');

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
// Somente essas contas podem usar GIF como foto de perfil (ver definição no topo).
const GIF_AVATAR_MAX = 5 * 1024 * 1024;
// Detecta GIF pelos magic bytes, não pela extensão/mimetype, para bloquear arquivos renomeados.
const isGifUpload = (f) => isValidGif(f);
const isValidGif = (f) => {
  try {
    const buf = Buffer.alloc(6);
    const fd = fs.openSync(f.path, 'r');
    fs.readSync(fd, buf, 0, 6, 0);
    fs.closeSync(fd);
    const head = buf.toString('ascii');
    return head === 'GIF87a' || head === 'GIF89a';
  } catch { return false; }
};
const cleanupUpload = (f) => { try { if (f && f.path) fs.unlinkSync(f.path); } catch {} };
const withPerms = (u) => (u ? { ...u, gif_avatar: Number(u.gif_avatar) || 0 } : u);

const up = multer({
  storage: multer.diskStorage({
    destination: path.join(__dirname, 'uploads'),
    filename: (r, f, cb) => cb(null, crypto.randomBytes(12).toString('hex') + extFor(f)),
  }),
  limits: { fileSize: 60 * 1024 * 1024 },
  fileFilter: (r, f, cb) => cb(null, allowed(f)),
});

const app = express();

// Express 4 não captura rejeições de handlers async: sem isso, um erro de banco
// deixa a requisição pendurada (e pode derrubar o processo). Encaminha pro handler de erro.
for (const m of ['get', 'post', 'put', 'delete', 'patch']) {
  const orig = app[m].bind(app);
  app[m] = (p, ...hs) => orig(p, ...hs.map((h) => (typeof h === 'function' && h.length < 4
    ? (req, res, next) => Promise.resolve(h(req, res, next)).catch((e) => { console.error('[erro]', e); next(e); })
    : h)));
}

const server = http.createServer(app);
const io = new Server(server);
app.use(express.json());
// manifest declarado explicitamente para garantir o Content-Type correto do PWA
app.get('/manifest.json', (req, res) => {
  res.type('application/manifest+json')
    .set('Cache-Control', 'public, max-age=3600')
    .sendFile(path.join(__dirname, 'public', 'manifest.json'));
});
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

const userById = async (id) => {
  return await get(
    'SELECT id,username,name,bio,avatar,private,verified,verified_color,song_title,song_artist,song_url,song_art,song_start,song_dur,gif_avatar FROM users WHERE id=$1',
    [id]
  );
};

const rel = async (me, id) => {
  if (me === id) return 'self';
  const r = await get("SELECT status FROM follows WHERE follower=$1 AND followee=$2", [me, id]);
  return (r && r.status) ? r.status : 'none';
};

const canSee = async (me, u) => {
  if (await isBlocked(me, u.id)) return false;
  const r = await rel(me, u.id);
  return (!u.private || ['self', 'ok'].includes(r));
};

const isBlocked = async (a, b) => {
  const r = await get('SELECT 1 FROM blocked_users WHERE blocker=$1 AND blocked=$2', [a, b]);
  return !!r;
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
  const u = await userById(req.user.id);
  u ? res.json(withPerms(u)) : res.status(401).json({ error: 'Sessão expirada.' });
});

app.put('/api/me', auth, up.single('avatar'), async (req, res) => {
  const b = req.body, me = req.user.id;
  const vc = String(b.verified_color || '').trim();
  const vcolor = /^#[0-9a-f]{6}$/i.test(vc) ? vc.toLowerCase() : '';
  const segStart = Math.max(0, Math.min(3600, parseInt(b.song_start, 10) || 0));
  const segDur = Math.max(0, Math.min(300, parseInt(b.song_dur, 10) || 0));

  // Valida avatar antes de alterar qualquer dado
  if (req.file && isGifUpload(req.file)) {
    const u = await get('SELECT gif_avatar FROM users WHERE id=$1', [me]);
    const ok = u && Number(u.gif_avatar) === 1;
    const fail = (code, error) => { cleanupUpload(req.file); return res.status(code).json({ error }); };
    if (req.file.size > GIF_AVATAR_MAX) return fail(400, 'O GIF deve ter no máximo 5 MB.');
    if (!isValidGif(req.file)) return fail(400, 'Arquivo inválido: não é um GIF.');
    if (!ok) return fail(403, 'Só @anarchy, @scorppionn e @horuswrld podem usar GIF como foto de perfil.');
  }

  await run(
    'UPDATE users SET name=$1,bio=$2,private=$3,song_title=$4,song_artist=$5,song_url=$6,song_art=$7,verified_color=$8,song_start=$9,song_dur=$10 WHERE id=$11',
    [(b.name || '').slice(0, 40), (b.bio || '').slice(0, 150), b.private === '1' ? 1 : 0,
     (b.song_title || '').slice(0, 100), (b.song_artist || '').slice(0, 100), httpsOnly(b.song_url),
     httpsOnly(b.song_art), vcolor, segStart, segDur, me]
  );

  if (req.file && kind(req.file) === 'image') {
    await run('UPDATE users SET avatar=$1 WHERE id=$2', ['/uploads/' + req.file.filename, me]);
  }

  const u = await userById(me);
  res.json(withPerms(u));
});

app.post('/api/verify', auth, async (req, res) => {
  await run('UPDATE users SET verified=1-verified WHERE id=$1', [req.user.id]);
  const u = await userById(req.user.id);
  res.json(withPerms(u));
});

app.get('/api/badge-colors', auth, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const rows = await all("SELECT LOWER(username) AS username, verified_color FROM users WHERE verified=1 AND verified_color<>''");
  res.json(rows);
});
const POST = `SELECT p.id,p.caption,p.media,p.type,p.created,p.user_id,p.repost_of,u.username,u.avatar,u.verified,u.verified_color,ou.username AS orig,p.song_preview,p.song_duration,p.edited_at,
 (SELECT COUNT(*) FROM likes WHERE post_id=p.id) AS likes,
 (SELECT COUNT(*) FROM comments WHERE post_id=p.id AND deleted=0) AS ncomments,
 (SELECT COUNT(*) FROM posts r WHERE r.repost_of=COALESCE(p.repost_of,p.id) AND r.deleted=0) AS reposts,
 EXISTS(SELECT 1 FROM likes WHERE post_id=p.id AND user_id=$1) AS liked
 FROM posts p JOIN users u ON u.id=p.user_id
 LEFT JOIN posts o ON o.id=p.repost_of LEFT JOIN users ou ON ou.id=o.user_id
 WHERE p.deleted=0`;

const fin = async (rows, me) => {
  const out = [];
  for (const p of rows) {
    const tags = await all('SELECT u.username FROM tags t JOIN users u ON u.id=t.user_id WHERE t.post_id=$1 ORDER BY u.username', [p.id]);
    const comments = await all('SELECT c.id,c.text,u.username,u.verified,u.verified_color,c.user_id,c.edited_at,c.deleted FROM comments c JOIN users u ON u.id=c.user_id WHERE c.post_id=$1 AND c.deleted=0 ORDER BY c.id DESC LIMIT 20', [p.id]);
    out.push({
      ...p, liked: !!p.liked,
      tags: tags.map((x) => x.username),
      comments: comments.reverse()
    });
  }
  return out;
};

const getPost = async (id, me) => {
  const rows = await all(POST + ' AND p.id=$2', [me, id]);
  if (!rows.length) return null;
  return (await fin(rows, me))[0];
};

const storyGroupFor = async (me, u) => {
  const base = { uid: u.id, username: u.username, avatar: u.avatar, verified: u.verified, verified_color: u.verified_color, items: [], count: 0, seen: false };
  if (!await canSee(me, u)) return base;

  const items = await all(`SELECT s.id,s.media,s.type,s.created,s.mentions,
    COALESCE(s.expires_at,s.created+864e5) AS expires_at,
    (SELECT COUNT(DISTINCT v.viewer_id) FROM story_views v WHERE v.story_id=s.id AND v.viewer_id<>s.user_id) AS views
    FROM stories s WHERE s.user_id=$1 AND s.created>$2 ORDER BY s.created`, [u.id, Date.now() - 864e5]);

  if (!items.length) return base;

  const seenRows = await all('SELECT story_id FROM story_views WHERE viewer_id=$1', [me]);
  const seen = new Set(seenRows.map((r) => r.story_id));
  items.forEach((i) => { i.seen = seen.has(i.id); });

  const allSeen = u.id !== me && items.every((i) => i.seen);
  return { ...base, items, count: items.length, seen: allSeen };
};

const parseTags = async (raw, caption, me) => {
  const names = new Set();
  String(raw || '').split(/[\s,]+/).forEach((x) => { x = x.replace(/^@/, '').toLowerCase(); if (/^[a-zA-Z0-9_]{3,20}$/.test(x)) names.add(x); });
  (String(caption || '').match(/@[a-zA-Z0-9_]{3,20}/g) || []).forEach((x) => names.add(x.slice(1).toLowerCase()));
  const ids = [];
  for (const n of names) {
    const u = await get('SELECT id FROM users WHERE LOWER(username)=$1', [n]);
    if (u && u.id !== me) ids.push(u.id);
  }
  return ids.slice(0, 20);
};

const mentionIds = async (text, me) => {
  const names = new Set((String(text || '').match(/(?:^|[^\w])@([a-zA-Z0-9_]{3,20})/g) || []).map((x) => x.replace(/^[^@]*@/, '').toLowerCase()));
  const ids = [];
  for (const n of names) {
    const u = await get('SELECT id FROM users WHERE LOWER(username)=$1', [n]);
    if (u && u.id !== me) ids.push(u.id);
  }
  return ids.slice(0, 10);
};

const notify = async (to, actor, type, post_id = null, text = '') => {
  if (!to || to === actor) return;
  await run('INSERT INTO notifs(user_id,actor_id,type,post_id,created,text) VALUES($1,$2,$3,$4,$5,$6)', [to, actor, type, post_id, Date.now(), String(text || '').slice(0, 120)]);
  io.to('u' + to).emit('notif');
};

// ---------- Busca ----------
app.get('/api/search', auth, async (req, res) => {
  const q = '%' + (req.query.q || '').toLowerCase() + '%';
  const rows = await all('SELECT id,username,name,avatar,verified,verified_color FROM users WHERE LOWER(username) LIKE $1 OR LOWER(name) LIKE $1 LIMIT 20', [q]);
  res.json(rows);
});

// ---------- Perfil ----------
app.get('/api/u/:name', auth, async (req, res) => {
  const row = await get('SELECT id FROM users WHERE LOWER(username)=$1', [req.params.name.toLowerCase()]);
  if (!row) return res.status(404).json({ error: 'Perfil não encontrado.' });

  const u = await userById(row.id);
  const me = req.user.id;
  const ok = await canSee(me, u);
  const r = await rel(me, u.id);

  const countPosts = await num('SELECT COUNT(*) n FROM posts WHERE user_id=$1 AND deleted=0', [u.id]);
  const countFollowers = await num("SELECT COUNT(*) n FROM follows WHERE followee=$1 AND status='ok'", [u.id]);
  const countFollowing = await num("SELECT COUNT(*) n FROM follows WHERE follower=$1 AND status='ok'", [u.id]);

  const story = await storyGroupFor(me, u);

  let items = [];
  let tagged = [];
  if (ok) {
    const rows1 = await all(POST + ' AND p.user_id=$2 ORDER BY p.pinned DESC, p.created DESC', [me, u.id]);
    items = await fin(rows1, me);

    const rows2 = await all(
      POST + ` AND p.id IN (SELECT post_id FROM tags WHERE user_id=$2)
        AND (u.private=0 OR p.user_id=$3 OR p.user_id IN (SELECT followee FROM follows WHERE follower=$4 AND status='ok'))
        ORDER BY p.created DESC`,
      [me, u.id, u.id, me]
    );
    tagged = await fin(rows2, me);
  }

  res.json({
    user: u, rel: r, canSee: ok, story: story,
    count: { posts: countPosts, followers: countFollowers, following: countFollowing },
    items: items,
    tagged: tagged
  });
});

// ---------- Seguir ----------
app.post('/api/follow/:id', auth, async (req, res) => {
  const id = +req.params.id;
  const me = req.user.id;
  const u = await userById(id);
  if (!u || id === me) return res.status(400).json({ error: 'Ação inválida.' });

  const had = await run('DELETE FROM follows WHERE follower=$1 AND followee=$2', [me, id]);
  if (!had.rowCount) {
    await run('INSERT INTO follows VALUES($1,$2,$3)', [me, id, u.private ? 'pending' : 'ok']);
    await notify(id, me, u.private ? 'request' : 'follow');
  } else {
    await run("DELETE FROM notifs WHERE user_id=$1 AND actor_id=$2 AND type IN ('follow','request')", [id, me]);
  }
  const status = await rel(me, id);
  res.json({ ok: true, status: status });
});

app.get('/api/requests', auth, async (req, res) => {
  const rows = await all('SELECT u.id,u.username,u.avatar FROM follows f JOIN users u ON u.id=f.follower WHERE f.followee=$1 AND f.status=$2', [req.user.id, 'pending']);
  res.json(rows);
});

app.post('/api/requests/:id/:act', auth, async (req, res) => {
  const followerId = +req.params.id;
  const me = req.user.id;
  if (req.params.act === 'accept') {
    await run("UPDATE follows SET status='ok' WHERE follower=$1 AND followee=$2", [followerId, me]);
  } else {
    await run("DELETE FROM follows WHERE follower=$1 AND followee=$2 AND status='pending'", [followerId, me]);
  }
  res.json({ ok: true });
});
// ---------- Posts ----------
app.get('/api/feed', auth, async (req, res) => {
  const me = req.user.id;
  const rows = await all(
    POST + ` AND (p.user_id=$2 OR p.user_id IN (SELECT followee FROM follows WHERE follower=$3 AND status='ok'))
      ORDER BY p.pinned DESC, p.created DESC LIMIT 50`,
    [me, me, me]
  );
  res.json(await fin(rows, me));
});

app.get('/api/explore', auth, async (req, res) => {
  const rows = await all(
    POST + ' AND u.private=0 AND p.user_id<>$2 ORDER BY p.created DESC LIMIT 60',
    [req.user.id, req.user.id]
  );
  res.json(await fin(rows, req.user.id));
});

app.get('/api/post/:id', auth, async (req, res) => {
  const p = await getPost(req.params.id, req.user.id);
  p ? res.json(p) : res.status(404).json({ error: 'Post não encontrado.' });
});

app.post('/api/posts', auth, up.single('media'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Escolha uma foto ou vídeo.' });
  if (kind(req.file) === 'audio') return res.status(400).json({ error: 'Aqui só é permitido foto ou vídeo.' });

  const caption = (req.body.caption || '').slice(0, 500);
  const song_preview = (req.body.song_preview || '').slice(0, 300);
  const song_duration = Math.max(0, Math.min(300, +req.body.song_duration || 0));

  const r = await run(
    'INSERT INTO posts(user_id,caption,media,type,song_preview,song_duration,created) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',
    [req.user.id, caption, '/uploads/' + req.file.filename, kind(req.file), song_preview, song_duration, Date.now()]
  );
  const pid = Number(r.rows[0].id);

  const tags = await parseTags(req.body.tags, caption, req.user.id);
  for (const uid of tags) {
    await run('INSERT INTO tags(post_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [pid, uid]);
    await notify(uid, req.user.id, 'tag', pid);
  }

  res.json({ ok: true });
});

app.post('/api/posts/:id/tag', auth, async (req, res) => {
  const pid = +req.params.id;
  const me = req.user.id;
  const post = await get('SELECT user_id FROM posts WHERE id=$1', [pid]);
  if (!post || post.user_id !== me) return res.status(403).json({ error: 'Não autorizado.' });

  const { username } = req.body || {};
  if (!username) return res.status(400).json({ error: 'Nome de usuário necessário.' });

  const user = await get('SELECT id FROM users WHERE LOWER(username)=$1', [String(username).replace(/^@/, '').toLowerCase()]);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });

  await run('INSERT INTO tags(post_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [pid, user.id]);
  await notify(user.id, me, 'tag', pid);
  res.json({ ok: true });
});

app.post('/api/posts/:id/repost', auth, async (req, res) => {
  const o = await get('SELECT p.*,u.private AS priv FROM posts p JOIN users u ON u.id=p.user_id WHERE p.id=$1', [req.params.id]);
  if (!o || (o.priv && o.user_id !== req.user.id)) return res.status(400).json({ error: 'Não é possível republicar este post.' });

  await run(
    'INSERT INTO posts(user_id,caption,media,type,repost_of,created) VALUES($1,$2,$3,$4,$5,$6)',
    [req.user.id, o.caption, o.media, o.type, o.repost_of || o.id, Date.now()]
  );
  await notify(o.user_id, req.user.id, 'repost', o.id);
  res.json({ ok: true });
});

app.post('/api/posts/:id/like', auth, async (req, res) => {
  const a = [req.user.id, req.params.id];
  const owner = await get('SELECT user_id FROM posts WHERE id=$1', [req.params.id]);
  const deleted = await run('DELETE FROM likes WHERE user_id=$1 AND post_id=$2', a);

  if (!deleted.rowCount) {
    await run('INSERT INTO likes(user_id,post_id) VALUES($1,$2) ON CONFLICT DO NOTHING', a);
    if (owner) await notify(owner.user_id, req.user.id, 'like', +req.params.id);
  } else {
    await run("DELETE FROM notifs WHERE actor_id=$1 AND post_id=$2 AND type='like'", a);
  }
  res.json({ ok: true });
});

app.post('/api/posts/:id/comments', auth, async (req, res) => {
  const t = (req.body.text || '').trim().slice(0, 300);
  if (!t) return res.status(400).json({ error: 'Comentário vazio.' });

  await run('INSERT INTO comments(post_id,user_id,text,created) VALUES($1,$2,$3,$4)', [req.params.id, req.user.id, t, Date.now()]);

  const owner = await get('SELECT user_id FROM posts WHERE id=$1', [req.params.id]);
  const ment = await mentionIds(t, req.user.id);

  if (owner && !ment.includes(owner.user_id)) await notify(owner.user_id, req.user.id, 'comment', +req.params.id, t);
  for (const uid of ment) await notify(uid, req.user.id, 'mention', +req.params.id, t);

  res.json({ ok: true });
});

// ---------- Reels ----------
app.get('/api/reels', auth, async (req, res) => {
  const me = req.user.id;
  const rows = await all(
    `${POST} AND p.type='video' AND p.repost_of IS NULL
      AND (u.private=0 OR p.user_id=$2 OR p.user_id IN (SELECT followee FROM follows WHERE follower=$3 AND status='ok'))
      ORDER BY p.created DESC LIMIT 40`,
    [me, me, me]
  );
  const reels = await fin(rows, me);
  reels.forEach((reel) => { reel.canDelete = reel.user_id === me; });
  res.json(reels);
});

// ---------- Editar / excluir post ----------
app.put('/api/posts/:id', auth, async (req, res) => {
  const id = +req.params.id;
  const me = req.user.id;
  const p = await get('SELECT user_id FROM posts WHERE id=$1 AND deleted=0', [id]);
  if (!p || p.user_id !== me) return res.status(403).json({ error: 'Não autorizado.' });

  const { caption, song_preview, song_duration } = req.body || {};
  await run(
    'UPDATE posts SET caption=COALESCE($1,caption), song_preview=COALESCE($2,song_preview), song_duration=COALESCE($3,song_duration), edited_at=$4 WHERE id=$5',
    [caption, song_preview, song_duration, Date.now(), id]
  );
  res.json({ ok: true });
});

app.delete('/api/posts/:id', auth, async (req, res) => {
  const id = +req.params.id;
  const me = req.user.id;
  const p = await get('SELECT user_id FROM posts WHERE id=$1', [id]);
  if (!p || p.user_id !== me) return res.status(403).json({ error: 'Não autorizado.' });

  await run('UPDATE posts SET deleted=1 WHERE id=$1', [id]);
  res.json({ ok: true });
});

// ---------- Fixar / desfixar post ----------
app.post('/api/posts/:id/pin', auth, async (req, res) => {
  const id = +req.params.id;
  const me = req.user.id;
  const p = await get('SELECT user_id FROM posts WHERE id=$1 AND deleted=0', [id]);
  if (!p || p.user_id !== me) return res.status(403).json({ error: 'Não autorizado.' });

  const cur = await get('SELECT pinned FROM posts WHERE id=$1', [id]);
  await run('UPDATE posts SET pinned=$1 WHERE id=$2', [cur.pinned === 0 ? 1 : 0, id]);
  res.json({ ok: true, pinned: cur.pinned === 0 ? 1 : 0 });
});
// ---------- Comentários ----------
app.put('/api/comments/:id', auth, async (req, res) => {
  const id = +req.params.id;
  const me = req.user.id;
  const c = await get('SELECT user_id FROM comments WHERE id=$1 AND deleted=0', [id]);
  if (!c || c.user_id !== me) return res.status(403).json({ error: 'Não autorizado.' });

  const { text } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'Comentário vazio.' });

  await run('UPDATE comments SET text=$1, edited_at=$2 WHERE id=$3', [text.trim(), Date.now(), id]);
  res.json({ ok: true });
});

app.delete('/api/comments/:id', auth, async (req, res) => {
  const id = +req.params.id;
  const me = req.user.id;
  const c = await get('SELECT user_id FROM comments WHERE id=$1', [id]);
  if (!c || c.user_id !== me) return res.status(403).json({ error: 'Não autorizado.' });

  await run('UPDATE comments SET deleted=1 WHERE id=$1', [id]);
  res.json({ ok: true });
});

// ---------- Editar / excluir mensagem DM ----------
app.put('/api/messages/:id', auth, async (req, res) => {
  const id = +req.params.id;
  const me = req.user.id;
  const m = await get('SELECT from_id, media FROM messages WHERE id=$1 AND deleted=0', [id]);
  if (!m || m.from_id !== me) return res.status(403).json({ error: 'Não autorizado.' });

  const text = String((req.body || {}).text || '').trim().slice(0, 1000);
  // Mensagem só de texto não pode ficar vazia; com mídia, pode limpar o texto
  if (!text && !m.media) return res.status(400).json({ error: 'Mensagem vazia.' });

  await run('UPDATE messages SET text=$1, edited_at=$2 WHERE id=$3', [text, Date.now(), id]);
  res.json({ ok: true });
});

app.delete('/api/messages/:id', auth, async (req, res) => {
  const id = +req.params.id;
  const me = req.user.id;
  const m = await get('SELECT from_id FROM messages WHERE id=$1', [id]);
  if (!m || m.from_id !== me) return res.status(403).json({ error: 'Não autorizado.' });

  await run('UPDATE messages SET deleted=1 WHERE id=$1', [id]);
  res.json({ ok: true });
});

// ---------- Mensagens ----------
app.get('/api/chats', auth, async (req, res) => {
  const me = req.user.id;
  const rows = await all(`
    SELECT u.id,u.username,u.avatar,u.verified,u.verified_color,
      lm.created AS last, lm.text AS last_text, lm.type AS last_type, lm.from_id AS last_from,
      COALESCE(rd.unread,0) AS unread,
      (u.id IN (SELECT peer_id FROM pinned_chats WHERE user_id=$1)) AS pinned
    FROM users u
    LEFT JOIN messages lm ON lm.id = (
      SELECT m2.id FROM messages m2 WHERE m2.deleted=0 AND
        ((m2.from_id=$2 AND m2.to_id=u.id) OR (m2.from_id=u.id AND m2.to_id=$2))
      ORDER BY m2.id DESC LIMIT 1)
    LEFT JOIN (
      SELECT m.from_id AS peer, COUNT(*) AS unread FROM messages m
      WHERE m.deleted=0 AND m.to_id=$3
        AND m.created > COALESCE((SELECT r.last_read FROM chat_reads r WHERE r.user_id=$4 AND r.peer_id=m.from_id),0)
      GROUP BY m.from_id) rd ON rd.peer=u.id
    WHERE u.id<>$5 AND (
      u.id IN (SELECT followee FROM follows WHERE follower=$6 AND status='ok')
      OR u.id IN (SELECT to_id FROM messages WHERE from_id=$7)
      OR u.id IN (SELECT from_id FROM messages WHERE to_id=$8))
    ORDER BY pinned DESC, COALESCE(lm.created,0) DESC, u.id ASC
  `, [me, me, me, me, me, me, me, me]);
  res.json(rows);
});

app.post('/api/chat/read/:id', auth, async (req, res) => {
  const me = req.user.id;
  const peerId = +req.params.id;
  if (!Number.isFinite(peerId) || !await userById(peerId)) return res.status(404).json({ error: 'Usuário não encontrado.' });

  await run(`
    INSERT INTO chat_reads(user_id,peer_id,last_read) VALUES($1,$2,$3)
    ON CONFLICT(user_id,peer_id) DO UPDATE SET last_read=excluded.last_read
  `, [me, peerId, Date.now()]);
  res.json({ ok: true });
});

app.get('/api/messages/:id', auth, async (req, res) => {
  const me = req.user.id;
  const o = req.params.id;
  const rows = await all(`
    SELECT * FROM messages WHERE ((from_id=$1 AND to_id=$2) OR (from_id=$2 AND to_id=$1)) AND deleted=0
    ORDER BY id DESC LIMIT 100
  `, [me, o]);
  const mapped = [];
  for (const m of rows.reverse()) {
    let post = null;
    if (m.post_id) post = await getPost(m.post_id, me);
    mapped.push({ ...m, post });
  }
  res.json(mapped);
});

// ---------- Notificações ----------
app.get('/api/notifs', auth, async (req, res) => {
  const me = req.user.id;
  const rows = await all(`SELECT n.id,n.type,n.post_id,n.created,n.seen,n.text,u.id uid,u.username,u.avatar,u.verified,u.verified_color,
    p.media p_media,p.type p_type,
    s.media s_media,s.type s_type
    FROM notifs n JOIN users u ON u.id=n.actor_id
    LEFT JOIN posts p ON p.id=n.post_id AND n.type NOT IN ('story_reply','story_view')
    LEFT JOIN stories s ON s.id=n.post_id AND n.type IN ('story_reply','story_view')
    WHERE n.user_id=$1 ORDER BY n.created DESC LIMIT 60`, [me]);
  const out = [];
  for (const r of rows) {
    if (r.type === 'request') {
      const f = await get('SELECT status FROM follows WHERE follower=$1 AND followee=$2', [r.uid, me]);
      if (!f || f.status !== 'pending') r.type = 'follow';
    }
    if (r.type === 'story_reply') { r.media = r.s_media; r.ptype = r.s_type; }
    else { r.media = r.p_media; r.ptype = r.p_type; }
    out.push({ ...r, rel: (r.type === 'follow' || r.type === 'request') ? await rel(me, r.uid) : null });
  }
  res.json(out);
});
app.get('/api/notifs/count', auth, async (req, res) => res.json({ n: await num('SELECT COUNT(*) n FROM notifs WHERE user_id=$1 AND seen=0', [req.user.id]) }));
app.post('/api/notifs/read', auth, async (req, res) => { await run('UPDATE notifs SET seen=1 WHERE user_id=$1', [req.user.id]); res.json({ ok: true }); });

// ---------- Stories ----------
app.post('/api/stories', auth, up.single('media'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Escolha uma foto ou vídeo.' });
  if (kind(req.file) === 'audio') return res.status(400).json({ error: 'Aqui só é permitido foto ou vídeo.' });

  const created = Date.now();
  const mentions = (String(req.body.mentions || '').match(/[a-zA-Z0-9_]{3,20}/g) || []).map((x) => x.toLowerCase()).slice(0, 10).join(',');

  await run(
    'INSERT INTO stories(user_id,media,type,created,expires_at,mentions) VALUES($1,$2,$3,$4,$5,$6)',
    [req.user.id, '/uploads/' + req.file.filename, kind(req.file), created, created + 864e5, mentions]
  );

  for (const n of mentions.split(',').filter(Boolean)) {
    const u = await get('SELECT id FROM users WHERE LOWER(username)=$1', [n]);
    if (u) await notify(u.id, req.user.id, 'story_mention');
  }

  res.json({ ok: true });
});

app.get('/api/stories', auth, async (req, res) => {
  const me = req.user.id;
  const now = Date.now();
  const rows = await all(`
    SELECT s.id,s.media,s.type,s.created,s.mentions,u.id uid,u.username,u.avatar,u.verified,u.verified_color,
      COALESCE(s.expires_at, s.created + 864e5) AS expires_at,
      (SELECT COUNT(DISTINCT v.viewer_id) FROM story_views v WHERE v.story_id=s.id AND v.viewer_id<>s.user_id) AS views
    FROM stories s JOIN users u ON u.id=s.user_id
    WHERE s.created > $1 AND (s.user_id=$2 OR s.user_id IN (SELECT followee FROM follows WHERE follower=$3 AND status='ok'))
    ORDER BY s.created
  `, [now - 864e5, me, me]);

  const seenRows = await all('SELECT story_id FROM story_views WHERE viewer_id=$1', [me]);
  const seen = new Set(seenRows.map((r) => r.story_id));

  rows.forEach((r) => {
    r.seen = seen.has(r.id);
    r.expired = r.expires_at < now;
    if (r.uid !== me) delete r.views;
  });

  const g = {};
  for (const r of rows) {
    if (!g[r.uid]) g[r.uid] = { uid: r.uid, username: r.username, avatar: r.avatar, items: [] };
    g[r.uid].items.push(r);
  }

  const groups = Object.values(g).map((x) => ({
    ...x,
    seen: x.uid !== me && x.items.every((i) => i.seen)
  }));

  groups.sort((a, b) => (b.uid === me) - (a.uid === me));
  res.json(groups);
});

app.get('/api/stories/user/:name', auth, async (req, res) => {
  const row = await get('SELECT id FROM users WHERE LOWER(username)=$1', [String(req.params.name || '').toLowerCase()]);
  if (!row) return res.status(404).json({ error: 'Perfil não encontrado.' });
  const u = await userById(row.id);
  if (!u) return res.status(404).json({ error: 'Perfil não encontrado.' });
  res.json(await storyGroupFor(req.user.id, u));
});

app.delete('/api/stories/:id', auth, async (req, res) => {
  const id = +req.params.id;
  const me = req.user.id;
  const s = await get('SELECT user_id FROM stories WHERE id=$1', [id]);
  if (!s || s.user_id !== me) return res.status(403).json({ error: 'Não autorizado.' });

  await run('DELETE FROM stories WHERE id=$1', [id]);
  await run('DELETE FROM story_views WHERE story_id=$1', [id]);
  await run('DELETE FROM story_reactions WHERE story_id=$1', [id]);
  res.json({ ok: true });
});

// ---------- Reações a Story ----------
app.post('/api/stories/:id/like', auth, async (req, res) => {
  const id = +req.params.id;
  const me = req.user.id;
  await run('INSERT INTO story_reactions(story_id,user_id,type,created) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [id, me, 'like', Date.now()]);
  res.json({ ok: true });
});

app.post('/api/stories/:id/comment', auth, async (req, res) => {
  const id = +req.params.id;
  const me = req.user.id;
  const { text } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'Comentário vazio.' });

  await run('INSERT INTO story_reactions(story_id,user_id,type,text,created) VALUES($1,$2,$3,$4,$5)', [id, me, 'comment', text.trim(), Date.now()]);

  const s = await get('SELECT user_id,media,type FROM stories WHERE id=$1', [id]);
  if (s && s.user_id !== me) {
    const created = Date.now();
    const r = await run(
      'INSERT INTO messages(from_id,to_id,text,media,type,created) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
      [me, s.user_id, text.trim(), s.media, 'story_reply', created]
    );
    io.to('u' + s.user_id).emit('msg', {
      id: Number(r.rows[0].id),
      from_id: me,
      to_id: s.user_id,
      text: text.trim(),
      post_id: null,
      media: s.media,
      type: 'story_reply',
      created
    });
  }
  res.json({ ok: true });
});

app.get('/api/stories/:id/reactions', auth, async (req, res) => {
  const id = +req.params.id;
  const rows = await all('SELECT r.id,r.type,r.text,r.created,u.id uid,u.username,u.avatar,u.verified,u.verified_color FROM story_reactions r JOIN users u ON u.id=r.user_id WHERE r.story_id=$1 ORDER BY r.created', [id]);
  res.json(rows);
});

// ---------- Visualizações de Story ----------
app.post('/api/stories/:id/view', auth, async (req, res) => {
  const id = +req.params.id;
  const me = req.user.id;
  const s = await get('SELECT user_id FROM stories WHERE id=$1', [id]);
  if (!s) return res.status(404).json({ error: 'Story não encontrada.' });
  if (s.user_id === me) return res.json({ ok: true, counted: false });

  const already = await get('SELECT 1 FROM story_views WHERE story_id=$1 AND viewer_id=$2', [id, me]);
  if (!already) {
    await run('INSERT INTO story_views(story_id,viewer_id,viewed_at,is_unique) VALUES($1,$2,$3,1)', [id, me, Date.now()]);
    io.to('u' + s.user_id).emit('story_view', { story_id: id, viewer_id: me });
  }
  res.json({ ok: true, counted: !already });
});

app.get('/api/stories/:id/views', auth, async (req, res) => {
  const id = +req.params.id;
  const me = req.user.id;
  const st = await get('SELECT user_id FROM stories WHERE id=$1', [id]);
  if (!st) return res.status(404).json({ error: 'Story não encontrada.' });
  if (st.user_id !== me) return res.status(403).json({ error: 'Só o dono do story vê quem visualizou.' });

  const count = await num('SELECT COUNT(DISTINCT viewer_id) AS n FROM story_views WHERE story_id=$1 AND viewer_id<>$2', [id, st.user_id]);
  const viewers = await all('SELECT v.viewer_id,v.viewed_at,u.id uid,u.username,u.avatar,u.verified,u.verified_color FROM story_views v JOIN users u ON u.id=v.viewer_id WHERE v.story_id=$1 AND v.viewer_id<>$2 ORDER BY v.viewed_at DESC', [id, st.user_id]);
  res.json({ count, viewers });
});
// ---------- Bloquear / desbloquear ----------
app.post('/api/block/:id', auth, async (req, res) => {
  const id = +req.params.id;
  const me = req.user.id;
  if (id === me) return res.status(400).json({ error: 'Não pode bloquear a si mesmo.' });

  const had = await run('DELETE FROM blocked_users WHERE blocker=$1 AND blocked=$2', [me, id]);
  if (!had.rowCount) {
    await run('INSERT INTO blocked_users VALUES($1,$2)', [me, id]);
  }
  res.json({ ok: true, blocked: !had.rowCount });
});

app.get('/api/blocked', auth, async (req, res) => {
  const rows = await all('SELECT u.id,u.username,u.avatar FROM blocked_users b JOIN users u ON u.id=b.blocked WHERE b.blocker=$1', [req.user.id]);
  res.json(rows);
});

// ---------- Trocar username ----------
app.post('/api/username/change', auth, async (req, res) => {
  const me = req.user.id;
  const new_username = String((req.body || {}).new_username || '').toLowerCase();
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(new_username || '')) return res.status(400).json({ error: 'Usuário: 3 a 20 letras, números ou _.' });

  const u = await get('SELECT username_change_count, last_username_change FROM users WHERE id=$1', [me]);
  const now = Date.now();
  const seteDias = 7 * 24 * 60 * 60 * 1000;
  if (u.username_change_count >= 2 && now - u.last_username_change < seteDias) {
    return res.status(403).json({ error: 'Limite: 2 trocas de username a cada 7 dias.' });
  }

  try {
    await run('UPDATE users SET username=$1, username_change_count=username_change_count+1, last_username_change=$2 WHERE id=$3', [new_username, now, me]);
    res.json({ ok: true, token: sign({ id: me, username: new_username }), username: new_username });
  } catch {
    res.status(409).json({ error: 'Esse nome de usuário já existe.' });
  }
});

// ---------- Desativar / excluir conta ----------
app.post('/api/account/deactivate', auth, async (req, res) => {
  const me = req.user.id;
  const u = await get('SELECT password FROM users WHERE id=$1', [me]);
  if (!u || !bcrypt.compareSync((req.body || {}).password || '', u.password)) {
    return res.status(403).json({ error: 'Senha incorreta.' });
  }
  await run('UPDATE users SET deactivated=1 WHERE id=$1', [me]);
  res.json({ ok: true });
});

app.delete('/api/account/delete', auth, async (req, res) => {
  const me = req.user.id;
  const u = await get('SELECT password FROM users WHERE id=$1', [me]);
  if (!u || !bcrypt.compareSync((req.body || {}).password || '', u.password)) {
    return res.status(403).json({ error: 'Senha incorreta.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM comments WHERE user_id=$1 OR post_id IN (SELECT id FROM posts WHERE user_id=$1)', [me]);
    await client.query('DELETE FROM likes WHERE user_id=$1 OR post_id IN (SELECT id FROM posts WHERE user_id=$1)', [me]);
    await client.query('DELETE FROM tags WHERE user_id=$1 OR post_id IN (SELECT id FROM posts WHERE user_id=$1)', [me]);
    await client.query('DELETE FROM notifs WHERE user_id=$1 OR actor_id=$1', [me]);
    await client.query('DELETE FROM story_views WHERE viewer_id=$1 OR story_id IN (SELECT id FROM stories WHERE user_id=$1)', [me]);
    await client.query('DELETE FROM story_reactions WHERE user_id=$1 OR story_id IN (SELECT id FROM stories WHERE user_id=$1)', [me]);
    await client.query('DELETE FROM stories WHERE user_id=$1', [me]);
    await client.query('DELETE FROM posts WHERE user_id=$1', [me]);
    await client.query('DELETE FROM messages WHERE from_id=$1 OR to_id=$1', [me]);
    await client.query('DELETE FROM follows WHERE follower=$1 OR followee=$1', [me]);
    await client.query('DELETE FROM blocked_users WHERE blocker=$1 OR blocked=$1', [me]);
    await client.query('DELETE FROM pinned_chats WHERE user_id=$1 OR peer_id=$1', [me]);
    await client.query('DELETE FROM chat_reads WHERE user_id=$1 OR peer_id=$1', [me]);
    await client.query('DELETE FROM users WHERE id=$1', [me]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'Não foi possível excluir a conta.' });
  } finally {
    client.release();
  }
  res.json({ ok: true });
});

// ---------- DM media ----------
app.post('/api/dm/media', auth, up.single('media'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Escolha uma imagem, vídeo ou arquivo de áudio.' });
  res.json({ url: '/uploads/' + req.file.filename, type: kind(req.file), name: req.file.originalname || '' });
});

// ---------- DM note ----------
app.post('/api/dm/note', auth, async (req, res) => {
  const { to, text, song_preview, song_duration } = req.body || {};
  if (!to) return res.status(400).json({ error: 'Destinatário necessário.' });
  if (!text && !song_preview) return res.status(400).json({ error: 'Envie uma nota ou música.' });

  const me = req.user.id;
  if (!await userById(to)) return res.status(404).json({ error: 'Usuário não encontrado.' });

  const created = Date.now();
  const r = await run(
    'INSERT INTO messages(from_id,to_id,text,media,type,created) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
    [me, to, text || '', song_preview || '', song_preview ? 'song' : '', created]
  );
  const m = {
    id: Number(r.rows[0].id),
    from_id: me,
    to_id: to,
    text: text || '',
    media: song_preview || '',
    type: song_preview ? 'song' : '',
    created
  };
  io.to('u' + to).to('u' + me).emit('msg', m);
  res.json({ ok: true, message: m });
});

// ---------- Download ----------
app.get('/api/download/:kind/:id', auth, async (req, res) => {
  const { kind: k, id } = req.params;
  let row;
  if (k === 'post') row = await get('SELECT media FROM posts WHERE id=$1 AND deleted=0', [id]);
  else if (k === 'story') row = await get('SELECT media FROM stories WHERE id=$1', [id]);
  else return res.status(400).json({ error: 'Tipo inválido.' });

  if (!row || !row.media) return res.status(404).json({ error: 'Não encontrado.' });
  const filePath = path.join(__dirname, row.media);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Arquivo não existe.' });
  res.download(filePath);
});

// ---------- Chat pin ----------
app.post('/api/chat/pin/:id', auth, async (req, res) => {
  const peerId = +req.params.id;
  const me = req.user.id;
  if (!await userById(peerId)) return res.status(404).json({ error: 'Usuário não encontrado.' });

  const had = await run('DELETE FROM pinned_chats WHERE user_id=$1 AND peer_id=$2', [me, peerId]);
  if (!had.rowCount) {
    await run('INSERT INTO pinned_chats VALUES($1,$2,$3)', [me, peerId, Date.now()]);
  }
  res.json({ ok: true, pinned: !had.rowCount });
});

// ---------- Excluir chat ----------
app.delete('/api/chat/:id', auth, async (req, res) => {
  const peerId = +req.params.id;
  const me = req.user.id;
  await run('DELETE FROM messages WHERE (from_id=$1 AND to_id=$2) OR (from_id=$2 AND to_id=$1)', [me, peerId]);
  await run('DELETE FROM pinned_chats WHERE user_id=$1 AND peer_id=$2', [me, peerId]);
  await run('DELETE FROM chat_reads WHERE user_id=$1 AND peer_id=$2', [me, peerId]);
  res.json({ ok: true });
});

// ---------- Socket.io ----------
io.use((s, next) => {
  try {
    s.user = jwt.verify(s.handshake.auth.token, SECRET);
    next();
  } catch {
    next(new Error('não autorizado'));
  }
});

io.on('connection', (s) => {
  s.join('u' + s.user.id);

  s.on('msg', async ({ to, text, post_id, media, media_type }) => {
    text = String(text || '').trim().slice(0, 1000);
    post_id = post_id ? +post_id : null;
    media = media || '';
    media_type = media_type || '';

    if ((!text && !post_id && !media) || !await userById(to)) return;
    if (post_id && !(await getPost(post_id, s.user.id))) return;

    const created = Date.now();
    const r = await run(
      'INSERT INTO messages(from_id,to_id,text,post_id,media,type,created) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [s.user.id, to, text, post_id, media, media_type, created]
    );
    const m = {
      id: Number(r.rows[0].id),
      from_id: s.user.id,
      to_id: to,
      text,
      post_id,
      media,
      type: media_type,
      created
    };
    io.to('u' + to).to('u' + s.user.id).emit('msg', m);
  });
});

// ---------- 404 API ----------
app.use('/api', (req, res) => res.status(404).json({ error: 'Recurso não encontrado.' }));

// ---------- Error handler ----------
app.use((e, req, res, next) => {
  if (res.headersSent) return next(e);
  res.status(400).json({ error: e && e.code === 'LIMIT_FILE_SIZE' ? 'Arquivo muito grande (máx. 60 MB).' : 'Erro no envio. Tente novamente.' });
});

server.listen(PORT, () => console.log(`ANARCHY rodando em http://localhost:${PORT}`));