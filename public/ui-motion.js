// CircuitMate UI choreography — Motion-driven, render layer only.
// Uses the vendored Motion bundle (window.Motion). If it or this file fails,
// app.js degrades to instant state swaps; the tool keeps working.
// Every choreographer is a no-op under prefers-reduced-motion.
(() => {
  const M = window.Motion;
  const mqReduce = matchMedia("(prefers-reduced-motion: reduce)");
  const SPRING_SOFT = { type: "spring", stiffness: 180, damping: 22 };
  const SPRING_POP  = { type: "spring", stiffness: 420, damping: 16 };
  const ok = () => Boolean(M) && !mqReduce.matches; // re-evaluated live — honors mid-session OS changes
  const done = (a) => (a && a.finished) ? a.finished : Promise.resolve();

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
          M.animate(el,
            { opacity: [0, 1], transform: [`translateY(${dy}px)`, "translateY(0px)"] },
            { ...SPRING_SOFT, delay: delay + i * 0.07 });
        });
      };
      run(groups.down, -10, 0.05);
      run(groups.up, 16, 0.14);
      run(groups["up-late"], 12, 0.32);

      const core = document.querySelector(".core");
      if (core) {
        core.style.opacity = "0";
        M.animate(core,
          { opacity: [0, 1], transform: ["scale(.55)", "scale(1)"] },
          { type: "spring", stiffness: 380, damping: 15, delay: 0.45 });
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
          await done(M.animate(t,
            { opacity: [1, 0], transform: ["translateY(0px)", "translateY(-5px)"] },
            { duration: 0.1, ease: "easeIn" }));
          if (mine !== token) return;
          t.textContent = label;
          M.animate(t,
            { opacity: [0, 1], transform: ["translateY(5px)", "translateY(0px)"] },
            { duration: 0.16, ease: "easeOut" });
        } catch { t.textContent = label; }
      } else if (label !== lastLabel || t.textContent !== label) {
        lastLabel = label;
        t.textContent = label;
      }
    }
    if (dot && ok()) {
      M.animate(dot, { transform: ["scale(1)", "scale(1.45)", "scale(1)"] }, { duration: 0.32 });
    }

    const s = document.getElementById("stateSub");
    if (s && sub && sub !== lastSub) {
      lastSub = sub;
      if (ok()) {
        try {
          await done(M.animate(s,
            { opacity: [1, 0], transform: ["translateY(0px)", "translateY(-4px)"] },
            { duration: 0.1, ease: "easeIn" }));
          s.textContent = sub;
          M.animate(s,
            { opacity: [0, 1], transform: ["translateY(4px)", "translateY(0px)"] },
            { duration: 0.18, ease: "easeOut" });
        } catch { s.textContent = sub; }
      } else {
        s.textContent = sub;
      }
    }
  }

  // ---- micro-interactions for injected content ----
  function rowIn(row) {
    if (!ok()) return;
    M.animate(row,
      { opacity: [0, 1], transform: ["translateX(-10px)", "translateX(0px)"] },
      SPRING_SOFT);
  }
  function chipIn(chip) {
    if (!ok()) return;
    M.animate(chip,
      { opacity: [0, 1], transform: ["scale(.7)", "scale(1)"] },
      SPRING_POP);
  }
  function cardIn(card) {
    if (!ok()) return;
    M.animate(card,
      { opacity: [0, 1], transform: ["translateY(10px)", "translateY(0px)"] },
      SPRING_SOFT);
  }
  function valueIn(el) {
    if (!ok()) return;
    M.animate(el,
      { opacity: [0, 1], transform: ["translateY(5px)", "translateY(0px)"] },
      { duration: 0.22, ease: "easeOut" });
  }

  // ---- magnetic core: subtle pull toward the pointer, springs home ----
  function coreMagnet(scopeWrap, core) {
    if (!ok() || !matchMedia("(pointer: fine)").matches) return;
    let anim = null;
    const clamp = (v) => Math.max(-9, Math.min(9, v));
    const move = (x, y) => {
      if (anim) anim.stop();
      anim = M.animate(core, { x, y }, { type: "spring", stiffness: 300, damping: 28 });
    };
    scopeWrap.addEventListener("pointermove", (e) => {
      const r = core.getBoundingClientRect();
      move(
        clamp((e.clientX - (r.left + r.width / 2)) * 0.05),
        clamp((e.clientY - (r.top + r.height / 2)) * 0.05)
      );
    });
    scopeWrap.addEventListener("pointerleave", () => move(0, 0));
  }

  window.CM = { boot, enterState, rowIn, chipIn, cardIn, valueIn, coreMagnet };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
