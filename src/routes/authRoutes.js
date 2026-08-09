/**
 * /api/auth/*
 *
 * Route files stay thin on purpose: a path, the middleware that guards it,
 * and the controller that handles it. Reading this file should tell you the
 * whole public surface of authentication in under a minute.
 */

const express = require("express");
const passport = require("passport");

const config = require("../config/env");
const authController = require("../controllers/authController");
const { requireAuth } = require("../middleware/requireAuth");
const {
  loginLimiter,
  signupLimiter,
  usernameCheckLimiter,
} = require("../middleware/rateLimit");

const router = express.Router();

// ---- Password auth ----------------------------------------------------

router.get("/username-available", usernameCheckLimiter, authController.checkUsername);
router.post("/signup", signupLimiter, authController.signup);
router.post("/login", loginLimiter, authController.login);
router.post("/logout", authController.logout);
router.get("/me", authController.me);

// ---- Google OAuth -----------------------------------------------------
//
// Registered unconditionally so the endpoints exist and can explain
// themselves when unconfigured, rather than 404ing and looking broken.

/** Guard for when the server has no Google credentials. */
function requireGoogleConfigured(req, res, next) {
  if (!config.google.enabled) {
    return res.status(503).json({
      error: "google_not_configured",
      message:
        "Google sign-in isn't set up on this server. Add GOOGLE_CLIENT_ID and " +
        "GOOGLE_CLIENT_SECRET to .env, or use a username and password.",
    });
  }
  next();
}

/** Step 1: bounce the user to Google. */
router.get("/google", requireGoogleConfigured, (req, res, next) => {
  // Remember where they were going so the callback can send them back.
  // Only a path is stored, never an absolute URL — see the open-redirect
  // note in middleware/requireAuth.js.
  const next_ = typeof req.query.next === "string" ? req.query.next : "";
  req.session.oauthNext = next_.startsWith("/") && !next_.startsWith("//") ? next_ : "/";

  passport.authenticate("google", { session: false, scope: ["profile", "email"] })(
    req,
    res,
    next
  );
});

/**
 * Step 2: Google redirects here with a code; passport exchanges it.
 *
 * A custom callback rather than passport's built-in redirect options,
 * because the two outcomes need different destinations: a known user gets a
 * session, a new one gets parked and sent to pick a username.
 *
 * This is a top-level browser navigation, so failures redirect with a
 * message in the query string instead of returning JSON — the user is
 * looking at a page here, not reading a fetch response.
 */
router.get("/google/callback", requireGoogleConfigured, (req, res, next) => {
  passport.authenticate("google", { session: false }, async (err, result) => {
    try {
      if (err || !result) {
        const reason = encodeURIComponent(
          err?.message || "Google sign-in was cancelled or failed."
        );
        return res.redirect(`/login.html?error=${reason}`);
      }

      const destination = req.session.oauthNext || "/";

      if (result.type === "user") {
        await authController.establishSession(req, result.user);
        return res.redirect(destination);
      }

      // New person: hold the verified identity server-side and send them to
      // name themselves. Nothing about this is exposed to the client except
      // the suggested username.
      req.session.pendingGoogle = result.pending;
      req.session.oauthNext = destination;
      return req.session.save((saveErr) =>
        saveErr ? next(saveErr) : res.redirect("/choose-username.html")
      );
    } catch (callbackErr) {
      next(callbackErr);
    }
  })(req, res, next);
});

router.get("/pending-google", authController.pendingGoogle);
router.post("/choose-username", authController.chooseUsername);

// ---- Example protected route -----------------------------------------
// Proof the guard works, and a place for the profile page to get its data.
router.get("/profile", requireAuth, (req, res) => {
  const userModel = require("../models/userModel");
  res.json({ user: userModel.toPublicUser(req.user) });
});

module.exports = router;
