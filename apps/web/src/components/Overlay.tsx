import * as Dialog from "@radix-ui/react-dialog";
import type { ReactNode } from "react";
import { Icon } from "./Icon.tsx";

/** Right-hand drawer on desktop; becomes a bottom sheet on mobile (CSS). Focus is trapped and restored. */
export function Drawer({ open, onOpenChange, title, subtitle, children, footer }: { open: boolean; onOpenChange: (o: boolean) => void; title: ReactNode; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className="drawer" aria-describedby={undefined}>
          <div className="drawer-head" style={{ position: "relative" }}>
            <div className="grow stack-tight">
              <Dialog.Title className="t-head truncate">{title}</Dialog.Title>
              {subtitle && <div className="t-small muted truncate">{subtitle}</div>}
            </div>
            <Dialog.Close className="btn btn-ghost btn-icon btn-sm" aria-label="Close">
              <Icon name="close" size={16} />
            </Dialog.Close>
          </div>
          <div className="drawer-body">{children}</div>
          {footer && <div className="drawer-foot">{footer}</div>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function Modal({ open, onOpenChange, title, description, children }: { open: boolean; onOpenChange: (o: boolean) => void; title: ReactNode; description?: ReactNode; children: ReactNode }) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className="dialog" {...(description ? {} : { "aria-describedby": undefined })}>
          <div className="row" style={{ alignItems: "flex-start" }}>
            <div className="grow stack-tight">
              <Dialog.Title className="t-title">{title}</Dialog.Title>
              {description && <Dialog.Description className="muted">{description}</Dialog.Description>}
            </div>
            <Dialog.Close className="btn btn-ghost btn-icon btn-sm" aria-label="Close">
              <Icon name="close" size={16} />
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
