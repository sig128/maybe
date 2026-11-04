import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { NavLink, Outlet, useLocation, useNavigate, useSearchParams } from "react-router";
import * as Popover from "@radix-ui/react-popover";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Icon, type IconName } from "../components/Icon.tsx";
import { Logo, Mark } from "../components/Logo.tsx";
import { Button, Kbd, Pill, Tip } from "../components/ui.tsx";
import { Drawer } from "../components/Overlay.tsx";
import { Toaster, toast } from "../components/Toast.tsx";
import { CommandPalette } from "./CommandPalette.tsx";
import { MarketPanel } from "../pages/MarketPanel.tsx";
import { useBackend } from "../data/BackendContext.tsx";
import { useEnvironment, useMarket, useNow, useStrategies, useWallet } from "../data/queries.ts";
import { Amount } from "../components/Amount.tsx";
import { fmtDateTime } from "../lib/time.ts";

interface NavDef {
  to: string;
  label: string;
  icon: IconName;
  key: string;
  mobile?: boolean;
}

export const NAV: NavDef[] = [
  { to: "/", label: "Overview", icon: "overview", key: "o", mobile: true },
  { to: "/discover", label: "Discover", icon: "discover", key: "d", mobile: true },
  { to: "/futures", label: "Futures", icon: "futures", key: "f", mobile: true },
  { to: "/money", label: "Money", icon: "money", key: "m", mobile: true },
  { to: "/agents", label: "Agents", icon: "agents", key: "a" },
  { to: "/rooms", label: "Rooms", icon: "rooms", key: "r" },
  { to: "/activity", label: "Activity", icon: "activity", key: "y" },
];

const SECONDARY: NavDef[] = [
  { to: "/ops", label: "Operations", icon: "ops", key: "p" },
  { to: "/settings", label: "Environment", icon: "settings", key: "e" },
];

const TITLES: Array<[RegExp, string]> = [
  [/^\/$/, "Overview"],
  [/^\/discover/, "Discover"],
  [/^\/markets\//, "Market"],
  [/^\/futures\/[^/]+\/review/, "Review & authorize"],
  [/^\/futures\/[^/]+\/edit/, "Future builder"],
  [/^\/futures\/new/, "New future"],
  [/^\/futures\/[^/]+/, "Future"],
  [/^\/futures/, "Futures"],
  [/^\/money/, "Money"],
  [/^\/agents/, "Agents"],
  [/^\/rooms\//, "Future Room"],
  [/^\/rooms/, "Future Rooms"],
  [/^\/activity/, "Activity"],
  [/^\/ops/, "Operations"],
  [/^\/settings/, "Environment"],
];

function isActive(path: string, to: string) {
  return to === "/" ? path === "/" : path === to || path.startsWith(`${to}/`) || (to === "/discover" && path.startsWith("/markets/"));
}

function useGlobalShortcuts(openPalette: () => void) {
  const navigate = useNavigate();
  const pending = useRef<number | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        openPalette();
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "/") {
        e.preventDefault();
        openPalette();
        return;
      }
      // "g" then a letter navigates. Navigation never moves funds.
      if (pending.current !== null) {
        const def = [...NAV, ...SECONDARY].find((n) => n.key === e.key.toLowerCase());
        window.clearTimeout(pending.current);
        pending.current = null;
        if (def) {
          e.preventDefault();
          navigate(def.to);
        }
        return;
      }
      if (e.key === "g") pending.current = window.setTimeout(() => (pending.current = null), 900);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate, openPalette]);
}

export function Shell() {
  const { pathname } = useLocation();
  const [params, setParams] = useSearchParams();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const { data: strategies } = useStrategies();
  useGlobalShortcuts(() => setPaletteOpen(true));
  const title = TITLES.find(([re]) => re.test(pathname))?.[1] ?? "MAYBE";
  const marketKey = params.get("market") ?? undefined;
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    document.title = `${title} · maybe`;
  }, [title]);
  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
  }, [pathname]);
  const activeCount = useMemo(() => (strategies ?? []).filter((s) => s.status === "ACTIVE" || s.status === "PAUSED").length, [strategies]);
  const attention = useMemo(() => (strategies ?? []).filter((s) => s.status === "INVALID" || s.status === "ACTIVATION_FAILED" || !!s.lastError).length, [strategies]);

  const closeMarket = () => {
    const next = new URLSearchParams(params);
    next.delete("market");
    setParams(next, { replace: false });
  };

  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <nav className="nav" aria-label="Primary">
        <NavLink to="/" className="nav-brand" aria-label="maybe — overview">
          <Logo />
        </NavLink>
        <div className="nav-group">
          {NAV.map((n) => (
            <NavItem key={n.to} def={n} active={isActive(pathname, n.to)} count={n.to === "/futures" ? activeCount : undefined} alert={n.to === "/futures" && attention > 0} />
          ))}
        </div>
        <div className="nav-group">
          {SECONDARY.map((n) => (
            <NavItem key={n.to} def={n} active={isActive(pathname, n.to)} />
          ))}
        </div>
        <div className="nav-foot">
          <button className="nav-item" onClick={() => setPaletteOpen(true)} aria-label="Search and commands">
            <Icon name="search" />
            <span className="nav-label grow" style={{ textAlign: "left" }}>
              Search
            </span>
            <span className="nav-count nav-foot-text">
              <Kbd>⌘K</Kbd>
            </span>
          </button>
        </div>
      </nav>

      <div className="main">
        <header className="topbar">
          <span className="only-mobile" style={{ color: "var(--c-text)", display: "inline-flex" }}>
            <Mark size={22} />
          </span>
          <div className="topbar-title">
            <h1 className="t-head truncate">{title}</h1>
          </div>
          <div className="topbar-spacer" />
          <ModeBadge />
          <Button variant="ghost" size="sm" iconOnly icon="search" aria-label="Search and commands" onClick={() => setPaletteOpen(true)} className="only-mobile" />
          <button className="btn btn-outline btn-sm hide-mobile" style={{ minWidth: 200, justifyContent: "flex-start", color: "var(--c-text-2)" }} onClick={() => setPaletteOpen(true)}>
            <Icon name="search" size={16} />
            <span className="grow" style={{ textAlign: "left" }}>
              Search markets, futures…
            </span>
            <Kbd>/</Kbd>
          </button>
          <WalletButton />
        </header>
        <div className="workspace">
          <main id="main" className="content" ref={contentRef} tabIndex={-1}>
            <Outlet />
          </main>
        </div>
      </div>

      <nav className="mobile-nav" aria-label="Primary">
        {NAV.filter((n) => n.mobile).map((n) => (
          <NavLink key={n.to} to={n.to} aria-current={isActive(pathname, n.to) ? "page" : undefined}>
            <Icon name={n.icon} size={20} />
            {n.label}
          </NavLink>
        ))}
        <button onClick={() => setMoreOpen(true)} aria-haspopup="dialog" aria-expanded={moreOpen}>
          <Icon name="more" size={20} />
          More
        </button>
      </nav>

      <Drawer open={moreOpen} onOpenChange={setMoreOpen} title="More">
        <div className="list panel panel-flush">
          {[...NAV.filter((n) => !n.mobile), ...SECONDARY].map((n) => (
            <NavLink key={n.to} to={n.to} className="list-item" onClick={() => setMoreOpen(false)} aria-current={isActive(pathname, n.to) ? "page" : undefined}>
              <Icon name={n.icon} />
              <span className="grow">{n.label}</span>
              <Icon name="chevronRight" size={16} />
            </NavLink>
          ))}
        </div>
      </Drawer>

      <MarketInspector marketKey={marketKey} onClose={closeMarket} />
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <Toaster />
    </div>
  );
}

function NavItem({ def, active, count, alert }: { def: NavDef; active: boolean; count?: number; alert?: boolean }) {
  const link = (
    <NavLink to={def.to} className="nav-item" aria-current={active ? "page" : undefined} aria-label={def.label}>
      <Icon name={def.icon} />
      <span className="nav-label">{def.label}</span>
      {alert ? (
        <span className="nav-count" aria-label="needs attention">
          <Icon name="alert" size={14} style={{ color: "var(--c-amber)" }} />
        </span>
      ) : count ? (
        <span className="nav-count t-micro num muted">{count}</span>
      ) : null}
    </NavLink>
  );
  return (
    <Tip content={<span>{def.label} <Kbd>g</Kbd> <Kbd>{def.key}</Kbd></span>} side="right">
      {link}
    </Tip>
  );
}

function MarketInspector({ marketKey, onClose }: { marketKey?: string; onClose: () => void }) {
  const { data } = useMarket(marketKey);
  return (
    <Drawer open={!!marketKey} onOpenChange={(o) => !o && onClose()} title={data?.title ?? "Market"} subtitle={data ? `${data.venue === "maybe-local" ? "MAYBE local settlement" : data.venue === "solana" ? "Solana on-chain" : data.venue} · ${data.category}` : undefined}>
      {marketKey && <MarketPanel marketKey={marketKey} compact />}
    </Drawer>
  );
}

export function ModeBadge() {
  const { data: env } = useEnvironment();
  const backend = useBackend();
  const now = useNow(5000);
  if (!env) return null;
  const sim = backend.sim;
  const badge = (
    <span className="pill pill-quiet" style={{ height: 26, borderRadius: 7, boxShadow: "inset 0 0 0 1px var(--c-line-3)", color: "var(--c-text)" }}>
      <Icon name={env.executionLive ? "dot" : "info"} size={13} style={{ color: env.executionLive ? "var(--c-accent)" : "var(--c-amber)" }} />
      {env.label}
      {sim && sim.clockOffset() !== 0 && <span className="muted hide-mobile">· +{Math.round(sim.clockOffset() / 3600)}h</span>}
    </span>
  );
  if (!sim && !backend.dev) return <Tip content={`${env.description} Network: ${env.network}.`}>{badge}</Tip>;
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button aria-label={`${env.label} environment and controls`}>{badge}</button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="pop pop-pad" sideOffset={8} align="end" style={{ width: 340 }}>
          {sim ? <SimControls now={now} /> : <DevControls description={env.description} network={env.network} />}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function DevControls({ description, network }: { description: string; network: string }) {
  const backend = useBackend();
  const dev = backend.dev!;
  const [paused, setPausedState] = useState(false);
  const toggle = async (on: boolean) => {
    setPausedState(on);
    try {
      await dev.setExecutionPaused(on);
      toast({ title: on ? "Emergency pause on" : "Emergency pause lifted", tone: "ok" });
    } catch (e) {
      setPausedState(!on);
      toast({ title: "Couldn't do that", detail: (e as Error).message, tone: "error" });
    }
  };
  return (
    <div className="stack">
      <div className="stack-tight">
        <strong>{dev.label}</strong>
        <p className="t-small muted">{description}</p>
        <p className="t-small muted">Network: {network}. Development keys sign outcomes here; they exist only on this machine and the server refuses them anywhere else.</p>
      </div>
      <label className="row t-small" style={{ justifyContent: "space-between" }}>
        <span>Emergency pause (new steps only)</span>
        <input type="checkbox" checked={paused} onChange={(e) => void toggle(e.target.checked)} />
      </label>
      <p className="hint">Resolve events from any market's detail panel.</p>
    </div>
  );
}

function SimControls({ now }: { now: number }) {
  const backend = useBackend();
  const sim = backend.sim!;
  const [fail, setFail] = useState(sim.failNext());
  const [paused, setPausedState] = useState(sim.executionPaused());
  const run = async (f: () => Promise<void>, msg?: string) => {
    try {
      await f();
      if (msg) toast({ title: msg, tone: "ok" });
    } catch (e) {
      toast({ title: "Couldn't do that", detail: (e as Error).message, tone: "error" });
    }
  };
  return (
    <div className="stack">
      <div className="stack-tight">
        <strong>Simulation</strong>
        <p className="t-small muted">Runs the real strategy engine in this browser on sample data. No chain, no real funds. Simulated time: {fmtDateTime(now)}.</p>
      </div>
      <div className="stack-tight">
        <span className="label">Move time forward</span>
        <div className="chips">
          {[
            ["+15m", 900],
            ["+1h", 3600],
            ["+1d", 86_400],
            ["+7d", 7 * 86_400],
          ].map(([l, s]) => (
            <button key={l} className="chip" onClick={() => run(() => sim.advance(s as number))}>
              {l}
            </button>
          ))}
        </div>
      </div>
      <label className="row t-small" style={{ justifyContent: "space-between" }}>
        <span>Make the next transaction fail</span>
        <input type="checkbox" checked={fail} onChange={(e) => (setFail(e.target.checked), run(() => sim.setFailNext(e.target.checked)))} />
      </label>
      <label className="row t-small" style={{ justifyContent: "space-between" }}>
        <span>Emergency pause (new steps only)</span>
        <input type="checkbox" checked={paused} onChange={(e) => (setPausedState(e.target.checked), run(() => sim.setExecutionPaused(e.target.checked)))} />
      </label>
      <p className="hint">Resolve events from any market's detail panel.</p>
      <hr className="divider" />
      <Button size="sm" variant="danger" onClick={() => run(() => sim.reset(), "Simulation reset")}>
        Reset simulation
      </Button>
    </div>
  );
}

function WalletButton() {
  const backend = useBackend();
  const { data: w } = useWallet();
  const navigate = useNavigate();
  if (!w) return <span className="skeleton" style={{ width: 120, height: 34 }} />;
  if (w.status !== "connected")
    return (
      <Button variant="primary" size="sm" icon="wallet" onClick={() => void backend.connectWallet()}>
        Connect
      </Button>
    );
  const usdc = Object.entries(w.balances)[0];
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button className="btn btn-sm" aria-label="Wallet">
          <Icon name="wallet" size={16} />
          <span className="mono hide-mobile">{w.address ? `${w.address.slice(0, 4)}…${w.address.slice(-4)}` : ""}</span>
          {usdc && (
            <span className="hide-mobile muted">
              <Amount units={usdc[1]} mint={usdc[0]} />
            </span>
          )}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="pop" sideOffset={8} align="end">
          <div className="pop-pad stack-tight" style={{ paddingBottom: 6 }}>
            <strong>{w.label}</strong>
            <span className="t-small muted">{w.kind === "simulated" ? "No keys exist; signatures are simulated." : w.kind === "dev-keypair" ? "Local-validator keypair stored in this browser. Never use it with real funds." : "Browser wallet"}</span>
          </div>
          <DropdownMenu.Item className="menu-item" onSelect={() => navigate("/money")}>
            <Icon name="money" size={16} /> Balances and transfers
          </DropdownMenu.Item>
          <DropdownMenu.Item className="menu-item" onSelect={() => w.address && void navigator.clipboard?.writeText(w.address).then(() => toast({ title: "Address copied" }))}>
            <Icon name="copy" size={16} /> Copy address
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="divider" style={{ margin: "6px 0" }} />
          <DropdownMenu.Item className="menu-item" onSelect={() => void backend.disconnectWallet()}>
            <Icon name="power" size={16} /> Disconnect
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** Top-level pages are named by the location bar (h1); the page leads with one plain sentence and its actions. */
export function PageHead({ title, sub, actions }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head" style={{ alignItems: "center" }}>
      <div className="stack-tight">
        <h2 className="sr-only">{title}</h2>
        {sub && <p className="t-read measure" style={{ color: "var(--c-text-2)" }}>{sub}</p>}
      </div>
      {actions && <div className="row row-wrap">{actions}</div>}
    </div>
  );
}

export { Pill };
