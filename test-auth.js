/**
 * End-to-end auth tests.
 *
 * Spawns a real server on its own port against a throwaway database, then
 * drives it over HTTP exactly the way a browser would. No mocks: the thing
 * under test is the whole stack — middleware order, cookie flags, the
 * session store, bcrypt, the rate limiter.
 *
 *   npm run test:auth
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const PORT = 3199;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_FILE = path.join(os.tmpdir(), `miniclip-test-${Date.now()}.db`);

let passed = 0;
let failed = 0;

function check(name, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m  ${name}`);
  } else {
    failed++;
    console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? `\n          ${detail}` : ""}`);
  }
}

/**
 * Minimal cookie jar. The browser does this for us in real life; here we
 * have to keep the session cookie ourselves to prove it works at all.
 */
function makeJar() {
  const cookies = new Map();
  return {
    store(response) {
      for (const raw of response.headers.getSetCookie?.() ?? []) {
        const [pair] = raw.split(";");
        const index = pair.indexOf("=");
        cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
      }
    },
    header() {
      return [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    },
    raw(response) {
      return response.headers.getSetCookie?.() ?? [];
    },
    clear() { cookies.clear(); },
  };
}

async function call(jar, method, urlPath, body, extraHeaders = {}) {
  const headers = { Origin: BASE, ...extraHeaders };
  if (body) headers["Content-Type"] = "application/json";
  const cookie = jar.header();
  if (cookie) headers.Cookie = cookie;

  const response = await fetch(BASE + urlPath, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  jar.store(response);

  let data = null;
  try { data = await response.json(); } catch { /* not JSON */ }
  return { status: response.status, data: data || {}, response };
}

async function waitForServer(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/api/auth/me`);
      if (response.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function run() {
  const jar = makeJar();
  const unique = Date.now().toString(36).slice(-6);
  const username = `tester_${unique}`;
  const strongPassword = "trombone-batter-glacier-71";

  console.log("\n\x1b[1mAuth end-to-end\x1b[0m\n");

  // ---- Username validation -------------------------------------------
  console.log("username rules");
  {
    const short = await call(jar, "GET", "/api/auth/username-available?username=ab");
    check("rejects a 2-character username", short.data.valid === false);

    const bad = await call(jar, "GET", "/api/auth/username-available?username=has%20space");
    check("rejects a username with a space", bad.data.valid === false);

    const reserved = await call(jar, "GET", "/api/auth/username-available?username=admin");
    check("rejects a reserved username", reserved.data.valid === false);

    const free = await call(jar, "GET", `/api/auth/username-available?username=${username}`);
    check("reports an unused username as available", free.data.available === true);
  }

  // ---- Password policy -------------------------------------------------
  console.log("\npassword policy (enforced server-side)");
  {
    const short = await call(jar, "POST", "/api/auth/signup", {
      username, password: "short1",
    });
    check("rejects a password under the length minimum", short.status === 400,
      `got ${short.status}`);

    // Passes any "uppercase + lowercase + digit + symbol" regex policy and is
    // still one of the most-guessed passwords in existence. This is the case
    // zxcvbn catches and a character-class rule does not.
    const common = await call(jar, "POST", "/api/auth/signup", {
      username, password: "P@ssw0rd123",
    });
    check("rejects a common password that satisfies regex rules",
      common.status === 400 && common.data.error === "weak_password",
      `got ${common.status} ${common.data.error}`);

    const asName = await call(jar, "POST", "/api/auth/signup", {
      username, password: `${username}${username}`,
    });
    check("rejects a password built from the username", asName.status === 400,
      `got ${asName.status}`);
  }

  // ---- Signup ----------------------------------------------------------
  console.log("\nsignup");
  let sessionCookieAttrs = "";
  {
    const created = await call(jar, "POST", "/api/auth/signup", {
      username, password: strongPassword,
    });
    check("creates the account", created.status === 201, `got ${created.status}`);
    check("returns the username", created.data.user?.username === username);
    check("never returns a password hash",
      !JSON.stringify(created.data).toLowerCase().includes("$2b$"));

    sessionCookieAttrs = jar.raw(created.response).find((c) => c.startsWith("miniclip.sid")) || "";
    check("sets an httpOnly session cookie", /httponly/i.test(sessionCookieAttrs),
      sessionCookieAttrs);
    check("sets SameSite=Lax on the session cookie", /samesite=lax/i.test(sessionCookieAttrs),
      sessionCookieAttrs);

    const taken = await call(jar, "GET", `/api/auth/username-available?username=${username}`);
    check("now reports the username as taken", taken.data.available === false);

    const dupe = await call(jar, "POST", "/api/auth/signup", {
      username: username.toUpperCase(), password: strongPassword,
    });
    check("rejects the same username in different case", dupe.status === 409,
      `got ${dupe.status}`);
  }

  // ---- Session ----------------------------------------------------------
  console.log("\nsession");
  {
    const me = await call(jar, "GET", "/api/auth/me");
    check("signup logged the user in", me.data.user?.username === username);

    const profile = await call(jar, "GET", "/api/auth/profile");
    check("protected route allows the session", profile.status === 200,
      `got ${profile.status}`);

    const anon = makeJar();
    const blocked = await call(anon, "GET", "/api/auth/profile");
    check("protected route rejects an anonymous caller", blocked.status === 401,
      `got ${blocked.status}`);

    const blockedScore = await call(anon, "POST", "/api/scores", { game: "flappy-duel", score: 10 });
    check("score submission requires login", blockedScore.status === 401,
      `got ${blockedScore.status}`);
  }

  // ---- Scores (the extension point) ------------------------------------
  console.log("\nprotected feature route");
  {
    const saved = await call(jar, "POST", "/api/scores", { game: "flappy-duel", score: 42 });
    check("saves a score for the logged-in user", saved.status === 201, `got ${saved.status}`);

    const bogusGame = await call(jar, "POST", "/api/scores", { game: "../etc/passwd", score: 5 });
    check("rejects an unknown game", bogusGame.status === 400);

    const bogusScore = await call(jar, "POST", "/api/scores", { game: "flappy-duel", score: 1e9 });
    check("rejects an implausible score", bogusScore.status === 400);

    const board = await call(jar, "GET", "/api/scores/leaderboard/flappy-duel");
    check("leaderboard lists the score",
      board.data.entries?.some((e) => e.username === username && e.score === 42));
  }

  // ---- Logout ------------------------------------------------------------
  console.log("\nlogout");
  {
    await call(jar, "POST", "/api/auth/logout");
    const after = await call(jar, "GET", "/api/auth/me");
    check("session is destroyed server-side", after.data.user === null);

    const blocked = await call(jar, "GET", "/api/auth/profile");
    check("protected route rejects the dead session", blocked.status === 401,
      `got ${blocked.status}`);
  }

  // ---- Login -------------------------------------------------------------
  console.log("\nlogin");
  {
    const wrong = await call(jar, "POST", "/api/auth/login", {
      username, password: "definitely-not-it-42",
    });
    check("rejects a wrong password", wrong.status === 401, `got ${wrong.status}`);

    const noSuchUser = await call(jar, "POST", "/api/auth/login", {
      username: `ghost_${unique}`, password: "definitely-not-it-42",
    });
    check("gives an identical message for an unknown username",
      noSuchUser.data.message === wrong.data.message,
      `"${noSuchUser.data.message}" vs "${wrong.data.message}"`);

    const good = await call(jar, "POST", "/api/auth/login", {
      username, password: strongPassword,
    });
    check("accepts the correct password", good.status === 200, `got ${good.status}`);

    const mixedCase = await call(makeJar(), "POST", "/api/auth/login", {
      username: username.toUpperCase(), password: strongPassword,
    });
    check("login is case-insensitive on the username", mixedCase.status === 200,
      `got ${mixedCase.status}`);
  }

  // ---- CSRF / origin -----------------------------------------------------
  console.log("\ncross-origin protection");
  {
    const forged = await call(jar, "POST", "/api/scores",
      { game: "flappy-duel", score: 99 }, { Origin: "https://evil.example" });
    check("rejects a state-changing request from another origin", forged.status === 403,
      `got ${forged.status}`);

    const readable = await call(jar, "GET", "/api/auth/me", null,
      { Origin: "https://evil.example" });
    check("still allows safe cross-origin GETs", readable.status === 200);
  }

  // ---- Static exposure ----------------------------------------------------
  console.log("\nstatic file exposure");
  {
    for (const target of ["/.env", "/server.js", "/package.json", "/src/app.js",
                          "/data/miniclip.db", "/../.env"]) {
      const response = await fetch(BASE + target, { redirect: "manual" });
      check(`does not serve ${target}`, response.status === 404,
        `got ${response.status}`);
    }

    const page = await fetch(`${BASE}/login.html`);
    check("does serve the login page", page.status === 200, `got ${page.status}`);

    const vendor = await fetch(`${BASE}/vendor/zxcvbn.js`);
    check("serves zxcvbn locally (no CDN)", vendor.status === 200, `got ${vendor.status}`);
  }

  // ---- Protected page --------------------------------------------------
  console.log("\nprotected page");
  {
    const anonPage = await fetch(`${BASE}/profile.html`, { redirect: "manual" });
    check("redirects an anonymous visitor to login",
      anonPage.status === 302 && (anonPage.headers.get("location") || "").startsWith("/login.html"),
      `got ${anonPage.status} -> ${anonPage.headers.get("location")}`);
  }

  // ---- Google, unconfigured ---------------------------------------------
  console.log("\ngoogle oauth (not configured in this run)");
  {
    const attempt = await call(jar, "GET", "/api/auth/google");
    check("explains itself instead of crashing", attempt.status === 503,
      `got ${attempt.status}`);

    const me = await call(jar, "GET", "/api/auth/me");
    check("tells the frontend Google is unavailable", me.data.googleEnabled === false);
  }

  // ---- Brute-force throttling --------------------------------------------
  console.log("\nbrute-force throttling");
  {
    const attacker = makeJar();
    let lockedAt = null;

    for (let i = 1; i <= 12 && lockedAt === null; i++) {
      const attempt = await call(attacker, "POST", "/api/auth/login", {
        username, password: `guess-number-${i}`,
      });
      if (attempt.status === 429) lockedAt = i;
    }

    check("locks out repeated failed logins", lockedAt !== null,
      lockedAt === null ? "12 wrong passwords never triggered a 429" : "");
    if (lockedAt !== null) console.log(`          (blocked at attempt ${lockedAt})`);
  }

  console.log(`\n\x1b[1m${passed} passed, ${failed} failed\x1b[0m\n`);
  return failed === 0;
}

// ---- Harness -------------------------------------------------------------

const server = spawn(process.execPath, ["server.js"], {
  env: {
    ...process.env,
    PORT: String(PORT),
    NODE_ENV: "development",
    DATABASE_FILE: DB_FILE,
    APP_ORIGIN: BASE,
    SESSION_SECRET: "test-secret-not-used-anywhere-real",
    // Force Google off for this run regardless of the developer's .env, so
    // the suite behaves the same on every machine.
    GOOGLE_CLIENT_ID: "",
    GOOGLE_CLIENT_SECRET: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let serverLog = "";
server.stdout.on("data", (chunk) => { serverLog += chunk; });
server.stderr.on("data", (chunk) => { serverLog += chunk; });

function cleanup() {
  server.kill();
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(DB_FILE + suffix); } catch { /* already gone */ }
  }
}

(async () => {
  const up = await waitForServer();
  if (!up) {
    console.error("Server did not start.\n" + serverLog);
    cleanup();
    process.exit(1);
  }

  let ok = false;
  try {
    ok = await run();
  } catch (err) {
    console.error("\nTest run threw:", err);
    console.error("\n--- server output ---\n" + serverLog);
  }

  cleanup();
  process.exit(ok ? 0 : 1);
})();
