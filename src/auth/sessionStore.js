/**
 * An express-session store backed by the same SQLite database as everything
 * else.
 *
 * Why hand-written instead of `connect-sqlite3`: that package depends on the
 * legacy `sqlite3` driver, which would put a second, entirely different
 * SQLite binding in node_modules alongside better-sqlite3 — and at time of
 * writing it dragged in 7 advisories (one critical, via node-gyp's old tar).
 * The store interface is three methods over a table with three columns. A
 * dependency should be carrying more weight than that to earn its place.
 *
 * The default MemoryStore isn't an option: it leaks (it never evicts expired
 * sessions), it logs a production warning for exactly that reason, and every
 * restart logs every player out.
 */

const session = require("express-session");
const { db } = require("../db");

const selectSession = db.prepare(`SELECT data, expires_at FROM sessions WHERE sid = ?`);

// SQLite's UPSERT. A session is written on every request that modifies it,
// so this needs to be one statement rather than a read-then-branch.
const upsertSession = db.prepare(`
  INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)
  ON CONFLICT (sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at
`);

const deleteSession = db.prepare(`DELETE FROM sessions WHERE sid = ?`);
const deleteExpired = db.prepare(`DELETE FROM sessions WHERE expires_at <= ?`);
const countSessions = db.prepare(`SELECT COUNT(*) AS n FROM sessions`);
const clearSessions = db.prepare(`DELETE FROM sessions`);

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // hourly

class SqliteSessionStore extends session.Store {
  constructor({ ttlMs = DEFAULT_TTL_MS } = {}) {
    super();
    this.ttlMs = ttlMs;

    // Expired rows are already treated as absent by get(), but without a
    // sweep the table grows forever. unref() so this timer never holds the
    // process open on shutdown.
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    if (typeof this.sweepTimer.unref === "function") this.sweepTimer.unref();
  }

  sweep() {
    try {
      deleteExpired.run(Date.now());
    } catch (err) {
      // A failed cleanup is not worth crashing a running server over.
      console.error("[sessions] sweep failed:", err.message);
    }
  }

  /** Milliseconds until this session should expire. */
  #ttlFor(sess) {
    const cookieExpiry = sess?.cookie?.expires;
    if (cookieExpiry) {
      return Math.max(0, new Date(cookieExpiry).getTime() - Date.now());
    }
    return this.ttlMs;
  }

  get(sid, callback) {
    try {
      const row = selectSession.get(sid);

      // Expiry is enforced on read as well as by the sweep. Relying on the
      // sweep alone would leave an hour-wide window where an expired session
      // still logs someone in.
      if (!row || row.expires_at <= Date.now()) {
        if (row) deleteSession.run(sid);
        return callback(null, null);
      }

      return callback(null, JSON.parse(row.data));
    } catch (err) {
      // A corrupt row shouldn't 500 the request — treat it as "no session"
      // and let the user log in again.
      return callback(null, null);
    }
  }

  set(sid, sess, callback) {
    try {
      upsertSession.run(sid, JSON.stringify(sess), Date.now() + this.#ttlFor(sess));
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  destroy(sid, callback) {
    try {
      deleteSession.run(sid);
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  /**
   * Called on every request for an existing session when `resave: false` and
   * a rolling cookie are in play. It slides the expiry without rewriting the
   * payload, which is what makes "log out after 7 days of *inactivity*"
   * different from "log out 7 days after logging in".
   */
  touch(sid, sess, callback) {
    try {
      const row = selectSession.get(sid);
      if (row) {
        upsertSession.run(sid, row.data, Date.now() + this.#ttlFor(sess));
      }
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  length(callback) {
    try {
      callback(null, countSessions.get().n);
    } catch (err) {
      callback(err);
    }
  }

  clear(callback) {
    try {
      clearSessions.run();
      callback(null);
    } catch (err) {
      callback(err);
    }
  }
}

module.exports = SqliteSessionStore;
