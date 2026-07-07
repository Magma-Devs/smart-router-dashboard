"use client";

/* Ported verbatim from the design prototype (shell.jsx Modal). */

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  children?: React.ReactNode;
  wide?: boolean;
  md?: boolean;
  footer?: React.ReactNode;
}

export function Modal({ open, onClose, title, children, wide, md, footer }: ModalProps) {
  if (!open) return null;
  const cls = "gw-modal fade-in" + (wide ? " gw-modal--wide" : md ? " gw-modal--md" : "");
  return (
    <div className="gw-modal-bg" onClick={onClose}>
      <div className={cls} onClick={(e) => e.stopPropagation()}>
        <div className="gw-modal__head">
          <div className="gw-modal__title">{title}</div>
          <button className="gw-btn gw-btn--ghost" style={{ padding: 5 }} onClick={onClose}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div className="gw-modal__body">{children}</div>
        {footer && <div className="gw-modal__foot">{footer}</div>}
      </div>
    </div>
  );
}
