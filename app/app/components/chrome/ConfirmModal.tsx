"use client";

import { useEffect, type ReactNode } from "react";

// Tauri's WKWebView doesn't reliably implement window.confirm/alert (see
// tauri-apps/wry#584), so native confirm dialogs can silently no-op instead
// of blocking for a response. Use this in-app modal for any destructive
// confirmation instead.
export function ModalShell({
  children,
  onClose,
  labelledBy,
}: {
  children: ReactNode;
  onClose: () => void;
  labelledBy: string;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

export function ConfirmModal({
  title,
  body,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
}) {
  return (
    <ModalShell onClose={onClose} labelledBy="confirm-modal-title">
      <h2 id="confirm-modal-title">{title}</h2>
      <p className="modal-body">{body}</p>
      <div className="modal-actions">
        <button className="btn btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-danger" onClick={() => void onConfirm()}>
          {confirmLabel}
        </button>
      </div>
    </ModalShell>
  );
}
