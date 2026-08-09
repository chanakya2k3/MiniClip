/**
 * Server-side input validation and normalisation.
 *
 * "Sanitising input" is often taken to mean stripping scary characters, which
 * is the wrong mental model — it produces mangled data and still misses
 * things. The defences that actually hold are applied where the data is
 * *used*, and they're already in place:
 *
 *   SQL injection   → parameterised statements in src/models (the driver
 *                     never concatenates a value into a query string).
 *   XSS             → the frontend writes usernames with textContent, never
 *                     innerHTML, so a name can't become markup.
 *   Oversized input → express.json({ limit }) in app.js, plus the length
 *                     caps here.
 *
 * What this file does instead is decide what counts as *valid*, and reject
 * everything else. An allow-list of permitted characters is both simpler and
 * stricter than any blocklist of forbidden ones.
 */

const USERNAME_MIN = 3;
const USERNAME_MAX = 20;

// Letters, digits, underscore, hyphen. No spaces, no punctuation, no emoji,
// crucially no non-ASCII: Unicode look-alikes let someone register "chаnshi"
// with a Cyrillic а and impersonate "chanshi" on a leaderboard. Restricting
// the alphabet removes that entire class of problem without needing a
// confusables table.
const USERNAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

// Names that would collide with routes or imply staff status.
const RESERVED_USERNAMES = new Set([
  "admin", "administrator", "root", "system", "moderator", "mod", "staff",
  "miniclip", "support", "help", "api", "auth", "login", "logout", "signup",
  "register", "profile", "settings", "account", "me", "user", "users",
  "null", "undefined", "anonymous", "guest",
]);

/**
 * @returns {{ok: true, value: string} | {ok: false, message: string}}
 */
function validateUsername(input) {
  if (typeof input !== "string") {
    return { ok: false, message: "Username is required." };
  }

  const value = input.trim();

  if (value.length === 0) {
    return { ok: false, message: "Username is required." };
  }
  if (value.length < USERNAME_MIN) {
    return { ok: false, message: `Username must be at least ${USERNAME_MIN} characters.` };
  }
  if (value.length > USERNAME_MAX) {
    return { ok: false, message: `Username must be at most ${USERNAME_MAX} characters.` };
  }
  if (!USERNAME_PATTERN.test(value)) {
    return { ok: false, message: "Use only letters, numbers, underscore and hyphen." };
  }
  if (RESERVED_USERNAMES.has(value.toLowerCase())) {
    return { ok: false, message: "That username is reserved." };
  }

  return { ok: true, value };
}

/**
 * Passwords get length-checked here and strength-checked in auth/password.js.
 * This exists only to reject the shapes that shouldn't reach bcrypt at all —
 * a non-string, or something long enough to be a denial-of-service attempt
 * (hashing is intentionally expensive, so unbounded input is a CPU faucet).
 */
function validatePasswordShape(input) {
  if (typeof input !== "string" || input.length === 0) {
    return { ok: false, message: "Password is required." };
  }
  if (Buffer.byteLength(input, "utf8") > 72) {
    return { ok: false, message: "Password must be at most 72 bytes." };
  }
  return { ok: true, value: input };
}

module.exports = {
  USERNAME_MIN,
  USERNAME_MAX,
  validateUsername,
  validatePasswordShape,
};
