import { memo, useMemo, useState } from "react";
import { Link } from "react-router";
import { useActivity, useNow } from "../data/queries.ts";
import { Amount } from "../components/Amount.tsx";
import { Empty, ErrorBlock, LoadingBlock, Pill, SampleTag } from "../components/ui.tsx";
import { Icon, type IconName } from "../components/Icon.tsx";
import { PageHead } from "../app/Shell.tsx";
import { TX_STATUS } from "../lib/status.ts";
import { fmtDateTime, relTime } from "../lib/time.ts";
import type { ActivityItem } from "../data/types.ts";

const ICON: Record<ActivityItem["kind"], IconName> = {
  deposit: "arrowDown",
  withdraw: "arrowUp",
  authorize: "check",
  activate: "lock",
  execute: "swap",
  release: "branch",
  refund: "refresh",
  cancel: "close",
  pause: "pause",
  event: "info",
  agent: "agents",
  policy: "shield",
  room: "rooms",
  failure: "alert",
  system: "settings",
};

const ACTOR: Record<ActivityItem["actor"], string> = { you: "You", keeper: "Keeper", agent: "Agent", attestor: "Attestors", system: "System" };

export const ActivityRow = memo(function ActivityRow({ item, now }: { item: ActivityItem; now: number }) {
  const tx = item.tx ? TX_STATUS[item.tx.state] : null;
  return (
    <div className="list-item" style={{ alignItems: "flex-start" }}>
      <Icon name={ICON[item.kind]} style={{ marginTop: 2, color: item.kind === "failure" ? "var(--c-red)" : "var(--c-text-2)", flex: "none" }} />
      <div className="grow stack-tight" style={{ minWidth: 0 }}>
        <div className="row-tight" style={{ flexWrap: "wrap" }}>
          {item.strategyId ? (
            <Link to={`/futures/${item.strategyId}`} className="strong">
              {item.title}
            </Link>
          ) : item.marketKey ? (
            <Link to={`/discover?market=${item.marketKey}`} className="strong">
              {item.title}
            </Link>
          ) : (
            <span className="strong">{item.title}</span>
          )}
          {item.sample && <SampleTag />}
        </div>
        {item.detail && <span className="t-small muted">{item.detail}</span>}
        {item.amounts && item.amounts.length > 0 && (
          <span className="row-tight t-small" style={{ flexWrap: "wrap" }}>
            {item.amounts.map((a, i) => (
              <span key={i} className={a.dir === "in" ? "" : "muted"}>
                {a.dir === "in" ? "+" : a.dir === "out" ? "−" : "↔ "}
                <Amount units={a.units} mint={a.mint} />
              </span>
            ))}
          </span>
        )}
        {item.tx && (
          <span className="row-tight t-micro faint">
            <span className="mono" title={item.tx.signature}>
              {item.tx.signature.slice(0, 10)}…
            </span>
            {item.tx.simulated && <span>simulated</span>}
          </span>
        )}
      </div>
      <div className="stack-tight" style={{ alignItems: "flex-end", flex: "none" }}>
        <span className="t-small muted nowrap" title={fmtDateTime(item.at)}>
          {relTime(item.at, now)}
        </span>
        <span className="t-micro faint">{ACTOR[item.actor]}</span>
        {tx && (
          <Pill tone={tx.tone} icon={tx.icon}>
            {tx.label}
          </Pill>
        )}
      </div>
    </div>
  );
});

export function Activity() {
  const q = useActivity();
  const now = useNow(10_000);
  const [kind, setKind] = useState<"all" | "money" | "steps" | "events" | "agents">("all");
  const items = useMemo(() => {
    const all = q.data ?? [];
    const groups: Record<string, ActivityItem["kind"][]> = {
      money: ["deposit", "withdraw", "refund", "release", "cancel"],
      steps: ["activate", "execute", "release", "failure", "pause"],
      events: ["event"],
      agents: ["agent", "policy"],
    };
    return kind === "all" ? all : all.filter((a) => groups[kind]!.includes(a.kind));
  }, [q.data, kind]);
  return (
    <div className="page">
      <PageHead title="Activity" sub="Every change to your money and futures, with who did it and how far each transaction got." />
      <div className="segmented" role="group" aria-label="Filter activity">
        {(
          [
            ["all", "All"],
            ["money", "Money"],
            ["steps", "Steps"],
            ["events", "Outcomes"],
            ["agents", "Agents"],
          ] as const
        ).map(([k, l]) => (
          <button key={k} aria-pressed={kind === k} onClick={() => setKind(k)}>
            {l}
          </button>
        ))}
      </div>
      {q.isLoading ? (
        <LoadingBlock />
      ) : q.error ? (
        <ErrorBlock error={q.error} />
      ) : items.length === 0 ? (
        <Empty title="Nothing here yet">Deposits, authorizations, executions and outcomes will appear here.</Empty>
      ) : (
        <div className="panel panel-flush">
          <div className="list">
            {items.map((a) => (
              <ActivityRow key={a.id} item={a} now={now} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
