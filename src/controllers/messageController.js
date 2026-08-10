/**
 * Direct messages.
 *
 * The rule that shapes this whole file: **you may only exchange messages
 * with an accepted friend**, checked server-side on every single operation —
 * read, write, and mark-as-read alike.
 *
 * It would be tempting to check once when the conversation is opened. That's
 * wrong: friendships end. A check at open time means someone who was unfriended
 * mid-conversation keeps a working socket into your inbox for as long as they
 * leave the tab open.
 */

const messageModel = require("../models/messageModel");
const friendModel = require("../models/friendModel");
const userModel = require("../models/userModel");
const hub = require("../realtime/hub");

/** Shared guard: resolves the other participant, or ends the request. */
function resolveFriend(req, res) {
  const otherUserId = Number(req.params.userId);

  if (!Number.isInteger(otherUserId)) {
    res.status(400).json({ error: "bad_id", message: "Invalid user." });
    return null;
  }

  if (!friendModel.areFriends(req.user.id, otherUserId)) {
    // 403 rather than 404: the caller may well know this user exists (they
    // could have just been unfriended). What's being refused is the
    // conversation, and saying so plainly is clearer than pretending the
    // person doesn't exist.
    res.status(403).json({
      error: "not_friends",
      message: "You can only message friends.",
    });
    return null;
  }

  return otherUserId;
}

/** GET /api/messages/:userId?before=<id> */
function getHistory(req, res) {
  const otherUserId = resolveFriend(req, res);
  if (otherUserId === null) return;

  const messages = messageModel.history(req.user.id, otherUserId, {
    limit: req.query.limit,
    before: req.query.before,
  });

  // Opening a conversation marks it read. Done here rather than in a
  // separate client call so the unread badge can't get stuck because a
  // follow-up request was dropped.
  messageModel.markConversationRead(req.user.id, otherUserId);

  const other = userModel.findById(otherUserId);

  res.json({
    with: other ? userModel.toPublicUser(other) : null,
    online: hub.isOnline(otherUserId),
    messages: messages.map(shapeMessage),
  });
}

function shapeMessage(row) {
  return {
    id: row.id,
    senderId: row.sender_id,
    recipientId: row.recipient_id,
    senderUsername: row.sender_username,
    body: row.body,
    createdAt: row.created_at,
  };
}

/** POST /api/messages/:userId  { body } */
function sendMessage(req, res) {
  const otherUserId = resolveFriend(req, res);
  if (otherUserId === null) return;

  const raw = typeof req.body?.body === "string" ? req.body.body : "";
  const body = raw.trim();

  if (!body) {
    return res.status(400).json({ error: "empty", message: "Type something first." });
  }
  if (body.length > messageModel.MAX_BODY_LENGTH) {
    return res.status(400).json({
      error: "too_long",
      message: `Messages are limited to ${messageModel.MAX_BODY_LENGTH} characters.`,
    });
  }

  const saved = messageModel.send(req.user.id, otherUserId, body);
  const shaped = shapeMessage(saved);

  // Push to the recipient's open tabs. If they're offline this is a no-op
  // and they'll see it in history next time — the database write above is
  // what makes the message real, not the socket.
  hub.emitToUser(otherUserId, "dm:message", shaped);

  // Echo to the sender's *other* tabs so all their windows stay in step.
  // The tab that sent it renders optimistically from the response.
  hub.emitToUser(req.user.id, "dm:message", shaped);

  res.status(201).json({ message: shaped });
}

/** GET /api/messages — unread summary for badges. */
function getUnreadSummary(req, res) {
  res.json({
    total: messageModel.totalUnread(req.user.id),
    bySender: messageModel.unreadCounts(req.user.id),
  });
}

module.exports = { getHistory, sendMessage, getUnreadSummary };
