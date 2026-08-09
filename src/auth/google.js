/**
 * Google OAuth 2.0 (Authorization Code flow) via passport-google-oauth20.
 *
 * ---- What actually happens, since this is the part worth being able to
 *      explain out loud ----
 *
 *   1. Browser hits /api/auth/google. We 302 it to accounts.google.com with
 *      our client_id, the scopes we want, and a redirect_uri.
 *   2. The user authenticates *on Google's domain*. Their password is typed
 *      into Google's page, over Google's TLS, into Google's servers. This
 *      application never sees it, never receives it, and could not store it
 *      if it wanted to. That is the entire point of OAuth: it replaces
 *      "give this site your password" with "let this site ask Google who
 *      you are".
 *   3. Google redirects back to our callback with a short-lived, single-use
 *      authorization *code*.
 *   4. Our server exchanges that code for tokens in a direct back-channel
 *      POST to Google, authenticated with our client_secret. The secret
 *      never touches the browser, and the code is useless to anyone who
 *      intercepts the redirect without it.
 *   5. Google returns a verified profile. We trust `profile.id` — a stable,
 *      Google-scoped subject identifier — as the identity.
 *
 * We key accounts on `profile.id`, not on the email address. Emails get
 * changed and reassigned; the subject id doesn't. Treating an email as the
 * primary key is how you end up handing an account to whoever inherits a
 * recycled corporate address.
 *
 * ---- Why passport is used here and nowhere else ----
 *
 * Local login doesn't go through passport at all — it's twenty lines in
 * authController and doesn't need a framework. OAuth is where passport earns
 * its place: the redirect dance, the state parameter, and the token exchange
 * are fiddly and easy to get subtly wrong.
 *
 * The strategy is registered with `session: false` and passport's
 * serializeUser/deserializeUser are never used. Passport hands us a verified
 * identity and gets out of the way; the session is then written by the same
 * establishSession() that password login uses. One definition of "logged
 * in", one code path, no second parallel session mechanism to reason about.
 */

const passport = require("passport");
const { Strategy: GoogleStrategy } = require("passport-google-oauth20");

const config = require("../config/env");
const userModel = require("../models/userModel");
const { validateUsername } = require("../validators/authValidators");

/**
 * Turns an email local-part into a legal username suggestion, then makes it
 * unique. Only a suggestion — the user can always type something else.
 */
function suggestUsername(email, displayName) {
  const base = String(email || displayName || "player")
    .split("@")[0]
    .replace(/[^a-zA-Z0-9_-]/g, "")   // match the username allow-list
    .slice(0, 16);

  const seed = base.length >= 3 ? base : `player${base}`;

  if (validateUsername(seed).ok && !userModel.usernameExists(seed)) return seed;

  // Walk a numeric suffix rather than appending randomness, so the first
  // suggestion a person sees is the tidy one.
  for (let i = 1; i < 100; i++) {
    const candidate = `${seed.slice(0, 16)}${i}`;
    if (validateUsername(candidate).ok && !userModel.usernameExists(candidate)) {
      return candidate;
    }
  }
  return "";
}

/**
 * The verify callback. Resolves the Google profile to one of two outcomes:
 *
 *   { type: "user",    user }     an existing account — log straight in
 *   { type: "pending", pending }  a new person — needs to pick a username
 *
 * It deliberately does *not* auto-create an account with a generated name.
 * A username is the thing other players see on a leaderboard; picking it is
 * the user's call, not a slug derived from their email address.
 */
function verify(_accessToken, _refreshToken, profile, done) {
  try {
    const googleId = profile.id;
    const emailEntry = profile.emails?.[0];
    const email = emailEntry?.value?.toLowerCase() || null;

    // passport-google-oauth20 surfaces Google's own verification flag. An
    // unverified email is not evidence of anything, so it's never used for
    // matching an existing account.
    const emailVerified = emailEntry?.verified === true || emailEntry?.verified === "true";

    const avatarUrl = profile.photos?.[0]?.value || null;

    // 1. Returning Google user.
    const byGoogleId = userModel.findByGoogleId(googleId);
    if (byGoogleId) return done(null, { type: "user", user: byGoogleId });

    // 2. An existing account with this verified email — link the two rather
    //    than creating a duplicate. Guarded on emailVerified: without that
    //    check, anyone able to set an arbitrary unverified email on a Google
    //    account could claim someone else's account here.
    if (email && emailVerified) {
      const byEmail = userModel.findByEmail(email);
      if (byEmail) {
        const linked = userModel.linkGoogleAccount(byEmail.id, googleId, avatarUrl);
        return done(null, { type: "user", user: linked });
      }
    }

    // 3. Nobody we know. Park the verified identity and let them name
    //    themselves. This is held in the session, never sent to the client.
    return done(null, {
      type: "pending",
      pending: {
        googleId,
        email,
        avatarUrl,
        suggestion: suggestUsername(email, profile.displayName),
      },
    });
  } catch (err) {
    return done(err);
  }
}

/**
 * Registers the strategy, if credentials exist.
 * @returns {boolean} whether Google login is available.
 */
function configureGoogleStrategy() {
  if (!config.google.enabled) {
    console.warn(
      "[auth] GOOGLE_CLIENT_ID/SECRET not set — Google sign-in is disabled. " +
        "Password login works as normal."
    );
    return false;
  }

  passport.use(
    new GoogleStrategy(
      {
        clientID: config.google.clientId,
        clientSecret: config.google.clientSecret,
        callbackURL: `${config.appOrigin}/api/auth/google/callback`,
        scope: ["profile", "email"],
        // Ask Google to sign a `state` parameter tying the callback to the
        // browser that started the flow. Without state, an attacker can feed
        // a victim their own authorization code and land the victim in the
        // attacker's account (login CSRF).
        state: true,
      },
      verify
    )
  );

  return true;
}

module.exports = { configureGoogleStrategy, suggestUsername };
