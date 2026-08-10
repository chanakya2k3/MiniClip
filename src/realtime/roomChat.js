/**
 * In-game chat, scoped to a game room.
 *
 * Deliberately NOT persisted, which is the main design decision here.
 * Match chat is disposable: it's banter attached to a room that stops
 * existing when the players leave. Writing it to SQLite would mean a table
 * that grows forever, holds the least valuable text on the site, and turns
 * every "delete my account" into a cascade problem. Direct messages between
 * friends are the opposite — those are a conversation people expect to
 * still be there tomorrow — so those go in the database and these don't.
 *
 * A short in-memory backlog per room is kept so someone who reloads mid-match
 * doesn't stare at an empty panel.
 *
 * Written against a generic `roomId` rather than tic-tac-toe specifically, so
 * Flappy Duel gets chat by calling the same events.
 */

const userModel = require("../models/userModel");
const { userIdOf } = require("./social");

const MAX_MESSAGE_LENGTH = 300;
const BACKLOG_PER_ROOM = 50;

// Flood control, per socket. The HTTP endpoints use express-rate-limit, but
// socket events never touch Express, so they need their own budget — a
// socket that can emit in a loop will happily push thousands of messages a
// second at everyone else in the room.
const BURST_LIMIT = 5;          // messages...
const BURST_WINDOW_MS = 4000;   // ...per this window

/** roomId -> array of recent messages */
const backlogs = new Map();

/** socketId -> number[] of recent send timestamps */
const sendTimes = new Map();

function withinRateLimit(socketId) {
  const now = Date.now();
  const times = (sendTimes.get(socketId) || []).filter((t) => now - t < BURST_WINDOW_MS);

  if (times.length >= BURST_LIMIT) {
    sendTimes.set(socketId, times);
    return false;
  }

  times.push(now);
  sendTimes.set(socketId, times);
  return true;
}

function pushBacklog(roomId, message) {
  let log = backlogs.get(roomId);
  if (!log) {
    log = [];
    backlogs.set(roomId, log);
  }
  log.push(message);
  if (log.length > BACKLOG_PER_ROOM) log.shift();
}

/**
 * Resolves the name a message is sent under.
 *
 * Identical reasoning to the game's player names: a logged-in user's name
 * comes from their account row, so it can't be spoofed. A guest may pick a
 * name, but the message carries `registered: false` and the client badges it
 * — otherwise a guest could type your username into the name field and say
 * whatever they liked as you.
 */
function senderIdentity(socket, fallbackName) {
  const userId = userIdOf(socket);

  if (userId !== null) {
    const user = userModel.findById(userId);
    if (user) return { userId: user.id, username: user.username, registered: true };
  }

  const guestName = String(fallbackName || "").trim().slice(0, 20) || "Guest";
  return { userId: null, username: guestName, registered: false };
}

function chatRoom(roomId) {
  return `chat:${roomId}`;
}

function registerRoomChat(io) {
  io.on("connection", (socket) => {
    socket.on("chat:join", ({ roomId } = {}) => {
      const room = String(roomId || "").slice(0, 64);
      if (!room) return;

      socket.join(chatRoom(room));
      socket.data.chatRoom = room;

      // Replay what was said before they arrived.
      socket.emit("chat:backlog", { roomId: room, messages: backlogs.get(room) || [] });
    });

    socket.on("chat:message", ({ roomId, body, name } = {}) => {
      const room = String(roomId || socket.data.chatRoom || "").slice(0, 64);
      if (!room) return;

      // Must actually be in the room they're addressing. Without this, a
      // client can broadcast into any room id it can guess.
      if (!socket.rooms.has(chatRoom(room))) {
        socket.emit("chat:error", { message: "Join the room first." });
        return;
      }

      const text = String(body || "").trim().slice(0, MAX_MESSAGE_LENGTH);
      if (!text) return;

      if (!withinRateLimit(socket.id)) {
        socket.emit("chat:error", { message: "Slow down." });
        return;
      }

      const identity = senderIdentity(socket, name);

      const message = {
        id: `${Date.now()}-${socket.id.slice(0, 6)}`,
        roomId: room,
        username: identity.username,
        registered: identity.registered,
        body: text,
        at: Date.now(),
      };

      pushBacklog(room, message);
      io.to(chatRoom(room)).emit("chat:message", message);
    });

    socket.on("disconnect", () => {
      sendTimes.delete(socket.id);
    });
  });
}

/** Drops a room's backlog once nobody is playing there. Called by the game. */
function clearRoom(roomId) {
  backlogs.delete(roomId);
}

module.exports = { registerRoomChat, clearRoom, MAX_MESSAGE_LENGTH };
