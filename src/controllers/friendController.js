/**
 * Friend requests, the friend list, and user search.
 *
 * Every handler here is behind requireAuth, so `req.user` is always a real
 * user. The identity of the *acting* user always comes from the session —
 * never from the request body. A body-supplied "fromUserId" would let anyone
 * send friend requests as anyone.
 */

const friendModel = require("../models/friendModel");
const messageModel = require("../models/messageModel");
const userModel = require("../models/userModel");
const hub = require("../realtime/hub");

/** Adds live presence to a friend row, so the UI can dot them green. */
function withPresence(friend) {
  return {
    id: friend.id,
    username: friend.username,
    avatarUrl: friend.avatar_url || null,
    friendsSince: friend.friends_since,
    online: hub.isOnline(friend.id),
  };
}

/** GET /api/friends */
function listFriends(req, res) {
  const friends = friendModel.listFriends(req.user.id).map(withPresence);
  const unread = messageModel.unreadCounts(req.user.id);

  res.json({
    friends: friends.map((friend) => ({ ...friend, unread: unread[friend.id] || 0 })),
    pendingRequests: friendModel.pendingCount(req.user.id),
  });
}

/** GET /api/friends/requests */
function listRequests(req, res) {
  const { incoming, outgoing } = friendModel.listRequests(req.user.id);

  const shape = (row) => ({
    friendshipId: row.id,
    userId: row.user_id,
    username: row.username,
    avatarUrl: row.avatar_url || null,
    createdAt: row.created_at,
    online: hub.isOnline(row.user_id),
  });

  res.json({ incoming: incoming.map(shape), outgoing: outgoing.map(shape) });
}

/** GET /api/friends/search?q=cha */
function searchUsers(req, res) {
  const query = typeof req.query.q === "string" ? req.query.q.trim() : "";

  // Two characters minimum. A one-character prefix search returns a large
  // slice of the user table, which turns the search box into a directory
  // scraper.
  if (query.length < 2) {
    return res.json({ results: [] });
  }

  const matches = friendModel.search(query, req.user.id, 10);
  const annotated = friendModel.annotateRelationships(matches, req.user.id);

  res.json({
    results: annotated.map((user) => ({
      id: user.id,
      username: user.username,
      avatarUrl: user.avatar_url || null,
      relationship: user.relationship,
      friendshipId: user.friendshipId,
      online: hub.isOnline(user.id),
    })),
  });
}

/**
 * POST /api/friends/requests  { username }
 *
 * Targeting by username rather than id, because that's what a person types.
 */
function sendRequest(req, res) {
  const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
  if (!username) {
    return res.status(400).json({ error: "missing_username", message: "Who do you want to add?" });
  }

  const target = userModel.findByUsername(username);

  // A deliberately vague answer, matching the login endpoint's reasoning:
  // a precise "no such user" turns this into a username oracle for anyone
  // with an account.
  if (!target) {
    return res.status(404).json({ error: "not_found", message: "No player with that name." });
  }

  const result = friendModel.sendRequest(req.user.id, target.id);

  if (!result.ok) {
    const messages = {
      self: "You can't add yourself.",
      already_friends: "You're already friends.",
      already_pending: "You've already sent them a request.",
      // Same wording a non-blocked failure would give. Confirming a block
      // tells the blocker's harasser exactly what happened.
      blocked: "Couldn't send that request.",
    };
    const status = result.reason === "self" ? 400 : 409;
    return res.status(status).json({
      error: result.reason,
      message: messages[result.reason] || "Couldn't send that request.",
    });
  }

  const me = userModel.toPublicUser(req.user);

  if (result.status === "accepted") {
    // They'd already asked us — this completed the handshake both ways.
    hub.emitToUser(target.id, "friend:accepted", { user: me });
    return res.status(200).json({
      status: "accepted",
      message: `You and ${target.username} are now friends.`,
    });
  }

  // Live nudge so the recipient's badge updates without a refresh.
  hub.emitToUser(target.id, "friend:request", {
    friendshipId: result.friendshipId,
    user: me,
  });

  res.status(201).json({ status: "pending", message: `Request sent to ${target.username}.` });
}

/** POST /api/friends/requests/:id/accept */
function acceptRequest(req, res) {
  const friendshipId = Number(req.params.id);
  if (!Number.isInteger(friendshipId)) {
    return res.status(400).json({ error: "bad_id", message: "Invalid request." });
  }

  // The model checks that this request was addressed to the caller, so
  // guessing another user's friendship id gets you a 404, not their friend.
  const result = friendModel.accept(friendshipId, req.user.id);
  if (!result.ok) {
    return res.status(404).json({ error: result.reason, message: "That request is no longer open." });
  }

  hub.emitToUser(result.otherUserId, "friend:accepted", {
    user: userModel.toPublicUser(req.user),
  });

  res.json({ ok: true });
}

/** POST /api/friends/requests/:id/decline — also used to cancel one you sent. */
function declineRequest(req, res) {
  const friendshipId = Number(req.params.id);
  if (!Number.isInteger(friendshipId)) {
    return res.status(400).json({ error: "bad_id", message: "Invalid request." });
  }

  const result = friendModel.removePending(friendshipId, req.user.id);
  if (!result.ok) {
    return res.status(404).json({ error: result.reason, message: "That request is no longer open." });
  }

  // The other party's list should stop showing it, but they are not told
  // whether it was declined or merely withdrawn.
  hub.emitToUser(result.otherUserId, "friend:removed", { userId: req.user.id });

  res.json({ ok: true });
}

/** DELETE /api/friends/:userId */
function unfriend(req, res) {
  const otherUserId = Number(req.params.userId);
  if (!Number.isInteger(otherUserId)) {
    return res.status(400).json({ error: "bad_id", message: "Invalid user." });
  }

  const result = friendModel.unfriend(req.user.id, otherUserId);
  if (!result.ok) {
    return res.status(404).json({ error: result.reason, message: "You're not friends." });
  }

  // Messages go with the friendship. Leaving the history would mean a
  // conversation neither party can open but the database still holds — and
  // one that would silently reappear if they friended again later.
  messageModel.purgeConversation(req.user.id, otherUserId);

  hub.emitToUser(otherUserId, "friend:removed", { userId: req.user.id });

  res.json({ ok: true });
}

module.exports = {
  listFriends,
  listRequests,
  searchUsers,
  sendRequest,
  acceptRequest,
  declineRequest,
  unfriend,
};
