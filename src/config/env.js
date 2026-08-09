/**
 * Environment configuration — the single place that reads process.env.
 *
 * Everything else imports this module and gets plain values. That means
 * a typo'd variable name fails here, once, at boot, instead of showing up
 * as `undefined` in the middle of a login six weeks from now.
 *
 * The rule for secrets: no defaults in production. A fallback secret is
 * worse than a missing one, because a missing one crashes loudly and a
 * fallback one quietly ships a key that's identical on every machine
 * running this code — including anyone who cloned the repo.
 */

require("dotenv").config();

const crypto = require("crypto");
const path = require("path");

const NODE_ENV = process.env.NODE_ENV || "development";
const isProduction = NODE_ENV === "production";

/** Reads a required value; in dev, falls back with a warning instead of dying. */
function requireSecret(name, devFallback) {
  const value = process.env[name];
  if (value) return value;

  if (isProduction) {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        `Copy .env.example to .env and fill it in.`
    );
  }

  console.warn(
    `[config] ${name} is not set — using a throwaway value for this dev run. ` +
      `Sessions will be invalidated on restart.`
  );
  return devFallback();
}

const config = {
  env: NODE_ENV,
  isProduction,
  port: Number(process.env.PORT) || 3001,

  // Where the app thinks it lives. OAuth callbacks and the same-origin
  // check are both derived from this, so it must match the URL in the
  // browser's address bar.
  appOrigin: process.env.APP_ORIGIN || `http://localhost:${Number(process.env.PORT) || 3001}`,

  session: {
    // A random per-boot secret in dev is deliberate: it means "you forgot
    // to configure this" shows up as being logged out after a restart,
    // rather than as a silently insecure deployment.
    secret: requireSecret("SESSION_SECRET", () =>
      crypto.randomBytes(48).toString("base64url")
    ),
    // 7 days. Long enough that a casual player isn't re-typing a password
    // every visit, short enough that an abandoned session on a shared
    // machine expires on its own.
    maxAgeMs: 7 * 24 * 60 * 60 * 1000,
    cookieName: "miniclip.sid",
  },

  db: {
    file: path.resolve(
      process.cwd(),
      process.env.DATABASE_FILE || "./data/miniclip.db"
    ),
  },

  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
    // Feature flag rather than a hard requirement: the whole app should
    // still boot and work with password auth when OAuth isn't set up.
    // A portfolio clone shouldn't need Google credentials to run at all.
    get enabled() {
      return Boolean(this.clientId && this.clientSecret);
    },
  },
};

module.exports = config;
