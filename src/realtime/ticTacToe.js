/**
 * Server-authoritative multiplayer tic-tac-toe.
 *
 * Moved out of server.js unchanged in behaviour — server.js is now an entry
 * point, and this is the game. The one addition is authentication awareness
 * at the bottom of the join handler: a logged-in player's name comes from
 * their account, not from whatever the client sent.
 *
 * The one rule that matters: clients send INTENTS ("I want to mark cell 4"),
 * never RESULTS ("I won" / "the board now looks like this"). This module
 * is the only thing that ever mutates game state. Everything the client
 * sees is a copy the server chose to send it.
 *
 * Identity note: a player is identified by a persistent `playerId` the
 * client generates and stores, NOT by socket.id. Sockets die every time
 * the page reloads; the player doesn't. Keying seats by socket.id is what
 * makes a refresh look like "someone left and a stranger arrived".
 */

const userModel = require("../models/userModel");

// How long a seat is held open after a socket drops. Long enough to cover
// a page reload or a phone flipping networks, short enough that a room
// isn't wedged forever by someone who closed the tab.
const RECONNECT_GRACE_MS = 30_000;

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
    winningLine: null, // [i, i, i] once someone wins
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

// Returns { winner, line } — the line comes back so the client can light
// up the winning three cells without re-implementing the rules locally.
// The client should never be the one deciding what "winning" looks like.
function checkWinner(board) {
  for (const line of WIN_LINES) {
    const [a, b, c] = line;
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return { winner: board[a], line }; // 'X' or 'O'
    }
  }
  if (board.every((cell) => cell !== null)) return { winner: "DRAW", line: null };
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
    winningLine: room.winningLine,
    players: room.players.map((p) => ({
      symbol: p.symbol,
      name: p.name,
      connected: p.connected,
      // Whether this seat is a real account or a drop-in guest. The client
      // can badge it; the server is the one that decides which it is.
      registered: Boolean(p.userId),
    })),
  };
}

/**
 * Resolves the name a player is allowed to appear under.
 *
 * A logged-in player is shown their account username, taken from the
 * database via the session — not from the `name` field in the join payload.
 * The client asking to be called something is a request, and requests from
 * clients get validated. Otherwise anyone could sit down in a room wearing
 * someone else's name.
 *
 * Guests keep the old behaviour so the game stays playable without an
 * account, but their chosen name is length-capped and marked unregistered.
 */
function resolveIdentity(socket, requestedName) {
  const userId = socket.request?.session?.userId;

  if (userId) {
    const user = userModel.findById(userId);
    if (user) return { userId: user.id, name: user.username };
  }

  const fallback = typeof requestedName === "string" ? requestedName.trim().slice(0, 20) : "";
  return { userId: null, name: fallback };
}

/**
 * Wires the game onto an existing socket.io server.
 * @param {import("socket.io").Server} io
 */
function registerTicTacToe(io) {
  io.on("connection", (socket) => {
    console.log(`connected: ${socket.id}`);

    socket.on("room:join", ({ roomId, name, playerId }) => {
      if (!roomId || !playerId) {
        socket.emit("error", { message: "Missing room or player id" });
        return;
      }

      let room = rooms.get(roomId);
      if (!room) room = createRoom(roomId);

      const identity = resolveIdentity(socket, name);

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
        if (identity.name) player.name = identity.name;
        player.userId = identity.userId;
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
          name: identity.name || symbol,
          userId: identity.userId,
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
      socket.emit("room:joined", {
        symbol: player.symbol,
        playerId,
        roomId,
        resumed,
        username: identity.userId ? identity.name : null,
      });

      broadcastRoomState(io, room);
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
        room.winner = result.winner; // 'X' | 'O' | 'DRAW'
        room.winningLine = result.line; // [i, i, i] | null on a draw
        recordResult(room, result.winner);
      } else {
        room.turn = room.turn === "X" ? "O" : "X";
      }

      broadcastRoomState(io, room);
    });

    socket.on("room:rematch", () => {
      const ref = socketIndex.get(socket.id);
      const room = ref && rooms.get(ref.roomId);
      if (!room || room.status !== "FINISHED") return;

      room.board = makeEmptyBoard();
      room.turn = "X";
      room.winner = null;
      room.winningLine = null;
      room.status = "LOBBY";
      recomputeStatus(room);
      broadcastRoomState(io, room);
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
        broadcastRoomState(io, stillThere);
      }, RECONNECT_GRACE_MS);

      broadcastRoomState(io, room);
    });
  });
}

function broadcastRoomState(io, room) {
  for (const player of room.players) {
    if (!player.socketId) continue; // nothing to send to a dropped socket
    io.to(player.socketId).emit("room:state", getPlayerView(room, player.playerId));
  }
}

/**
 * Persists a finished game for players who have accounts.
 *
 * This is the slot the original code marked with "this is also where you'd
 * write match history to a DB, if you had one" — now there is one. Guests
 * are skipped rather than blocked: you don't need an account to play, only
 * to be on the leaderboard.
 *
 * Note that the score comes from the server's own game state, not from a
 * client claim, which is what makes it trustworthy enough to rank.
 */
function recordResult(room, winner) {
  // Required lazily: the scores model opens the database, and this module is
  // otherwise usable in tests without one.
  const scoreModel = require("../models/scoreModel");

  for (const player of room.players) {
    if (!player.userId) continue;
    const points = winner === "DRAW" ? 1 : player.symbol === winner ? 3 : 0;
    try {
      scoreModel.recordScore(player.userId, "tic-tac-toe", points);
    } catch (err) {
      // A leaderboard write must never take down a game in progress.
      console.error("[scores] failed to record result:", err.message);
    }
  }
}

module.exports = { registerTicTacToe, RECONNECT_GRACE_MS };
