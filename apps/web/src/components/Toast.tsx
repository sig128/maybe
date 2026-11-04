import { create } from "zustand";
import { Icon } from "./Icon.tsx";

export interface ToastItem {
  id: number;
  title: string;
  detail?: string;
  tone?: "info" | "ok" | "error";
}

interface ToastStore {
  items: ToastItem[];
  push(t: Omit<ToastItem, "id">): void;
  dismiss(id: number): void;
}

let seq = 0;
export const useToasts = create<ToastStore>((set, get) => ({
  items: [],
  push: (t) => {
    const id = ++seq;
    set({ items: [...get().items.slice(-3), { ...t, id }] });
    setTimeout(() => get().dismiss(id), t.tone === "error" ? 9000 : 5000);
  },
  dismiss: (id) => set({ items: get().items.filter((x) => x.id !== id) }),
}));

export function toast(t: Omit<ToastItem, "id">) {
  useToasts.getState().push(t);
}

export function Toaster() {
  const { items, dismiss } = useToasts();
  return (
    <div className="toasts" aria-live="polite" aria-relevant="additions">
      {items.map((t) => (
        <div key={t.id} className="toast" role={t.tone === "error" ? "alert" : "status"}>
          <Icon name={t.tone === "error" ? "alert" : t.tone === "ok" ? "check" : "info"} size={16} style={{ color: t.tone === "error" ? "var(--c-red)" : t.tone === "ok" ? "var(--c-accent)" : "var(--c-text-2)", marginTop: 2, flex: "none" }} />
          <div className="grow stack-tight">
            <strong className="t-small">{t.title}</strong>
            {t.detail && <span className="t-small muted">{t.detail}</span>}
          </div>
          <button className="btn btn-ghost btn-icon btn-sm" onClick={() => dismiss(t.id)} aria-label="Dismiss">
            <Icon name="close" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
