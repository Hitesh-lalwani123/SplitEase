const { query, withTransaction } = require('./database');

async function initializeDatabase() {
  // ─── Create all tables ───────────────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id              SERIAL PRIMARY KEY,
      name            TEXT NOT NULL,
      email           TEXT UNIQUE NOT NULL,
      password_hash   TEXT,
      google_id       TEXT UNIQUE,
      avatar_color    TEXT DEFAULT '#14b8a6',
      profile_photo   TEXT,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Column-existence guards — safe to run every time (no-op if already present)
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id    TEXT`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_color TEXT DEFAULT '#14b8a6'`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_photo TEXT`);
  // Unique index on google_id — CREATE INDEX IF NOT EXISTS is idempotent
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id) WHERE google_id IS NOT NULL`);

  await query(`
    CREATE TABLE IF NOT EXISTS categories (
      id         SERIAL PRIMARY KEY,
      name       TEXT UNIQUE NOT NULL,
      icon       TEXT NOT NULL,
      color      TEXT NOT NULL,
      is_custom  INTEGER DEFAULT 0,
      created_by INTEGER DEFAULT NULL,
      keywords   JSONB DEFAULT NULL
    )
  `);
  await query(`ALTER TABLE categories ADD COLUMN IF NOT EXISTS is_custom  INTEGER DEFAULT 0`);
  await query(`ALTER TABLE categories ADD COLUMN IF NOT EXISTS created_by INTEGER DEFAULT NULL`);
  await query(`ALTER TABLE categories ADD COLUMN IF NOT EXISTS keywords   JSONB DEFAULT NULL`);

  await query(`
    CREATE TABLE IF NOT EXISTS groups_ (
      id             SERIAL PRIMARY KEY,
      name           TEXT NOT NULL,
      description    TEXT DEFAULT '',
      created_by     INTEGER NOT NULL REFERENCES users(id),
      join_code      TEXT UNIQUE,
      retention_days INTEGER DEFAULT NULL,
      created_at     TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await query(`ALTER TABLE groups_ ADD COLUMN IF NOT EXISTS join_code      TEXT`);
  await query(`ALTER TABLE groups_ ADD COLUMN IF NOT EXISTS retention_days INTEGER DEFAULT NULL`);
  await query(`ALTER TABLE groups_ ADD COLUMN IF NOT EXISTS description    TEXT DEFAULT ''`);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_groups_join_code ON groups_(join_code) WHERE join_code IS NOT NULL`);

  await query(`
    CREATE TABLE IF NOT EXISTS group_members (
      group_id  INTEGER NOT NULL REFERENCES groups_(id) ON DELETE CASCADE,
      user_id   INTEGER NOT NULL REFERENCES users(id),
      role      TEXT NOT NULL DEFAULT 'member',
      joined_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (group_id, user_id)
    )
  `);
  await query(`ALTER TABLE group_members ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'member'`);

  await query(`
    CREATE TABLE IF NOT EXISTS join_requests (
      id           SERIAL PRIMARY KEY,
      group_id     INTEGER NOT NULL REFERENCES groups_(id) ON DELETE CASCADE,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status       TEXT NOT NULL DEFAULT 'pending',
      requested_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(group_id, user_id)
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS expenses (
      id          SERIAL PRIMARY KEY,
      group_id    INTEGER NOT NULL REFERENCES groups_(id) ON DELETE CASCADE,
      paid_by     INTEGER NOT NULL REFERENCES users(id),
      amount      NUMERIC(12,2) NOT NULL,
      description TEXT NOT NULL,
      category_id INTEGER DEFAULT 10 REFERENCES categories(id),
      split_type  TEXT DEFAULT 'equal',
      date        DATE DEFAULT CURRENT_DATE,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS expense_payers (
      id          SERIAL PRIMARY KEY,
      expense_id  INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
      user_id     INTEGER NOT NULL REFERENCES users(id),
      amount_paid NUMERIC(12,2) NOT NULL
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS expense_splits (
      id          SERIAL PRIMARY KEY,
      expense_id  INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
      user_id     INTEGER NOT NULL REFERENCES users(id),
      amount_owed NUMERIC(12,2) NOT NULL
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS group_invitations (
      id             SERIAL PRIMARY KEY,
      group_id       INTEGER NOT NULL REFERENCES groups_(id) ON DELETE CASCADE,
      invited_email  TEXT NOT NULL,
      token          TEXT UNIQUE NOT NULL,
      invited_by     INTEGER NOT NULL REFERENCES users(id),
      status         TEXT DEFAULT 'pending',
      created_at     TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS settlements (
      id         SERIAL PRIMARY KEY,
      group_id   INTEGER NOT NULL REFERENCES groups_(id) ON DELETE CASCADE,
      paid_by    INTEGER NOT NULL REFERENCES users(id),
      paid_to    INTEGER NOT NULL REFERENCES users(id),
      amount     NUMERIC(12,2) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS leave_requests (
      id           SERIAL PRIMARY KEY,
      group_id     INTEGER NOT NULL REFERENCES groups_(id) ON DELETE CASCADE,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status       TEXT DEFAULT 'pending',
      requested_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(group_id, user_id)
    )
  `);

  // ─── Indexes ─────────────────────────────────────────────────────────────
  await query(`CREATE INDEX IF NOT EXISTS idx_expenses_group       ON expenses(group_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_expenses_date        ON expenses(date)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_expense_splits_exp   ON expense_splits(expense_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_expense_splits_user  ON expense_splits(user_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_group_members_user   ON group_members(user_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_settlements_group    ON settlements(group_id)`);

  // ─── Seed categories ─────────────────────────────────────────────────────
  const { rows } = await query('SELECT COUNT(*) AS c FROM categories');
  if (parseInt(rows[0].c) === 0) {
    const cats = [
      ['Food & Drink', '🍕', '#f97316'],
      ['Transport', '🚗', '#3b82f6'],
      ['Entertainment', '🎬', '#a855f7'],
      ['Shopping', '🛍️', '#ec4899'],
      ['Utilities', '💡', '#eab308'],
      ['Rent & Housing', '🏠', '#6366f1'],
      ['Health', '💊', '#10b981'],
      ['Travel', '✈️', '#06b6d4'],
      ['Education', '📚', '#8b5cf6'],
      ['Other', '📦', '#64748b'],
    ];
    for (const [name, icon, color] of cats) {
      await query(
        'INSERT INTO categories (name, icon, color) VALUES ($1, $2, $3) ON CONFLICT (name) DO NOTHING',
        [name, icon, color]
      );
    }
  }

  console.log('✅ Database initialized (PostgreSQL)');
}

module.exports = { initializeDatabase };
