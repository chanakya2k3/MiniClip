/**
 * SQLite connection.
 *
 * Why SQLite and not Postgres, since that question will get asked:
 *
 *   SQLite is a file, not a server. There is nothing to install, nothing to
 *   start, no connection string, no port. Someone cloning this repo runs
 *   `npm start` and has a working database. For a portfolio project that is
 *   worth a great deal — the reviewer who has to provision Postgres before
 *   seeing your app is a reviewer who closes the tab.
 *
 *   What you give up:
 *     - One writer at a time. WAL mode (below) lets readers run concurrently
 *       with a writer, so this bites much later than people expect, but it
 *       is a real ceiling.
 *     - It's a local file, so it can't be shared by two app processes on two
 *       machines. Horizontal scaling means moving off it.
 *     - Ephemeral filesystems (Heroku, some Render/Fly configs) wipe the
 *       file on redeploy. Deploying SQLite means deploying a persistent disk.
 *     - Loose typing and fewer built-ins than Postgres (no native JSONB,
 *       no real ENUM, weaker date handling).
 *
 *   None of those bind an arcade site with a login form. The migration path
 *   is kept cheap by confining SQL to the model layer: swapping in Postgres
 *   means rewriting src/models/*, not hunting queries through controllers.
 *
 * better-sqlite3 (rather than node:sqlite or the older `sqlite3` package)
 * because its API is synchronous. SQLite reads are a memcpy from the OS page
 * cache — microseconds — so wrapping them in promises buys no concurrency and
 * costs a callback at every call site. Synchronous queries also mean a
 * transaction is an ordinary JS function that either returns or throws.
 */

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const config = require("../config/env");

// The DB file lives in data/, which git ignores. Create it on first run so
// a fresh clone doesn't fail on a missing directory.
fs.mkdirSync(path.dirname(config.db.file), { recursive: true });

const db = new Database(config.db.file);

// Write-Ahead Logging: readers don't block the writer and the writer doesn't
// block readers. Without it, a single slow write stalls every request.
db.pragma("journal_mode = WAL");

// SQLite honours foreign keys only if you ask it to — off is the historical
// default. Without this, `scores.user_id REFERENCES users(id)` is a comment.
db.pragma("foreign_keys = ON");

// Wait rather than instantly throwing SQLITE_BUSY if another connection
// (the session store's cleanup, say) holds the write lock.
db.pragma("busy_timeout = 5000");

/** Applies schema.sql. Idempotent — every statement is CREATE IF NOT EXISTS. */
function migrate() {
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  db.exec(schema);
}

// Run at import time, not from the entry point.
//
// The models and the session store build their prepared statements at module
// scope, and `db.prepare()` fails immediately if the table isn't there yet.
// Those statements are created the moment something `require`s them — which,
// through the app's import chain, happens before any line of server.js runs.
// Migrating here makes "you have a connection" and "the schema exists" the
// same fact, so no caller can observe the gap between them.
migrate();

module.exports = { db, migrate };
