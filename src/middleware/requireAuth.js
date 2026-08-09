/**
 * Route protection.
 *
 * There is exactly one thing that means "logged in" in this codebase:
 * `req.session.userId` is set. Not a header, not a token, not a passport
 * property — one field, in one place. Adding a second way to be authenticated
 * is how apps end up with a bypass nobody noticed.
 */

const userModel = require("../models/userModel");

/**
 * Loads the session's user onto `req.user` when there is one.
 *
 * Runs on every request, including anonymous ones — it never rejects. That
 * lets a page like the home page say "hello <name>" or "log in" from the
 * same handler, and keeps the actual gate (below) down to a null check.
 *
 * It re-reads the user from the database rather than trusting a copy stored
 * in the session, so a rename or a deletion takes effect on the next request
 * instead of whenever the session happens to expire.
 */
function attachUser(req, _res, next) {
  req.user = null;

  if (req.session?.userId) {
    const user = userModel.findById(req.session.userId);
    if (user) {
      req.user = user;
    } else {
      // The session points at a user that no longer exists (deleted account,
      // or a database that got reset in development). Drop the stale session
      // rather than carrying a dangling id around.
      req.session.userId = null;
    }
  }

  next();
}

/** Gate for API routes. Answers with JSON, because its callers speak JSON. */
function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: "auth_required", message: "You need to be logged in." });
  }
  next();
}

/**
 * Gate for HTML pages. Same check, but redirects to the login page with a
 * `next` parameter so the user lands back where they were headed.
 *
 * The redirect target is a path only (never a full URL from the query
 * string) — accepting an absolute URL here is the classic open-redirect
 * that turns your login page into a convincing phishing hop.
 */
function requireAuthPage(req, res, next) {
  if (!req.user) {
    const target = encodeURIComponent(req.originalUrl);
    return res.redirect(`/login.html?next=${target}`);
  }
  next();
}

module.exports = { attachUser, requireAuth, requireAuthPage };
