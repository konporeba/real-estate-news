// The confirmation step every irreversible action goes through (confirm selection, approve, reject,
// publish). Built on the native <dialog> opened with showModal(), which gives what the old
// hand-rolled overlays lacked: the page behind becomes inert, focus stays inside, and Escape closes it.
import { useEffect, useId, useRef, type ReactNode } from "react";

import { PRIMARY_BUTTON, SECONDARY_BUTTON } from "@/components/ui/button-styles";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  children?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  busy?: boolean;
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  cancelLabel = "Back",
  busy = false,
  confirmDisabled = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  // Unique per dialog: a page can hold several (one per week row), and a shared id would point
  // every dialog's label at the first one.
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(event) => {
        // Escape. The browser would close the element itself; keep React's `open` the source of
        // truth instead, and refuse while a request is in flight so its outcome is not hidden.
        event.preventDefault();
        if (!busy) onCancel();
      }}
      className="bg-card text-foreground backdrop:bg-primary/55 m-auto max-h-[calc(100%-2rem)] w-[calc(100%-2rem)] max-w-lg rounded-[20px] p-7 shadow-2xl"
    >
      <h2 id={titleId} className="text-[22px] leading-tight font-bold">
        {title}
      </h2>
      <div className="mt-3">{children}</div>
      <div className="mt-6 flex flex-wrap justify-end gap-2.5">
        <button type="button" className={SECONDARY_BUTTON} disabled={busy} onClick={onCancel}>
          {cancelLabel}
        </button>
        <button type="button" className={PRIMARY_BUTTON} disabled={busy || confirmDisabled} onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
