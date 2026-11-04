import { useEffect, useState } from "react";
import { Logo } from "../components/Logo.tsx";
import { Toaster } from "../components/Toast.tsx";
import Odds, { BalanceButton, HowButton, StatusBar } from "../pages/odds/Odds.tsx";
import { Intro, shouldPlayIntro } from "./Intro.tsx";
import "./site.css";

export function OddsSite() {
  // the board starts loading at once; the intro plays over it and hands over to it
  const [intro, setIntro] = useState<"playing" | "leaving" | "done">(() => (shouldPlayIntro() ? "playing" : "done"));
  const [revealing, setRevealing] = useState(false);
  useEffect(() => {
    if (!revealing) return;
    const t = setTimeout(() => setRevealing(false), 1200);
    return () => clearTimeout(t);
  }, [revealing]);

  return (
    <div className={`osite${revealing ? " is-revealing" : ""}`} {...(intro !== "done" ? { "data-intro": intro } : {})}>
      <a className="skip-link" href="#board">
        Skip to the board
      </a>
      <header className="osite-top">
        <a className="osite-brand" data-site-logo href={import.meta.env.BASE_URL} aria-label="maybe Odds, reload the board">
          <Logo />
        </a>
        <span className="osite-title">Odds</span>
        {/* on wide screens the live status sits up here; narrow screens keep it on the board */}
        <div className="osite-status">
          <StatusBar />
        </div>
        <div className="osite-actions">
          <HowButton />
          <BalanceButton />
        </div>
      </header>
      <main id="board" className="osite-main" tabIndex={-1}>
        <h1 className="sr-only">Live odds on pump.fun tokens</h1>
        <Odds />
      </main>
      <Toaster />
      {intro !== "done" && (
        <Intro
          onExit={() => {
            setIntro("leaving");
            setRevealing(true);
          }}
          onDone={() => setIntro("done")}
        />
      )}
    </div>
  );
}
