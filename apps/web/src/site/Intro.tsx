import { useEffect, useLayoutEffect, useRef } from "react";
import { Wordmark } from "../components/Logo.tsx";
import { useLiveStatus } from "../live/hooks.ts";
import "./intro.css";

/**
 * The opening: the mark tells its own story. A stem rises; at the fork a fan of dotted futures
 * opens; every one but the "maybe" falls back into the fork while the committed branch draws; the
 * lime dot lands like a confirmed block. The name follows, the live slot ticks underneath, and the
 * logo flies into the header as the board (loading underneath all along) comes up.
 * Once per visit, any key or tap skips it, and it never plays for reduced motion.
 */

const SEEN_KEY = "maybe.odds.intro";

export function shouldPlayIntro(): boolean {
  try {
    if (typeof Element.prototype.animate !== "function") return false;
    const q = new URLSearchParams(location.search);
    if (q.has("intro")) return q.get("intro") !== "0";
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
    return sessionStorage.getItem(SEEN_KEY) !== "seen";
  } catch {
    return false;
  }
}

// the mark's geometry (viewBox 0 0 24 24, see components/Logo.tsx)
const FORK = { x: 12, y: 13.2 };
const MAYBE_ANGLE = -37.5; // the dotted branch, up and to the left
const DOT_AT = [3.75, 7.45]; // where the mark's dash pattern (0.1 on, 3.6 off) puts its dots
const FAN_R = [0.8, 0.72, 0.63, 0.54]; // possible futures thin out the further they run
// hand-set, uneven on purpose: possible futures spread like a spray, not like neat rings
const GHOSTS = [
  { angle: -9, start: 4.4, gap: 3.9, dots: 4, lag: 0 },
  { angle: 7, start: 5.0, gap: 3.6, dots: 3, lag: 30 },
  { angle: -24, start: 4.7, gap: 4.1, dots: 4, lag: 12 },
  { angle: 21, start: 4.2, gap: 4.3, dots: 3, lag: 45 },
  { angle: -53, start: 5.2, gap: 3.7, dots: 3, lag: 8 },
  { angle: 59, start: 4.5, gap: 4.0, dots: 3, lag: 38 },
  { angle: -66, start: 4.9, gap: 4.4, dots: 2, lag: 20 },
  { angle: 74, start: 5.3, gap: 3.8, dots: 2, lag: 52 },
  { angle: -81, start: 4.3, gap: 4.2, dots: 2, lag: 15 },
];
type Ray = { angle: number; dist: number[]; maybe: boolean; rank: number; lag: number };
const RAYS: Ray[] = [
  { angle: MAYBE_ANGLE, dist: DOT_AT, maybe: true, rank: 3, lag: 18 },
  ...GHOSTS.map((g, i) => ({ angle: g.angle, dist: Array.from({ length: g.dots }, (_, k) => g.start + k * g.gap), maybe: false, rank: i < 3 ? i : i + 1, lag: g.lag })),
];

const at = (angle: number, d: number) => {
  const a = (angle * Math.PI) / 180;
  return { x: FORK.x + Math.sin(a) * d, y: FORK.y - Math.cos(a) * d };
};

// timeline, ms from the start
const T = {
  stem: 80,
  fan: 380,
  collapse: 1090,
  commit: 1070,
  land: 1430,
  word: 1570,
  status: 1750,
  exit: 2520,
};
const EASE_OUT = "cubic-bezier(0.22, 0.8, 0.24, 1)";
const EASE_IN_OUT = "cubic-bezier(0.62, 0, 0.24, 1)";

function IntroStatus() {
  const s = useLiveStatus();
  const live = s.chain.state === "live" && s.chain.slot > 0;
  return (
    <>
      <i className={live ? "is-live" : undefined} />
      {live ? (
        <>
          Solana mainnet <span className="ointro-slot">slot {s.chain.slot.toLocaleString("en-US")}</span>
        </>
      ) : (
        "Connecting to Solana mainnet"
      )}
    </>
  );
}

export function Intro({ onExit, onDone }: { onExit: () => void; onDone: () => void }) {
  const backdrop = useRef<HTMLDivElement>(null);
  const glow = useRef<HTMLDivElement>(null);
  const lockup = useRef<HTMLDivElement>(null);
  const mark = useRef<SVGSVGElement>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const exitRef = useRef<(fast: boolean) => void>(() => undefined);
  const callbacks = useRef({ onExit, onDone });
  callbacks.current = { onExit, onDone };

  // place everything before the first paint: the lockup centred and scaled up from the header logo's
  // own size, the glow under where the dot will land, the status line under the name
  useLayoutEffect(() => {
    const el = lockup.current!;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // big on a wide screen, still generous on a phone
    const scale = Math.max(2.4, Math.min(6.2, (vw * (vw < 600 ? 0.6 : 0.36)) / w, (vh * 0.22) / h));
    const x = (vw - w * scale) / 2;
    const y = (vh - h * scale) / 2 - Math.min(28, vh * 0.03);
    el.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    el.dataset.start = el.style.transform;
    const m = mark.current!.getBoundingClientRect();
    glow.current!.style.left = `${m.left + (18.9 / 24) * m.width}px`;
    glow.current!.style.top = `${m.top + (4.2 / 24) * m.height}px`;
    status.current!.style.top = `${el.getBoundingClientRect().bottom + Math.max(18, 10 * scale)}px`;
  }, []);

  useEffect(() => {
    try {
      sessionStorage.setItem(SEEN_KEY, "seen");
    } catch {
      // the intro may play again next visit
    }
    const running: Animation[] = [];
    const play = (el: Element | null | undefined, frames: Keyframe[], o: KeyframeAnimationOptions) => {
      if (!el) return;
      running.push(el.animate(frames, { fill: "both", easing: EASE_OUT, ...o }));
    };
    const svg = mark.current!;
    const q = (sel: string) => [...svg.querySelectorAll(sel)];

    // 1. the stem rises from the ground to the fork
    play(svg.querySelector(".ointro-stem"), [{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { delay: T.stem, duration: 420 });

    // 2. at the fork, possible futures open outward, dot by dot; the one that will stay looks like the rest
    const rays = q(".ointro-ray").sort((a, b) => Number((a as SVGElement).dataset.rank) - Number((b as SVGElement).dataset.rank));
    rays.forEach((ray, i) => {
      [...ray.querySelectorAll("circle")].forEach((c, k) => {
        const peak = 0.78 - k * 0.12;
        play(c, [
          { opacity: 0, transform: "scale(0.2)" },
          { opacity: peak, transform: "scale(1.2)", offset: 0.4 },
          { opacity: peak * 0.62, transform: "scale(1)" },
        ], { delay: T.fan + i * 24 + Number((ray as SVGElement).dataset.lag) + k * 86, duration: 440 });
      });
    });

    // 3. every other future falls back into the fork; the one that stays sharpens into the mark
    q(".ointro-ray.is-ghost").forEach((ray, i) => {
      play(ray, [{ opacity: 1, transform: "scale(1)" }, { opacity: 0, transform: "scale(0.18)" }], {
        delay: T.collapse + (i % 4) * 22,
        duration: 480,
        easing: EASE_IN_OUT,
        fill: "forwards",
      });
    });
    q(".ointro-ray.is-maybe circle").forEach((c, k) =>
      play(c, [{ opacity: (0.78 - k * 0.12) * 0.62, transform: "scale(0.82)", fill: "var(--c-text-2)" }, { opacity: 1, transform: "scale(1)", fill: "var(--c-text)" }], {
        delay: T.collapse + 160 + k * 60,
        duration: 420,
        fill: "forwards",
      }),
    );

    // 4. the committed branch draws, and the dot lands like a confirmed block
    play(svg.querySelector(".ointro-commit"), [{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { delay: T.commit, duration: 380 });
    play(svg.querySelector(".ointro-dot"), [
      { transform: "scale(0)", opacity: 0 },
      { transform: "scale(1.35)", opacity: 1, offset: 0.55 },
      { transform: "scale(1)", opacity: 1 },
    ], { delay: T.land, duration: 420 });
    play(svg.querySelector(".ointro-ring"), [
      { transform: "scale(1)", opacity: 0.9, strokeWidth: 0.9 },
      { transform: "scale(3.4)", opacity: 0, strokeWidth: 0.2 },
    ], { delay: T.land + 60, duration: 900, easing: "cubic-bezier(0.1, 0.7, 0.3, 1)", fill: "forwards" });
    play(glow.current, [
      { opacity: 0, transform: "translate(-50%, -50%) scale(0.6)" },
      { opacity: 1, transform: "translate(-50%, -50%) scale(1)", offset: 0.35 },
      { opacity: 0.55, transform: "translate(-50%, -50%) scale(1.08)" },
    ], { delay: T.land, duration: 1300 });

    // 5. the name, then the chain it's reading
    const name = lockup.current!.querySelector(".wordmark");
    play(name, [{ clipPath: "inset(-30% 100% -30% 0)", transform: "translateX(-6px)" }, { clipPath: "inset(-30% 0% -30% 0)", transform: "translateX(0)" }], { delay: T.word, duration: 520 });
    play(status.current, [{ opacity: 0, transform: "translate(-50%, 4px)" }, { opacity: 1, transform: "translate(-50%, 0)" }], { delay: T.status, duration: 420 });

    // 6. hand over: the logo flies into the header and lands on its own copy there
    let leaving = false;
    const exit = (fast: boolean) => {
      if (leaving) return;
      leaving = true;
      for (const a of running) a.finish();
      callbacks.current.onExit();
      const el = lockup.current!;
      const header = document.querySelector<HTMLElement>("[data-site-logo]");
      const target = header?.querySelector("svg")?.getBoundingClientRect();
      const own = svg.getBoundingClientRect();
      const start = el.dataset.start ?? "";
      let end = start.replace(/scale\([^)]*\)/, "scale(1)");
      if (target && own.width) {
        // where the mark sits inside the lockup at its natural size
        const box = el.getBoundingClientRect();
        const scale = box.width / el.offsetWidth;
        const offX = (own.left - box.left) / scale;
        const offY = (own.top - box.top) / scale;
        end = `translate(${target.left - offX}px, ${target.top - offY}px) scale(1)`;
      }
      const headerWord = header?.querySelector(".wordmark");
      const wordHidden = !headerWord || getComputedStyle(headerWord).display === "none";
      const fly = el.animate([{ transform: start }, { transform: end }], { duration: fast ? 460 : 720, easing: EASE_IN_OUT, fill: "forwards" });
      if (wordHidden) name?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 260, fill: "forwards" });
      status.current?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, fill: "forwards" });
      glow.current?.animate([{ opacity: 0.55 }, { opacity: 0 }], { duration: 360, fill: "forwards" });
      backdrop.current?.animate([{ opacity: 1 }, { opacity: 0 }], { delay: fast ? 60 : 170, duration: fast ? 380 : 540, easing: "ease-out", fill: "forwards" });
      const done = () => callbacks.current.onDone();
      void fly.finished.then(done, done);
    };
    exitRef.current = exit;
    const timer = setTimeout(() => exit(false), T.exit);
    const skip = (e: KeyboardEvent) => {
      if (e.key === "Tab" || e.metaKey || e.ctrlKey) return;
      exit(true);
    };
    window.addEventListener("keydown", skip);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("keydown", skip);
      for (const a of running) a.cancel();
    };
  }, []);

  return (
    <div className="ointro" aria-hidden="true" onPointerDown={() => exitRef.current(true)}>
      <div className="ointro-backdrop" ref={backdrop} />
      <div className="ointro-glow" ref={glow} />
      <div className="ointro-lockup" ref={lockup}>
        <svg ref={mark} width={22} height={22} viewBox="0 0 24 24" fill="none" className="ointro-mark">
          {RAYS.map((r) => (
            <g key={r.angle} className={`ointro-ray ${r.maybe ? "is-maybe" : "is-ghost"}`} data-rank={r.rank} data-lag={r.lag} style={{ transformOrigin: `${FORK.x}px ${FORK.y}px` }}>
              {r.dist.map((d, k) => {
                const p = at(r.angle, d);
                // the dot that stays is drawn at the mark's own size and shown smaller until it's chosen
                return <circle key={d} cx={p.x} cy={p.y} r={r.maybe ? 1.1 : FAN_R[k]} style={{ transformOrigin: `${p.x}px ${p.y}px` }} />;
              })}
            </g>
          ))}
          <path className="ointro-stem" d="M12 21.5V13.2" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" pathLength={1} strokeDasharray="1 1" />
          <path className="ointro-commit" d="M12 13.2 18.6 4.6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" pathLength={1} strokeDasharray="1 1" />
          <circle className="ointro-ring" cx="18.9" cy="4.2" r="2.1" stroke="var(--c-accent)" style={{ transformOrigin: "18.9px 4.2px" }} />
          <circle className="ointro-dot" cx="18.9" cy="4.2" r="2.1" fill="var(--c-accent)" style={{ transformOrigin: "18.9px 4.2px" }} />
        </svg>
        <Wordmark />
      </div>
      <p className="ointro-status" ref={status}>
        <IntroStatus />
      </p>
    </div>
  );
}
