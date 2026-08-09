/**
 * High scores, keyed to a user id.
 *
 * This table is the reason the auth work was worth doing, and it's here now
 * as the proof that the structure extends: adding a feature means a model, a
 * controller and a route file, and the auth middleware already knows how to
 * protect it.
 */

const { db } = require("../db");

const insertScore = db.prepare(`
  INSERT INTO scores (user_id, game, score) VALUES (?, ?, ?)
`);

function recordScore(userId, game, score) {
  const info = insertScore.run(userId, game, score);
  return { id: info.lastInsertRowid, userId, game, score };
}

const selectBestForUser = db.prepare(`
  SELECT MAX(score) AS best FROM scores WHERE user_id = ? AND game = ?
`);

function bestForUser(userId, game) {
  return selectBestForUser.get(userId, game)?.best ?? null;
}

// One row per player (their personal best), not one row per play — a
// leaderboard where the same person holds the top ten slots is a bug.
const selectLeaderboard = db.prepare(`
  SELECT u.username, MAX(s.score) AS score, MIN(s.created_at) AS first_played
    FROM scores s
    JOIN users u ON u.id = s.user_id
   WHERE s.game = ?
   GROUP BY s.user_id
   ORDER BY score DESC, first_played ASC
   LIMIT ?
`);

function leaderboard(game, limit = 10) {
  return selectLeaderboard.all(game, limit);
}

const selectRecentForUser = db.prepare(`
  SELECT game, score, created_at FROM scores
   WHERE user_id = ? ORDER BY created_at DESC LIMIT ?
`);

function recentForUser(userId, limit = 20) {
  return selectRecentForUser.all(userId, limit);
}

module.exports = { recordScore, bestForUser, leaderboard, recentForUser };
