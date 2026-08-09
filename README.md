# MiniClip

A small arcade site with server-authoritative multiplayer and a full
authentication system — password accounts, Google OAuth, sessions, and
per-user high scores.

Built as a learning project, so the code is commented with *why* rather than
*what*. This README covers the decisions worth defending in an interview.

```bash
npm install
cp .env.example .env      # then set SESSION_SECRET
npm start                 # http://localhost:3001
```

Google sign-in is optional — leave the `GOOGLE_*` variables blank and the app
runs with password login only.

```bash
npm test            # multiplayer reconnect behaviour (18 checks)
npm run test:auth   # auth end-to-end against a real server (42 checks)
```

---

## Layout

```
server.js               entry point: builds the HTTP server, mounts Express + socket.io
src/
  config/env.js         the only module that reads process.env
  db/
    index.js            SQLite connection, pragmas, migrate-on-import
    schema.sql          users, sessions, login_attempts, scores
  models/               every SQL statement in the project lives here
  auth/
    password.js         bcrypt + zxcvbn policy
    sessionStore.js     express-session store on better-sqlite3
    google.js           passport strategy, OAuth flow notes
  middleware/           requireAuth, rate limiters, origin/CSRF check
  validators/           input rules, shared by signup and OAuth completion
  controllers/          request handling and flow control
  routes/               URL surface
  realtime/             the tic-tac-toe game server
public/                 all browser-facing files, and nothing else
```

The layering rule: **routes** know URLs, **controllers** know HTTP,
**models** know SQL, and nothing knows two of those at once. Adding a feature
(a friends list, match history) means one file in each layer, and
`requireAuth` already knows how to protect it.

---

## Decisions

### SQLite, not PostgreSQL

SQLite is a file. Nothing to install, no connection string, no daemon —
`git clone && npm install && npm start` gives you a working database. For a
portfolio project that matters more than it sounds: a reviewer who has to
provision Postgres before seeing the app is a reviewer who closes the tab.

The real limits, honestly stated: one writer at a time (WAL mode lets readers
run concurrently, so this bites much later than people expect); it can't be
shared across machines, so horizontal scaling means migrating off it; and
ephemeral filesystems wipe it on redeploy, so deploying it means attaching a
persistent disk.

None of those constrain an arcade site with a login form. The migration path
is kept cheap by confining all SQL to `src/models/` — swapping in Postgres
means rewriting that directory, not hunting queries through controllers.

`better-sqlite3` over `node:sqlite` or `sqlite3` because its API is
synchronous. SQLite reads are a memcpy from the OS page cache, so wrapping
them in promises buys no concurrency and costs a callback at every call site.

### Session cookies, not JWTs

The one people ask about. A session cookie is a random id that means nothing
on its own; the server looks it up. A JWT is a signed blob that *contains* the
claims and needs no lookup.

That statelessness is the JWT's selling point and the source of its problems:

- **Revocation.** A signed token is valid until it expires, full stop. "Log
  out everywhere", "ban this account", "I changed my password" all require a
  server-side denylist of revoked tokens — at which point you have session
  storage again, with worse ergonomics and two sources of truth. Here, logout
  is `DELETE FROM sessions WHERE sid = ?`, and it is instant and total.
- **Client storage.** A JWT has to live somewhere. `localStorage` is readable
  by any script on the page, so one XSS exfiltrates a credential valid for its
  full lifetime. The session cookie here is `httpOnly` — page JavaScript
  cannot read it, which the test suite verifies.
- **Staleness.** Claims baked into a token are a snapshot from login time.
  Sessions re-read the user row per request.

What you give up is shared storage across app instances — the problem JWTs
exist to solve, and one this single-process app does not have.

A bonus specific to this project: socket.io's handshake carries cookies
automatically, so the game server identifies players from the same session
with no second token scheme. A logged-in player's displayed name comes from
their account, not from what the client claims — which is why you can't sit
down in a room wearing someone else's name.

### bcrypt, not argon2

argon2id is the better algorithm on paper and what I'd choose if this stored
anything valuable. It's *memory*-hard, not just CPU-hard, so a GPU attacker
is bottlenecked on RAM per guess.

bcrypt was chosen for project reasons rather than cryptographic ones: it's
been deployed and attacked continuously since 1999, it has one tuning knob
(cost, set to 12 here) instead of argon2's three — and a badly-tuned argon2,
usually with memory set too low, is weaker than bcrypt while looking more
modern.

Both are correct answers. MD5 or SHA-256 would be the wrong answer: they're
built to be *fast*, and speed is the attacker's asset. bcrypt is deliberately
slow, salts each password automatically (the salt is stored inside the hash
string), and its cost is tunable upward as hardware improves — old hashes get
re-hashed transparently on next login.

### zxcvbn instead of a character-class regex

`P@ssw0rd123` satisfies every "uppercase, lowercase, digit, symbol" rule ever
written and falls in the first few thousand guesses of a real cracking run.
zxcvbn estimates *guessability* instead of composition, so it catches that,
plus keyboard walks, dates, names and l33tspeak.

The same library runs in the browser (live meter) and on the server (enforced
minimum), so the rule the user sees and the rule that's enforced are the same
rule — rather than a pretty meter next to a server that only counts
characters. The username is passed as context, which is what makes
`chanshi2024` correctly score weak for the user `chanshi`.

### Google OAuth stops at "who are you"

Google verifies the identity; it doesn't finish the signup. A new Google user
is parked in the session and sent to `/choose-username.html` to pick a
display name, because an email local-part is not a leaderboard name.

Accounts are keyed on Google's stable subject id, not the email — emails get
changed and reassigned, and keying on one is how you hand an account to
whoever inherits a recycled address. Email is used only to *link* to an
existing account, and only when Google reports it as verified.

The user's Google password never touches this server. The flow returns an
authorization code, which is exchanged for tokens over a back-channel request
authenticated with the client secret — so the secret never reaches the
browser, and an intercepted code is useless without it.

Passport is used for OAuth and nothing else. Local login is twenty lines in a
controller and doesn't need a framework; `serializeUser`/`deserializeUser` are
never used. There is exactly one thing that means "logged in" in this
codebase: `req.session.userId`.

---

## Security notes

| Concern | Handling |
|---|---|
| Password storage | bcrypt cost 12, per-password salt, auto-rehash on cost bump |
| Brute force (one IP) | `express-rate-limit`, 10 failed logins / 15 min; successes don't count |
| Brute force (one account) | `login_attempts` table, 8 failures / 15 min, across all IPs |
| Password spraying | The two limiters above cover different axes; neither alone is enough |
| SQL injection | Prepared statements with bound parameters, confined to `src/models/` |
| XSS | Usernames rendered with `textContent`, never `innerHTML`; charset restricted to `[A-Za-z0-9_-]` |
| Session theft | `httpOnly` (JS can't read it), `Secure` in production, `SameSite=Lax` |
| Session fixation | Session id regenerated on every login and signup |
| CSRF | `SameSite=Lax` + an explicit `Origin` check on all mutating requests |
| User enumeration | Identical message *and* identical timing for "no such user" and "wrong password" |
| Open redirect | `?next=` accepts same-site paths only; `//evil.example` is rejected |
| Unicode impersonation | Username charset is ASCII-only, so `chаnshi` with a Cyrillic а can't be registered |
| Case impersonation | Uniqueness enforced on a lowercased canonical column |
| Secret exposure | `.env` gitignored; static root is `public/`, so `/​.env` and `/server.js` 404 |
| Supply chain | zxcvbn self-hosted from `node_modules`, not a CDN — no third-party script on the password field |

Verified by `npm run test:auth`, which drives a real server over HTTP.

### Known limitation

The Content-Security-Policy allows `'unsafe-inline'` for scripts, because the
games are self-contained HTML files with inline `<script>` blocks. That means
CSP is not currently providing XSS protection, only restricting where scripts
may be loaded from. Extracting those blocks into separate `.js` files is the
single highest-value hardening left, and it's a mechanical change.

---

## Extending it

`src/routes/scoreRoutes.js` is the worked example. A protected endpoint is:

```js
router.post("/", requireAuth, (req, res) => {
  // req.user is the database row; the session was already verified
});
```

Scores submitted by the browser are treated as claims and bounds-checked.
Tic-tac-toe results are recorded by the *server* from its own game state
(`src/realtime/ticTacToe.js`), which is the only kind of score worth ranking.
