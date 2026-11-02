const { Pool, types } = require('pg');

// COUNT() e colunas BIGINT chegam como string por padrão (int8).
// Nossos valores (contadores e timestamps em ms) cabem com folga em Number.
types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

module.exports = pool;