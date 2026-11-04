import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { ROLE_INFO } from "@maybe/agent";
import { useBackend } from "../data/BackendContext.tsx";
import { useAgentSessions, useAssets, useFixturesOnce, useNow, usePolicies } from "../data/queries.ts";
import { Banner, Button, Empty, Pill } from "../components/ui.tsx";
import { Icon, type IconName } from "../components/Icon.tsx";
import { Modal } from "../components/Overlay.tsx";
import { Amount } from "../components/Amount.tsx";
import { toast } from "../components/Toast.tsx";
import { PageHead } from "../app/Shell.tsx";
import { relTime } from "../lib/time.ts";
import type { AgentRole, AgentSession, AgentStep } from "../data/types.ts";

const ROLES: AgentRole[] = ["builder", "researcher", "monitor", "executor"];
const SUGGEST: Record<AgentRole, string[]> = {
  builder: ["Reserve 500 USDC. Use 300 if A resolves YES, and 200 if B and C resolve YES. Expire after 30 days. Show me the plan before funding.", "Use 100 USDC to buy MAYBE if the orbit relaunch resolves YES. Otherwise return it."],
  researcher: ["orbit testnet relaunch", "treasury proposal", "harbor bridge"],
  monitor: ["What's waiting?"],
  executor: ["What can execute right now?", "Fund the latest draft with 200 USDC"],
};
const STEP_ICON: Record<AgentStep["kind"], IconName> = { message: "agents", tool: "settings", source: "external", draft: "futures", validation: "check", question: "info", refusal: "shield", receipt: "check" };

export function Agents() {
  const [params, setParams] = useSearchParams();
  const role = (params.get("role") as AgentRole) ?? "builder";
  const sessionId = params.get("session");
  const backend = useBackend();
  const { data: sessions } = useAgentSessions();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [permOpen, setPermOpen] = useState(false);
  const session = sessions?.find((s) => s.id === sessionId) ?? null;
  const roleSessions = (sessions ?? []).filter((s) => s.role === role);
  const send = async (msg: string) => {
    if (!msg.trim()) return;
    setBusy(true);
    try {
      const s = await backend.sendAgentMessage(session && session.role === role ? session.id : null, role, msg.trim());
      setText("");
      if (s.id !== sessionId) setParams({ role, session: s.id }, { replace: true });
    } catch (e) {
      toast({ title: "The agent couldn't respond", detail: (e as Error).message, tone: "error" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="page">
      <PageHead
        title="Agents"
        sub="Agents research, draft, watch and check. They never hold your wallet key, and they can't move money unless you grant a bounded, revocable policy."
        actions={
          <Button icon="shield" onClick={() => setPermOpen(true)}>
            Permissions
          </Button>
        }
      />
      <div className="segmented" role="tablist" aria-label="Agent">
        {ROLES.map((r) => (
          <button key={r} role="tab" aria-selected={role === r} onClick={() => setParams({ role: r }, { replace: true })}>
            {ROLE_INFO[r].name}
          </button>
        ))}
      </div>
      <p className="muted">{ROLE_INFO[role].job}</p>
      <Banner tone="info">Local assistant — deterministic and rule-based, not an AI model. It uses the same compiler, validator and simulator as everything else. A model provider can be configured on the server.</Banner>
      <div className="split">
        <section className="stack" aria-label="Conversation">
          {session && session.role === role ? (
            <Conversation session={session} onAnswer={(v) => void send(v)} busy={busy} />
          ) : (
            <Empty title={`Ask the ${ROLE_INFO[role].name}`}>
              <div className="stack">
                {SUGGEST[role].map((s) => (
                  <button key={s} className="btn btn-outline" style={{ height: "auto", minHeight: 38, padding: "8px 14px", whiteSpace: "normal", textAlign: "left", justifyContent: "flex-start" }} onClick={() => void send(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </Empty>
          )}
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              void send(text);
            }}
          >
            <label className="grow">
              <span className="sr-only">Message</span>
              <input className="input" style={{ height: 46 }} value={text} onChange={(e) => setText(e.target.value)} placeholder={role === "builder" ? "Describe what your money should do…" : "Ask…"} />
            </label>
            <Button variant="primary" type="submit" disabledReason={busy ? "Working…" : !text.trim() ? "Type a message" : null}>
              Send
            </Button>
          </form>
        </section>
        <aside className="stack" aria-label="Sessions">
          <div className="row">
            <h3 className="t-head grow">Sessions</h3>
            <Button size="sm" variant="ghost" icon="plus" onClick={() => setParams({ role }, { replace: true })}>
              New
            </Button>
          </div>
          {roleSessions.length === 0 ? (
            <p className="muted t-small">No sessions yet.</p>
          ) : (
            <div className="panel panel-flush">
              <div className="list">
                {roleSessions.map((s) => (
                  <button key={s.id} className="list-item" aria-current={s.id === sessionId || undefined} onClick={() => setParams({ role, session: s.id }, { replace: true })}>
                    <span className="grow stack-tight" style={{ minWidth: 0 }}>
                      <span className="truncate">{s.title}</span>
                      <span className="t-micro faint">
                        {s.steps.length} steps · {s.provider.startsWith("Local") ? "local" : s.provider}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </aside>
      </div>
      <PermissionsDialog open={permOpen} onOpenChange={setPermOpen} />
    </div>
  );
}

function Conversation({ session, onAnswer, busy }: { session: AgentSession; onAnswer: (v: string) => void; busy: boolean }) {
  const end = useRef<HTMLDivElement>(null);
  const now = useNow(30_000);
  useEffect(() => end.current?.scrollIntoView({ block: "end" }), [session.steps.length]);
  const lastQuestion = [...session.steps].reverse().find((s) => s.kind === "question" || s.role === "user");
  return (
    <div className="chat panel" aria-live="polite">
      {session.steps.map((st) => {
        if (st.role === "user")
          return (
            <div key={st.id} className="bubble bubble-user">
              {st.text.replace(/(map|act|rem):\S+/g, (m) => `“${m.split("=").pop()}”`)}
            </div>
          );
        if (st.kind === "message")
          return (
            <div key={st.id} className="bubble bubble-agent">
              {st.text}
            </div>
          );
        if (st.kind === "source")
          return (
            <div key={st.id} className="stack-tight">
              <span className="trail-item">
                <Icon name="external" size={14} /> Source (untrusted external text): {st.text}
              </span>
              <blockquote className="untrusted">{st.detail}</blockquote>
            </div>
          );
        if (st.kind === "question") {
          const opts = ((st.data as { options?: Array<{ label: string; value: string }> })?.options ?? []).slice(0, 8);
          const active = lastQuestion === st || session.steps.indexOf(st) > session.steps.indexOf(lastQuestion as AgentStep);
          return (
            <div key={st.id} className="stack">
              <div className="bubble bubble-agent strong">{st.text}</div>
              <div className="chips">
                {opts.map((o) => (
                  <button key={o.value} className="chip" disabled={busy || !active} onClick={() => onAnswer(o.value)}>
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
          );
        }
        if (st.kind === "draft") {
          const id = (st.data as { id?: string })?.id;
          return (
            <div key={st.id} className="panel panel-raised row row-wrap">
              <Icon name="futures" />
              <span className="grow strong">Draft: {st.text}</span>
              <Link className="btn btn-sm" to={`/futures/${id}/edit`}>
                Open in builder
              </Link>
              <Link className="btn btn-sm btn-primary" to={`/futures/${id}/review`}>
                Review
              </Link>
            </div>
          );
        }
        if (st.kind === "refusal")
          return (
            <div key={st.id} className="banner banner-warn">
              <Icon name="shield" size={16} />
              <span>{st.text}</span>
            </div>
          );
        return (
          <span key={st.id} className="trail-item">
            <Icon name={STEP_ICON[st.kind]} size={14} style={{ marginTop: 2 }} />
            <span>
              {st.text}
              {st.kind === "validation" && Array.isArray(st.data) && (st.data as Array<{ severity: string; message: string }>).filter((i) => i.severity === "error").length > 0 && (
                <ul className="t-small">
                  {(st.data as Array<{ severity: string; message: string }>)
                    .filter((i) => i.severity === "error")
                    .map((i, k) => (
                      <li key={k}>{i.message}</li>
                    ))}
                </ul>
              )}
            </span>
          </span>
        );
      })}
      <div ref={end} />
      <span className="t-micro faint">
        {session.provider} · started {relTime(session.createdAt, now)} · cost ${session.costUsd.toFixed(2)}
      </span>
    </div>
  );
}

function PermissionsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const backend = useBackend();
  const { data: policies } = usePolicies();
  const fx = useFixturesOnce();
  const { data: assets } = useAssets();
  const [label, setLabel] = useState("Strategy Builder budget");
  const [total, setTotal] = useState("300");
  const [per, setPer] = useState("150");
  const [days, setDays] = useState("14");
  const usdc = assets?.find((a) => a.symbol === "USDC");
  const create = async () => {
    if (!fx || !usdc) return;
    try {
      const t = BigInt(Math.round(Number(total) * 1e6));
      const p = BigInt(Math.round(Number(per) * 1e6));
      await backend.createPolicy({
        label,
        canCreate: true,
        canCancel: false,
        allowedMints: [usdc.mint, fx.assetByKey.MAYBE!.mint, fx.assetByKey.LUMEN!.mint, fx.assetByKey.FERN!.mint],
        allowedRoutes: [fx.poolByKey["USDC-MAYBE"]!.address, fx.poolByKey["USDC-LUMEN"]!.address, fx.poolByKey["USDC-FERN"]!.address],
        allowedRecipients: [],
        maxTotal: { [usdc.mint]: t },
        maxPerAction: { [usdc.mint]: p },
        maxFeeBps: 30,
        expiresAt: backend.now() + Number(days) * 86_400,
      });
      toast({ title: "Policy granted", detail: "The agent session key can now fund drafts within these limits.", tone: "ok" });
    } catch (e) {
      toast({ title: "Couldn't create the policy", detail: (e as Error).message, tone: "error" });
    }
  };
  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Agent permissions" description="Draft-and-confirm is the default. A policy lets an agent session key fund drafts inside hard limits the vault program enforces.">
      <ul className="stack">
        {(policies ?? []).length === 0 && <li className="muted t-small">No policies. Agents can only draft.</li>}
        {(policies ?? []).map((p) => (
          <li key={p.address} className="panel panel-raised">
            <div className="row">
              <strong className="grow">{p.label}</strong>
              <Pill tone={p.revoked ? "quiet" : "live"} icon={p.revoked ? "close" : "shield"}>
                {p.revoked ? "Revoked" : "Active"}
              </Pill>
            </div>
            <div className="t-small muted stack-tight">
              {Object.entries(p.maxTotal).map(([m, v]) => (
                <span key={m}>
                  Total cap <Amount units={v} mint={m} /> · used <Amount units={p.spent[m] ?? 0n} mint={m} />
                </span>
              ))}
              {Object.entries(p.maxPerAction).map(([m, v]) => (
                <span key={m}>
                  Per step <Amount units={v} mint={m} /> · fee ≤ {(p.maxFeeBps / 100).toFixed(2)}% · {p.allowedRoutes.length} routes · no withdrawals
                </span>
              ))}
            </div>
            {!p.revoked && (
              <Button size="sm" variant="danger" onClick={() => void backend.revokePolicy(p.address)}>
                Revoke
              </Button>
            )}
          </li>
        ))}
      </ul>
      <div className="panel panel-outline">
        <strong>Grant a policy</strong>
        <div className="grid-2">
          <label className="field">
            <span className="label">Name</span>
            <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} />
          </label>
          <label className="field">
            <span className="label">Expires in (days)</span>
            <input className="input" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value.replace(/\D/g, ""))} />
          </label>
          <label className="field">
            <span className="label">Total cap (USDC)</span>
            <input className="input num" inputMode="decimal" value={total} onChange={(e) => setTotal(e.target.value)} />
          </label>
          <label className="field">
            <span className="label">Per step (USDC)</span>
            <input className="input num" inputMode="decimal" value={per} onChange={(e) => setPer(e.target.value)} />
          </label>
        </div>
        <p className="t-small muted">Allowed: USDC, MAYBE, Lumen, Fern via their local pools. No recipients, no withdrawals, can't raise its own limits.</p>
        <Button variant="primary" size="sm" onClick={() => void create()} disabledReason={!Number(total) || !Number(per) ? "Enter caps" : Number(per) > Number(total) ? "Per-step cap can't exceed the total" : null}>
          Grant
        </Button>
      </div>
      <div className="row">
        <span className="grow t-small muted">Kill switch voids every policy at once. Withdrawals and refunds keep working.</span>
        <Button variant="danger" icon="power" onClick={() => void backend.killSwitch().then(() => toast({ title: "All agent authority revoked", tone: "ok" }))}>
          Kill switch
        </Button>
      </div>
    </Modal>
  );
}
