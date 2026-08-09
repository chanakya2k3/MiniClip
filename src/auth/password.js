/**
 * Password hashing and strength policy.
 *
 * ---- bcrypt or argon2? -----------------------------------------------
 *
 * argon2id is the better algorithm on paper and the one I'd pick if this
 * were storing anything valuable. It is *memory*-hard, not just CPU-hard:
 * an attacker with a rack of GPUs is bottlenecked on RAM per guess, which
 * is the resource that doesn't parallelise cheaply. bcrypt's working set is
 * ~4 KB, small enough to fit thousands of instances on one GPU.
 *
 * bcrypt is used here anyway, for reasons that are about this project
 * rather than about cryptography:
 *   - It's been deployed and attacked continuously since 1999. There is no
 *     surprise left in it.
 *   - argon2 has three tuning parameters (memory, iterations, parallelism)
 *     and choosing them badly — the common failure being memory set too low
 *     — produces something weaker than bcrypt while looking more modern.
 *     bcrypt has one knob and a well-known good value for it.
 *   - Every language has a bcrypt implementation that interoperates, so the
 *     hashes aren't tied to this stack.
 *
 * Both are correct answers. Choosing MD5, SHA-256, or anything else built
 * to be *fast* is the wrong answer — speed is the attacker's asset here, and
 * a general-purpose hash lets a consumer GPU try billions of candidates a
 * second. bcrypt is deliberately slow and the cost is tunable upward as
 * hardware improves.
 *
 * Salting isn't a separate step: bcrypt generates a random 16-byte salt per
 * password and stores it inside the output string, so two users with the
 * same password get different hashes and one rainbow table can't cover both.
 * A stored hash looks like:
 *
 *   $2b$12$Xy3f...salt+digest...
 *    │  │  └── 22-char base64 salt, then the digest
 *    │  └───── cost factor (12)
 *    └──────── algorithm variant
 */

const bcrypt = require("bcrypt");
const zxcvbn = require("zxcvbn");

// 2^12 = 4096 key-expansion rounds, ~200-300ms on a typical machine. The
// number to tune against is human patience, not a benchmark: login should
// feel instant to a person and expensive to a script. Because the cost is
// embedded in the hash, raising this later doesn't invalidate old hashes —
// they keep verifying at their original cost and get upgraded on next login
// (see needsRehash below).
const COST_FACTOR = 12;

// bcrypt silently ignores everything past 72 bytes of input. Left unchecked
// that's a real vulnerability — "correct horse battery staple <70 more
// chars>" and a different 100-char password can collide. Reject instead of
// truncating, so nobody ends up with a password that isn't the one they
// think they set. (It also caps the work an unauthenticated request can ask
// the CPU to do.)
const MAX_PASSWORD_BYTES = 72;

const MIN_PASSWORD_LENGTH = 10;

// zxcvbn scores 0-4. 3 ("safely unguessable") is the usual bar for anything
// holding money; 2 is right for an arcade account, where an unreasonable
// policy just pushes people to `Password1!` and a sticky note.
const MIN_STRENGTH_SCORE = 2;

/**
 * Server-side strength check.
 *
 * The frontend runs this same library for the live meter, but the frontend
 * is a suggestion — anyone can POST straight to /api/auth/signup with curl
 * and skip it entirely. Running zxcvbn on both sides means the rule the user
 * sees and the rule that's enforced are the same rule, rather than a pretty
 * meter next to a server that only counts characters.
 *
 * zxcvbn beats a regex policy because it estimates *guessability* instead of
 * checking composition. `P@ssw0rd!` satisfies every "uppercase, lowercase,
 * digit, symbol" rule ever written and is in the first few thousand guesses
 * of any real cracking run. zxcvbn catches it, along with keyboard walks
 * (qwertyuiop), dates, l33tspeak substitutions and common names.
 *
 * @param {string} password
 * @param {string[]} userInputs Context to penalise — username, email. A
 *   password containing your own username is weak in a way no amount of
 *   entropy in the rest of it repairs.
 */
function checkStrength(password, userInputs = []) {
  const value = String(password ?? "");

  if (value.length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      score: 0,
      message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    };
  }

  if (Buffer.byteLength(value, "utf8") > MAX_PASSWORD_BYTES) {
    return {
      ok: false,
      score: 0,
      message: `Password must be at most ${MAX_PASSWORD_BYTES} bytes.`,
    };
  }

  const result = zxcvbn(value, userInputs.filter(Boolean).map(String));

  if (result.score < MIN_STRENGTH_SCORE) {
    // zxcvbn's own feedback is better than anything generic we'd write:
    // it says "this is a top-100 password" or "avoid repeated characters"
    // rather than "password too weak".
    const hint =
      result.feedback.warning ||
      result.feedback.suggestions[0] ||
      "Try a longer phrase, or mix in unrelated words.";
    return { ok: false, score: result.score, message: hint };
  }

  return { ok: true, score: result.score, message: null };
}

async function hashPassword(plaintext) {
  return bcrypt.hash(plaintext, COST_FACTOR);
}

/**
 * Verifies a password against a stored hash.
 *
 * bcrypt.compare re-derives the hash using the salt and cost embedded in
 * `hash`, then compares in constant time — it will not leak, via how long
 * it took, how many leading characters were right.
 */
async function verifyPassword(plaintext, hash) {
  if (!hash) return false; // Google-only account: nothing to compare against.
  return bcrypt.compare(plaintext, hash);
}

/**
 * A hash to compare against when the username doesn't exist.
 *
 * Without this, a login for a real user takes ~250ms (a bcrypt compare) and
 * a login for a nonexistent user returns in ~1ms. That difference is a
 * username enumeration oracle: an attacker learns which accounts are real by
 * timing the failures. Burning an equivalent compare on the miss path makes
 * both take the same time.
 */
const DUMMY_HASH = bcrypt.hashSync("miniclip-timing-equaliser", COST_FACTOR);

async function burnComparison(plaintext) {
  await bcrypt.compare(String(plaintext ?? ""), DUMMY_HASH);
}

/**
 * True if a hash was made with an out-of-date cost, so it can be silently
 * upgraded during a successful login (the only moment the plaintext is in
 * memory to re-hash it).
 */
function needsRehash(hash) {
  if (!hash) return false;
  const cost = Number(hash.split("$")[2]);
  return Number.isFinite(cost) && cost < COST_FACTOR;
}

module.exports = {
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_BYTES,
  MIN_STRENGTH_SCORE,
  checkStrength,
  hashPassword,
  verifyPassword,
  burnComparison,
  needsRehash,
};
