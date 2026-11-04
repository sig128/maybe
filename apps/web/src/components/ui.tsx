import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { Icon, type IconName } from "./Icon.tsx";

type Variant = "primary" | "secondary" | "ghost" | "outline" | "danger";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: "sm" | "md" | "lg";
  icon?: IconName;
  iconRight?: IconName;
  block?: boolean;
  /** When set, the button is disabled and the reason is announced and shown on hover/focus. */
  disabledReason?: string | null;
  iconOnly?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", icon, iconRight, block, disabledReason, iconOnly, className, children, onClick, ...rest },
  ref,
) {
  const cls = ["btn", variant !== "secondary" && `btn-${variant}`, size !== "md" && `btn-${size}`, block && "btn-block", iconOnly && "btn-icon", className].filter(Boolean).join(" ");
  const disabled = !!disabledReason;
  const btn = (
    <button
      ref={ref}
      className={cls}
      aria-disabled={disabled || undefined}
      onClick={(e) => {
        if (disabled) {
          e.preventDefault();
          return;
        }
        onClick?.(e);
      }}
      {...rest}
      {...(disabled ? { "aria-describedby": undefined } : {})}
    >
      {icon && <Icon name={icon} size={size === "sm" ? 16 : 18} />}
      {children}
      {disabled && <span className="sr-only">. Unavailable: {disabledReason}</span>}
      {iconRight && <Icon name={iconRight} size={size === "sm" ? 16 : 18} />}
    </button>
  );
  if (!disabled) return btn;
  return <Tip content={disabledReason}>{btn}</Tip>;
});

export function Tip({ content, children, side = "top" }: { content: ReactNode; children: ReactNode; side?: "top" | "bottom" | "left" | "right" }) {
  if (!content) return <>{children}</>;
  return (
    <Tooltip.Root delayDuration={250}>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tip" side={side} sideOffset={6} collisionPadding={12}>
          {content}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

export type Tone = "live" | "pending" | "error" | "quiet" | "neutral" | "solid";

export function Pill({ tone = "neutral", icon, children, title }: { tone?: Tone; icon?: IconName; children: ReactNode; title?: string }) {
  return (
    <span className={`pill ${tone !== "neutral" ? `pill-${tone}` : ""}`} title={title}>
      {icon && <Icon name={icon} size={13} />}
      {children}
    </span>
  );
}

export function Outcome({ value }: { value: "YES" | "NO" | "VOID" | string }) {
  return <span className="outcome">{value === "VOID" ? "VOID" : value}</span>;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

export function Banner({ tone = "info", icon, children, action }: { tone?: "info" | "warn" | "error"; icon?: IconName; children: ReactNode; action?: ReactNode }) {
  return (
    <div className={`banner banner-${tone}`} role={tone === "error" ? "alert" : "status"}>
      <Icon name={icon ?? (tone === "info" ? "info" : "alert")} size={16} />
      <div className="grow">{children}</div>
      {action}
    </div>
  );
}

export function Empty({ title, children, action, center }: { title: string; children?: ReactNode; action?: ReactNode; center?: boolean }) {
  return (
    <div className={`empty ${center ? "empty-center" : ""}`}>
      <p className="t-head">{title}</p>
      {children && <div className="muted measure">{children}</div>}
      {action}
    </div>
  );
}

export function LoadingBlock({ label = "Loading", lines = 3 }: { label?: string; lines?: number }) {
  return (
    <div className="stack" role="status" aria-live="polite">
      <span className="sr-only">{label}…</span>
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="skeleton" style={{ height: i === 0 ? 22 : 14, width: `${[46, 88, 72, 64][i % 4]}%` }} />
      ))}
    </div>
  );
}

export function ErrorBlock({ error, retry }: { error: unknown; retry?: () => void }) {
  return (
    <Banner tone="error" action={retry && <Button size="sm" onClick={retry} icon="refresh">Try again</Button>}>
      <strong>Couldn't load this.</strong> {error instanceof Error ? error.message : String(error)}
    </Banner>
  );
}

export function SampleTag() {
  return (
    <Pill tone="quiet" title="Deterministic sample data — not real activity">
      Sample
    </Pill>
  );
}

export function KV({ items }: { items: Array<[ReactNode, ReactNode]> }) {
  return (
    <dl className="kv">
      {items.map(([k, v], i) => (
        <div key={i} style={{ display: "contents" }}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}
