/**
 * Per-account login attempt tracking.
 *
 * This is the second half of the brute-force defence. The IP rate limiter in
 * middleware/rateLimit.js caps how fast any one address can try; this caps
 * how many times any one *account* can be missed, no matter how many
 * addresses the guesses come from. Neither alone is enough:
 *
 *   IP limit only      → a botnet with 1000 addresses gets 1000x the guesses
 *                        at your account while each address looks polite.
 *   Account limit only → password spraying (one common password, tried once
 *                        against ten thousand accounts) never trips it.
 */

const { db } = require("../db");

const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 8;

const insertAttempt = db.prepare(`
  INSERT INTO login_attempts (username_canonical, ip, succeeded, attempted_at)
  VALUES (?, ?, ?, ?)
`);

const countRecentFailures = db.prepare(`
  SELECT COUNT(*) AS n FROM login_attempts
   WHERE username_canonical = ? AND succeeded = 0 AND attempted_at > ?
`);

const clearForUser = db.prepare(
  `DELETE FROM login_attempts WHERE username_canonical = ?`
);

const deleteOld = db.prepare(`DELETE FROM login_attempts WHERE attempted_at < ?`);

function record(usernameCanonical, ip, succeeded) {
  insertAttempt.run(usernameCanonical, ip, succeeded ? 1 : 0, Date.now());
}

/**
 * @returns {{locked: boolean, remaining: number}}
 */
function status(usernameCanonical) {
  const { n } = countRecentFailures.get(
    usernameCanonical,
    Date.now() - FAILURE_WINDOW_MS
  );
  return { locked: n >= MAX_FAILURES, remaining: Math.max(0, MAX_FAILURES - n) };
}

/** Called on success — getting in resets your own counter. */
function clear(usernameCanonical) {
  clearForUser.run(usernameCanonical);
}

/** Housekeeping so the table doesn't grow without bound. */
function prune() {
  deleteOld.run(Date.now() - 24 * 60 * 60 * 1000);
}

module.exports = {
  FAILURE_WINDOW_MS,
  MAX_FAILURES,
  record,
  status,
  clear,
  prune,
};
