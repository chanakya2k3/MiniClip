/**
 * Direct messages between friends.
 *
 * Storage is deliberately boring: one flat table, no conversation entity.
 * A conversation here is just "all rows sharing a pair_key", which is enough
 * for one-to-one chat and avoids maintaining a second table that can drift
 * out of sync with the messages in it. Group chat would be the point at
 * which a real conversations table earns its place.
 */

const { db } = require("../db");

const MAX_BODY_LENGTH = 1000;

/**
 * Canonical key for a pair of users, independent of who is sending.
 * [12, 7] and [7, 12] must produce the same string or the two halves of a
 * conversation end up in different buckets.
 */
function pairKey(userA, userB) {
  return [Number(userA), Number(userB)].sort((x, y) => x - y).join(":");
}

const insertMessage = db.prepare(`
  INSERT INTO direct_messages (pair_key, sender_id, recipient_id, body)
  VALUES (@pairKey, @senderId, @recipientId, @body)
`);

const selectMessageById = db.prepare(`
  SELECT m.id, m.sender_id, m.recipient_id, m.body, m.created_at, m.read_at,
         u.username AS sender_username
    FROM direct_messages m
    JOIN users u ON u.id = m.sender_id
   WHERE m.id = ?
`);

/**
 * Stores a message. Callers must have already checked the two users are
 * friends — this layer stores what it's given.
 *
 * The body is trimmed and hard-capped here as well as in the controller.
 * Belt and braces: this is the last point before it becomes a row, and a
 * future caller (a socket handler, a bot) might not go through the
 * controller at all.
 */
function send(senderId, recipientId, body) {
  const clean = String(body).trim().slice(0, MAX_BODY_LENGTH);
  const info = insertMessage.run({
    pairKey: pairKey(senderId, recipientId),
    senderId,
    recipientId,
    body: clean,
  });
  return selectMessageById.get(info.lastInsertRowid);
}

/**
 * Conversation history, newest-first from the database then reversed.
 *
 * Reading backwards and flipping is what makes "the last 50 messages" an
 * index scan that stops after 50 rows. Ordering ascending with a LIMIT would
 * give the *oldest* 50 and force a full scan to find the recent ones.
 */
const selectHistory = db.prepare(`
  SELECT m.id, m.sender_id, m.recipient_id, m.body, m.created_at, m.read_at,
         u.username AS sender_username
    FROM direct_messages m
    JOIN users u ON u.id = m.sender_id
   WHERE m.pair_key = @pairKey
     AND (@before IS NULL OR m.id < @before)
   ORDER BY m.id DESC
   LIMIT @limit
`);

function history(userA, userB, { limit = 50, before = null } = {}) {
  const rows = selectHistory.all({
    pairKey: pairKey(userA, userB),
    limit: Math.min(Number(limit) || 50, 100),
    before: before ? Number(before) : null,
  });
  return rows.reverse();
}

const markRead = db.prepare(`
  UPDATE direct_messages
     SET read_at = datetime('now')
   WHERE pair_key = ? AND recipient_id = ? AND read_at IS NULL
`);

/** Marks everything the caller has received in this conversation as read. */
function markConversationRead(userId, otherUserId) {
  const info = markRead.run(pairKey(userId, otherUserId), userId);
  return info.changes;
}

// Unread counts grouped by who sent them, so the friends list can badge each
// row from one query rather than one query per friend.
const selectUnreadBySender = db.prepare(`
  SELECT sender_id, COUNT(*) AS n
    FROM direct_messages
   WHERE recipient_id = ? AND read_at IS NULL
   GROUP BY sender_id
`);

function unreadCounts(userId) {
  const counts = {};
  for (const row of selectUnreadBySender.all(userId)) {
    counts[row.sender_id] = row.n;
  }
  return counts;
}

const countAllUnread = db.prepare(`
  SELECT COUNT(*) AS n FROM direct_messages WHERE recipient_id = ? AND read_at IS NULL
`);

function totalUnread(userId) {
  return countAllUnread.get(userId).n;
}

/**
 * Deletes a conversation's history. Called when two people unfriend, on the
 * principle that removing someone should also remove their ability to keep
 * reading what you said — and that a friends-only inbox shouldn't retain
 * threads you can no longer open.
 */
const deleteConversation = db.prepare(`DELETE FROM direct_messages WHERE pair_key = ?`);

function purgeConversation(userA, userB) {
  return deleteConversation.run(pairKey(userA, userB)).changes;
}

module.exports = {
  MAX_BODY_LENGTH,
  pairKey,
  send,
  history,
  markConversationRead,
  unreadCounts,
  totalUnread,
  purgeConversation,
};
