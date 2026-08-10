/**
 * The Express application: middleware stack, routes, static files.
 *
 * Exported rather than started here. server.js owns the HTTP server, because
 * socket.io needs to attach to that same server object — one process, one
 * port, one origin, and therefore one session cookie that both the REST API
 * and the game socket can read.
 *
 * ============ Sessions or JWTs? ============
 *
 * Session cookies. The reasoning, since it's the question every reviewer
 * asks:
 *
 * A session cookie is a random id. It means nothing on its own; the server
 * looks it up in the sessions table to find out who you are. A JWT is the
 * opposite — a signed blob that *contains* the claims, which the server
 * verifies without looking anything up.
 *
 * That statelessness is the JWT's whole selling point, and it's the source of
 * every problem with it:
 *
 *   Revocation. A signed token is valid until it expires, full stop. "Log
 *   out everywhere", "ban this account", "I changed my password" cannot be
 *   honoured without a server-side denylist of revoked tokens — at which
 *   point you have session storage again, but with worse ergonomics and two
 *   sources of truth. Here, logout is `DELETE FROM sessions WHERE sid = ?`.
 *
 *   Storage on the client. A JWT has to live somewhere. localStorage is
 *   readable by any JavaScript on the page, so one XSS exfiltrates a
 *   credential that stays valid for its full lifetime. Put it in a cookie
 *   instead and you get the security properties of a cookie — httpOnly,
 *   Secure, SameSite — while still carrying the downsides of a JWT, which is
 *   the worst of both. The session cookie below is httpOnly: page JavaScript
 *   cannot read it, so XSS can't steal it.
 *
 *   Staleness. Claims baked into a token are a snapshot from login time.
 *   Sessions read the user row per request, so a rename shows up immediately.
 *
 * What you give up: sessions need shared storage across app instances. That
 * matters when you're running many servers behind a load balancer. This is
 * one Node process serving an arcade site — the constraint JWTs exist to
 * solve is not one this app has.
 *
 * There's a bonus specific to this project: socket.io's handshake carries
 * cookies automatically, so the game server can identify a player from the
 * same session with no extra token plumbing.
 */

const path = require("path");
const express = require("express");
const session = require("express-session");
const helmet = require("helmet");
const passport = require("passport");

const config = require("./config/env");
const SqliteSessionStore = require("./auth/sessionStore");
const { configureGoogleStrategy } = require("./auth/google");
const { attachUser, requireAuthPage } = require("./middleware/requireAuth");
const { checkOrigin } = require("./middleware/originCheck");
const { apiLimiter } = require("./middleware/rateLimit");
const authRoutes = require("./routes/authRoutes");
const scoreRoutes = require("./routes/scoreRoutes");
const socialRoutes = require("./routes/socialRoutes");

const PUBLIC_DIR = path.join(__dirname, "..", "public");

function createApp() {
  const app = express();

  // Behind a reverse proxy (nginx, Fly, Render) the socket's address is the
  // proxy's. Without this, req.ip is the proxy for every visitor — which
  // would make the rate limiter treat all traffic as one client — and
  // express-session would see http and refuse to set a Secure cookie.
  // Only in production: trusting this header locally would let anyone spoof
  // their IP past the rate limiter with a header.
  if (config.isProduction) app.set("trust proxy", 1);

  app.disable("x-powered-by");

  // ---- Security headers ----------------------------------------------
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          // The games are single self-contained HTML files with inline
          // <style> and <script>, so 'unsafe-inline' is required for the
          // site to run at all. Being honest about the cost: it means CSP
          // is not providing XSS protection here, only limiting where
          // scripts may be *loaded* from. Extracting the inline blocks into
          // .js/.css files (or hashing them) is what would let this be
          // tightened, and it's the single highest-value hardening left.
          scriptSrc: ["'self'", "'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
          fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
          // Google profile pictures come from googleusercontent.com.
          imgSrc: ["'self'", "data:", "https://lh3.googleusercontent.com"],
          // socket.io upgrades to a WebSocket on the same origin.
          connectSrc: ["'self'", "ws:", "wss:"],
          formAction: ["'self'", "https://accounts.google.com"],
          frameAncestors: ["'none'"],  // no embedding: clickjacking defence
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
        },
      },
      // Google's OAuth popup/redirect and the fonts CDN don't send CORP
      // headers, and blocking them breaks both.
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: "cross-origin" },
      // HSTS is meaningful only over real HTTPS. On http://localhost it
      // would pin the browser to https for localhost — which breaks every
      // other local project on that host, and is genuinely annoying to undo.
      hsts: config.isProduction,
    })
  );

  // ---- Body parsing ---------------------------------------------------
  // 16kb: a login form is a few hundred bytes. Anything larger is either a
  // bug or someone probing, and rejecting it early keeps oversized payloads
  // from reaching the handlers at all.
  app.use(express.json({ limit: "16kb" }));
  app.use(express.urlencoded({ extended: false, limit: "16kb" }));

  // ---- Sessions -------------------------------------------------------
  app.set("sessionCookieName", config.session.cookieName);

  const sessionMiddleware = session({
    name: config.session.cookieName,     // not the default "connect.sid" — no free "this is Express" hint
    secret: config.session.secret,
    store: new SqliteSessionStore({ ttlMs: config.session.maxAgeMs }),
    resave: false,                       // don't rewrite an unchanged session on every request
    saveUninitialized: false,            // no DB row (or cookie) for anonymous visitors
    rolling: true,                       // sliding expiry: active players stay logged in
    cookie: {
      httpOnly: true,                    // JavaScript cannot read it — an XSS can't steal the session
      // HTTPS-only in production. It cannot be unconditional: a Secure
      // cookie is silently dropped over http://localhost, which presents as
      // "login succeeds and then I'm immediately logged out".
      secure: config.isProduction,
      sameSite: "lax",                   // not sent on cross-site POSTs — the primary CSRF defence.
                                         // "lax" rather than "strict" so the Google OAuth redirect
                                         // back into the site still arrives with the session attached.
      maxAge: config.session.maxAgeMs,
      path: "/",
    },
  });

  app.use(sessionMiddleware);

  // ---- Passport (Google only; see src/auth/google.js) ------------------
  const googleEnabled = configureGoogleStrategy();
  app.set("googleEnabled", googleEnabled);
  app.use(passport.initialize());  // no passport.session() — sessions are ours, not passport's

  // Populate req.user for every request, anonymous ones included.
  app.use(attachUser);

  // ---- API ------------------------------------------------------------
  app.use("/api", apiLimiter);
  app.use("/api", checkOrigin);        // rejects cross-site POST/PUT/DELETE
  app.use("/api/auth", authRoutes);
  app.use("/api/scores", scoreRoutes);
  app.use("/api/friends", socialRoutes.friends);
  app.use("/api/messages", socialRoutes.messages);

  // ---- Protected pages -------------------------------------------------
  // Registered before express.static so the guard runs first; otherwise the
  // static handler would serve the file and never reach this.
  for (const page of ["profile.html", "friends.html"]) {
    app.get(`/${page}`, requireAuthPage, (_req, res) => {
      res.sendFile(path.join(PUBLIC_DIR, page));
    });
  }

  // ---- Static files ----------------------------------------------------
  // Rooted at public/, not the project directory. Serving the project root
  // — which is what a naive static server does — publishes .env, server.js,
  // package.json and the whole src/ tree to anyone who guesses a filename.
  // The directory boundary is the control; nothing secret lives below it.
  app.use(
    express.static(PUBLIC_DIR, {
      extensions: ["html"],
      // Development is a live-reload loop, so caching a stale file is the
      // opposite of helpful. In production the pages are small and mostly
      // HTML; an hour is a reasonable compromise until there's a build step
      // emitting content-hashed filenames.
      maxAge: config.isProduction ? "1h" : 0,
      etag: true,
    })
  );

  // Serve zxcvbn from node_modules rather than a CDN. Two reasons: the page
  // keeps working offline and on a locked-down network, and a third-party
  // script tag on the signup form is a script with access to the password
  // field. Self-hosting removes that trust relationship entirely.
  //
  // A single file, so it's a route rather than express.static — serve-static
  // takes a directory as its root, and pointing it at one file doesn't work.
  const ZXCVBN_PATH = require.resolve("zxcvbn/dist/zxcvbn.js");
  app.get("/vendor/zxcvbn.js", (_req, res) => {
    res.sendFile(ZXCVBN_PATH, {
      maxAge: "7d",  // version is pinned in package.json; safe to cache hard
      headers: { "Content-Type": "text/javascript; charset=utf-8" },
    });
  });

  // ---- Fallbacks -------------------------------------------------------
  app.use((req, res) => {
    if (req.path.startsWith("/api/")) {
      return res.status(404).json({ error: "not_found", message: "No such endpoint." });
    }
    res.status(404).sendFile(path.join(PUBLIC_DIR, "404.html"), (err) => {
      if (err) res.status(404).type("text/plain").send("Not found");
    });
  });

  // ---- Error handler ---------------------------------------------------
  // Four arguments is what marks this as Express's error handler; the unused
  // `next` is load-bearing and cannot be removed.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    console.error("[error]", err);

    // Never return err.message to the client. Stack traces and driver errors
    // leak table names, file paths and library versions — free reconnaissance.
    // The log above keeps the detail on the server where it belongs.
    if (res.headersSent) return;
    res.status(500).json({
      error: "server_error",
      message: "Something went wrong on our end.",
    });
  });

  return { app, sessionMiddleware };
}

module.exports = { createApp, PUBLIC_DIR };
