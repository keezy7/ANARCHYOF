const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

(async () => {
  try {
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

    // Colunas que podem faltar se o banco já tiver sido criado antes
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
    await addCol('comments', 'parent_id', 'INTEGER DEFAULT NULL');
    try { await pool.query('CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_id)'); } catch {}
    await addCol('stories', 'expires_at', 'BIGINT DEFAULT 0');
    await addCol('stories', 'mentions', "TEXT DEFAULT ''");
    await addCol('messages', 'media', 'TEXT DEFAULT \'\'');
    await addCol('messages', 'type', 'TEXT DEFAULT \'\'');
    await addCol('messages', 'edited_at', 'BIGINT DEFAULT 0');
    await addCol('messages', 'deleted', 'INTEGER DEFAULT 0');
    await addCol('messages', 'reply_id', 'INTEGER');
    await addCol('notifs', 'story_id', 'INTEGER');
    await addCol('notifs', 'text', "TEXT DEFAULT ''");

    // Concede permissão de GIF às contas autorizadas, uma vez por conta.
    try {
      await pool.query('CREATE TABLE IF NOT EXISTS app_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      const seedKey = 'gif_granted_v1';
      const existing = await pool.query('SELECT value FROM app_settings WHERE key=$1 LIMIT 1', [seedKey]);
      let granted = [];
      if (existing.rows.length && existing.rows[0].value) {
        try { granted = JSON.parse(existing.rows[0].value) || []; } catch { granted = String(existing.rows[0].value).split(','); }
      }
      const grantedSet = new Set(granted.map((u) => String(u).toLowerCase()));
      const wanted = ['anarchy', 'scorppionn', 'horuswrld'];
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

    // Garante que apenas as contas autorizadas tenham verificado (remove de todas as outras).
    try {
      const allowed = ['anarchy', 'scorppionn', 'horuswrld'];
      await pool.query('UPDATE users SET verified=0 WHERE verified <> 0 AND LOWER(username) <> ALL($1)', [allowed]);
    } catch (e) {
      console.error('[migração] verified:', e.message);
    }

    // Remove reposts duplicados do mesmo post pelo mesmo usuário (mantém o mais recente) e impede duplicação.
    try {
      await pool.query(`UPDATE posts AS a SET deleted=1 FROM posts AS b
        WHERE a.user_id=b.user_id AND a.repost_of IS NOT NULL AND b.repost_of IS NOT NULL
          AND a.repost_of=b.repost_of AND a.deleted=0 AND b.deleted=0 AND a.id<b.id`);
      await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_repost_unique ON posts(user_id, repost_of) WHERE repost_of IS NOT NULL AND deleted=0');
    } catch (e) {
      console.error('[migração] posts repost:', e.message);
    }

    // Migração: timestamps em milissegundos (Date.now()) não cabem em INTEGER (32 bits).
    // Necessário em bancos que já existiam antes da correção para BIGINT.
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

    console.log('Banco configurado com sucesso!');
    process.exit(0);
  } catch (e) {
    console.error('Erro ao configurar banco:', e);
    process.exit(1);
  }
})();