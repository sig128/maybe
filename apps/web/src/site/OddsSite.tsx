import { Logo } from "../components/Logo.tsx";
import { Toaster } from "../components/Toast.tsx";
import Odds, { StatusBar } from "../pages/odds/Odds.tsx";
import "./site.css";

export function OddsSite() {
  return (
    <div className="osite">
      <a className="skip-link" href="#board">
        Skip to the board
      </a>
      <header className="osite-top">
        <a className="osite-brand" href={import.meta.env.BASE_URL} aria-label="maybe Odds, reload the board">
          <Logo />
        </a>
        <span className="osite-title">Odds</span>
        {/* on wide screens the live status sits up here; narrow screens keep it on the board */}
        <div className="osite-status">
          <StatusBar />
        </div>
      </header>
      <main id="board" className="osite-main" tabIndex={-1}>
        <h1 className="sr-only">Live odds on pump.fun tokens</h1>
        <Odds />
      </main>
      <Toaster />
    </div>
  );
}
