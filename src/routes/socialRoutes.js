/**
 * /api/friends/* and /api/messages/*
 *
 * Every route here is behind requireAuth — there is no anonymous view of
 * anyone's social graph. The rate limits are per-action rather than global:
 * friend requests and user search are the two endpoints that are worth
 * abusing (spam and directory scraping respectively), and they deserve
 * tighter budgets than reading your own friend list.
 */

const express = require("express");
const rateLimit = require("express-rate-limit");
const { ipKeyGenerator } = require("express-rate-limit");

const friendController = require("../controllers/friendController");
const messageController = require("../controllers/messageController");
const { requireAuth } = require("../middleware/requireAuth");

// Rate limits here are keyed per authenticated user, not per IP. Two players
// on the same student-halls NAT shouldn't share a friend-request budget, and
// an attacker with a proxy pool shouldn't get a fresh one per address.
//
// The IP fallback can't just be `req.ip`. An IPv6 user is typically handed a
// whole /64, so keying on the full address lets them rotate through billions
// of them and get a fresh budget every time. `ipKeyGenerator` collapses IPv6
// to its /64 prefix (and leaves IPv4 alone), which is the unit an ISP
// actually assigns. In practice these routes are all behind requireAuth so
// the fallback is unreachable — but an unreachable branch that's wrong is
// just a bug waiting for someone to move a middleware.
const perUser = (req) => (req.user ? `u${req.user.id}` : ipKeyGenerator(req.ip));

const requestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  keyGenerator: perUser,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "rate_limited", message: "Too many friend requests. Try again later." },
});

const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 40,
  keyGenerator: perUser,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "rate_limited", message: "Slow down a moment." },
});

const messageLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,   // a fast typist sends maybe 20/min; 60 is generous but not a firehose
  keyGenerator: perUser,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "rate_limited", message: "You're sending messages too quickly." },
});

// ---- Friends ---------------------------------------------------------

const friends = express.Router();
friends.use(requireAuth);

friends.get("/", friendController.listFriends);
friends.get("/requests", friendController.listRequests);
friends.get("/search", searchLimiter, friendController.searchUsers);
friends.post("/requests", requestLimiter, friendController.sendRequest);
friends.post("/requests/:id/accept", friendController.acceptRequest);
friends.post("/requests/:id/decline", friendController.declineRequest);
friends.delete("/:userId", friendController.unfriend);

// ---- Messages ---------------------------------------------------------

const messages = express.Router();
messages.use(requireAuth);

messages.get("/", messageController.getUnreadSummary);
messages.get("/:userId", messageController.getHistory);
messages.post("/:userId", messageLimiter, messageController.sendMessage);

module.exports = { friends, messages };
