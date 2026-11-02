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

    // Colunas que podem faltar se o banco já tiver sido criado antes
    const addCol = async (table, col, def) => {
      try {
        await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col} ${def};`);
      } catch {}
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

    console.log('Banco configurado com sucesso!');
    process.exit(0);
  } catch (e) {
    console.error('Erro ao configurar banco:', e);
    process.exit(1);
  }
})();