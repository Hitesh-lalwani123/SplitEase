const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', '..', 'splitwise.db');

let db;

function generateJoinCode() {
  return crypto.randomBytes(3).toString('hex').toUpperCase(); // 6 chars e.g. "A3F9C1"
}

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initializeDatabase();
  }
  return db;
}

function initializeDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT,
      google_id TEXT UNIQUE,
      avatar_color TEXT DEFAULT '#14b8a6',
      profile_photo TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      icon TEXT NOT NULL,
      color TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS groups_ (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      created_by INTEGER NOT NULL,
      join_code TEXT UNIQUE,
      retention_days INTEGER DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS group_members (
      group_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (group_id, user_id),
      FOREIGN KEY (group_id) REFERENCES groups_(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS join_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(group_id, user_id),
      FOREIGN KEY (group_id) REFERENCES groups_(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL,
      paid_by INTEGER NOT NULL,
      amount REAL NOT NULL,
      description TEXT NOT NULL,
      category_id INTEGER DEFAULT 10,
      split_type TEXT DEFAULT 'equal',
      date DATE DEFAULT (date('now')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (group_id) REFERENCES groups_(id) ON DELETE CASCADE,
      FOREIGN KEY (paid_by) REFERENCES users(id),
      FOREIGN KEY (category_id) REFERENCES categories(id)
    );

    CREATE TABLE IF NOT EXISTS expense_payers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      expense_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      amount_paid REAL NOT NULL,
      FOREIGN KEY (expense_id) REFERENCES expenses(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS expense_splits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      expense_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      amount_owed REAL NOT NULL,
      FOREIGN KEY (expense_id) REFERENCES expenses(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS group_invitations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL,
      invited_email TEXT NOT NULL,
      token TEXT UNIQUE NOT NULL,
      invited_by INTEGER NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (group_id) REFERENCES groups_(id) ON DELETE CASCADE,
      FOREIGN KEY (invited_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS settlements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL,
      paid_by INTEGER NOT NULL,
      paid_to INTEGER NOT NULL,
      amount REAL NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (group_id) REFERENCES groups_(id) ON DELETE CASCADE,
      FOREIGN KEY (paid_by) REFERENCES users(id),
      FOREIGN KEY (paid_to) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_expenses_group ON expenses(group_id);
    CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date);
    CREATE INDEX IF NOT EXISTS idx_expense_splits_expense ON expense_splits(expense_id);
    CREATE INDEX IF NOT EXISTS idx_expense_splits_user ON expense_splits(user_id);
    CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id);
    CREATE INDEX IF NOT EXISTS idx_settlements_group ON settlements(group_id);
  `);

  // Migration: fix users table — remove NOT NULL from password_hash, add google_id & avatar_color
  // SQLite doesn't support ALTER COLUMN, so we rebuild the table if password_hash is NOT NULL
  const usersInfo = db.prepare("PRAGMA table_info(users)").all();
  const usersColNames = usersInfo.map(c => c.name);
  const pwdCol = usersInfo.find(c => c.name === 'password_hash');
  const needsRebuild = pwdCol && pwdCol.notnull === 1; // 1 = NOT NULL constraint

  if (needsRebuild) {
    db.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN;
      CREATE TABLE IF NOT EXISTS users_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT,
        google_id TEXT UNIQUE,
        avatar_color TEXT DEFAULT '#14b8a6',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO users_new (id, name, email, password_hash, avatar_color, created_at)
        SELECT id, name, email, password_hash,
          COALESCE(avatar_color, '#14b8a6'),
          created_at
        FROM users;
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
    // Re-create indexes
    try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id)`); } catch (e) { }
    console.log('✅ users table migrated: password_hash NOT NULL removed, google_id added');
  } else {
    // Table already rebuilt or fresh — just ensure columns exist
    if (!usersColNames.includes('google_id')) {
      db.exec(`ALTER TABLE users ADD COLUMN google_id TEXT`);
      try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id)`); } catch (e) { }
    }
    if (!usersColNames.includes('avatar_color')) {
      db.exec(`ALTER TABLE users ADD COLUMN avatar_color TEXT DEFAULT '#14b8a6'`);
    }
    if (!usersColNames.includes('profile_photo')) {
      db.exec(`ALTER TABLE users ADD COLUMN profile_photo TEXT`);
    }
  }

  // Migration: add join_code column to groups_ if it doesn't exist (safe for both new and existing DBs)
  const groupsColumns = db.prepare("PRAGMA table_info(groups_)").all();
  const hasJoinCode = groupsColumns.some(c => c.name === 'join_code');
  if (!hasJoinCode) {
    db.exec(`ALTER TABLE groups_ ADD COLUMN join_code TEXT`);
  }

  // Back-fill join_code for existing groups that don't have one
  const groupsWithoutCode = db.prepare("SELECT id FROM groups_ WHERE join_code IS NULL").all();
  const updateCode = db.prepare("UPDATE groups_ SET join_code = ? WHERE id = ?");
  for (const g of groupsWithoutCode) {
    let code;
    let attempts = 0;
    do {
      code = generateJoinCode();
      attempts++;
    } while (db.prepare("SELECT 1 FROM groups_ WHERE join_code = ?").get(code) && attempts < 10);
    updateCode.run(code, g.id);
  }
  // Ensure uniqueness via index (not UNIQUE constraint on old cols to avoid migration issues)
  try {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_groups_join_code ON groups_(join_code)`);
  } catch (e) { /* already exists */ }

  // Migration: add role column to group_members
  const gmCols = db.prepare("PRAGMA table_info(group_members)").all().map(c => c.name);
  if (!gmCols.includes('role')) {
    db.exec(`ALTER TABLE group_members ADD COLUMN role TEXT NOT NULL DEFAULT 'member'`);
    // Make group creators admins
    db.exec(`
      UPDATE group_members SET role = 'admin'
      WHERE (group_id, user_id) IN (
        SELECT id, created_by FROM groups_
      )
    `);
  }

  // Migration: create join_requests table
  db.exec(`
    CREATE TABLE IF NOT EXISTS join_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(group_id, user_id),
      FOREIGN KEY (group_id) REFERENCES groups_(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  // Migration: add retention_days to groups_
  const grpCols = db.prepare("PRAGMA table_info(groups_)").all().map(c => c.name);
  if (!grpCols.includes('retention_days')) {
    db.exec(`ALTER TABLE groups_ ADD COLUMN retention_days INTEGER DEFAULT NULL`);
  }

  // Migration: add is_custom flag to categories (for user-created categories)
  const catCols = db.prepare("PRAGMA table_info(categories)").all().map(c => c.name);
  if (!catCols.includes('is_custom')) {
    db.exec(`ALTER TABLE categories ADD COLUMN is_custom INTEGER DEFAULT 0`);
  }
  if (!catCols.includes('created_by')) {
    db.exec(`ALTER TABLE categories ADD COLUMN created_by INTEGER DEFAULT NULL`);
  }
  if (!catCols.includes('keywords')) {
    db.exec(`ALTER TABLE categories ADD COLUMN keywords TEXT DEFAULT NULL`);
  }

  // Seed categories if empty
  const count = db.prepare('SELECT COUNT(*) as c FROM categories').get();
  if (count.c === 0) {
    const insert = db.prepare('INSERT INTO categories (name, icon, color) VALUES (?, ?, ?)');
    const categories = [
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
    const insertMany = db.transaction((cats) => {
      for (const [name, icon, color] of cats) {
        insert.run(name, icon, color);
      }
    });
    insertMany(categories);
  }

  // Migration: create leave_requests table
  db.exec(`
    CREATE TABLE IF NOT EXISTS leave_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      status TEXT DEFAULT 'pending',
      requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(group_id, user_id),
      FOREIGN KEY (group_id) REFERENCES groups_(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);
}


module.exports = { getDb, generateJoinCode };
