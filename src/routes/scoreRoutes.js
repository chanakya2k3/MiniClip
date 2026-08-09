/**
 * /api/scores/*
 *
 * Here to demonstrate the extension point the auth work was for: a feature
 * route that says `requireAuth` and is then free to trust `req.user`.
 *
 * Note what submitting a score does *not* do: trust the number. The existing
 * game server already establishes the principle (server validates, client
 * asserts nothing) — a score POSTed straight from the browser is a claim, and
 * a leaderboard built on claims is a leaderboard of whoever opened devtools
 * first. The sanity bounds below are a placeholder; the real fix is for the
 * server to observe the game, the way src/realtime does for tic-tac-toe.
 */

const express = require("express");

const scoreModel = require("../models/scoreModel");
const { requireAuth } = require("../middleware/requireAuth");

const router = express.Router();

const KNOWN_GAMES = new Set(["flappy-duel", "tic-tac-toe"]);
const MAX_PLAUSIBLE_SCORE = 100000;

/** POST /api/scores  { game, score } — protected. */
router.post("/", requireAuth, (req, res) => {
  const game = String(req.body?.game || "");
  const score = Number(req.body?.score);

  if (!KNOWN_GAMES.has(game)) {
    return res.status(400).json({ error: "unknown_game", message: "Unknown game." });
  }
  if (!Number.isInteger(score) || score < 0 || score > MAX_PLAUSIBLE_SCORE) {
    return res.status(400).json({ error: "invalid_score", message: "Invalid score." });
  }

  const saved = scoreModel.recordScore(req.user.id, game, score);
  res.status(201).json({
    score: saved.score,
    best: scoreModel.bestForUser(req.user.id, game),
  });
});

/** GET /api/scores/leaderboard/:game — public; a leaderboard nobody can read is decoration. */
router.get("/leaderboard/:game", (req, res) => {
  const game = String(req.params.game || "");
  if (!KNOWN_GAMES.has(game)) {
    return res.status(404).json({ error: "unknown_game", message: "Unknown game." });
  }
  res.json({ game, entries: scoreModel.leaderboard(game, 10) });
});

/** GET /api/scores/mine — protected. */
router.get("/mine", requireAuth, (req, res) => {
  res.json({ scores: scoreModel.recentForUser(req.user.id) });
});

module.exports = router;
