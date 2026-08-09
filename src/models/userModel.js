/**
 * Every SQL statement that touches `users` lives here.
 *
 * Two reasons to keep it confined:
 *   1. Swapping SQLite for Postgres later means rewriting this file, not
 *      grepping controllers for stray queries.
 *   2. `password_hash` can only escape through code in this file, and the
 *      only function that returns it is named so you notice.
 *
 * Every query is a prepared statement with bound `?` parameters. That is
 * what makes SQL injection structurally impossible here rather than a thing
 * we remember to escape: the driver sends the query and the values over
 * separate channels, so a username of `'; DROP TABLE users; --` is looked up
 * as a (nonexistent) user with a silly name, not executed.
 */

const { db } = require("../db");

/** Uniqueness is case-insensitive; this is the form we compare and index on. */
function canonicalise(username) {
  return String(username).trim().toLowerCase();
}

/**
 * The only shape a user is ever allowed to leave the server in.
 * Anything not listed here — password_hash above all — cannot reach a
 * response body by accident, because the mapper drops unknown fields
 * rather than spreading them.
 */
function toPublicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    avatarUrl: row.avatar_url || null,
    createdAt: row.created_at,
    // Useful to the frontend: tells it whether to offer "set a password"
    // to a Google-only account, without exposing the hash itself.
    hasPassword: Boolean(row.password_hash),
  };
}

// ---- Lookups ---------------------------------------------------------

const selectById = db.prepare(`SELECT * FROM users WHERE id = ?`);
const selectByCanonical = db.prepare(
  `SELECT * FROM users WHERE username_canonical = ?`
);
const selectByGoogleId = db.prepare(`SELECT * FROM users WHERE google_id = ?`);
const selectByEmail = db.prepare(`SELECT * FROM users WHERE email = ?`);

function findById(id) {
  return selectById.get(id) || null;
}

function findByUsername(username) {
  return selectByCanonical.get(canonicalise(username)) || null;
}

function findByGoogleId(googleId) {
  return selectByGoogleId.get(googleId) || null;
}

function findByEmail(email) {
  if (!email) return null;
  return selectByEmail.get(String(email).trim().toLowerCase()) || null;
}

function usernameExists(username) {
  return selectByCanonical.get(canonicalise(username)) !== undefined;
}

// ---- Writes ----------------------------------------------------------

const insertUser = db.prepare(`
  INSERT INTO users (username, username_canonical, email, password_hash, google_id, avatar_url)
  VALUES (@username, @usernameCanonical, @email, @passwordHash, @googleId, @avatarUrl)
`);

/**
 * Creates a user. Callers pass a password *hash*, never a password —
 * this layer has no idea what bcrypt is and shouldn't.
 *
 * Throws SqliteError with code SQLITE_CONSTRAINT_UNIQUE if the username or
 * email was taken between the availability check and this insert. That race
 * is not hypothetical: two people can pass "username is free" a millisecond
 * apart. The UNIQUE index is what actually enforces it; the check endpoint
 * is only a courtesy to the typing user.
 */
function createUser({
  username,
  email = null,
  passwordHash = null,
  googleId = null,
  avatarUrl = null,
}) {
  const info = insertUser.run({
    username: String(username).trim(),
    usernameCanonical: canonicalise(username),
    email: email ? String(email).trim().toLowerCase() : null,
    passwordHash,
    googleId,
    avatarUrl,
  });
  return findById(info.lastInsertRowid);
}

const updateLastLogin = db.prepare(
  `UPDATE users SET last_login_at = datetime('now') WHERE id = ?`
);

function touchLastLogin(id) {
  updateLastLogin.run(id);
}

const updatePasswordHash = db.prepare(
  `UPDATE users SET password_hash = ? WHERE id = ?`
);

function setPasswordHash(id, passwordHash) {
  updatePasswordHash.run(passwordHash, id);
}

const attachGoogle = db.prepare(
  `UPDATE users SET google_id = ?, avatar_url = COALESCE(?, avatar_url) WHERE id = ?`
);

/** Links a Google identity to an existing password account (same email). */
function linkGoogleAccount(id, googleId, avatarUrl = null) {
  attachGoogle.run(googleId, avatarUrl, id);
  return findById(id);
}

module.exports = {
  canonicalise,
  toPublicUser,
  findById,
  findByUsername,
  findByGoogleId,
  findByEmail,
  usernameExists,
  createUser,
  touchLastLogin,
  setPasswordHash,
  linkGoogleAccount,
};
