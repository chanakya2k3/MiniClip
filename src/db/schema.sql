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

-- ---- Friendships -----------------------------------------------------
-- ONE row per relationship, not two.
--
-- The tempting alternative is a symmetric pair of rows (A→B and B→A) so
-- "who are my friends" is a single-column lookup. It's a trap: every accept,
-- decline and removal then has to update two rows atomically, and the first
-- time one of those writes is missed you get a friendship that exists in one
-- direction. One row can't disagree with itself.
--
-- The cost is that lookups must check both columns, which is what the two
-- indexes below are for.
CREATE TABLE IF NOT EXISTS friendships (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Direction is retained after acceptance, because it's the only record of
  -- who asked. A blocked relationship needs to know who blocked whom.
  requester_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  addressee_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,

  -- pending  → requested, awaiting the addressee
  -- accepted → mutual friends
  -- blocked  → requester_id has blocked addressee_id
  status       TEXT    NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'accepted', 'blocked')),

  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  responded_at TEXT,

  -- Stops a double-send from creating two pending requests. The reverse
  -- direction (B asking A while A→B is pending) can't be caught by a
  -- constraint, so friendModel.sendRequest handles it as an auto-accept.
  UNIQUE (requester_id, addressee_id),

  -- Nobody friends themselves. Cheap to enforce here, and then it's true
  -- regardless of which code path does the insert.
  CHECK (requester_id <> addressee_id)
);

CREATE INDEX IF NOT EXISTS idx_friend_requester ON friendships (requester_id, status);
CREATE INDEX IF NOT EXISTS idx_friend_addressee ON friendships (addressee_id, status);

-- ---- Direct messages --------------------------------------------------
CREATE TABLE IF NOT EXISTS direct_messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,

  -- The two participant ids sorted ascending and joined ("7:12"). Without
  -- it, loading a conversation is
  --   WHERE (sender=? AND recipient=?) OR (sender=? AND recipient=?)
  -- which is an OR across two columns and can't use one index. With it,
  -- the same query is a single equality lookup on an indexed column.
  pair_key     TEXT    NOT NULL,

  sender_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  recipient_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  body         TEXT    NOT NULL,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  read_at      TEXT
);

CREATE INDEX IF NOT EXISTS idx_dm_pair ON direct_messages (pair_key, id DESC);
CREATE INDEX IF NOT EXISTS idx_dm_unread ON direct_messages (recipient_id, read_at);
