/**
 * Signup, login, logout, and the Google "pick a username" completion step.
 *
 * Controllers do flow control and HTTP. They don't write SQL (models do) and
 * they don't know what bcrypt is (auth/password.js does). Keeping that line
 * sharp is what makes the file readable at a glance six months from now.
 */

const userModel = require("../models/userModel");
const loginAttempts = require("../models/loginAttemptModel");
const password = require("../auth/password");
const { validateUsername, validatePasswordShape } = require("../validators/authValidators");

/**
 * Rebuilds the session under a fresh id, then marks it as belonging to
 * `user`.
 *
 * The regenerate is not optional ceremony. Without it, the session id the
 * browser had *before* logging in stays valid after — so an attacker who can
 * plant a known session id in someone's browser (a shared computer, an XSS
 * on a subdomain, a crafted link on some setups) is holding a live id the
 * moment that person logs in. That's session fixation, and issuing a new id
 * at the privilege boundary is the whole fix.
 */
function establishSession(req, user) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);

      req.session.userId = user.id;

      // save() before responding, so the row is committed before the browser
      // can fire its next request with the new cookie.
      req.session.save((saveErr) => (saveErr ? reject(saveErr) : resolve()));
    });
  });
}

// ---- Username availability -------------------------------------------

/**
 * GET /api/auth/username-available?username=foo
 *
 * Powers the live check on the signup form. It runs the exact same validator
 * the signup endpoint does, so the form can't show a green tick for a name
 * that submit will reject.
 *
 * "Available" here is a snapshot, not a reservation — see the UNIQUE
 * constraint note in userModel.createUser for what actually guarantees it.
 */
function checkUsername(req, res) {
  const raw = req.query.username;

  const validation = validateUsername(typeof raw === "string" ? raw : "");
  if (!validation.ok) {
    return res.json({ available: false, valid: false, message: validation.message });
  }

  const taken = userModel.usernameExists(validation.value);

  res.json({
    available: !taken,
    valid: true,
    message: taken ? "That username is taken." : "Available.",
  });
}

// ---- Signup -----------------------------------------------------------

/** POST /api/auth/signup  { username, password } */
async function signup(req, res, next) {
  try {
    const usernameCheck = validateUsername(req.body?.username);
    if (!usernameCheck.ok) {
      return res.status(400).json({ error: "invalid_username", message: usernameCheck.message });
    }

    const shapeCheck = validatePasswordShape(req.body?.password);
    if (!shapeCheck.ok) {
      return res.status(400).json({ error: "invalid_password", message: shapeCheck.message });
    }

    // The same zxcvbn check the browser ran, re-run where it can't be
    // skipped. The username is passed as context so "chanshi2024" is
    // correctly judged weak for the user chanshi.
    const strength = password.checkStrength(shapeCheck.value, [usernameCheck.value]);
    if (!strength.ok) {
      return res.status(400).json({
        error: "weak_password",
        message: strength.message,
        score: strength.score,
      });
    }

    if (userModel.usernameExists(usernameCheck.value)) {
      return res.status(409).json({ error: "username_taken", message: "That username is taken." });
    }

    const passwordHash = await password.hashPassword(shapeCheck.value);

    let user;
    try {
      user = userModel.createUser({ username: usernameCheck.value, passwordHash });
    } catch (err) {
      // Lost the race against another signup between the check above and
      // this insert. The UNIQUE index caught it; turn that into the same
      // message the check would have given.
      if (String(err.code).startsWith("SQLITE_CONSTRAINT")) {
        return res.status(409).json({ error: "username_taken", message: "That username is taken." });
      }
      throw err;
    }

    await establishSession(req, user);
    userModel.touchLastLogin(user.id);

    res.status(201).json({ user: userModel.toPublicUser(user) });
  } catch (err) {
    next(err);
  }
}

// ---- Login ------------------------------------------------------------

/** POST /api/auth/login  { username, password } */
async function login(req, res, next) {
  try {
    const rawUsername = typeof req.body?.username === "string" ? req.body.username : "";
    const rawPassword = typeof req.body?.password === "string" ? req.body.password : "";
    const canonical = userModel.canonicalise(rawUsername);
    const ip = req.ip;

    if (!canonical || !rawPassword) {
      return res.status(400).json({
        error: "missing_credentials",
        message: "Enter a username and password.",
      });
    }

    // Per-account lockout, checked before doing any work.
    const attemptStatus = loginAttempts.status(canonical);
    if (attemptStatus.locked) {
      return res.status(429).json({
        error: "account_locked",
        message: "Too many failed attempts for this account. Try again in 15 minutes.",
      });
    }

    const user = userModel.findByUsername(canonical);

    // Deliberately identical responses for "no such user" and "wrong
    // password". Saying "no account with that username" hands an attacker a
    // free list of which names are worth attacking. The equal-time compare
    // below closes the same leak in the timing channel.
    const genericFailure = {
      error: "invalid_credentials",
      message: "Incorrect username or password.",
    };

    if (!user) {
      await password.burnComparison(rawPassword);
      loginAttempts.record(canonical, ip, false);
      return res.status(401).json(genericFailure);
    }

    if (!user.password_hash) {
      // A Google-only account. Still the generic message — but the hint is
      // safe to give, since they had to know a real username to get here and
      // the alternative is an unsolvable login loop.
      await password.burnComparison(rawPassword);
      loginAttempts.record(canonical, ip, false);
      return res.status(401).json({
        error: "no_password_set",
        message: "This account was created with Google. Use “Sign in with Google”.",
      });
    }

    const matches = await password.verifyPassword(rawPassword, user.password_hash);
    if (!matches) {
      loginAttempts.record(canonical, ip, false);
      return res.status(401).json(genericFailure);
    }

    // Successful login is the one moment the plaintext exists in memory, so
    // it's the only chance to transparently upgrade an old, cheaper hash.
    if (password.needsRehash(user.password_hash)) {
      userModel.setPasswordHash(user.id, await password.hashPassword(rawPassword));
    }

    loginAttempts.record(canonical, ip, true);
    loginAttempts.clear(canonical);

    await establishSession(req, user);
    userModel.touchLastLogin(user.id);

    res.json({ user: userModel.toPublicUser(user) });
  } catch (err) {
    next(err);
  }
}

// ---- Logout -----------------------------------------------------------

/**
 * POST /api/auth/logout
 *
 * Destroys the row in the sessions table, so the cookie the browser is
 * holding refers to nothing. This is the concrete advantage of sessions over
 * JWTs: logout is a DELETE, and it's instant and total. With a stateless
 * token, "log out" only clears the client's copy — the token itself stays
 * valid until it expires, and revoking it early requires the denylist that
 * people adopt JWTs to avoid.
 */
function logout(req, res, next) {
  if (!req.session) return res.json({ ok: true });

  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie(req.app.get("sessionCookieName"));
    res.json({ ok: true });
  });
}

// ---- Current user -----------------------------------------------------

/**
 * GET /api/auth/me
 *
 * Not protected: an anonymous caller gets `{ user: null }` rather than a 401.
 * The home page calls this on load to decide between "hello <name>" and a
 * log-in link, and a 401 in the console on every anonymous page view would
 * be noise, not information.
 */
function me(req, res) {
  res.json({
    user: req.user ? userModel.toPublicUser(req.user) : null,
    // Lets the frontend hide the Google button when the server has no
    // credentials configured, instead of offering a link that 503s.
    googleEnabled: req.app.get("googleEnabled") === true,
  });
}

// ---- Google completion step -------------------------------------------

/**
 * POST /api/auth/choose-username  { username }
 *
 * The second half of a Google signup. Google gives us a verified email and a
 * stable id, but "chanakyashivaji1@gmail.com" is not a name to put on a
 * leaderboard, so a new Google user is parked in `session.pendingGoogle` and
 * sent here to pick one.
 *
 * The pending identity is read from the *session*, never from the request
 * body. If the client could post its own googleId/email, this endpoint would
 * be an "create an account as anyone" hole.
 */
async function chooseUsername(req, res, next) {
  try {
    const pending = req.session?.pendingGoogle;
    if (!pending) {
      return res.status(400).json({
        error: "no_pending_signup",
        message: "That signup expired. Start again with Google.",
      });
    }

    const usernameCheck = validateUsername(req.body?.username);
    if (!usernameCheck.ok) {
      return res.status(400).json({ error: "invalid_username", message: usernameCheck.message });
    }

    if (userModel.usernameExists(usernameCheck.value)) {
      return res.status(409).json({ error: "username_taken", message: "That username is taken." });
    }

    let user;
    try {
      user = userModel.createUser({
        username: usernameCheck.value,
        email: pending.email,
        googleId: pending.googleId,
        avatarUrl: pending.avatarUrl,
        // No password_hash: this account genuinely has no password. NULL
        // says that honestly instead of storing an unusable placeholder.
        passwordHash: null,
      });
    } catch (err) {
      if (String(err.code).startsWith("SQLITE_CONSTRAINT")) {
        return res.status(409).json({ error: "username_taken", message: "That username is taken." });
      }
      throw err;
    }

    await establishSession(req, user);
    userModel.touchLastLogin(user.id);

    res.status(201).json({ user: userModel.toPublicUser(user) });
  } catch (err) {
    next(err);
  }
}

/** GET /api/auth/pending-google — lets the pick-a-username page prefill a suggestion. */
function pendingGoogle(req, res) {
  const pending = req.session?.pendingGoogle;
  if (!pending) return res.status(404).json({ error: "no_pending_signup" });

  res.json({
    email: pending.email,
    suggestion: pending.suggestion,
    avatarUrl: pending.avatarUrl,
  });
}

module.exports = {
  establishSession,
  checkUsername,
  signup,
  login,
  logout,
  me,
  chooseUsername,
  pendingGoogle,
};
