/**
 * The socket registry: who is online, and how to reach them.
 *
 * This is the piece that lets an ordinary HTTP controller cause a realtime
 * push. When A posts a friend request over REST, B should see it appear
 * without refreshing — so the controller calls `emitToUser(B, ...)` and this
 * module finds B's live sockets.
 *
 * Kept dependency-free on purpose: controllers require the hub, and the hub
 * requires nothing but the friend model. Wiring it the other way (the socket
 * layer reaching into controllers) is what produces circular requires.
 *
 * One user maps to a SET of sockets, not one socket. People have the site
 * open in three tabs, plus a phone. Treating the newest connection as "the"
 * connection means messages land in whichever tab happened to connect last.
 */

const friendModel = require("../models/friendModel");

/** @type {Map<number, Set<string>>} userId -> socket ids */
const userSockets = new Map();

/** @type {import("socket.io").Server | null} */
let io = null;

function attach(server) {
  io = server;
}

/**
 * Associates a live socket with an authenticated user.
 * @returns {boolean} true if this was the user's FIRST socket (they just
 *   came online, as opposed to opening another tab).
 */
function bind(userId, socketId) {
  let sockets = userSockets.get(userId);
  const wasOffline = !sockets || sockets.size === 0;

  if (!sockets) {
    sockets = new Set();
    userSockets.set(userId, sockets);
  }
  sockets.add(socketId);

  return wasOffline;
}

/**
 * @returns {boolean} true if that was the user's LAST socket (they are now
 *   genuinely offline, not just down one tab).
 */
function unbind(userId, socketId) {
  const sockets = userSockets.get(userId);
  if (!sockets) return false;

  sockets.delete(socketId);
  if (sockets.size === 0) {
    userSockets.delete(userId);
    return true;
  }
  return false;
}

function isOnline(userId) {
  const sockets = userSockets.get(userId);
  return Boolean(sockets && sockets.size > 0);
}

/** Fan-out to every tab a user has open. Silently no-ops if they're offline. */
function emitToUser(userId, event, payload) {
  if (!io) return false;
  const sockets = userSockets.get(userId);
  if (!sockets || sockets.size === 0) return false;

  for (const socketId of sockets) {
    io.to(socketId).emit(event, payload);
  }
  return true;
}

/** Tells a user's friends that something about them changed. */
function emitToFriendsOf(userId, event, payload) {
  for (const friend of friendModel.listFriends(userId)) {
    emitToUser(friend.id, event, payload);
  }
}

/** The subset of a user's friends who are currently connected. */
function onlineFriendIds(userId) {
  return friendModel
    .listFriends(userId)
    .filter((friend) => isOnline(friend.id))
    .map((friend) => friend.id);
}

module.exports = {
  attach,
  bind,
  unbind,
  isOnline,
  emitToUser,
  emitToFriendsOf,
  onlineFriendIds,
};
