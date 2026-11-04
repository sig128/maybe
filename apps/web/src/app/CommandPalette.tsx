import { Command } from "cmdk";
import * as Dialog from "@radix-ui/react-dialog";
import { useNavigate } from "react-router";
import { TEMPLATES } from "@maybe/core";
import { useMarkets, useStrategies } from "../data/queries.ts";
import { useBackend } from "../data/BackendContext.tsx";
import { Icon, type IconName } from "../components/Icon.tsx";
import { Kbd } from "../components/ui.tsx";
import { NAV } from "./Shell.tsx";
import { toast } from "../components/Toast.tsx";

/**
 * ⌘K / "/" palette. Commands navigate or open forms; none of them moves
 * funds directly — money actions always land on a form with a preview.
 */
export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const navigate = useNavigate();
  const backend = useBackend();
  const { data: markets } = useMarkets();
  const { data: strategies } = useStrategies();
  const go = (to: string) => {
    onOpenChange(false);
    navigate(to);
  };
  const Item = ({ icon, label, hint, onSelect, value }: { icon: IconName; label: string; hint?: string; onSelect: () => void; value?: string }) => (
    <Command.Item className="cmd-item" onSelect={onSelect} value={value ?? label}>
      <Icon name={icon} size={16} style={{ color: "var(--c-text-2)", flex: "none" }} />
      <span className="grow truncate">{label}</span>
      {hint && <span className="t-small faint nowrap">{hint}</span>}
    </Command.Item>
  );
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className="dialog" style={{ padding: 0, gap: 0, top: "10vh" }} aria-describedby={undefined}>
          <Dialog.Title className="sr-only">Search and commands</Dialog.Title>
          <Command className="cmd" label="Search and commands" loop>
            <Command.Input className="cmd-input" placeholder="Search markets, futures and commands…" autoFocus />
            <Command.List className="cmd-list">
              <Command.Empty className="cmd-empty">No matches. Try a market keyword like “orbit”.</Command.Empty>
              <Command.Group heading="Go to" className="cmd-group">
                {NAV.map((n) => (
                  <Item key={n.to} icon={n.icon} label={n.label} hint={`g ${n.key}`} onSelect={() => go(n.to)} />
                ))}
                <Item icon="ops" label="Operations" onSelect={() => go("/ops")} />
                <Item icon="settings" label="Environment and capabilities" onSelect={() => go("/settings")} />
              </Command.Group>
              <Command.Group heading="Actions" className="cmd-group">
                <Item icon="plus" label="New future" hint="templates" onSelect={() => go("/futures/new")} />
                <Item icon="arrowDown" label="Deposit to vault" hint="opens form" onSelect={() => go("/money?action=deposit")} />
                <Item icon="arrowUp" label="Withdraw available funds" hint="opens form" onSelect={() => go("/money?action=withdraw")} />
                <Item icon="agents" label="Ask the Strategy Builder" onSelect={() => go("/agents?role=builder")} />
                {backend.sim && (
                  <Item
                    icon="time"
                    label="Simulation: move time forward 1 day"
                    onSelect={() => {
                      onOpenChange(false);
                      void backend.sim!.advance(86_400).then(() => toast({ title: "Simulated time +1 day" }));
                    }}
                  />
                )}
              </Command.Group>
              {!!strategies?.length && (
                <Command.Group heading="Your futures" className="cmd-group">
                  {strategies.slice(0, 12).map((s) => (
                    <Item key={s.id} icon="futures" label={s.title} value={`future ${s.title} ${s.id}`} hint={s.status.toLowerCase()} onSelect={() => go(`/futures/${s.id}`)} />
                  ))}
                </Command.Group>
              )}
              {!!markets?.length && (
                <Command.Group heading="Markets" className="cmd-group">
                  {markets.map((m) => (
                    <Item key={m.key} icon="discover" label={m.title} value={`market ${m.title} ${m.category}`} hint={m.quote ? `${(m.quote.yesBps / 100).toFixed(0)}% YES` : m.status} onSelect={() => go(`/discover?market=${m.key}`)} />
                  ))}
                </Command.Group>
              )}
              <Command.Group heading="Templates" className="cmd-group">
                {TEMPLATES.map((t) => (
                  <Item key={t.id} icon="branch" label={t.title} value={`template ${t.title}`} onSelect={() => go(`/futures/new?template=${t.id}`)} />
                ))}
              </Command.Group>
            </Command.List>
            <div className="row t-micro faint" style={{ padding: "8px 14px", borderTop: "1px solid var(--c-line)" }}>
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd> to move · <Kbd>↵</Kbd> to open · <Kbd>esc</Kbd> to close
            </div>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
