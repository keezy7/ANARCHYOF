const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { Server } = require('socket.io');

const SECRET = process.env.JWT_SECRET || 'anarchy-archives-2026-segredo-secreto-alterado';
const PORT = process.env.PORT || 3000;
fs.mkdirSync(path.join(__dirname, 'uploads'), { recursive: true });

const db = new DatabaseSync(path.join(__dirname, 'anarchy.db'));
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL,
  name TEXT DEFAULT '', bio TEXT DEFAULT '', avatar TEXT, private INTEGER DEFAULT 0, verified INTEGER DEFAULT 0,
  verified_color TEXT DEFAULT '',
  song_title TEXT DEFAULT '', song_artist TEXT DEFAULT '', song_url TEXT DEFAULT '', song_art TEXT DEFAULT '',
  song_start INTEGER DEFAULT 0, song_dur INTEGER DEFAULT 0,
  username_change_count INTEGER DEFAULT 0, last_username_change INTEGER DEFAULT 0,
  deactivated INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS follows(follower INTEGER, followee INTEGER, status TEXT, PRIMARY KEY(follower, followee));
CREATE TABLE IF NOT EXISTS blocked_users(blocker INTEGER, blocked INTEGER, PRIMARY KEY(blocker, blocked));
CREATE TABLE IF NOT EXISTS pinned_chats(user_id INTEGER, peer_id INTEGER, pinned_at INTEGER NOT NULL, PRIMARY KEY(user_id, peer_id));
CREATE TABLE IF NOT EXISTS posts(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, caption TEXT DEFAULT '', media TEXT, type TEXT, repost_of INTEGER, created INTEGER NOT NULL,
  song_preview TEXT DEFAULT '', song_duration INTEGER DEFAULT 0, deleted INTEGER DEFAULT 0, edited_at INTEGER DEFAULT 0, pinned INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS likes(user_id INTEGER, post_id INTEGER, PRIMARY KEY(user_id, post_id));
CREATE TABLE IF NOT EXISTS comments(id INTEGER PRIMARY KEY, post_id INTEGER NOT NULL, user_id INTEGER NOT NULL, text TEXT NOT NULL, created INTEGER NOT NULL,
  edited_at INTEGER DEFAULT 0, deleted INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS stories(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, media TEXT, type TEXT, created INTEGER NOT NULL, expires_at INTEGER DEFAULT 0, mentions TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS story_views(id INTEGER PRIMARY KEY, story_id INTEGER, viewer_id INTEGER, viewed_at INTEGER NOT NULL, is_unique INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS story_reactions(id INTEGER PRIMARY KEY, story_id INTEGER, user_id INTEGER, type TEXT NOT NULL, text TEXT DEFAULT '', created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY, from_id INTEGER NOT NULL, to_id INTEGER NOT NULL, text TEXT DEFAULT '', post_id INTEGER, media TEXT, type TEXT, created INTEGER NOT NULL,
  edited_at INTEGER DEFAULT 0, deleted INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS tags(post_id INTEGER, user_id INTEGER, PRIMARY KEY(post_id, user_id));
CREATE TABLE IF NOT EXISTS notifs(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, actor_id INTEGER NOT NULL, type TEXT NOT NULL, post_id INTEGER, story_id INTEGER, created INTEGER NOT NULL, seen INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS chat_reads(user_id INTEGER, peer_id INTEGER, last_read INTEGER NOT NULL, PRIMARY KEY(user_id, peer_id));
`);

// Migraçăo: adicionar colunas novas em tabelas existentes (se faltarem)
const addCol = (table, col, def) => {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def};`); } catch { /* já existe */ }
};
addCol('users', 'username_change_count', 'INTEGER DEFAULT 0');
addCol('users', 'last_username_change', 'INTEGER DEFAULT 0');
addCol('users', 'verified_color', "TEXT DEFAULT ''");
addCol('users', 'song_start', 'INTEGER DEFAULT 0');
addCol('users', 'song_dur', 'INTEGER DEFAULT 0');
addCol('users', 'deactivated', 'INTEGER DEFAULT 0');
addCol('posts', 'song_preview', "TEXT DEFAULT ''");
addCol('posts', 'song_duration', 'INTEGER DEFAULT 0');
addCol('posts', 'deleted', 'INTEGER DEFAULT 0');
addCol('posts', 'edited_at', 'INTEGER DEFAULT 0');
addCol('posts', 'pinned', 'INTEGER DEFAULT 0');
addCol('comments', 'edited_at', 'INTEGER DEFAULT 0');
addCol('comments', 'deleted', 'INTEGER DEFAULT 0');
addCol('stories', 'expires_at', 'INTEGER DEFAULT 0');
addCol('stories', 'mentions', "TEXT DEFAULT ''");
addCol('messages', 'media', 'TEXT DEFAULT \'\'');
addCol('messages', 'type', 'TEXT DEFAULT \'\'');
addCol('messages', 'edited_at', 'INTEGER DEFAULT 0');
addCol('messages', 'deleted', 'INTEGER DEFAULT 0');
addCol('notifs', 'story_id', 'INTEGER');
addCol('notifs', 'text', "TEXT DEFAULT ''");
// limpeza: versões antigas gravavam " (editado)" dentro do texto do comentário
try { db.exec("UPDATE comments SET text=substr(text,1,length(text)-10) WHERE edited_at>0 AND text LIKE '% (editado)'"); } catch {}
// limpeza: visualizações de story não devem virar notificação
try { db.exec("DELETE FROM notifs WHERE type='story_view'"); } catch {}
const Q = (s) => db.prepare(s);

// Tipos aceitos (imagem, vídeo e TODOS os formatos de áudio comuns)
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
  if (AUDIO_EXT[ne]) return ne; // áudio mantém o formato original escolhido no dispositivo
  const m = String((f && f.mimetype) || '').toLowerCase();
  if (EXT[m]) return EXT[m];
  if (m.startsWith('audio/')) {
    // mimetype de áudio desconhecido: tenta deduzir a extensão pelo subtipo (ex.: audio/x-m4a)
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
const auth = (req, res, next) => {
  try {
    req.user = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), SECRET);
    const acc = Q('SELECT deactivated FROM users WHERE id=?').get(req.user.id);
    if (!acc) return res.status(401).json({ error: 'Sessão expirada.' });
    if (acc.deactivated) return res.status(401).json({ error: 'Esta conta está desativada. Entre novamente para reativá-la.' });
    next();
  }
  catch { res.status(401).json({ error: 'Faça login para continuar.' }); }
};

const userById = (id) => Q('SELECT id,username,name,bio,avatar,private,verified,verified_color,song_title,song_artist,song_url,song_art,song_start,song_dur FROM users WHERE id=?').get(id);
const rel = (me, id) => (me === id ? 'self' : (Q('SELECT status FROM follows WHERE follower=? AND followee=?').get(me, id) || {}).status || 'none');
const canSee = (me, u) => isBlocked(me, u.id) ? false : (!u.private || ['self', 'ok'].includes(rel(me, u.id)));
const num = (s, ...a) => Q(s).get(...a).n;
const httpsOnly = (s) => (/^https:\/\//.test(s || '') ? s : '');

const POST = `SELECT p.id,p.caption,p.media,p.type,p.created,p.user_id,p.repost_of,u.username,u.avatar,u.verified,ou.username AS orig,p.song_preview,p.song_duration,p.edited_at,
 (SELECT COUNT(*) FROM likes WHERE post_id=p.id) AS likes,
 (SELECT COUNT(*) FROM comments WHERE post_id=p.id AND deleted=0) AS ncomments,
 (SELECT COUNT(*) FROM posts r WHERE r.repost_of=COALESCE(p.repost_of,p.id) AND r.deleted=0) AS reposts,
 EXISTS(SELECT 1 FROM likes WHERE post_id=p.id AND user_id=?) AS liked
 FROM posts p JOIN users u ON u.id=p.user_id
 LEFT JOIN posts o ON o.id=p.repost_of LEFT JOIN users ou ON ou.id=o.user_id
 WHERE p.deleted=0`;
const fin = (rows) => rows.map((p) => ({
  ...p, liked: !!p.liked,
  tags: Q('SELECT u.username FROM tags t JOIN users u ON u.id=t.user_id WHERE t.post_id=? ORDER BY u.username').all(p.id).map((x) => x.username),
  comments: Q('SELECT c.id,c.text,u.username,u.verified,c.user_id,c.edited_at,c.deleted FROM comments c JOIN users u ON u.id=c.user_id WHERE c.post_id=? AND c.deleted=0 ORDER BY c.id DESC LIMIT 20').all(p.id).reverse(),
}));
const getPost = (id, me) => fin(Q(POST + ' AND p.id=?').all(me, id))[0] || null;
// Grupo de stories ativos de um usuário (usado no perfil e no indicador de story)
const storyGroupFor = (me, u) => {
  const base = { uid: u.id, username: u.username, avatar: u.avatar, verified: u.verified, items: [], count: 0, seen: false };
  if (!canSee(me, u)) return base;
  const items = Q(`SELECT s.id,s.media,s.type,s.created,s.mentions,
    COALESCE(s.expires_at,s.created+864e5) AS expires_at,
    (SELECT COUNT(DISTINCT v.viewer_id) FROM story_views v WHERE v.story_id=s.id AND v.viewer_id<>s.user_id) AS views
    FROM stories s WHERE s.user_id=? AND s.created>? ORDER BY s.created`).all(u.id, Date.now() - 864e5);
  if (!items.length) return base;
  const seen = new Set(Q('SELECT story_id FROM story_views WHERE viewer_id=?').all(me).map((r) => r.story_id));
  items.forEach((i) => { i.seen = seen.has(i.id); });
  // O próprio usuário sempre vê o indicador ativo; para terceiros só fica "visto" se viu todos.
  const allSeen = u.id !== me && items.every((i) => i.seen);
  return { ...base, items, count: items.length, seen: allSeen };
};
const parseTags = (raw, caption, me) => {
  const names = new Set();
  String(raw || '').split(/[\s,]+/).forEach((x) => { x = x.replace(/^@/, '').toLowerCase(); if (/^[a-zA-Z0-9_]{3,20}$/.test(x)) names.add(x); });
  (String(caption || '').match(/@[a-zA-Z0-9_]{3,20}/g) || []).forEach((x) => names.add(x.slice(1).toLowerCase()));
  return [...names].slice(0, 20).map((n) => Q('SELECT id FROM users WHERE LOWER(username)=?').get(n)).filter((u) => u && u.id !== me).map((u) => u.id);
};
const mentionIds = (text, me) => {
  const names = new Set((String(text || '').match(/(?:^|[^\w])@([a-zA-Z0-9_]{3,20})/g) || []).map((x) => x.replace(/^[^@]*@/, '').toLowerCase()));
  return [...names].slice(0, 10).map((n) => Q('SELECT id FROM users WHERE LOWER(username)=?').get(n)).filter((u) => u && u.id !== me).map((u) => u.id);
};
// Notificações (curtidas, comentários, seguidores, republicações e marcações)
const notify = (to, actor, type, post_id = null, text = '') => {
  if (!to || to === actor) return;
  Q('INSERT INTO notifs(user_id,actor_id,type,post_id,created,text) VALUES(?,?,?,?,?,?)').run(to, actor, type, post_id, Date.now(), String(text || '').slice(0, 120));
  io.to('u' + to).emit('notif');
};

// ---------- Conta ----------
app.post('/api/register', (req, res) => {
  const { username, password } = req.body || {};
  const un = (username || '').toLowerCase();
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(un)) return res.status(400).json({ error: 'Usuário: 3 a 20 letras, números ou _.' });
  if ((password || '').length < 6) return res.status(400).json({ error: 'A senha precisa ter 6 ou mais caracteres.' });
  try {
    const r = Q('INSERT INTO users(username,password,name) VALUES(?,?,?)').run(un, bcrypt.hashSync(password, 10), un);
    res.json({ token: sign({ id: Number(r.lastInsertRowid), username: un }) });
  } catch { res.status(409).json({ error: 'Esse nome de usuário já existe.' }); }
});
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const u = Q('SELECT * FROM users WHERE username=?').get((username || '').toLowerCase());
  if (!u || !bcrypt.compareSync(password || '', u.password)) return res.status(401).json({ error: 'Usuário ou senha incorretos.' });
  // Ao entrar novamente, uma conta desativada volta a ficar ativa.
  if (u.deactivated) Q('UPDATE users SET deactivated=0 WHERE id=?').run(u.id);
  res.json({ token: sign(u) });
});
app.get('/api/me', auth, (req, res) => {
  const u = userById(req.user.id);
  u ? res.json(u) : res.status(401).json({ error: 'Sessão expirada.' });
});
app.put('/api/me', auth, up.single('avatar'), (req, res) => {
  const b = req.body, me = req.user.id;
  const vc = String(b.verified_color || '').trim();
  const vcolor = /^#[0-9a-f]{6}$/i.test(vc) ? vc.toLowerCase() : '';
  const segStart = Math.max(0, Math.min(3600, parseInt(b.song_start, 10) || 0));
  const segDur = Math.max(0, Math.min(300, parseInt(b.song_dur, 10) || 0));
  Q('UPDATE users SET name=?,bio=?,private=?,song_title=?,song_artist=?,song_url=?,song_art=?,verified_color=?,song_start=?,song_dur=? WHERE id=?').run(
    (b.name || '').slice(0, 40), (b.bio || '').slice(0, 150), b.private === '1' ? 1 : 0,
    (b.song_title || '').slice(0, 100), (b.song_artist || '').slice(0, 100), httpsOnly(b.song_url), httpsOnly(b.song_art),
    vcolor, segStart, segDur, me);
  if (req.file && kind(req.file) === 'image') Q('UPDATE users SET avatar=? WHERE id=?').run('/uploads/' + req.file.filename, me);
  res.json(userById(me));
});
app.post('/api/verify', auth, (req, res) => { // assinatura gratuita do selo
  Q('UPDATE users SET verified=1-verified WHERE id=?').run(req.user.id);
  res.json(userById(req.user.id));
});
app.get('/api/badge-colors', auth, (req, res) => { // cores personalizadas dos selos verificados
  res.set('Cache-Control', 'no-store');
  res.json(Q("SELECT LOWER(username) AS username, verified_color FROM users WHERE verified=1 AND verified_color<>''").all());
});

// ---------- Perfis e seguidores ----------
app.get('/api/search', auth, (req, res) => {
  const q = '%' + (req.query.q || '').toLowerCase() + '%';
  res.json(Q('SELECT id,username,name,avatar,verified FROM users WHERE LOWER(username) LIKE ? OR LOWER(name) LIKE ? LIMIT 20').all(q, q));
});
app.get('/api/u/:name', auth, (req, res) => {
  const row = Q('SELECT id FROM users WHERE LOWER(username)=?').get(req.params.name.toLowerCase());
  if (!row) return res.status(404).json({ error: 'Perfil não encontrado.' });
  const u = userById(row.id), me = req.user.id, ok = canSee(me, u);
  res.json({
    user: u, rel: rel(me, u.id), canSee: ok,
    story: storyGroupFor(me, u),
    count: {
      posts: num('SELECT COUNT(*) n FROM posts WHERE user_id=? AND repost_of IS NULL', u.id),
      followers: num("SELECT COUNT(*) n FROM follows WHERE followee=? AND status='ok'", u.id),
      following: num("SELECT COUNT(*) n FROM follows WHERE follower=? AND status='ok'", u.id),
    },
    items: ok ? fin(Q(POST + ' AND p.user_id=? ORDER BY p.pinned DESC, p.created DESC').all(me, u.id)) : [],
    tagged: ok ? fin(Q(POST + ` AND p.id IN (SELECT post_id FROM tags WHERE user_id=?)
      AND (u.private=0 OR p.user_id=? OR p.user_id IN (SELECT followee FROM follows WHERE follower=? AND status='ok'))
      ORDER BY p.created DESC`).all(me, u.id, me, me)) : [],
  });
});
app.post('/api/follow/:id', auth, (req, res) => {
  const id = +req.params.id, me = req.user.id, u = userById(id);
  if (!u || id === me) return res.status(400).json({ error: 'Ação inválida.' });
  const had = Q('DELETE FROM follows WHERE follower=? AND followee=?').run(me, id).changes;
  if (!had) { Q('INSERT INTO follows VALUES(?,?,?)').run(me, id, u.private ? 'pending' : 'ok'); notify(id, me, u.private ? 'request' : 'follow'); }
  else Q("DELETE FROM notifs WHERE user_id=? AND actor_id=? AND type IN ('follow','request')").run(id, me);
  res.json({ ok: true, status: rel(me, id) });
});
app.get('/api/requests', auth, (req, res) => {
  res.json(Q("SELECT u.id,u.username,u.avatar FROM follows f JOIN users u ON u.id=f.follower WHERE f.followee=? AND f.status='pending'").all(req.user.id));
});
app.post('/api/requests/:id/:act', auth, (req, res) => {
  const a = [req.params.id, req.user.id];
  if (req.params.act === 'accept') Q("UPDATE follows SET status='ok' WHERE follower=? AND followee=?").run(...a);
  else Q("DELETE FROM follows WHERE follower=? AND followee=? AND status='pending'").run(...a);
  res.json({ ok: true });
});

// ---------- Posts ----------
app.get('/api/feed', auth, (req, res) => {
  const me = req.user.id;
  const feed = fin(Q(POST + ` AND (p.user_id=? OR p.user_id IN (SELECT followee FROM follows WHERE follower=? AND status='ok'))
    ORDER BY p.pinned DESC, p.created DESC LIMIT 50`).all(me, me, me));
  res.json(feed);
});
app.get('/api/explore', auth, (req, res) => {
  res.json(fin(Q(POST + ' AND u.private=0 AND p.user_id<>? ORDER BY p.created DESC LIMIT 60').all(req.user.id, req.user.id)));
});
app.get('/api/post/:id', auth, (req, res) => {
  const p = getPost(req.params.id, req.user.id);
  p ? res.json(p) : res.status(404).json({ error: 'Post não encontrado.' });
});
app.post('/api/posts', auth, up.single('media'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Escolha uma foto ou vídeo.' });
  if (kind(req.file) === 'audio') return res.status(400).json({ error: 'Aqui só é permitido foto ou vídeo.' });
  const caption = (req.body.caption || '').slice(0, 500);
  const song_preview = (req.body.song_preview || '').slice(0, 300);
  const song_duration = Math.max(0, Math.min(300, +req.body.song_duration || 0));
  const r = Q('INSERT INTO posts(user_id,caption,media,type,song_preview,song_duration,created) VALUES(?,?,?,?,?,?,?)')
    .run(req.user.id, caption, '/uploads/' + req.file.filename, kind(req.file), song_preview, song_duration, Date.now());
  const pid = Number(r.lastInsertRowid);
  parseTags(req.body.tags, caption, req.user.id).forEach((uid) => { Q('INSERT OR IGNORE INTO tags VALUES(?,?)').run(pid, uid); notify(uid, req.user.id, 'tag', pid); });
  res.json({ ok: true });
});

app.post('/api/posts/:id/tag', auth, (req, res) => {
  const pid = +req.params.id;
  const me = req.user.id;
  const post = Q('SELECT user_id FROM posts WHERE id=?').get(pid);
  if (!post || post.user_id !== me) return res.status(403).json({ error: 'Não autorizado.' });
  const { username } = req.body || {};
  if (!username) return res.status(400).json({ error: 'Nome de usuário necessário.' });
  const user = Q('SELECT id FROM users WHERE LOWER(username)=?').get(String(username).replace(/^@/, '').toLowerCase());
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });
  Q('INSERT OR IGNORE INTO tags VALUES(?,?)').run(pid, user.id);
  notify(user.id, me, 'tag', pid);
  res.json({ ok: true });
});
app.post('/api/posts/:id/repost', auth, (req, res) => {
  const o = Q('SELECT p.*,u.private AS priv FROM posts p JOIN users u ON u.id=p.user_id WHERE p.id=?').get(req.params.id);
  if (!o || (o.priv && o.user_id !== req.user.id)) return res.status(400).json({ error: 'Não é possível republicar este post.' });
  Q('INSERT INTO posts(user_id,caption,media,type,repost_of,created) VALUES(?,?,?,?,?,?)')
    .run(req.user.id, o.caption, o.media, o.type, o.repost_of || o.id, Date.now());
  notify(o.user_id, req.user.id, 'repost', o.id);
  res.json({ ok: true });
});
app.post('/api/posts/:id/like', auth, (req, res) => {
  const a = [req.user.id, req.params.id];
  const owner = Q('SELECT user_id FROM posts WHERE id=?').get(req.params.id);
  if (!Q('DELETE FROM likes WHERE user_id=? AND post_id=?').run(...a).changes) {
    Q('INSERT OR IGNORE INTO likes VALUES(?,?)').run(...a);
    if (owner) notify(owner.user_id, req.user.id, 'like', +req.params.id);
  } else Q("DELETE FROM notifs WHERE actor_id=? AND post_id=? AND type='like'").run(...a);
  res.json({ ok: true });
});
app.post('/api/posts/:id/comments', auth, (req, res) => {
  const t = (req.body.text || '').trim().slice(0, 300);
  if (!t) return res.status(400).json({ error: 'Comentário vazio.' });
  Q('INSERT INTO comments(post_id,user_id,text,created) VALUES(?,?,?,?)').run(req.params.id, req.user.id, t, Date.now());
  const owner = Q('SELECT user_id FROM posts WHERE id=?').get(req.params.id);
  const ment = mentionIds(t, req.user.id);
  if (owner && !ment.includes(owner.user_id)) notify(owner.user_id, req.user.id, 'comment', +req.params.id, t);
  ment.forEach((uid) => notify(uid, req.user.id, 'mention', +req.params.id, t));
  res.json({ ok: true });
});

app.get('/api/reels', auth, (req, res) => {
  const me = req.user.id;
  const reels = fin(Q(`${POST} AND p.type='video' AND p.repost_of IS NULL
    AND (u.private=0 OR p.user_id=? OR p.user_id IN (SELECT followee FROM follows WHERE follower=? AND status='ok'))
    ORDER BY p.created DESC LIMIT 40`).all(me, me, me));
  res.json(reels.map(reel => {
    reel.canDelete = reel.user_id === me;
    return reel;
  }));
});

// ---------- Sugestões e notificações ----------
app.get('/api/suggestions', auth, (req, res) => {
  const me = req.user.id, lim = Math.min(+req.query.limit || 5, 30);
  res.json(Q(`SELECT u.id,u.username,u.name,u.avatar,u.verified,
    (SELECT x.username FROM follows f1 JOIN follows f2 ON f2.follower=f1.followee AND f2.followee=u.id AND f2.status='ok'
      JOIN users x ON x.id=f1.followee WHERE f1.follower=? AND f1.status='ok' LIMIT 1) AS via
    FROM users u WHERE u.id<>? AND u.id NOT IN (SELECT followee FROM follows WHERE follower=?)
    ORDER BY (via IS NOT NULL) DESC, u.id DESC LIMIT ?`).all(me, me, me, lim));
});
app.get('/api/notifs', auth, (req, res) => {
  const me = req.user.id;
  const rows = Q(`SELECT n.id,n.type,n.post_id,n.created,n.seen,n.text,u.id uid,u.username,u.avatar,u.verified,
    p.media p_media,p.type p_type,
    s.media s_media,s.type s_type
    FROM notifs n JOIN users u ON u.id=n.actor_id
    LEFT JOIN posts p ON p.id=n.post_id AND n.type NOT IN ('story_reply','story_view')
    LEFT JOIN stories s ON s.id=n.post_id AND n.type IN ('story_reply','story_view')
    WHERE n.user_id=? ORDER BY n.created DESC LIMIT 60`).all(me);
  res.json(rows.map((r) => {
    if (r.type === 'request' && (Q('SELECT status FROM follows WHERE follower=? AND followee=?').get(r.uid, me) || {}).status !== 'pending') r.type = 'follow';
    if (r.type === 'story_reply') { r.media = r.s_media; r.ptype = r.s_type; }
    return { ...r, rel: r.type === 'follow' || r.type === 'request' ? rel(me, r.uid) : null };
  }));
});
app.get('/api/notifs/count', auth, (req, res) => res.json({ n: num('SELECT COUNT(*) n FROM notifs WHERE user_id=? AND seen=0', req.user.id) }));
app.post('/api/notifs/read', auth, (req, res) => { Q('UPDATE notifs SET seen=1 WHERE user_id=?').run(req.user.id); res.json({ ok: true }); });

// ---------- Stories (24h) ----------
app.post('/api/stories', auth, up.single('media'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Escolha uma foto ou vídeo.' });
  if (kind(req.file) === 'audio') return res.status(400).json({ error: 'Aqui só é permitido foto ou vídeo.' });
  const created = Date.now();
  const mentions = (String(req.body.mentions || '').match(/[a-zA-Z0-9_]{3,20}/g) || []).map((x) => x.toLowerCase()).slice(0, 10).join(',');
  Q('INSERT INTO stories(user_id,media,type,created,expires_at,mentions) VALUES(?,?,?,?,?,?)').run(req.user.id, '/uploads/' + req.file.filename, kind(req.file), created, created + 864e5, mentions);
  mentions.split(',').filter(Boolean).forEach((n) => { const u = Q('SELECT id FROM users WHERE LOWER(username)=?').get(n); if (u) notify(u.id, req.user.id, 'story_mention'); });
  res.json({ ok: true });
});
app.get('/api/stories', auth, (req, res) => {
  const me = req.user.id;
  const now = Date.now();
  const rows = Q(`SELECT s.id,s.media,s.type,s.created,s.mentions,u.id uid,u.username,u.avatar,
    COALESCE(s.expires_at, s.created + 864e5) AS expires_at,
    (SELECT COUNT(DISTINCT v.viewer_id) FROM story_views v WHERE v.story_id=s.id AND v.viewer_id<>s.user_id) AS views
    FROM stories s JOIN users u ON u.id=s.user_id
    WHERE s.created > ? AND (s.user_id=? OR s.user_id IN (SELECT followee FROM follows WHERE follower=? AND status='ok')) ORDER BY s.created`).all(now - 864e5, me, me);
  // marcar vistas pelo usuario logado
  const seen = new Set(Q('SELECT story_id FROM story_views WHERE viewer_id=?').all(me).map((r) => r.story_id));
  rows.forEach((r) => { r.seen = seen.has(r.id); r.expired = r.expires_at < now; if (r.uid !== me) delete r.views; });
  const g = {};
  rows.forEach((r) => { (g[r.uid] = g[r.uid] || { uid: r.uid, username: r.username, avatar: r.avatar, items: [] }).items.push(r); });
  // Agrupa e calcula o estado do anel. Sem isso, o story voltava a aparecer como novo ao recarregar.
  const groups = Object.values(g).map((x) => ({ ...x, seen: x.uid !== me && x.items.every((i) => i.seen) }));
  res.json(groups.sort((a, b) => (b.uid === me) - (a.uid === me)));
});
app.get('/api/stories/user/:name', auth, (req, res) => {
  const row = Q('SELECT id FROM users WHERE LOWER(username)=?').get(String(req.params.name || '').toLowerCase());
  if (!row) return res.status(404).json({ error: 'Perfil não encontrado.' });
  const u = userById(row.id);
  if (!u) return res.status(404).json({ error: 'Perfil não encontrado.' });
  res.json(storyGroupFor(req.user.id, u));
});

// ---------- Mensagens ----------
app.get('/api/chats', auth, (req, res) => {
  const me = req.user.id;
  res.json(Q(`SELECT u.id,u.username,u.avatar,u.verified,
    lm.created AS last, lm.text AS last_text, lm.type AS last_type, lm.from_id AS last_from,
    COALESCE(rd.unread,0) AS unread,
    (u.id IN (SELECT peer_id FROM pinned_chats WHERE user_id=?)) AS pinned
    FROM users u
    LEFT JOIN messages lm ON lm.id = (
      SELECT m2.id FROM messages m2 WHERE m2.deleted=0 AND
        ((m2.from_id=? AND m2.to_id=u.id) OR (m2.from_id=u.id AND m2.to_id=?))
      ORDER BY m2.id DESC LIMIT 1)
    LEFT JOIN (
      SELECT m.from_id AS peer, COUNT(*) AS unread FROM messages m
      WHERE m.deleted=0 AND m.to_id=?
        AND m.created > COALESCE((SELECT r.last_read FROM chat_reads r WHERE r.user_id=? AND r.peer_id=m.from_id),0)
      GROUP BY m.from_id) rd ON rd.peer=u.id
    WHERE u.id<>? AND (
      u.id IN (SELECT followee FROM follows WHERE follower=? AND status='ok')
      OR u.id IN (SELECT to_id FROM messages WHERE from_id=?)
      OR u.id IN (SELECT from_id FROM messages WHERE to_id=?))
    ORDER BY pinned DESC, COALESCE(lm.created,0) DESC, u.id ASC`).all(me, me, me, me, me, me, me, me, me));
});
app.post('/api/chat/read/:id', auth, (req, res) => {
  const me = req.user.id, peerId = +req.params.id;
  if (!Number.isFinite(peerId) || !userById(peerId)) return res.status(404).json({ error: 'Usuário não encontrado.' });
  Q(`INSERT INTO chat_reads(user_id,peer_id,last_read) VALUES(?,?,?)
     ON CONFLICT(user_id,peer_id) DO UPDATE SET last_read=excluded.last_read`).run(me, peerId, Date.now());
  res.json({ ok: true });
});
app.get('/api/messages/:id', auth, (req, res) => {
  const me = req.user.id, o = req.params.id;
  const rows = Q(`SELECT * FROM messages WHERE ((from_id=? AND to_id=?) OR (from_id=? AND to_id=?)) AND deleted=0 ORDER BY id DESC LIMIT 100`).all(me, o, o, me).reverse();
  res.json(rows.map((m) => ({ ...m, post: m.post_id ? getPost(m.post_id, me) : null })));
});

// Erros de upload/API são tratados no final do arquivo (depois de todas as rotas).

io.use((s, next) => {
  try { s.user = jwt.verify(s.handshake.auth.token, SECRET); next(); } catch { next(new Error('não autorizado')); }
});
io.on('connection', (s) => {
  s.join('u' + s.user.id);
  s.on('msg', ({ to, text, post_id, media, media_type }) => {
    text = String(text || '').trim().slice(0, 1000);
    post_id = post_id ? +post_id : null;
    media = media || '';
    media_type = media_type || '';
    if ((!text && !post_id && !media) || !userById(to)) return;
    if (post_id && !getPost(post_id, s.user.id)) return;
    const created = Date.now();
    const r = Q('INSERT INTO messages(from_id,to_id,text,post_id,media,type,created) VALUES(?,?,?,?,?,?,?)')
      .run(s.user.id, to, text, post_id, media, media_type, created);
    const m = { id: Number(r.lastInsertRowid), from_id: s.user.id, to_id: to, text, post_id, media, type: media_type, created };
    io.to('u' + to).to('u' + s.user.id).emit('msg', m);
  });
});

// ============ NOVAS FUNCIONALIDADES ============

// ---- Bloquear/desbloquear usuário ----
const isBlocked = (a, b) => !!Q('SELECT 1 FROM blocked_users WHERE blocker=? AND blocked=?').get(a, b);
app.post('/api/block/:id', auth, (req, res) => {
  const id = +req.params.id, me = req.user.id;
  if (id === me) return res.status(400).json({ error: 'Não pode bloquear a si mesmo.' });
  const had = Q('DELETE FROM blocked_users WHERE blocker=? AND blocked=?').run(me, id).changes;
  if (!had) Q('INSERT INTO blocked_users VALUES(?,?)').run(me, id);
  res.json({ ok: true, blocked: !had });
});
app.get('/api/blocked', auth, (req, res) => {
  const rows = Q('SELECT u.id,u.username,u.avatar FROM blocked_users b JOIN users u ON u.id=b.blocked WHERE b.blocker=?').all(req.user.id);
  res.json(rows);
});

// ---- Editar/Excluir Post ----
app.put('/api/posts/:id', auth, (req, res) => {
  const id = +req.params.id, me = req.user.id;
  const p = Q('SELECT user_id FROM posts WHERE id=? AND deleted=0').get(id);
  if (!p || p.user_id !== me) return res.status(403).json({ error: 'Não autorizado.' });
  const { caption, song_preview, song_duration } = req.body || {};
  Q('UPDATE posts SET caption=COALESCE(?,caption), song_preview=COALESCE(?,song_preview), song_duration=COALESCE(?,song_duration), edited_at=? WHERE id=?')
    .run(caption, song_preview, song_duration, Date.now(), id);
  res.json({ ok: true });
});
app.delete('/api/posts/:id', auth, (req, res) => {
  const id = +req.params.id, me = req.user.id;
  const p = Q('SELECT user_id FROM posts WHERE id=?').get(id);
  if (!p || p.user_id !== me) return res.status(403).json({ error: 'Não autorizado.' });
  Q('UPDATE posts SET deleted=1 WHERE id=?').run(id);
  res.json({ ok: true });
});

// ---- Editar/Excluir Comentário ----
app.put('/api/comments/:id', auth, (req, res) => {
  const id = +req.params.id, me = req.user.id;
  const c = Q('SELECT user_id FROM comments WHERE id=? AND deleted=0').get(id);
  if (!c || c.user_id !== me) return res.status(403).json({ error: 'Não autorizado.' });
  const { text } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'Comentário vazio.' });
  Q('UPDATE comments SET text=?, edited_at=? WHERE id=?').run(text.trim(), Date.now(), id);
  res.json({ ok: true });
});
app.delete('/api/comments/:id', auth, (req, res) => {
  const id = +req.params.id, me = req.user.id;
  const c = Q('SELECT user_id FROM comments WHERE id=?').get(id);
  if (!c || c.user_id !== me) return res.status(403).json({ error: 'Não autorizado.' });
  Q('UPDATE comments SET deleted=1 WHERE id=?').run(id);
  res.json({ ok: true });
});

// ---- Editar/Excluir Mensagem DM ----
app.put('/api/messages/:id', auth, (req, res) => {
  const id = +req.params.id, me = req.user.id;
  const m = Q('SELECT from_id FROM messages WHERE id=? AND deleted=0').get(id);
  if (!m) return res.status(404).json({ error: 'Mensagem não encontrada.' });
  if (Number(m.from_id) !== Number(me)) return res.status(403).json({ error: 'Você só pode editar as suas próprias mensagens.' });
  const { text } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'Mensagem vazia.' });
  Q('UPDATE messages SET text=?, edited_at=? WHERE id=?').run(text.trim(), Date.now(), id);
  res.json({ ok: true });
});
app.delete('/api/messages/:id', auth, (req, res) => {
  const id = +req.params.id, me = req.user.id;
  const m = Q('SELECT from_id FROM messages WHERE id=?').get(id);
  if (!m) return res.status(404).json({ error: 'Mensagem não encontrada.' });
  if (Number(m.from_id) !== Number(me)) return res.status(403).json({ error: 'Você só pode excluir as suas próprias mensagens.' });
  Q('UPDATE messages SET deleted=1 WHERE id=?').run(id);
  res.json({ ok: true });
});

// ---- Excluir Story ----
app.delete('/api/stories/:id', auth, (req, res) => {
  const id = +req.params.id, me = req.user.id;
  const s = Q('SELECT user_id FROM stories WHERE id=?').get(id);
  if (!s || s.user_id !== me) return res.status(403).json({ error: 'Não autorizado.' });
  Q('DELETE FROM stories WHERE id=?').run(id);
  Q('DELETE FROM story_views WHERE story_id=?').run(id);
  Q('DELETE FROM story_reactions WHERE story_id=?').run(id);
  res.json({ ok: true });
});

// ---- Reações a Story ----
app.post('/api/stories/:id/like', auth, (req, res) => {
  const id = +req.params.id, me = req.user.id;
  Q('INSERT OR IGNORE INTO story_reactions(story_id,user_id,type,created) VALUES(?,?,?,?)').run(id, me, 'like', Date.now());
  res.json({ ok: true });
});
app.post('/api/stories/:id/comment', auth, (req, res) => {
  const id = +req.params.id, me = req.user.id;
  const { text } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'Comentário vazio.' });
  Q('INSERT INTO story_reactions(story_id,user_id,type,text,created) VALUES(?,?,?,?,?)').run(id, me, 'comment', text.trim(), Date.now());
  const s = Q('SELECT user_id,media,type FROM stories WHERE id=?').get(id);
  if (s && s.user_id !== me) {
    const created = Date.now();
    const r = Q('INSERT INTO messages(from_id,to_id,text,media,type,created) VALUES(?,?,?,?,?,?)')
      .run(me, s.user_id, text.trim(), s.media, 'story_reply', created);
    io.to('u' + s.user_id).emit('msg', {
      id: Number(r.lastInsertRowid), from_id: me, to_id: s.user_id, text: text.trim(),
      post_id: null, media: s.media, type: 'story_reply', created
    });
  }
  res.json({ ok: true });
});
app.get('/api/stories/:id/reactions', auth, (req, res) => {
  const id = +req.params.id;
  const rows = Q('SELECT r.id,r.type,r.text,r.created,u.id uid,u.username,u.avatar,u.verified FROM story_reactions r JOIN users u ON u.id=r.user_id WHERE r.story_id=? ORDER BY r.created').all(id);
  res.json(rows);
});

// ---- Visualizações Únicas de Story ----
// A visualização só é contabilizada quando o story é realmente aberto na tela de visualização.
app.post('/api/stories/:id/view', auth, (req, res) => {
  const id = +req.params.id, me = req.user.id;
  const s = Q('SELECT user_id FROM stories WHERE id=?').get(id);
  if (!s) return res.status(404).json({ error: 'Story não encontrada.' });
  // o dono vendo o próprio story nunca conta como visualização
  if (s.user_id === me) return res.json({ ok: true, counted: false });
  const already = Q('SELECT 1 FROM story_views WHERE story_id=? AND viewer_id=?').get(id, me);
  if (!already) {
    Q('INSERT INTO story_views(story_id,viewer_id,viewed_at,is_unique) VALUES(?,?,?,1)').run(id, me, Date.now());
    // atualiza o contador do dono em tempo real (sem poluir as notificações)
    io.to('u' + s.user_id).emit('story_view', { story_id: id, viewer_id: me });
  }
  res.json({ ok: true, counted: !already });
});
app.get('/api/stories/:id/views', auth, (req, res) => {
  const id = +req.params.id, me = req.user.id;
  const st = Q('SELECT user_id FROM stories WHERE id=?').get(id);
  if (!st) return res.status(404).json({ error: 'Story não encontrada.' });
  if (st.user_id !== me) return res.status(403).json({ error: 'Só o dono do story vê quem visualizou.' });
  const count = Q('SELECT COUNT(DISTINCT viewer_id) AS n FROM story_views WHERE story_id=? AND viewer_id<>?').get(id, st.user_id).n;
  const viewers = Q('SELECT v.viewer_id,v.viewed_at,u.id uid,u.username,u.avatar,u.verified FROM story_views v JOIN users u ON u.id=v.viewer_id WHERE v.story_id=? AND v.viewer_id<>? ORDER BY v.viewed_at DESC').all(id, st.user_id);
  res.json({ count, viewers });
});

// ---- Trocar Username (2x a cada 7 dias) ----
app.post('/api/username/change', auth, (req, res) => {
  const me = req.user.id;
  const new_username = String((req.body || {}).new_username || '').toLowerCase();
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(new_username || '')) return res.status(400).json({ error: 'Usuário: 3 a 20 letras, números ou _.' });
  const u = Q('SELECT username_change_count, last_username_change FROM users WHERE id=?').get(me);
  const now = Date.now();
  const seteDias = 7 * 24 * 60 * 60 * 1000;
  if (u.username_change_count >= 2 && now - u.last_username_change < seteDias) {
    return res.status(403).json({ error: 'Limite: 2 trocas de username a cada 7 dias.' });
  }
  try {
    Q('UPDATE users SET username=?, username_change_count=username_change_count+1, last_username_change=? WHERE id=?').run(new_username, now, me);
    res.json({ ok: true, token: sign({ id: me, username: new_username }), username: new_username });
  } catch { res.status(409).json({ error: 'Esse nome de usuário já existe.' }); }
});

// ---- Desativar / Excluir conta ----
app.post('/api/account/deactivate', auth, (req, res) => {
  const me = req.user.id;
  const u = Q('SELECT password FROM users WHERE id=?').get(me);
  if (!u || !bcrypt.compareSync((req.body || {}).password || '', u.password)) {
    return res.status(403).json({ error: 'Senha incorreta.' });
  }
  Q('UPDATE users SET deactivated=1 WHERE id=?').run(me);
  res.json({ ok: true });
});
app.delete('/api/account/delete', auth, (req, res) => {
  const me = req.user.id;
  const u = Q('SELECT password FROM users WHERE id=?').get(me);
  if (!u || !bcrypt.compareSync((req.body || {}).password || '', u.password)) {
    return res.status(403).json({ error: 'Senha incorreta.' });
  }
  const meRow = Q('SELECT avatar AS media FROM users WHERE id=?').get(me) || {};
  const files = [
    meRow,
    ...Q('SELECT media FROM posts WHERE user_id=?').all(me),
    ...Q('SELECT media FROM stories WHERE user_id=?').all(me),
    ...Q('SELECT media FROM messages WHERE (from_id=? OR to_id=?) AND media<>\'\'').all(me, me),
  ].map((r) => r.media).filter(Boolean);
  try {
    db.exec('BEGIN');
    Q('DELETE FROM comments WHERE user_id=? OR post_id IN (SELECT id FROM posts WHERE user_id=?)').run(me, me);
    Q('DELETE FROM likes WHERE user_id=? OR post_id IN (SELECT id FROM posts WHERE user_id=?)').run(me, me);
    Q('DELETE FROM tags WHERE user_id=? OR post_id IN (SELECT id FROM posts WHERE user_id=?)').run(me, me);
    Q('DELETE FROM notifs WHERE user_id=? OR actor_id=?').run(me, me);
    Q('DELETE FROM story_views WHERE viewer_id=? OR story_id IN (SELECT id FROM stories WHERE user_id=?)').run(me, me);
    Q('DELETE FROM story_reactions WHERE user_id=? OR story_id IN (SELECT id FROM stories WHERE user_id=?)').run(me, me);
    Q('DELETE FROM stories WHERE user_id=?').run(me);
    Q('DELETE FROM posts WHERE user_id=?').run(me);
    Q('DELETE FROM messages WHERE from_id=? OR to_id=?').run(me, me);
    Q('DELETE FROM follows WHERE follower=? OR followee=?').run(me, me);
    Q('DELETE FROM blocked_users WHERE blocker=? OR blocked=?').run(me, me);
    Q('DELETE FROM pinned_chats WHERE user_id=? OR peer_id=?').run(me, me);
    Q('DELETE FROM chat_reads WHERE user_id=? OR peer_id=?').run(me, me);
    Q('DELETE FROM users WHERE id=?').run(me);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    return res.status(500).json({ error: 'Não foi possível excluir a conta.' });
  }
  files.forEach((f) => {
    try {
      const stillUsed = Q('SELECT 1 FROM posts WHERE media=? UNION SELECT 1 FROM stories WHERE media=? UNION SELECT 1 FROM messages WHERE media=? UNION SELECT 1 FROM users WHERE avatar=?').get(f, f, f, f);
      if (stillUsed) return;
      const fp = path.join(__dirname, f);
      if (fp.startsWith(path.join(__dirname, 'uploads')) && fs.existsSync(fp)) fs.unlinkSync(fp);
    } catch {}
  });
  res.json({ ok: true });
});

// ---- Enviar mídia/áudio na DM ----
app.post('/api/dm/media', auth, up.single('media'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Escolha uma imagem, vídeo ou arquivo de áudio.' });
  res.json({ url: '/uploads/' + req.file.filename, type: kind(req.file), name: req.file.originalname || '' });
});

// ---- Enviar nota com música na DM ----
app.post('/api/dm/note', auth, (req, res) => {
  const { to, text, song_preview, song_duration } = req.body || {};
  if (!to) return res.status(400).json({ error: 'Destinatário necessário.' });
  if (!text && !song_preview) return res.status(400).json({ error: 'Envie uma nota ou música.' });
  const me = req.user.id;
  if (!userById(to)) return res.status(404).json({ error: 'Usuário não encontrado.' });
  const created = Date.now();
  const r = Q('INSERT INTO messages(from_id,to_id,text,media,type,created) VALUES(?,?,?,?,?,?)')
    .run(me, to, text || '', song_preview || '', song_preview ? 'song' : '', created);
  const m = { id: Number(r.lastInsertRowid), from_id: me, to_id: to, text: text || '', media: song_preview || '', type: song_preview ? 'song' : '', created };
  io.to('u' + to).to('u' + me).emit('msg', m);
  res.json({ ok: true, message: m });
});

// ---- Baixar Post / Story ----
app.get('/api/download/:kind/:id', auth, (req, res) => {
  const { kind: k, id } = req.params;
  let row;
  if (k === 'post') row = Q('SELECT media FROM posts WHERE id=? AND deleted=0').get(id);
  else if (k === 'story') row = Q('SELECT media FROM stories WHERE id=?').get(id);
  else return res.status(400).json({ error: 'Tipo inválido.' });
  if (!row || !row.media) return res.status(404).json({ error: 'Não encontrado.' });
  const filePath = path.join(__dirname, row.media);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Arquivo não existe.' });
  res.download(filePath);
});

// ---- Fixar/desfixar chat na DM ----
app.post('/api/chat/pin/:id', auth, (req, res) => {
  const peerId = +req.params.id, me = req.user.id;
  if (!userById(peerId)) return res.status(404).json({ error: 'Usuário não encontrado.' });
  const had = Q('DELETE FROM pinned_chats WHERE user_id=? AND peer_id=?').run(me, peerId).changes;
  if (!had) Q('INSERT INTO pinned_chats VALUES(?,?,?)').run(me, peerId, Date.now());
  res.json({ ok: true, pinned: !had });
});

// ---- Excluir chat na DM ----
app.delete('/api/chat/:id', auth, (req, res) => {
  const peerId = +req.params.id, me = req.user.id;
  Q('DELETE FROM messages WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?)').run(me, peerId, peerId, me);
  Q('DELETE FROM pinned_chats WHERE user_id=? AND peer_id=?').run(me, peerId);
  Q('DELETE FROM chat_reads WHERE user_id=? AND peer_id=?').run(me, peerId);
  res.json({ ok: true });
});

// ---- Fixar/desfixar post no feed ----
app.post('/api/posts/:id/pin', auth, (req, res) => {
  const id = +req.params.id, me = req.user.id;
  const p = Q('SELECT user_id FROM posts WHERE id=? AND deleted=0').get(id);
  if (!p || p.user_id !== me) return res.status(403).json({ error: 'Não autorizado.' });
  const had = Q('UPDATE posts SET pinned=1-pinned WHERE id=?').run(id).changes > 0;
  res.json({ ok: true, pinned: had === 0 ? 1 : 0 });
});

// ---- Links na bio (salvar no campo bio com detecção automática de URL) ----
// O campo bio já existe; links são detectados e convertidos no frontend.

// Qualquer rota /api inexistente responde JSON (nunca HTML), evitando o erro "Unexpected token '<'".
app.use('/api', (req, res) => res.status(404).json({ error: 'Recurso não encontrado.' }));
// Tratador de erros de upload/API no final, cobrindo todas as rotas (inclusive as declaradas acima).
app.use((e, req, res, next) => {
  if (res.headersSent) return next(e);
  res.status(400).json({ error: e && e.code === 'LIMIT_FILE_SIZE' ? 'Arquivo muito grande (máx. 60 MB).' : 'Erro no envio. Tente novamente.' });
});

server.listen(PORT, () => console.log(`ANARCHY rodando em http://localhost:${PORT}`));
