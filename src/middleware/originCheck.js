/**
 * CSRF defence.
 *
 * The problem, concretely: session cookies are attached by the browser to
 * *every* request to this origin, including one triggered by a form on
 * evil.com. Without a check, a page the user visits while logged in can POST
 * to /api/auth/logout — or anything worse we add later — and the browser
 * will helpfully authenticate it.
 *
 * There are two layers here rather than a csurf-style token, and the reason
 * is that this app's state-changing endpoints are all JSON fetches from the
 * same origin, which is exactly the case the two cheap layers cover:
 *
 *  1. SameSite=Lax on the session cookie (set in app.js). The browser simply
 *     won't send the cookie on a cross-site POST, so the forged request
 *     arrives logged out. This alone stops the classic attack.
 *
 *  2. This middleware: an explicit Origin header check on every mutating
 *     request. Defence in depth for old browsers, and it fails closed —
 *     a request with no Origin at all on a POST is rejected.
 *
 * If this app ever grows a cross-origin frontend or a plain <form> that POSTs
 * across sites, swap this for real per-session CSRF tokens. Until then a
 * token would be ceremony without added protection.
 */

const config = require("../config/env");

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function checkOrigin(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();

  // Browsers send Origin on every cross-origin request and on all POSTs.
  // Referer is the fallback for the rare client that omits Origin.
  const origin = req.get("origin") || req.get("referer");

  if (!origin) {
    return res.status(403).json({
      error: "csrf",
      message: "Missing origin header on a state-changing request.",
    });
  }

  let originHost;
  try {
    originHost = new URL(origin).origin;
  } catch {
    return res.status(403).json({ error: "csrf", message: "Malformed origin header." });
  }

  // Compare against the configured public origin, and also against the host
  // the request actually arrived on — so hitting the dev server via
  // 127.0.0.1 when APP_ORIGIN says localhost doesn't lock you out.
  const allowed = new Set([config.appOrigin, `${req.protocol}://${req.get("host")}`]);

  if (!allowed.has(originHost)) {
    return res.status(403).json({
      error: "csrf",
      message: "Cross-origin request rejected.",
    });
  }

  next();
}

module.exports = { checkOrigin };
