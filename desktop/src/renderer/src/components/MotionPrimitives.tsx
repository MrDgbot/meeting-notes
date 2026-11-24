import { Check, Copy } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAppStore } from "@/stores/appStore";

export type PresenceState = "entering" | "entered" | "exiting";

const overlayStack: string[] = [];

function syncRootInert(): void {
  const rootEl = typeof document !== "undefined" ? document.getElementById("root") : null;
  if (!rootEl) return;
  if (overlayStack.length > 0) {
    rootEl.setAttribute("inert", "");
  } else {
    rootEl.removeAttribute("inert");
  }
}

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  const selector =
    'a[href], button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';
  return Array.from(container.querySelectorAll<HTMLElement>(selector)).filter(
    (el) => !el.closest("[inert]") && el.getClientRects().length > 0,
  );
}

function useOverlayDialog(
  open: boolean,
  onClose: () => void,
  panelRef: React.RefObject<HTMLDivElement | null>,
): void {
  const overlayId = useId();
  const prevFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    prevFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    overlayStack.push(overlayId);
    syncRootInert();

    const raf = requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel || overlayStack[overlayStack.length - 1] !== overlayId) return;
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      if (active && panel.contains(active)) return;
      const autoTarget = panel.querySelector<HTMLElement>("[autofocus]");
      const focusables = getFocusableElements(panel);
      const target = (autoTarget && !autoTarget.closest("[inert]") ? autoTarget : focusables[0]) ?? panel;
      target.focus({ preventScroll: true });
    });

    const onKey = (e: KeyboardEvent) => {
      if (overlayStack[overlayStack.length - 1] !== overlayId) return;
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key === "Tab") {
        const panel = panelRef.current;
        if (!panel) return;
        const focusables = getFocusableElements(panel);
        if (!focusables.length) {
          e.preventDefault();
          panel.focus({ preventScroll: true });
          return;
        }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (!first || !last) return;
        const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        if (e.shiftKey) {
          if (!active || !panel.contains(active) || active === first) {
            e.preventDefault();
            last.focus();
          }
        } else if (!active || !panel.contains(active) || active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    window.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKey);
      const idx = overlayStack.lastIndexOf(overlayId);
      if (idx >= 0) overlayStack.splice(idx, 1);
      syncRootInert();
      const prev = prevFocusRef.current;
      prevFocusRef.current = null;
      if (prev?.isConnected && !prev.closest("[inert]")) {
        prev.focus({ preventScroll: true });
      }
    };
  }, [open, overlayId, panelRef]);
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches)
  );
}

/**
 * Keeps an overlay mounted just long enough for its exit transition to finish,
 * then unmounts it cleanly so detached DOM checks pass immediately.
 */
export function usePresence(open: boolean, exitMs = 150): { mounted: boolean; state: PresenceState } {
  const [mounted, setMounted] = useState(open);
  const [state, setState] = useState<PresenceState>(open ? "entered" : "exiting");
  const mountedRef = useRef(open);
  mountedRef.current = mounted;

  useEffect(() => {
    if (open) {
      mountedRef.current = true;
      setMounted(true);
      if (prefersReducedMotion()) {
        setState("entered");
        return;
      }
      setState("entering");
      const raf = requestAnimationFrame(() => setState("entered"));
      return () => cancelAnimationFrame(raf);
    }

    if (!mountedRef.current) return;
    if (prefersReducedMotion() || exitMs <= 0) {
      mountedRef.current = false;
      setMounted(false);
      setState("exiting");
      return;
    }

    setState("exiting");
    const timer = setTimeout(() => {
      mountedRef.current = false;
      setMounted(false);
    }, exitMs);
    return () => clearTimeout(timer);
  }, [open, exitMs]);

  return { mounted, state };
}

interface ModalShellProps {
  open: boolean;
  onClose: () => void;
  label: string;
  variant?: "dialog" | "palette";
  maxWidthClass?: string;
  backdropClassName?: string;
  panelClassName?: string;
  children: ReactNode;
}

export function ModalShell({
  open,
  onClose,
  label,
  variant = "dialog",
  maxWidthClass = "max-w-lg",
  backdropClassName = "",
  panelClassName = "",
  children,
}: ModalShellProps) {
  const { mounted, state } = usePresence(open, 150);
  const panelRef = useRef<HTMLDivElement | null>(null);
  useOverlayDialog(open, onClose, panelRef);

  if (!mounted || typeof document === "undefined") return null;

  const isPalette = variant === "palette";
  const animClass = isPalette ? "mn-palette" : "mn-dialog";

  return createPortal(
    <div
      className={`mn-backdrop fixed inset-0 z-50 bg-black/45 backdrop-blur-[2px] flex justify-center ${
        isPalette ? "items-start pt-[14vh] px-4" : "items-center p-4"
      } ${backdropClassName}`}
      data-state={state}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        data-state={state}
        onClick={(e) => e.stopPropagation()}
        className={`${animClass} w-full ${maxWidthClass} rounded-[14px] bg-[var(--surface-elev)] shadow-[var(--shadow-pop)] overflow-hidden outline-none ${panelClassName}`}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

interface DrawerShellProps {
  open: boolean;
  onClose: () => void;
  label: string;
  widthClass?: string;
  children: ReactNode;
}

export function DrawerShell({
  open,
  onClose,
  label,
  widthClass = "w-full max-w-[520px]",
  children,
}: DrawerShellProps) {
  const { mounted, state } = usePresence(open, 150);
  const panelRef = useRef<HTMLDivElement | null>(null);
  useOverlayDialog(open, onClose, panelRef);

  if (!mounted || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="mn-backdrop fixed inset-0 z-50 bg-black/35 flex justify-end"
      data-state={state}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        data-state={state}
        onClick={(e) => e.stopPropagation()}
        className={`mn-drawer ${widthClass} h-full bg-[var(--surface-elev)] shadow-[var(--shadow-pop)] flex flex-col outline-none`}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

interface DisclosureProps {
  open: boolean;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  id?: string;
}

export function Disclosure({ open, children, className = "", contentClassName = "", id }: DisclosureProps) {
  return (
    <div
      id={id}
      className={`mn-disclosure ${className}`}
      data-open={open ? "true" : "false"}
      aria-hidden={!open || undefined}
    >
      <div inert={!open} className={contentClassName}>
        {children}
      </div>
    </div>
  );
}

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  badge?: string | number;
  title?: string;
  disabled?: boolean;
}

interface SegmentedControlProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: Array<SegmentOption<T>>;
  ariaLabel: string;
  className?: string;
  fullWidth?: boolean;
  size?: "xs" | "sm";
}

export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  className = "",
  fullWidth = false,
  size = "sm",
}: SegmentedControlProps<T>) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const btnRefs = useRef<Map<T, HTMLButtonElement>>(new Map());
  const readyRef = useRef(false);
  const [thumb, setThumb] = useState<{ left: number; width: number; ready: boolean }>({
    left: 0,
    width: 0,
    ready: false,
  });

  const optionsKey = options.map((o) => `${o.value}:${o.label}:${o.badge ?? ""}`).join("|");

  const measure = useCallback(() => {
    void optionsKey;
    const root = containerRef.current;
    const btn = btnRefs.current.get(value);
    if (!root || !btn) {
      setThumb((cur) => (cur.width === 0 ? cur : { left: 0, width: 0, ready: false }));
      return;
    }
    const left = btn.offsetLeft;
    const width = btn.offsetWidth;
    const animate = readyRef.current;
    readyRef.current = true;
    setThumb({ left, width, ready: animate });
  }, [value, optionsKey]);

  useLayoutEffect(() => {
    measure();
  }, [measure]);

  useEffect(() => {
    const root = containerRef.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(root);
    return () => ro.disconnect();
  }, [measure]);

  const padCls = size === "xs" ? "h-[26px] px-1.5 text-[12px]" : "py-1.5 px-2.5 text-xs";

  return (
    <div
      ref={containerRef}
      role="tablist"
      aria-label={ariaLabel}
      className={`relative rounded-[9px] bg-[var(--fill)] p-[3px] gap-0.5 ${
        fullWidth ? "flex w-full" : "inline-flex"
      } ${className}`}
    >
      {thumb.width > 0 && (
        <span
          aria-hidden="true"
          className={`mn-slide-indicator pointer-events-none absolute top-[3px] bottom-[3px] left-0 rounded-[7px] bg-[var(--surface)] shadow-[var(--shadow-1)] ${
            thumb.ready && !prefersReducedMotion()
              ? "transition-[transform,width] duration-[200ms] [transition-timing-function:var(--ease-spring)]"
              : ""
          }`}
          style={{
            width: `${thumb.width}px`,
            transform: `translate3d(${thumb.left}px, 0, 0)`,
          }}
        />
      )}
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            ref={(el) => {
              if (el) btnRefs.current.set(opt.value, el);
              else btnRefs.current.delete(opt.value);
            }}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={opt.disabled}
            title={opt.title}
            onClick={() => onChange(opt.value)}
            className={`relative z-[1] ${fullWidth ? "flex-1" : ""} ${padCls} rounded-[7px] inline-flex items-center justify-center gap-1 cursor-pointer transition-colors duration-150 ${
              active ? "text-[var(--text)] font-medium" : "text-[var(--text-2)] hover:text-[var(--text)]"
            }`}
          >
            <span className="truncate">{opt.label}</span>
            {opt.badge !== undefined && opt.badge !== "" && (
              <span className={`text-[11px] num ${active ? "text-[var(--text-2)]" : "text-[var(--muted)]"}`}>
                {opt.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

interface SlidingTabItem<T extends string> {
  id: T;
  label: string;
  badge?: string | number;
}

interface SlidingTabBarProps<T extends string> {
  value: T;
  onChange: (id: T) => void;
  tabs: Array<SlidingTabItem<T>>;
  ariaLabel: string;
  className?: string;
}

export function SlidingTabBar<T extends string>({
  value,
  onChange,
  tabs,
  ariaLabel,
  className = "",
}: SlidingTabBarProps<T>) {
  const barRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef<Map<T, HTMLButtonElement>>(new Map());
  const readyRef = useRef(false);
  const [indicator, setIndicator] = useState<{ left: number; width: number; ready: boolean }>({
    left: 0,
    width: 0,
    ready: false,
  });

  const tabsKey = tabs.map((t) => `${t.id}:${t.label}:${t.badge ?? ""}`).join("|");

  const measure = useCallback(() => {
    void tabsKey;
    const bar = barRef.current;
    const activeBtn = tabRefs.current.get(value);
    if (!bar || !activeBtn) return;
    const animate = readyRef.current;
    readyRef.current = true;
    setIndicator({
      left: activeBtn.offsetLeft,
      width: activeBtn.offsetWidth,
      ready: animate,
    });
  }, [value, tabsKey]);

  useLayoutEffect(() => {
    measure();
  }, [measure]);

  useEffect(() => {
    const bar = barRef.current;
    if (!bar || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(bar);
    return () => ro.disconnect();
  }, [measure]);

  return (
    <div
      ref={barRef}
      role="tablist"
      aria-label={ariaLabel}
      className={`relative flex items-center gap-1 border-b border-[var(--line-2)] ${className}`}
    >
      {tabs.map((tab) => {
        const active = tab.id === value;
        return (
          <button
            key={tab.id}
            ref={(el) => {
              if (el) tabRefs.current.set(tab.id, el);
              else tabRefs.current.delete(tab.id);
            }}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(tab.id)}
            className={`px-3 py-2 text-[13px] cursor-pointer transition-colors duration-150 inline-flex items-center gap-1.5 ${
              active ? "text-[var(--text)] font-medium" : "text-[var(--muted)] hover:text-[var(--text)]"
            }`}
          >
            {tab.label}
            {tab.badge !== undefined && tab.badge !== "" && (
              <span className="text-[11.5px] num opacity-80">{tab.badge}</span>
            )}
          </button>
        );
      })}
      {indicator.width > 0 && (
        <span
          aria-hidden="true"
          className={`mn-slide-indicator pointer-events-none absolute bottom-0 left-0 h-[2px] rounded-full bg-[var(--ink)] ${
            indicator.ready && !prefersReducedMotion()
              ? "transition-[transform,width] duration-[220ms] [transition-timing-function:var(--ease-spring)]"
              : ""
          }`}
          style={{
            width: `${indicator.width}px`,
            transform: `translate3d(${indicator.left}px, 0, 0)`,
          }}
        />
      )}
    </div>
  );
}

interface CopyButtonProps {
  text: string;
  label?: string;
  copiedLabel?: string;
  successToast?: string;
  className?: string;
  size?: "xs" | "sm";
  ariaLabel?: string;
}

export function CopyButton({
  text,
  label = "复制",
  copiedLabel = "已复制",
  successToast,
  className = "",
  size = "xs",
  ariaLabel,
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const pushToast = useAppStore((s) => s.pushToast);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setCopied(true);
    if (successToast) pushToast(successToast, { tone: "success", durationMs: 2000 });
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 1600);
  };

  const sizeCls = size === "xs" ? "h-7 px-2.5 text-xs" : "h-8 px-3 text-[13px]";

  return (
    <button
      type="button"
      onClick={() => void handleCopy()}
      aria-label={ariaLabel || (copied ? copiedLabel : label)}
      className={`btn-secondary rounded-[8px] ${sizeCls} inline-flex items-center justify-center gap-1.5 cursor-pointer shrink-0 ${className}`}
    >
      <span className="relative w-3.5 h-3.5 inline-flex items-center justify-center" aria-hidden="true">
        <Copy
          className={`w-3.5 h-3.5 absolute transition-[opacity,transform] duration-150 ${
            copied ? "opacity-0 scale-75" : "opacity-100 scale-100"
          }`}
        />
        <Check
          className={`w-3.5 h-3.5 absolute text-[var(--green)] transition-[opacity,transform] duration-150 ${
            copied ? "opacity-100 scale-100" : "opacity-0 scale-75"
          }`}
        />
      </span>
      <span>{copied ? copiedLabel : label}</span>
    </button>
  );
}

interface InlineConfirmProps {
  triggerLabel?: string;
  triggerAriaLabel?: string;
  triggerTitle?: string;
  triggerClassName?: string;
  triggerIcon?: ReactNode;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  disabled?: boolean;
  align?: "left" | "right";
  onConfirm: () => void | Promise<void>;
}

export function InlineConfirm({
  triggerLabel,
  triggerAriaLabel,
  triggerTitle,
  triggerClassName = "btn-ghost btn-danger rounded-[7px] px-2.5 h-7 text-xs",
  triggerIcon,
  message,
  confirmLabel = "确认",
  cancelLabel = "取消",
  danger = true,
  disabled = false,
  align = "right",
  onConfirm,
}: InlineConfirmProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const popId = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const handleConfirm = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onConfirm();
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={wrapRef} className="relative inline-flex">
      <button
        type="button"
        disabled={disabled}
        aria-label={triggerAriaLabel}
        title={triggerTitle}
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex items-center justify-center gap-1 cursor-pointer ${triggerClassName}`}
      >
        {triggerIcon}
        {triggerLabel && <span>{triggerLabel}</span>}
      </button>

      {open && (
        <div
          id={popId}
          role="alertdialog"
          aria-label={message}
          className={`mn-popover absolute top-full mt-1.5 z-40 w-[230px] rounded-[11px] bg-[var(--surface-elev)] shadow-[var(--shadow-pop)] border border-[var(--line)] p-3 space-y-2.5 text-left ${
            align === "left" ? "left-0 origin-top-left" : "right-0 origin-top-right"
          }`}
        >
          <p className="text-xs leading-relaxed text-[var(--text)]">{message}</p>
          <div className="flex items-center justify-end gap-1.5">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="btn-ghost rounded-[7px] h-7 px-2.5 text-xs cursor-pointer"
            >
              {cancelLabel}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleConfirm()}
              className={`rounded-[7px] h-7 px-2.5 text-xs font-medium cursor-pointer transition-colors ${
                danger ? "bg-[var(--rec)] hover:bg-[var(--rec-hover)] text-white" : "btn-primary"
              }`}
            >
              {busy ? "处理中…" : confirmLabel}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function SkeletonLines({ lines = 3, className = "" }: { lines?: number; className?: string }) {
  const widths = ["w-3/4", "w-full", "w-5/6", "w-2/3", "w-4/5"];
  return (
    <div className={`space-y-2.5 ${className}`} aria-hidden="true">
      {Array.from({ length: lines }).map((_, idx) => (
        <div key={idx} className={`mn-shimmer h-3.5 ${widths[idx % widths.length]}`} />
      ))}
    </div>
  );
}
