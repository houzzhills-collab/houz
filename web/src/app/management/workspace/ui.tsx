"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Info, X } from "lucide-react";
import { errorMessage, type Permission, type Property, type Reference, type User } from "@/lib/api";
import type { Focus } from "./assist";

export type Notify = (message: string) => void;

/** What every workspace section receives from the shell. */
export type SectionProps = {
  user: User;
  notify: Notify;
  /** Changes whenever live updates report a committed change; sections reload on it. */
  refreshKey: number;
  /** Whether the API granted the signed-in user this permission. */
  can: (permission: Permission) => boolean;
  /** Labels and allowed values from the API. */
  reference: Reference;
  property: Property;
  /** A record to open or a form to start when the section mounts (from search or a link). */
  focus?: Focus | null;
};

/** An info icon that explains the thing next to it on hover or keyboard focus. */
export function Tip({ text }: { text: string }) {
  return (
    <span className="tip-icon" tabIndex={0} role="img" aria-label={text} data-tip={text}>
      <Info size={13} />
    </span>
  );
}

/** A form field. `tip` explains what the field means; `hint` is a short note shown under it. */
export function Field({ label, children, hint, tip }: { label: string; children: ReactNode; hint?: string; tip?: string }) {
  return (
    <label className="form-field">
      <span className="field-label" data-tip={tip}>
        {label}
        {tip && <Info className="field-label-icon" size={13} aria-hidden />}
      </span>
      {children}
      {hint && <small className="field-hint">{hint}</small>}
    </label>
  );
}

export function Empty({ text }: { text: string }) {
  return <div className="empty-state">{text}</div>;
}

export function InlineError({ message, onDismiss }: { message: string; onDismiss?: () => void }) {
  if (!message) return null;
  return (
    <div className="inline-error" role="alert">
      <span>{message}</span>
      {onDismiss && (
        <button type="button" aria-label="Dismiss" onClick={onDismiss}>
          <X size={15} />
        </button>
      )}
    </div>
  );
}

export function Metric({ label, icon, tone, value, unit, foot, progress, tip }: { label: string; icon: ReactNode; tone: string; value: string; unit?: string; foot: string; progress?: number; tip?: string }) {
  return (
    <article className="metric-card">
      <div className="metric-top">
        <span className="metric-label" data-tip={tip}>
          {label}
        </span>
        <span className={`metric-icon ${tone}`}>{icon}</span>
      </div>
      <div className="metric-value metric-text-value">
        {value}
        {unit && <span className="metric-unit">{unit}</span>}
      </div>
      <div className="metric-foot">
        {progress !== undefined && (
          <div className="occupancy-track">
            <i style={{ width: `${Math.min(100, Math.max(0, progress))}%` }} />
          </div>
        )}
        <span>{foot}</span>
      </div>
    </article>
  );
}

type ModalProps = {
  title: string;
  description?: string;
  submitLabel?: string;
  busy?: boolean;
  error?: string;
  /** Omit for read-only dialogs. */
  onSubmit?: (values: FormData) => unknown;
  onClose?: () => void;
  wide?: boolean;
  /** Red submit button for destructive actions. */
  danger?: boolean;
  children: ReactNode;
};

/** Form dialog. Without `onClose` it cannot be dismissed (e.g. the temporary-password gate). */
export function Modal({ title, description, submitLabel = "Save changes", busy, error, onSubmit, onClose, wide, danger, children }: ModalProps) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void onSubmit?.(new FormData(event.currentTarget));
  };
  useEffect(() => {
    if (!onClose) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose?.()}>
      <form className={`management-modal ${wide ? "modal-wide" : ""}`} onSubmit={submit} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-heading">
          <div>
            <h2>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          {onClose && (
            <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>
              <X size={18} />
            </button>
          )}
        </div>
        {error && <div className="form-error">{error}</div>}
        {children}
        <div className="modal-actions">
          {onClose && (
            <button type="button" className="button-secondary" onClick={onClose}>
              {onSubmit ? "Cancel" : "Close"}
            </button>
          )}
          {onSubmit && (
            <button className={danger ? "button-danger" : "button-primary"} disabled={busy}>
              {busy ? "Saving…" : submitLabel}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

/** Side panel for viewing a record and acting on it. Closes on Escape or a click outside. */
export function Drawer({
  title,
  subtitle,
  badge,
  onClose,
  actions,
  children,
}: {
  title: string;
  subtitle?: string;
  badge?: ReactNode;
  onClose: () => void;
  /** Footer buttons. */
  actions?: ReactNode;
  children: ReactNode;
}) {
  useEffect(() => {
    // A dialog opened from the drawer handles its own Escape.
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && !document.querySelector(".modal-backdrop") && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside className="management-drawer" role="dialog" aria-modal="true" aria-label={title}>
        <header className="drawer-header">
          <div>
            <h2>{title}</h2>
            {(subtitle || badge) && (
              <p>
                {badge}
                {subtitle && <span>{subtitle}</span>}
              </p>
            )}
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <div className="drawer-body">{children}</div>
        {actions && <footer className="drawer-footer">{actions}</footer>}
      </aside>
    </div>
  );
}

/** A titled group of label/value rows inside a drawer. Empty values are skipped. */
/** Label/value rows; an optional third element explains the label on hover. */
export function DetailList({ title, tip, rows }: { title?: string; tip?: string; rows: ReadonlyArray<readonly [label: string, value: ReactNode, tip?: string]> }) {
  const shown = rows.filter(([, value]) => value !== null && value !== undefined && value !== "");
  if (shown.length === 0) return null;
  return (
    <section className="detail-section">
      {title && (
        <h3>
          {title}
          {tip && <Tip text={tip} />}
        </h3>
      )}
      <dl className="detail-list">
        {shown.map(([label, value, rowTip]) => (
          <div key={label}>
            <dt data-tip={rowTip}>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export type ConfirmOptions = {
  title: string;
  message: string;
  confirmLabel: string;
  /** Destructive actions get a red button. */
  danger?: boolean;
  /** Ask for a reason (recorded in the audit log); the promise resolves to it. */
  reason?: string;
};

/**
 * In-app confirmation instead of window.confirm/prompt. `confirm` resolves to
 * the reason (or "") when accepted, and null when cancelled; render `dialog`.
 */
export function useConfirm() {
  const [pending, setPending] = useState<(ConfirmOptions & { resolve: (value: string | null) => void }) | null>(null);
  const confirm = useCallback((options: ConfirmOptions) => new Promise<string | null>((resolve) => setPending({ ...options, resolve })), []);
  const finish = (value: string | null) => {
    pending?.resolve(value);
    setPending(null);
  };
  const dialog = pending && (
    <Modal
      title={pending.title}
      description={pending.message}
      submitLabel={pending.confirmLabel}
      danger={pending.danger}
      onClose={() => finish(null)}
      onSubmit={(values) => finish(pending.reason ? String(values.get("reason") ?? "").trim() : "")}
    >
      {pending.reason && (
        <Field label={pending.reason}>
          <textarea name="reason" required minLength={3} maxLength={500} rows={3} autoFocus />
        </Field>
      )}
    </Modal>
  );
  return { confirm, dialog };
}

export type Resource<T> = { data: T | null; error: string; loading: boolean; reload: () => Promise<void> };

/**
 * Loads data from the API and reloads whenever `key` changes (filters, live
 * updates). Errors are kept separately so stale data stays visible.
 */
export function useResource<T>(load: () => Promise<T>, key: string): Resource<T> {
  const [state, setState] = useState<{ data: T | null; error: string; loading: boolean }>({ data: null, error: "", loading: true });
  const loader = useRef(load);
  useEffect(() => {
    loader.current = load;
  });
  const reload = useCallback(async () => {
    try {
      const data = await loader.current();
      setState({ data, error: "", loading: false });
    } catch (error) {
      setState((current) => ({ ...current, error: errorMessage(error, "Unable to load data"), loading: false }));
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload, key]);
  return { ...state, reload };
}

/** Runs a form action with busy/error state shared by a dialog. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = useCallback(async (work: () => Promise<void>, fallback = "Unable to save changes") => {
    setBusy(true);
    setError("");
    try {
      await work();
      return true;
    } catch (caught) {
      setError(errorMessage(caught, fallback));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run, clearError: () => setError("") };
}

/** Triggers a browser download of a Blob. */
export function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
