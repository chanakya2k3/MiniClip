/**
 * Presence and live chat signalling over socket.io.
 *
 * The identity rule, which every handler in this file depends on:
 * a socket's user is read from `socket.request.session.userId`, populated by
 * the express-session middleware that server.js shares with socket.io. It is
 * never taken from the client's payload. A socket event carrying its own
 * "userId" field would let any connected browser impersonate anyone by
 * editing one number.
 *
 * Presence is derived, not stored. There is no `users.is_online` column,
 * because a column like that is wrong the instant a process crashes — it
 * records "was online when we last managed to write", and the recovery is a
 * sweep job that guesses. The set of live sockets in hub.js is the truth,
 * and it resets correctly on restart by construction.
 */

const friendModel = require("../models/friendModel");
const messageModel = require("../models/messageModel");
const userModel = require("../models/userModel");
const hub = require("./hub");

/** @returns {number|null} the authenticated user id for a socket, if any. */
function userIdOf(socket) {
  const id = socket.request?.session?.userId;
  return Number.isInteger(id) ? id : null;
}

function registerSocial(io) {
  hub.attach(io);

  io.on("connection", (socket) => {
    const userId = userIdOf(socket);

    // Guests get a socket for the games, but no social wiring at all. Every
    // handler below is registered only for authenticated sockets, so an
    // anonymous connection cannot even attempt them.
    if (userId === null) return;

    const user = userModel.findById(userId);
    if (!user) return; // session pointing at a deleted account

    const cameOnline = hub.bind(userId, socket.id);

    // A private room per user id. It isn't used for delivery (hub.emitToUser
    // addresses sockets directly) but it makes "is this user connected"
    // inspectable from the socket.io admin tooling.
    socket.join(`user:${userId}`);

    if (cameOnline) {
      // Only on the first socket. Firing this per tab would spam a friend's
      // UI with "came online" every time they opened a new window.
      hub.emitToFriendsOf(userId, "friend:online", { userId, username: user.username });
    }

    // Initial snapshot so a freshly-loaded page can paint presence dots
    // immediately instead of waiting for the first change event.
    socket.emit("presence:snapshot", {
      onlineFriendIds: hub.onlineFriendIds(userId),
      unread: messageModel.totalUnread(userId),
      pendingRequests: friendModel.pendingCount(userId),
    });

    /**
     * Typing indicator. Not persisted, not acknowledged, and dropped
     * entirely if the two aren't friends — the friendship check is repeated
     * here rather than trusted from whenever the conversation was opened.
     */
    socket.on("dm:typing", ({ toUserId } = {}) => {
      const target = Number(toUserId);
      if (!Number.isInteger(target)) return;
      if (!friendModel.areFriends(userId, target)) return;

      hub.emitToUser(target, "dm:typing", { fromUserId: userId });
    });

    socket.on("disconnect", () => {
      const wentOffline = hub.unbind(userId, socket.id);
      if (wentOffline) {
        hub.emitToFriendsOf(userId, "friend:offline", { userId });
      }
    });
  });
}

module.exports = { registerSocial, userIdOf };
