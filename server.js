/**
 * Minimal server-authoritative multiplayer game server.
 *
 * The one rule that matters: clients send INTENTS ("I want to mark cell 4"),
 * never RESULTS ("I won" / "the board now looks like this"). This server
 * is the only thing that ever mutates game state. Everything the client
 * sees is a copy the server chose to send it.
 *
 * No database, no auth, no Redis. Rooms live in a plain JS Map and vanish
 * when the process restarts. That's fine for learning — add persistence
 * later, once you feel the actual need for it.
 */

const { Server } = require("socket.io");

const io = new Server(3001, {
  cors: { origin: "*" }, // wide open for local dev only — lock this down for anything real
});

// ---- In-memory "database" of rooms ----------------------------------
// roomId -> Room
const rooms = new Map();

function makeEmptyBoard() {
  return Array(9).fill(null); // 3x3 tic-tac-toe board, null = empty cell
}

function createRoom(roomId) {
  const room = {
    id: roomId,
    players: [], // [{ id: socketId, symbol: 'X' | 'O', name }]
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
  const player = room.players.find((p) => p.id === playerId);
  if (!player) return "You're not in this room";
  if (player.symbol !== room.turn) return "Not your turn";
  if (cellIndex < 0 || cellIndex > 8) return "Invalid cell";
  if (room.board[cellIndex] !== null) return "Cell already taken";
  return null; // null = valid
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
    players: room.players.map((p) => ({ symbol: p.symbol, name: p.name })),
  };
}

function broadcastRoomState(room) {
  for (const player of room.players) {
    io.to(player.id).emit("room:state", getPlayerView(room, player.id));
  }
}

// ---- Socket wiring ----------------------------------------------------
io.on("connection", (socket) => {
  console.log(`connected: ${socket.id}`);

  socket.on("room:join", ({ roomId, name }) => {
    let room = rooms.get(roomId);
    if (!room) room = createRoom(roomId);

    if (room.players.length >= 2) {
      socket.emit("error", { message: "Room is full" });
      return;
    }

    const symbol = room.players.length === 0 ? "X" : "O";
    room.players.push({ id: socket.id, symbol, name: name || symbol });
    socket.join(roomId);
    socket.data.roomId = roomId; // remember which room this socket is in

    if (room.players.length === 2) {
      room.status = "IN_PROGRESS";
    }

    // Tell this socket, and only this socket, which symbol it owns.
    // Never make the client guess its own identity from shared state.
    socket.emit("room:joined", { symbol });

    broadcastRoomState(room);
  });

  socket.on("game:action", ({ cellIndex }) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) {
      socket.emit("error", { message: "You're not in a room" });
      return;
    }

    // This is the whole point of the architecture in one line:
    // validate on the server, ignore anything the client merely asserts.
    const validationError = validateMove(room, socket.id, cellIndex);
    if (validationError) {
      socket.emit("error", { message: validationError });
      return;
    }

    const player = room.players.find((p) => p.id === socket.id);
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
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || room.status !== "FINISHED") return;

    room.board = makeEmptyBoard();
    room.turn = "X";
    room.status = room.players.length === 2 ? "IN_PROGRESS" : "LOBBY";
    room.winner = null;
    broadcastRoomState(room);
  });

  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    room.players = room.players.filter((p) => p.id !== socket.id);
    if (room.players.length === 0) {
      rooms.delete(roomId);
    } else {
      room.status = "LOBBY";
      broadcastRoomState(room);
    }
  });

});

console.log("Game server listening on ws://localhost:3001");
