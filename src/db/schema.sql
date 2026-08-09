-- MiniClip schema.
--
-- Applied on every boot; every statement is IF NOT EXISTS, so starting the
-- server is the same thing as running the migration. That's fine at this
-- size. The day a column needs to change type or backfill, this file should
-- be replaced by numbered migration files — "re-run the whole schema" stops
-- being a safe operation once there's data you can't recreate.

-- ---- Users -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Two columns for one name, on purpose:
  --   username           what the player typed, shown back to them ("ChanShi")
  --   username_canonical lowercased, what uniqueness is actually enforced on
  -- Without the canonical column, "ChanShi" and "chanshi" are two different
  -- accounts, which is an impersonation bug wearing a case-sensitivity hat.
  username           TEXT    NOT NULL,
  username_canonical TEXT    NOT NULL UNIQUE,

  -- Nullable: a password signup has no verified email yet, and we don't
  -- ask for one. Google signups always have one.
  email              TEXT    UNIQUE,

  -- Nullable: a Google-only account has no password to store. NULL here
  -- means "this account cannot be logged into with a password", which is
  -- meaningfully different from "the empty password".
  password_hash      TEXT,

  -- Google's stable subject id. Not the email — people change emails, and
  -- an email is not proof of identity on its own.
  google_id          TEXT    UNIQUE,
  avatar_url         TEXT,

  created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  last_login_at      TEXT
);

-- ---- Sessions --------------------------------------------------------
-- Server-side session storage. The browser only ever holds the signed id;
-- everything about who you are lives here, where it can be deleted.
CREATE TABLE IF NOT EXISTS sessions (
  sid        TEXT    PRIMARY KEY,
  data       TEXT    NOT NULL,
  expires_at INTEGER NOT NULL  -- unix ms, so expiry is a plain integer compare
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);

-- ---- Login attempts --------------------------------------------------
-- Feeds per-account throttling. IP rate limiting alone doesn't stop a
-- distributed guess at one specific account, and per-account limiting alone
-- doesn't stop one IP spraying one password across many accounts. Both.
CREATE TABLE IF NOT EXISTS login_attempts (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  username_canonical TEXT    NOT NULL,
  ip                 TEXT    NOT NULL,
  succeeded          INTEGER NOT NULL DEFAULT 0,
  attempted_at       INTEGER NOT NULL  -- unix ms
);

CREATE INDEX IF NOT EXISTS idx_attempts_user ON login_attempts (username_canonical, attempted_at);

-- ---- Scores ----------------------------------------------------------
-- Not needed for auth. It exists now because the point of building auth is
-- having something to attach to a player, and adding the table later would
-- mean rediscovering how this layer fits together.
CREATE TABLE IF NOT EXISTS scores (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  game       TEXT    NOT NULL,   -- 'flappy-duel' | 'tic-tac-toe' | ...
  score      INTEGER NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Leaderboard query is "top N for one game", so index the game and let
-- SQLite walk the scores descending instead of sorting the whole table.
CREATE INDEX IF NOT EXISTS idx_scores_game ON scores (game, score DESC);
CREATE INDEX IF NOT EXISTS idx_scores_user ON scores (user_id, game);
