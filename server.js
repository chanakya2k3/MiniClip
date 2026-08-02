/**
 * Minimal server-authoritative multiplayer game server.
 *
 * The one rule that matters: clients send INTENTS ("I want to mark cell 4"),
 * never RESULTS ("I won" / "the board now looks like this"). This server
 * is the only thing that ever mutates game state. Everything the client
 * sees is a copy the server chose to send it.
 *
 * Identity note: a player is identified by a persistent `playerId` the
 * client generates and stores, NOT by socket.id. Sockets die every time
 * the page reloads; the player doesn't. Keying seats by socket.id is what
 * makes a refresh look like "someone left and a stranger arrived".
 *
 * No database, no auth, no Redis. Rooms live in a plain JS Map and vanish
 * when the process restarts. That's fine for learning — add persistence
 * later, once you feel the actual need for it.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { Server } = require("socket.io");

const PORT = 3001;
const DEV = process.env.NODE_ENV !== "production";

// How long a seat is held open after a socket drops. Long enough to cover
// a page reload or a phone flipping networks, short enough that a room
// isn't wedged forever by someone who closed the tab.
const RECONNECT_GRACE_MS = 30_000;

// ---- Static file server ---------------------------------------------
// Serving the page from the same origin as the socket means the client
// can just call io() with no hardcoded URL, and live-reload has something
// to reload. Open http://localhost:3001 to play.

const STATIC_ROOT = __dirname;
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

const httpServer = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const filePath = path.join(STATIC_ROOT, rel);

  // Don't let a crafted path escape the project directory.
  if (!filePath.startsWith(STATIC_ROOT)) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404).end("Not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store", // dev only: always get the file you just edited
    });
    res.end(data);
  });
});

const io = new Server(httpServer, {
  cors: { origin: "*" }, // wide open for local dev only — lock this down for anything real
});

// ---- In-memory "database" of rooms ----------------------------------
// roomId -> Room
const rooms = new Map();

// socketId -> { roomId, playerId }, so a disconnect knows who just left.
const socketIndex = new Map();

function makeEmptyBoard() {
  return Array(9).fill(null); // 3x3 tic-tac-toe board, null = empty cell
}

function createRoom(roomId) {
  const room = {
    id: roomId,
    // [{ playerId, socketId, symbol, name, connected, graceTimer }]
    players: [],
    board: makeEmptyBoard(),
    turn: "X", // whose symbol moves next
    status: "LOBBY", // LOBBY -> IN_PROGRESS -> FINISHED
    winner: null, // 'X' | 'O' | 'DRAW' | null
  };
  rooms.set(roomId, room);
  return room;
}

// ---- Game rules (kept separate from socket plumbing on purpose) -----
// If you add a second game later, this is the part you'd swap out
// behind a shared interface. For now, keep it simple and concrete.

const WIN_LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8], // rows
  [0, 3, 6], [1, 4, 7], [2, 5, 8], // cols
  [0, 4, 8], [2, 4, 6],           // diagonals
];

function checkWinner(board) {
  for (const [a, b, c] of WIN_LINES) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return board[a]; // 'X' or 'O'
    }
  }
  if (board.every((cell) => cell !== null)) return "DRAW";
  return null; // game continues
}

// Validates a move BEFORE applying it. This is the anti-cheat boundary:
// even if a malicious client sends a bogus cell index or moves out of
// turn, the server just rejects it. The client's local UI state never
// gets to dictate what "actually happened".
function validateMove(room, playerId, cellIndex) {
  if (room.status !== "IN_PROGRESS") return "Game is not in progress";
  const player = room.players.find((p) => p.playerId === playerId);
  if (!player) return "You're not in this room";
  if (player.symbol !== room.turn) return "Not your turn";
  if (!Number.isInteger(cellIndex) || cellIndex < 0 || cellIndex > 8) return "Invalid cell";
  if (room.board[cellIndex] !== null) return "Cell already taken";
  return null; // null = valid
}

// A game with a temporarily-absent player is still IN_PROGRESS. The board,
// the turn and the winner are never touched by connection churn — the only
// thing that changes is the `connected` flag the UI reads to say
// "opponent reconnecting...".
function recomputeStatus(room) {
  if (room.status === "FINISHED") return;
  room.status = room.players.length === 2 ? "IN_PROGRESS" : "LOBBY";
}

// Strips anything a specific player shouldn't see before sending state
// out. Tic-tac-toe has no hidden information, so this is a no-op here —
// but it's the same slot where Minesweeper would hide mine positions,
// or a card game would hide opponents' hands. Keep the shape even when
// the game doesn't need it yet, so adding game #2 doesn't require
// re-plumbing the whole server.
function getPlayerView(room, _playerId) {
  return {
    id: room.id,
    board: room.board,
    turn: room.turn,
    status: room.status,
    winner: room.winner,
    players: room.players.map((p) => ({
      symbol: p.symbol,
      name: p.name,
      connected: p.connected,
    })),
  };
}

function broadcastRoomState(room) {
  for (const player of room.players) {
    if (!player.socketId) continue; // nothing to send to a dropped socket
    io.to(player.socketId).emit("room:state", getPlayerView(room, player.playerId));
  }
}

// ---- Socket wiring ----------------------------------------------------
io.on("connection", (socket) => {
  console.log(`connected: ${socket.id}`);

  socket.on("room:join", ({ roomId, name, playerId }) => {
    if (!roomId || !playerId) {
      socket.emit("error", { message: "Missing room or player id" });
      return;
    }

    let room = rooms.get(roomId);
    if (!room) room = createRoom(roomId);

    // Is this a returning player? If so they get their seat, symbol and
    // the in-flight board back — a reload is not a new player.
    let player = room.players.find((p) => p.playerId === playerId);
    const resumed = Boolean(player);

    if (player) {
      if (player.graceTimer) {
        clearTimeout(player.graceTimer);
        player.graceTimer = null;
      }
      // If an older socket for this player is still around, forget it so
      // its eventual disconnect can't evict the seat we just restored.
      if (player.socketId && player.socketId !== socket.id) {
        socketIndex.delete(player.socketId);
      }
      player.socketId = socket.id;
      player.connected = true;
      if (name) player.name = name;
    } else {
      if (room.players.length >= 2) {
        socket.emit("error", { message: "Room is full" });
        return;
      }
      const taken = new Set(room.players.map((p) => p.symbol));
      const symbol = taken.has("X") ? "O" : "X";
      player = {
        playerId,
        socketId: socket.id,
        symbol,
        name: name || symbol,
        connected: true,
        graceTimer: null,
      };
      room.players.push(player);
    }

    socket.join(roomId);
    socketIndex.set(socket.id, { roomId, playerId });

    recomputeStatus(room);

    // Tell this socket, and only this socket, which symbol it owns.
    // Never make the client guess its own identity from shared state.
    socket.emit("room:joined", { symbol: player.symbol, playerId, roomId, resumed });

    broadcastRoomState(room);
  });

  socket.on("game:action", ({ cellIndex }) => {
    const ref = socketIndex.get(socket.id);
    const room = ref && rooms.get(ref.roomId);
    if (!room) {
      socket.emit("error", { message: "You're not in a room" });
      return;
    }

    // This is the whole point of the architecture in one line:
    // validate on the server, ignore anything the client merely asserts.
    const validationError = validateMove(room, ref.playerId, cellIndex);
    if (validationError) {
      socket.emit("error", { message: validationError });
      return;
    }

    const player = room.players.find((p) => p.playerId === ref.playerId);
    room.board[cellIndex] = player.symbol;

    const result = checkWinner(room.board);
    if (result) {
      room.status = "FINISHED";
      room.winner = result; // 'X' | 'O' | 'DRAW'
      // This is also where you'd write match history to a DB, if you had one.
    } else {
      room.turn = room.turn === "X" ? "O" : "X";
    }

    broadcastRoomState(room);
  });

  socket.on("room:rematch", () => {
    const ref = socketIndex.get(socket.id);
    const room = ref && rooms.get(ref.roomId);
    if (!room || room.status !== "FINISHED") return;

    room.board = makeEmptyBoard();
    room.turn = "X";
    room.winner = null;
    room.status = "LOBBY";
    recomputeStatus(room);
    broadcastRoomState(room);
  });

  socket.on("disconnect", () => {
    const ref = socketIndex.get(socket.id);
    socketIndex.delete(socket.id);
    if (!ref) return;

    const room = rooms.get(ref.roomId);
    if (!room) return;

    const player = room.players.find((p) => p.playerId === ref.playerId);
    // A newer socket already claimed this seat (fast reload) — the old
    // socket's death is stale news, ignore it.
    if (!player || player.socketId !== socket.id) return;

    player.connected = false;
    player.socketId = null;

    // The seat is held, not freed. Board and turn are untouched, so a
    // reload lands the player back exactly where they were.
    player.graceTimer = setTimeout(() => {
      const stillThere = rooms.get(ref.roomId);
      if (!stillThere) return;
      const p = stillThere.players.find((x) => x.playerId === ref.playerId);
      if (!p || p.connected) return; // came back in time

      stillThere.players = stillThere.players.filter((x) => x.playerId !== ref.playerId);
      if (stillThere.players.length === 0) {
        rooms.delete(ref.roomId);
        return;
      }
      recomputeStatus(stillThere);
      broadcastRoomState(stillThere);
    }, RECONNECT_GRACE_MS);

    broadcastRoomState(room);
  });
});

// ---- Dev live-reload --------------------------------------------------
// Watches the files you actually edit and pushes a hint to every client.
// style.css is swapped in place (no reload, so nothing in the running game
// is disturbed). index.html can't be hot-swapped, so the client reloads —
// and because identity lives in playerId, the reload resumes the same seat
// with the same board.

if (DEV) {
  const WATCHED = ["style.css", "index.html"];
  let lastFired = 0;

  for (const file of WATCHED) {
    const full = path.join(STATIC_ROOT, file);
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

httpServer.listen(PORT, () => {
  console.log(`MiniClip running at http://localhost:${PORT}`);
  if (DEV) console.log("live-reload on: css hot-swaps, html reloads (game state survives)");
});
