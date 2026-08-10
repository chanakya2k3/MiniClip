/**
 * Entry point.
 *
 * This file used to be the whole application: a hand-rolled static file
 * server, the tic-tac-toe rules, and the socket wiring in one place. Adding
 * authentication is what made that stop scaling, so the pieces now live in
 * src/ and this file does the one thing an entry point should — assemble
 * them and listen.
 *
 *   src/app.js              Express app (middleware, API routes, static)
 *   src/realtime/           the game, unchanged in behaviour
 *   src/{routes,controllers,models}   the layers auth and scores are built in
 *
 * The important structural decision: Express and socket.io share ONE
 * http.Server. Not two processes on two ports.
 *
 *   - One origin, so fetch('/api/...') needs no CORS configuration and no
 *     hardcoded backend URL.
 *   - One cookie. The session cookie the browser holds for the page is sent
 *     with the socket.io handshake automatically, which is why the game can
 *     tell who a player is (see resolveIdentity in src/realtime/ticTacToe.js)
 *     without inventing a second token scheme.
 *   - One thing to deploy.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { Server } = require("socket.io");

const config = require("./src/config/env");
const { createApp, PUBLIC_DIR } = require("./src/app");
const { registerRealtime } = require("./src/realtime");
const loginAttempts = require("./src/models/loginAttemptModel");

const DEV = !config.isProduction;

// (The schema is applied by src/db as soon as it's imported — see the note
// there on why it can't wait until here.)

const { app, sessionMiddleware } = createApp();
const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  // Same-origin only. The old `origin: "*"` was survivable when the socket
  // was anonymous, but now that the handshake carries a session cookie it
  // would let any website open an authenticated socket as a visiting user.
  cors: { origin: config.appOrigin, credentials: true },
});

// Give socket handlers access to the same session the HTTP side sees, so
// `socket.request.session.userId` is the very same field `req.session.userId`
// is — one definition of "logged in", shared by both transports.
io.engine.use(sessionMiddleware);

// Games, presence, chat and voice signalling.
registerRealtime(io);

// ---- Dev live-reload --------------------------------------------------
// Watches the files you actually edit and pushes a hint to every client.
// style.css is swapped in place (no reload, so nothing in the running game
// is disturbed). HTML can't be hot-swapped, so the client reloads — and
// because identity lives in playerId, the reload resumes the same seat
// with the same board.

if (DEV) {
  const WATCHED = [
    "style.css",
    "index.html",
    "tic-tac-toe.html",
    "flappy-duel.html",
    "login.html",
    "signup.html",
    "choose-username.html",
    "profile.html",
    "auth-client.js",
  ];
  let lastFired = 0;

  for (const file of WATCHED) {
    const full = path.join(PUBLIC_DIR, file);
    if (!fs.existsSync(full)) continue;

    fs.watch(full, () => {
      // Editors often write a file two or three times in a burst; one
      // event per save is enough.
      const now = Date.now();
      if (now - lastFired < 100) return;
      lastFired = now;

      if (file.endsWith(".css")) {
        io.emit("dev:css", { file, version: now });
      } else {
        io.emit("dev:reload", { file });
      }
      console.log(`changed: ${file}`);
    });
  }
}

// Trim old rows on boot and daily, so login_attempts doesn't grow forever.
loginAttempts.prune();
setInterval(() => loginAttempts.prune(), 24 * 60 * 60 * 1000).unref();

httpServer.listen(config.port, () => {
  console.log(`MiniClip running at http://localhost:${config.port}`);
  console.log(`  auth:   ${config.google.enabled ? "password + Google" : "password only"}`);
  console.log(`  db:     ${config.db.file}`);
  if (DEV) console.log("  live-reload on: css hot-swaps, html reloads (game state survives)");
});
