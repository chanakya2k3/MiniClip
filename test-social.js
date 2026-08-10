/**
 * End-to-end tests for friends, direct messages, presence and voice
 * signalling.
 *
 * Same harness as test-auth.js: a real server on a throwaway database,
 * driven over HTTP and over real socket.io connections. The socket tests
 * matter most — the authorisation on those events is hand-written, and it's
 * the part a reviewer should be most suspicious of.
 *
 *   npm run test:social
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { io: ioClient } = require("socket.io-client");

const PORT = 3198;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_FILE = path.join(os.tmpdir(), `miniclip-social-${Date.now()}.db`);

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

/** A logged-in browser: cookie jar + helpers + an optional socket. */
function makeClient(label) {
  const cookies = new Map();

  const client = {
    label,
    user: null,
    socket: null,

    async call(method, urlPath, body, extraHeaders = {}) {
      const headers = { Origin: BASE, ...extraHeaders };
      if (body) headers["Content-Type"] = "application/json";
      const cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
      if (cookie) headers.Cookie = cookie;

      const response = await fetch(BASE + urlPath, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        redirect: "manual",
      });

      for (const raw of response.headers.getSetCookie?.() ?? []) {
        const [pair] = raw.split(";");
        const index = pair.indexOf("=");
        cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
      }

      let data = null;
      try { data = await response.json(); } catch { /* not JSON */ }
      return { status: response.status, data: data || {} };
    },

    async signup(username, password) {
      const result = await client.call("POST", "/api/auth/signup", { username, password });
      client.user = result.data.user;
      return result;
    },

    /** Opens a socket carrying this client's session cookie. */
    connect() {
      return new Promise((resolve, reject) => {
        const cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
        const socket = ioClient(BASE, {
          extraHeaders: { Cookie: cookie },
          transports: ["websocket", "polling"],
        });
        client.socket = socket;

        // The server sends presence:snapshot from inside its connection
        // handler, so it can be in flight before this promise resolves.
        // Attaching the listener here — synchronously, at socket creation —
        // is what a browser page does too, and is the only way not to race
        // it. Storing rather than awaiting lets the assertion run later.
        client.snapshot = null;
        socket.on("presence:snapshot", (payload) => { client.snapshot = payload; });

        const timer = setTimeout(() => reject(new Error(`${label}: socket timeout`)), 8000);
        socket.on("connect", () => { clearTimeout(timer); resolve(socket); });
        socket.on("connect_error", (err) => { clearTimeout(timer); reject(err); });
      });
    },

    /** Waits for the snapshot captured at connect time. */
    async waitForSnapshot(ms = 2500) {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (client.snapshot) return client.snapshot;
        await new Promise((r) => setTimeout(r, 50));
      }
      return null;
    },

    /** Resolves with the first payload for `event`, or null after `ms`. */
    once(event, ms = 2500) {
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          client.socket.off(event, handler);
          resolve(null);
        }, ms);
        const handler = (payload) => {
          clearTimeout(timer);
          client.socket.off(event, handler);
          resolve(payload);
        };
        client.socket.on(event, handler);
      });
    },

    disconnect() {
      if (client.socket) client.socket.disconnect();
    },
  };

  return client;
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

const PASSWORD = "trombone-batter-glacier-71";

async function run() {
  const tag = Date.now().toString(36).slice(-5);
  const alice = makeClient("alice");
  const bob = makeClient("bob");
  const mallory = makeClient("mallory");

  const aliceName = `alice_${tag}`;
  const bobName = `bob_${tag}`;
  const malloryName = `mallory_${tag}`;

  console.log("\n\x1b[1mSocial end-to-end\x1b[0m\n");

  console.log("setup");
  {
    const a = await alice.signup(aliceName, PASSWORD);
    const b = await bob.signup(bobName, PASSWORD);
    const m = await mallory.signup(malloryName, PASSWORD);
    check("three accounts created",
      a.status === 201 && b.status === 201 && m.status === 201,
      `${a.status}/${b.status}/${m.status}`);
  }

  // ---- Authentication boundary -----------------------------------------
  console.log("\nauth boundary");
  {
    const anon = makeClient("anon");
    for (const [method, url] of [
      ["GET", "/api/friends"],
      ["GET", "/api/friends/requests"],
      ["GET", "/api/friends/search?q=al"],
      ["POST", "/api/friends/requests"],
      ["GET", "/api/messages"],
    ]) {
      const result = await anon.call(method, url, method === "POST" ? { username: "x" } : undefined);
      check(`${method} ${url} requires login`, result.status === 401, `got ${result.status}`);
    }
  }

  // ---- Search -----------------------------------------------------------
  console.log("\nuser search");
  {
    const short = await alice.call("GET", "/api/friends/search?q=a");
    check("ignores a single-character query", short.data.results.length === 0);

    const found = await alice.call("GET", `/api/friends/search?q=${bobName.slice(0, 6)}`);
    check("finds a user by prefix",
      found.data.results.some((u) => u.username === bobName));

    const self = await alice.call("GET", `/api/friends/search?q=${aliceName.slice(0, 6)}`);
    check("excludes the searcher from their own results",
      !self.data.results.some((u) => u.username === aliceName));

    // '%' is a LIKE wildcard. Unescaped it would match every username.
    const wildcard = await alice.call("GET", "/api/friends/search?q=%25%25");
    check("treats LIKE wildcards as literal characters",
      wildcard.data.results.length === 0,
      `'%%' returned ${wildcard.data.results.length} users`);
  }

  // ---- Friend requests ---------------------------------------------------
  console.log("\nfriend requests");
  let requestId = null;
  {
    const self = await alice.call("POST", "/api/friends/requests", { username: aliceName });
    check("refuses a self-request", self.status === 400, `got ${self.status}`);

    const ghost = await alice.call("POST", "/api/friends/requests", { username: "nobody_at_all_xyz" });
    check("404s an unknown username", ghost.status === 404, `got ${ghost.status}`);

    const sent = await alice.call("POST", "/api/friends/requests", { username: bobName });
    check("sends a request", sent.status === 201 && sent.data.status === "pending",
      `got ${sent.status} ${sent.data.status}`);

    const again = await alice.call("POST", "/api/friends/requests", { username: bobName });
    check("refuses a duplicate request", again.status === 409, `got ${again.status}`);

    const inbox = await bob.call("GET", "/api/friends/requests");
    check("appears in the recipient's inbox",
      inbox.data.incoming.some((r) => r.username === aliceName));
    requestId = inbox.data.incoming.find((r) => r.username === aliceName)?.friendshipId;

    const outbox = await alice.call("GET", "/api/friends/requests");
    check("appears in the sender's outbox",
      outbox.data.outgoing.some((r) => r.username === bobName));

    // The core authorisation test: a third party must not be able to accept
    // a request addressed to someone else by guessing its id.
    const hijack = await mallory.call("POST", `/api/friends/requests/${requestId}/accept`);
    check("a stranger cannot accept someone else's request",
      hijack.status === 404, `got ${hijack.status}`);

    const selfAccept = await alice.call("POST", `/api/friends/requests/${requestId}/accept`);
    check("the sender cannot accept their own request",
      selfAccept.status === 404, `got ${selfAccept.status}`);
  }

  // ---- Messaging is friends-only ----------------------------------------
  console.log("\nmessaging before friendship");
  {
    const read = await alice.call("GET", `/api/messages/${bob.user.id}`);
    check("cannot read a conversation with a non-friend",
      read.status === 403, `got ${read.status}`);

    const write = await alice.call("POST", `/api/messages/${bob.user.id}`, { body: "hello?" });
    check("cannot message a non-friend (pending is not friendship)",
      write.status === 403, `got ${write.status}`);
  }

  // ---- Accept -------------------------------------------------------------
  console.log("\naccepting");
  {
    const accepted = await bob.call("POST", `/api/friends/requests/${requestId}/accept`);
    check("the addressee can accept", accepted.status === 200, `got ${accepted.status}`);

    const aliceFriends = await alice.call("GET", "/api/friends");
    const bobFriends = await bob.call("GET", "/api/friends");
    check("both sides now list each other",
      aliceFriends.data.friends.some((f) => f.username === bobName) &&
      bobFriends.data.friends.some((f) => f.username === aliceName));

    const stale = await bob.call("POST", `/api/friends/requests/${requestId}/accept`);
    check("accepting twice is rejected", stale.status === 404, `got ${stale.status}`);
  }

  // ---- Mutual request auto-accepts ---------------------------------------
  console.log("\nmutual requests");
  {
    await mallory.call("POST", "/api/friends/requests", { username: bobName });
    const reciprocal = await bob.call("POST", "/api/friends/requests", { username: malloryName });

    check("requesting someone who already asked you auto-accepts",
      reciprocal.status === 200 && reciprocal.data.status === "accepted",
      `got ${reciprocal.status} ${reciprocal.data.status}`);

    const requests = await bob.call("GET", "/api/friends/requests");
    check("no orphaned pending request is left behind",
      !requests.data.incoming.some((r) => r.username === malloryName) &&
      !requests.data.outgoing.some((r) => r.username === malloryName));
  }

  // ---- Messaging between friends ------------------------------------------
  console.log("\nmessaging between friends");
  {
    const sent = await alice.call("POST", `/api/messages/${bob.user.id}`, { body: "gg wp" });
    check("a friend can send a message", sent.status === 201, `got ${sent.status}`);

    const empty = await alice.call("POST", `/api/messages/${bob.user.id}`, { body: "   " });
    check("rejects a whitespace-only message", empty.status === 400, `got ${empty.status}`);

    const huge = await alice.call("POST", `/api/messages/${bob.user.id}`, { body: "x".repeat(1001) });
    check("rejects an over-length message", huge.status === 400, `got ${huge.status}`);

    await bob.call("POST", `/api/messages/${alice.user.id}`, { body: "gg" });

    const history = await alice.call("GET", `/api/messages/${bob.user.id}`);
    check("history contains both sides in order",
      history.data.messages.length === 2 &&
      history.data.messages[0].body === "gg wp" &&
      history.data.messages[1].body === "gg",
      JSON.stringify(history.data.messages.map((m) => m.body)));

    // Mallory is friends with Bob but not Alice. She must not be able to
    // read the Alice<->Bob conversation from either direction.
    const snoop = await mallory.call("GET", `/api/messages/${alice.user.id}`);
    check("a non-friend cannot read the conversation", snoop.status === 403,
      `got ${snoop.status}`);

    const snoopBob = await mallory.call("GET", `/api/messages/${bob.user.id}`);
    check("being friends with one participant doesn't expose the other's thread",
      snoopBob.status === 200 && snoopBob.data.messages.length === 0,
      `${snoopBob.status}, ${snoopBob.data.messages?.length} messages`);
  }

  // ---- Unread counts --------------------------------------------------------
  console.log("\nunread counts");
  {
    await alice.call("POST", `/api/messages/${bob.user.id}`, { body: "you there?" });

    const summary = await bob.call("GET", "/api/messages");
    check("recipient has an unread count", summary.data.total >= 1, `total ${summary.data.total}`);

    await bob.call("GET", `/api/messages/${alice.user.id}`);   // opening marks read

    const after = await bob.call("GET", "/api/messages");
    check("opening the conversation clears it", after.data.total === 0, `total ${after.data.total}`);
  }

  // ---- Realtime -------------------------------------------------------------
  console.log("\nrealtime presence and delivery");
  {
    // Bob first, so that by the time Alice connects there is genuinely an
    // online friend for her snapshot to report. Connecting Alice first would
    // correctly show an empty list and the assertion below would be testing
    // the test's ordering rather than the server.
    await bob.connect();
    await alice.connect();

    const snapshot = await alice.waitForSnapshot();
    check("a connecting client gets a presence snapshot", snapshot !== null);
    check("the snapshot lists the online friend",
      snapshot?.onlineFriendIds?.includes(bob.user.id),
      JSON.stringify(snapshot));

    // Bob should be told when Alice sends him a message, without polling.
    const incoming = bob.once("dm:message");
    await alice.call("POST", `/api/messages/${bob.user.id}`, { body: "socket delivery" });
    const delivered = await incoming;
    check("a message is pushed over the socket",
      delivered?.body === "socket delivery", JSON.stringify(delivered));

    // Typing indicators must respect the friendship check.
    await mallory.connect();
    const shouldArrive = bob.once("dm:typing", 1200);
    mallory.socket.emit("dm:typing", { toUserId: bob.user.id });
    check("typing relays between friends", (await shouldArrive) !== null);

    const shouldNotArrive = alice.once("dm:typing", 1200);
    mallory.socket.emit("dm:typing", { toUserId: alice.user.id });
    check("typing does NOT relay to a non-friend", (await shouldNotArrive) === null);

    // Presence: Bob going away should notify Alice.
    const offline = alice.once("friend:offline", 3000);
    bob.disconnect();
    const wentOffline = await offline;
    check("a friend disconnecting fires friend:offline",
      wentOffline?.userId === bob.user.id, JSON.stringify(wentOffline));
  }

  // ---- Room chat ---------------------------------------------------------------
  console.log("\nin-game room chat");
  {
    const room = `testroom-${tag}`;

    alice.socket.emit("chat:join", { roomId: room });
    await alice.once("chat:backlog");

    // A socket that never joined must not be able to broadcast into the room.
    const leaked = alice.once("chat:message", 1200);
    mallory.socket.emit("chat:message", { roomId: room, body: "i was never here" });
    check("cannot broadcast into a room without joining", (await leaked) === null);

    // Now join properly and confirm delivery.
    mallory.socket.emit("chat:join", { roomId: room });
    await mallory.once("chat:backlog");

    const received = alice.once("chat:message");
    mallory.socket.emit("chat:message", { roomId: room, body: "hello room" });
    const message = await received;

    check("a joined socket can broadcast", message?.body === "hello room",
      JSON.stringify(message));
    check("the server stamps the sender's account name",
      message?.username === malloryName, `got ${message?.username}`);
    check("the message is marked as from a registered user",
      message?.registered === true);

    // The client asking to be called something else must be ignored.
    const spoofed = alice.once("chat:message");
    mallory.socket.emit("chat:message", { roomId: room, body: "trust me", name: aliceName });
    const spoofResult = await spoofed;
    check("a client-supplied name cannot override the account name",
      spoofResult?.username === malloryName, `got ${spoofResult?.username}`);
  }

  // ---- Voice signalling -----------------------------------------------------
  console.log("\nvoice signalling");
  {
    const room = `voice-${tag}`;

    mallory.socket.emit("voice:join", { roomId: room });
    const joined = await mallory.once("voice:joined");
    check("can join a voice channel", joined?.roomId === room, JSON.stringify(joined));
    check("first joiner sees no peers", joined?.peers?.length === 0);

    const peerSeen = mallory.once("voice:peer-joined");
    alice.socket.emit("voice:join", { roomId: room });
    const aliceJoined = await alice.once("voice:joined");

    check("second joiner is told about the incumbent",
      aliceJoined?.peers?.length === 1, JSON.stringify(aliceJoined?.peers));
    check("the incumbent is told someone arrived", (await peerSeen) !== null);

    // The relay must refuse to forward to a socket outside the voice room.
    const bystander = makeClient("bystander");
    await bystander.signup(`bystander_${tag}`, PASSWORD);
    await bystander.connect();

    const leaked = bystander.once("voice:signal", 1200);
    alice.socket.emit("voice:signal", {
      to: bystander.socket.id,
      data: { type: "offer", sdp: "malicious" },
    });
    check("will not relay signalling to a socket outside the room",
      (await leaked) === null);

    // A third participant must be turned away (1:1 only).
    bystander.socket.emit("voice:join", { roomId: room });
    const rejected = await bystander.once("voice:error");
    check("voice channel is capped at two people",
      rejected?.code === "full", JSON.stringify(rejected));

    bystander.disconnect();
  }

  // ---- Unfriending -------------------------------------------------------------
  console.log("\nunfriending");
  {
    const removed = await alice.call("DELETE", `/api/friends/${bob.user.id}`);
    check("either party can unfriend", removed.status === 200, `got ${removed.status}`);

    const blocked = await alice.call("POST", `/api/messages/${bob.user.id}`, { body: "still here?" });
    check("messaging stops immediately after unfriending",
      blocked.status === 403, `got ${blocked.status}`);

    const gone = await bob.call("GET", "/api/friends");
    check("the other side's list updates too",
      !gone.data.friends.some((f) => f.username === aliceName));

    // Re-friend and confirm the old conversation didn't come back.
    await alice.call("POST", "/api/friends/requests", { username: bobName });
    const inbox = await bob.call("GET", "/api/friends/requests");
    const newId = inbox.data.incoming.find((r) => r.username === aliceName)?.friendshipId;
    await bob.call("POST", `/api/friends/requests/${newId}/accept`);

    const history = await alice.call("GET", `/api/messages/${bob.user.id}`);
    check("old messages do not reappear after re-friending",
      history.data.messages.length === 0,
      `${history.data.messages.length} messages resurfaced`);
  }

  alice.disconnect();
  mallory.disconnect();

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
