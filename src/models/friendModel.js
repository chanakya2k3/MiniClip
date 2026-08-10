/**
 * Friendships.
 *
 * One row per relationship, direction preserved (see the note in schema.sql
 * for why not two symmetric rows). Everything here has to cope with the fact
 * that "A and B are friends" can be stored as either `A→B` or `B→A`, so no
 * query may assume which column a given user sits in.
 *
 * The state machine:
 *
 *        (nothing)
 *            │ A requests B
 *            ▼
 *        pending ──── B accepts ────► accepted
 *            │                            │
 *            │ B declines                 │ either removes
 *            │ or A cancels               │
 *            ▼                            ▼
 *        (nothing) ◄────────────────── (nothing)
 *
 * The interesting edge: B requests A while A→B is already pending. That's
 * two people who both want to be friends, so it resolves to accepted rather
 * than a second row. Handling it any other way leaves two pending requests
 * that each look unanswered.
 */

const { db } = require("../db");

// ---- Lookups ---------------------------------------------------------

// Order-independent: finds the relationship whichever way round it's stored.
const selectBetween = db.prepare(`
  SELECT * FROM friendships
   WHERE (requester_id = @a AND addressee_id = @b)
      OR (requester_id = @b AND addressee_id = @a)
`);

function between(userA, userB) {
  return selectBetween.get({ a: userA, b: userB }) || null;
}

/**
 * The authorisation primitive for direct messages.
 *
 * Every DM path calls this. It is deliberately a single boolean with no
 * "sort of" states — a pending request is not a friendship, so it does not
 * grant the ability to send messages. Otherwise "send a friend request" becomes
 * "deliver a message to anyone", which is the spam vector.
 */
function areFriends(userA, userB) {
  const row = between(userA, userB);
  return Boolean(row && row.status === "accepted");
}

const selectById = db.prepare(`SELECT * FROM friendships WHERE id = ?`);

function findById(id) {
  return selectById.get(id) || null;
}

/**
 * Accepted friends of a user, as public user shapes.
 *
 * The CASE picks whichever column *isn't* the caller — this is the query
 * that the one-row design costs us, and it's the whole cost.
 */
const selectFriends = db.prepare(`
  SELECT u.id, u.username, u.avatar_url, f.created_at AS friends_since
    FROM friendships f
    JOIN users u
      ON u.id = CASE WHEN f.requester_id = @me THEN f.addressee_id ELSE f.requester_id END
   WHERE (f.requester_id = @me OR f.addressee_id = @me)
     AND f.status = 'accepted'
   ORDER BY u.username COLLATE NOCASE
`);

function listFriends(userId) {
  return selectFriends.all({ me: userId });
}

/** Requests waiting on this user to answer. */
const selectIncoming = db.prepare(`
  SELECT f.id, f.created_at, u.id AS user_id, u.username, u.avatar_url
    FROM friendships f
    JOIN users u ON u.id = f.requester_id
   WHERE f.addressee_id = ? AND f.status = 'pending'
   ORDER BY f.created_at DESC
`);

/** Requests this user has sent that haven't been answered. */
const selectOutgoing = db.prepare(`
  SELECT f.id, f.created_at, u.id AS user_id, u.username, u.avatar_url
    FROM friendships f
    JOIN users u ON u.id = f.addressee_id
   WHERE f.requester_id = ? AND f.status = 'pending'
   ORDER BY f.created_at DESC
`);

function listRequests(userId) {
  return {
    incoming: selectIncoming.all(userId),
    outgoing: selectOutgoing.all(userId),
  };
}

const countIncoming = db.prepare(`
  SELECT COUNT(*) AS n FROM friendships WHERE addressee_id = ? AND status = 'pending'
`);

function pendingCount(userId) {
  return countIncoming.get(userId).n;
}

// ---- Mutations --------------------------------------------------------

const insertRequest = db.prepare(`
  INSERT INTO friendships (requester_id, addressee_id, status) VALUES (?, ?, 'pending')
`);

const markAccepted = db.prepare(`
  UPDATE friendships SET status = 'accepted', responded_at = datetime('now') WHERE id = ?
`);

const deleteById = db.prepare(`DELETE FROM friendships WHERE id = ?`);

/**
 * Sends a friend request from `requesterId` to `addresseeId`.
 *
 * Wrapped in a transaction because it reads the current relationship and then
 * writes based on what it found. Without one, two people hitting "add friend"
 * on each other simultaneously can both read "nothing exists" and both
 * insert — producing the duplicate reciprocal row the UNIQUE constraint
 * can't catch, since (A,B) and (B,A) are different keys.
 *
 * @returns {{ok: true, status: 'pending'|'accepted'} | {ok: false, reason: string}}
 */
const sendRequest = db.transaction((requesterId, addresseeId) => {
  if (requesterId === addresseeId) {
    return { ok: false, reason: "self" };
  }

  const existing = between(requesterId, addresseeId);

  if (existing) {
    if (existing.status === "accepted") {
      return { ok: false, reason: "already_friends" };
    }
    if (existing.status === "blocked") {
      // Deliberately the same answer a stranger would get for any other
      // failure — see the note in the controller. Telling someone "you have
      // been blocked" turns a block into a notification.
      return { ok: false, reason: "blocked" };
    }
    // status === 'pending'
    if (existing.requester_id === requesterId) {
      return { ok: false, reason: "already_pending" };
    }

    // They asked us first and we're now asking them: mutual, so accept the
    // row that already exists rather than creating a second one.
    markAccepted.run(existing.id);
    return { ok: true, status: "accepted", friendshipId: existing.id };
  }

  const info = insertRequest.run(requesterId, addresseeId);
  return { ok: true, status: "pending", friendshipId: info.lastInsertRowid };
});

/**
 * Accepts a pending request.
 *
 * `userId` must be the *addressee*. Checking that here rather than in the
 * controller means there is no way to accept a request on someone else's
 * behalf by guessing a friendship id — the row is only touched if it was
 * addressed to the caller.
 */
function accept(friendshipId, userId) {
  const row = findById(friendshipId);
  if (!row || row.status !== "pending") return { ok: false, reason: "not_found" };
  if (row.addressee_id !== userId) return { ok: false, reason: "not_yours" };

  markAccepted.run(friendshipId);
  return { ok: true, otherUserId: row.requester_id };
}

/**
 * Declines a request, or cancels one you sent.
 *
 * Either participant may do this, which is why the ownership check accepts
 * both columns — but it still has to be *one of them*.
 */
function removePending(friendshipId, userId) {
  const row = findById(friendshipId);
  if (!row || row.status !== "pending") return { ok: false, reason: "not_found" };
  if (row.requester_id !== userId && row.addressee_id !== userId) {
    return { ok: false, reason: "not_yours" };
  }

  deleteById.run(friendshipId);
  const otherUserId = row.requester_id === userId ? row.addressee_id : row.requester_id;
  return { ok: true, otherUserId };
}

/** Unfriends. Either side can, and it deletes the single shared row. */
function unfriend(userId, otherUserId) {
  const row = between(userId, otherUserId);
  if (!row || row.status !== "accepted") return { ok: false, reason: "not_found" };

  deleteById.run(row.id);
  return { ok: true, otherUserId };
}

/**
 * Users matching a username prefix, excluding the caller.
 *
 * The `escape` clause matters: `%` and `_` are wildcards in LIKE, so an
 * unescaped search for "a_b" would also match "axb". Users can't currently
 * type those characters into a username, but the search box accepts any
 * text, and relying on a *different* validator to keep this one safe is how
 * these bugs survive refactors.
 */
const searchUsers = db.prepare(`
  SELECT u.id, u.username, u.avatar_url
    FROM users u
   WHERE u.username_canonical LIKE @pattern ESCAPE '\\'
     AND u.id <> @me
   ORDER BY LENGTH(u.username), u.username COLLATE NOCASE
   LIMIT @limit
`);

function search(query, meId, limit = 10) {
  const escaped = String(query).toLowerCase().replace(/[\\%_]/g, "\\$&");
  return searchUsers.all({ pattern: `${escaped}%`, me: meId, limit });
}

/**
 * Annotates search results with the caller's relationship to each user, so
 * the UI can show "Add" / "Pending" / "Friends" without N extra requests.
 */
function annotateRelationships(users, meId) {
  return users.map((user) => {
    const row = between(meId, user.id);
    let relationship = "none";

    if (row) {
      if (row.status === "accepted") relationship = "friends";
      else if (row.status === "pending") {
        relationship = row.requester_id === meId ? "outgoing" : "incoming";
      } else if (row.status === "blocked") {
        // Blocked users are reported as if nothing exists. The request will
        // fail if they try, but the list itself gives nothing away.
        relationship = "none";
      }
    }

    return { ...user, relationship, friendshipId: row?.id ?? null };
  });
}

module.exports = {
  between,
  areFriends,
  findById,
  listFriends,
  listRequests,
  pendingCount,
  sendRequest,
  accept,
  removePending,
  unfriend,
  search,
  annotateRelationships,
};
