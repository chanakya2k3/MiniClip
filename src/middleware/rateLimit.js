/**
 * IP-based rate limiters.
 *
 * Different endpoints get different budgets because they cost different
 * things and are abused for different reasons. One global limiter would have
 * to be loose enough for the chattiest endpoint (username availability, one
 * call per keystroke-pause) which makes it useless on the one that matters
 * (login).
 */

const rateLimit = require("express-rate-limit");

const common = {
  standardHeaders: true,  // RateLimit-* headers, so a client can back off politely
  legacyHeaders: false,
};

/**
 * Login. The tight one.
 *
 * `skipSuccessfulRequests` means the budget is spent only on failures — a
 * person logging in correctly ten times in a row (multiple tabs, a shared
 * machine) never sees it, while someone guessing is cut off after 10 misses.
 */
const loginLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  message: {
    error: "rate_limited",
    message: "Too many login attempts. Wait 15 minutes and try again.",
  },
});

/**
 * Signup. Slower still, because each one creates a row and runs a bcrypt
 * hash — it's the most expensive unauthenticated endpoint on the server.
 */
const signupLimiter = rateLimit({
  ...common,
  windowMs: 60 * 60 * 1000,
  limit: 5,
  message: {
    error: "rate_limited",
    message: "Too many accounts created from this address. Try again later.",
  },
});

/**
 * Username availability.
 *
 * This endpoint is a user enumeration oracle by construction — its entire
 * job is answering "does this account exist". That's an accepted tradeoff:
 * a signup form that only tells you the name is taken *after* you fill in
 * the password is worse UX, and the same information falls out of the signup
 * endpoint anyway.
 *
 * What the limit does is change the economics. 60/minute is invisible to
 * someone typing (the frontend debounces to at most a few calls per name)
 * and makes scraping the user list a multi-day job instead of a two-minute
 * script.
 */
const usernameCheckLimiter = rateLimit({
  ...common,
  windowMs: 60 * 1000,
  limit: 60,
  message: {
    error: "rate_limited",
    message: "Slow down a moment.",
  },
});

/** Broad backstop for the rest of /api. Generous; it's only there to catch runaways. */
const apiLimiter = rateLimit({
  ...common,
  windowMs: 60 * 1000,
  limit: 240,
  message: { error: "rate_limited", message: "Too many requests." },
});

module.exports = { loginLimiter, signupLimiter, usernameCheckLimiter, apiLimiter };
