// CircuitMate UI choreography — Web Animations API, render layer only.
// Replaces the previous Motion-driven layer (the /vendor/motion.js reference
// was broken, so window.Motion was always undefined and every animation
// silently no-opped). WAAPI is native, dependency-free, and honors
// prefers-reduced-motion via the same no-op guard.
// Every choreographer is a no-op under prefers-reduced-motion.
(() => {
  const mqReduce = matchMedia("(prefers-reduced-motion: reduce)");
  const ok = () => !mqReduce.matches; // re-evaluated live — honors mid-session OS changes

  // WAAPI-friendly approximations of the previous Motion springs.
  const EASE_SOFT = "cubic-bezier(0.22, 1, 0.36, 1)";   // spring-ish ease-out
  const EASE_POP  = "cubic-bezier(0.34, 1.56, 0.64, 1)"; // overshoot pop

  function animate(el, keyframes, opts = {}) {
    if (!el || !el.animate) return null;
    try {
      return el.animate(keyframes, {
        duration: opts.duration ?? 300,
        easing: opts.easing ?? EASE_SOFT,
        delay: opts.delay ?? 0,
        fill: opts.fill ?? "both",
        ...opts,
      });
    } catch {
      return null; // choreography must never block the tool
    }
  }

  // ---- entrance choreography: masthead → panels → core ----
  function boot() {
    if (!ok()) return;
    try {
      const groups = { down: [], up: [], "up-late": [] };
      document.querySelectorAll("[data-boot]").forEach((el) => {
        (groups[el.dataset.boot] ?? groups.up).push(el);
      });
      const run = (els, dy, delay) => {
        els.forEach((el, i) => {
          el.style.opacity = "0";
          animate(el,
            { opacity: [0, 1], transform: [`translateY(${dy}px)`, "translateY(0px)"] },
            { duration: 420, easing: EASE_SOFT, delay: delay + i * 70 });
        });
      };
      run(groups.down, -10, 50);
      run(groups.up, 16, 140);
      run(groups["up-late"], 12, 320);

      const core = document.querySelector(".core");
      if (core) {
        core.style.opacity = "0";
        animate(core,
          { opacity: [0, 1], transform: ["scale(.55)", "scale(1)"] },
          { duration: 520, easing: EASE_POP, delay: 450 });
      }
      const scopeWrap = document.getElementById("scopeWrap");
      if (core && scopeWrap) coreMagnet(scopeWrap, core);

      // safety net: nothing may stay invisible if an animation never ran
      setTimeout(() => {
        document.querySelectorAll("[data-boot]").forEach((el) => {
          if (el.style.opacity === "0") el.style.opacity = "";
        });
        const c = document.querySelector(".core");
        if (c && c.style.opacity === "0") c.style.opacity = "";
      }, 2000);
    } catch { /* choreography must never block the tool */ }
  }

  // ---- state transitions: crossfade label + sub, pop the dot ----
  let lastLabel = null, lastSub = null, token = 0;
  async function enterState(label, sub) {
    const t = document.getElementById("stateText");
    const dot = document.getElementById("stateDot");
    const scopeState = document.getElementById("scopeState");
    if (scopeState && scopeState.textContent !== label) scopeState.textContent = label;

    if (t) {
      if (ok() && label !== lastLabel) {
        lastLabel = label;
        const mine = ++token;
        try {
          const out = animate(t,
            { opacity: [1, 0], transform: ["translateY(0px)", "translateY(-5px)"] },
            { duration: 100, easing: "ease-in", fill: "both" });
          if (out) await out.finished;
          if (mine !== token) return;
          t.textContent = label;
          animate(t,
            { opacity: [0, 1], transform: ["translateY(5px)", "translateY(0px)"] },
            { duration: 160, easing: "ease-out", fill: "both" });
        } catch { t.textContent = label; }
      } else if (label !== lastLabel || t.textContent !== label) {
        lastLabel = label;
        t.textContent = label;
      }
    }
    if (dot && ok()) {
      animate(dot, { transform: ["scale(1)", "scale(1.45)", "scale(1)"] },
        { duration: 320, easing: "ease-out", fill: "both" });
    }

    const s = document.getElementById("stateSub");
    if (s && sub && sub !== lastSub) {
      lastSub = sub;
      if (ok()) {
        try {
          const out = animate(s,
            { opacity: [1, 0], transform: ["translateY(0px)", "translateY(-4px)"] },
            { duration: 100, easing: "ease-in", fill: "both" });
          if (out) await out.finished;
          s.textContent = sub;
          animate(s,
            { opacity: [0, 1], transform: ["translateY(4px)", "translateY(0px)"] },
            { duration: 180, easing: "ease-out", fill: "both" });
        } catch { s.textContent = sub; }
      } else {
        s.textContent = sub;
      }
    }
  }

  // ---- micro-interactions for injected content ----
  function rowIn(row) {
    if (!ok()) return;
    animate(row,
      { opacity: [0, 1], transform: ["translateX(-10px)", "translateX(0px)"] },
      { duration: 300, easing: EASE_SOFT });
  }
  function chipIn(chip) {
    if (!ok()) return;
    animate(chip,
      { opacity: [0, 1], transform: ["scale(.7)", "scale(1)"] },
      { duration: 260, easing: EASE_POP });
  }
  function cardIn(card) {
    if (!ok()) return;
    animate(card,
      { opacity: [0, 1], transform: ["translateY(10px)", "translateY(0px)"] },
      { duration: 300, easing: EASE_SOFT });
  }
  function valueIn(el) {
    if (!ok()) return;
    animate(el,
      { opacity: [0, 1], transform: ["translateY(5px)", "translateY(0px)"] },
      { duration: 220, easing: "ease-out" });
  }

  // ---- magnetic core: subtle pull toward the pointer, springs home ----
  // WAAPI can't spring a transform smoothly on every pointermove; a CSS
  // transition on transform gives the same soft follow + return feel.
  function coreMagnet(scopeWrap, core) {
    if (!ok() || !matchMedia("(pointer: fine)").matches) return;
    const clamp = (v) => Math.max(-9, Math.min(9, v));
    core.style.transition = "transform 0.35s cubic-bezier(0.22, 1, 0.36, 1)";
    scopeWrap.addEventListener("pointermove", (e) => {
      const r = core.getBoundingClientRect();
      core.style.transform = `translate(${clamp((e.clientX - (r.left + r.width / 2)) * 0.05)}px, ${clamp((e.clientY - (r.top + r.height / 2)) * 0.05)}px)`;
    });
    scopeWrap.addEventListener("pointerleave", () => {
      core.style.transform = "translate(0px, 0px)";
    });
  }

  window.CM = { boot, enterState, rowIn, chipIn, cardIn, valueIn, coreMagnet };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
