/**
 * Shared frontend helpers for the auth pages.
 *
 * Deliberately plain: no framework, no build step, matching the rest of the
 * site. Loaded as a classic script, so it hangs one global (`MiniAuth`) off
 * window rather than using modules — that keeps it usable from the inline
 * <script> blocks the other pages already use.
 */
(function (global) {
  "use strict";

  /**
   * fetch wrapper for the JSON API.
   *
   * Always returns { ok, status, data } instead of throwing on 4xx, because
   * every 4xx here is a *result* the form needs to display ("username taken",
   * "wrong password"), not an exception. A network failure is the genuinely
   * exceptional case, and that comes back as status 0.
   */
  async function api(path, { method = "GET", body } = {}) {
    try {
      const response = await fetch(path, {
        method,
        // Send the session cookie. Same-origin is the browser default, but
        // being explicit means this keeps working if the API ever moves.
        credentials: "same-origin",
        headers: body
          ? {
              "Content-Type": "application/json",
              // Marks the request as a scripted, same-origin fetch. A plain
              // cross-site <form> cannot set this header.
              "X-Requested-With": "fetch",
            }
          : { "X-Requested-With": "fetch" },
        body: body ? JSON.stringify(body) : undefined,
      });

      let data = null;
      try {
        data = await response.json();
      } catch {
        data = null; // 204, or an HTML error page from a proxy
      }

      return { ok: response.ok, status: response.status, data: data || {} };
    } catch (err) {
      return {
        ok: false,
        status: 0,
        data: { error: "network", message: "Can't reach the server. Is it running?" },
      };
    }
  }

  /**
   * Trailing debounce.
   *
   * Used for the username availability check: fires once the typing pauses,
   * rather than once per keystroke. Without it, "chanshi" is eight requests
   * and the answers can arrive out of order — see the sequence guard in
   * signup.html for the other half of that problem.
   */
  function debounce(fn, delay) {
    let timer = null;
    return function debounced(...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), delay);
    };
  }

  /** Sets the text and state of a hint line under a field. */
  function setHint(el, text, state) {
    if (!el) return;
    // textContent, never innerHTML. Server messages are ours, but a username
    // echoed back into one is not — assigning as text means a name like
    // <img onerror=...> renders as characters instead of executing.
    el.textContent = text || "";
    el.className = "hint" + (state ? " " + state : "");
  }

  /** Sets a field wrapper's ok/bad border state. */
  function setFieldState(fieldEl, state) {
    if (!fieldEl) return;
    fieldEl.classList.remove("is-ok", "is-bad");
    if (state === "ok") fieldEl.classList.add("is-ok");
    if (state === "bad") fieldEl.classList.add("is-bad");
  }

  /** Shows or hides the form-level banner. */
  function setBanner(el, text, kind = "error") {
    if (!el) return;
    if (!text) {
      el.className = "banner";
      el.textContent = "";
      return;
    }
    el.textContent = text;
    el.className = "banner show " + kind;
    // Announce to screen readers; the element carries role="alert".
    el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  /** Decorative starfield, same as the arcade page. */
  function starfield(containerId, count = 70) {
    const stars = document.getElementById(containerId);
    if (!stars) return;
    for (let i = 0; i < count; i++) {
      const s = document.createElement("i");
      s.style.left = (Math.random() * 100).toFixed(2) + "%";
      s.style.top = (Math.random() * 70).toFixed(2) + "%";
      s.style.animationDelay = (Math.random() * 3.4).toFixed(2) + "s";
      if (Math.random() < 0.2) { s.style.width = "3px"; s.style.height = "3px"; }
      stars.appendChild(s);
    }
  }

  /**
   * Reads the `next` query parameter as a safe redirect target.
   *
   * Only same-site paths are honoured. Without this check, /login?next=
   * https://evil.example is an open redirect: the link looks like your
   * domain, and the user is bounced to a clone of it after logging in.
   * The `//` test matters — "//evil.example" is protocol-relative and is a
   * different site despite starting with a slash.
   */
  function safeNext(fallback = "/") {
    const raw = new URLSearchParams(location.search).get("next");
    if (!raw) return fallback;
    if (!raw.startsWith("/") || raw.startsWith("//")) return fallback;
    return raw;
  }

  /** GET /api/auth/me — { user, googleEnabled }. */
  async function whoami() {
    const { data } = await api("/api/auth/me");
    return data;
  }

  global.MiniAuth = { api, debounce, setHint, setFieldState, setBanner, starfield, safeNext, whoami };
})(window);
