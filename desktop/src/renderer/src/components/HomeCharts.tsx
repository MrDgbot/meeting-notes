import { fmtDur } from "@shared/format";

export interface ActivityBucket {
  key: string;
  label: string;
  sublabel: string;
  count: number;
  dur: number;
  isCurrent?: boolean;
  targetHash?: string;
}

export function ActivityTrendChart({
  buckets,
  hoveredKey,
  onHover,
  onSelect,
}: {
  buckets: ActivityBucket[];
  hoveredKey: string | null;
  onHover: (key: string | null) => void;
  onSelect?: (bucket: ActivityBucket) => void;
}) {
  const maxDur = Math.max(60, ...buckets.map((b) => b.dur));

  return (
    <div className="select-none">
      <div className="flex items-center justify-end pb-1">
        <span className="text-xs leading-[16px] text-[var(--muted)] num whitespace-nowrap">
          {fmtDur(maxDur)}
        </span>
      </div>
      <div className="relative h-[100px]">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 bottom-6 flex flex-col justify-between"
        >
          <div className="border-t border-dashed border-[var(--line-2)]" />
          <div className="border-t border-dashed border-[var(--line-2)]" />
        </div>

        <div className="relative h-full flex items-stretch gap-1.5 sm:gap-2">
          {buckets.map((b) => {
            const active = hoveredKey !== null ? hoveredKey === b.key : Boolean(b.isCurrent);
            const scaleY = b.dur > 0 ? Math.max(0.14, Math.min(1, b.dur / maxDur)) : 0.06;
            return (
              <button
                key={b.key}
                type="button"
                onMouseEnter={() => onHover(b.key)}
                onMouseLeave={() => onHover(null)}
                onFocus={() => onHover(b.key)}
                onBlur={() => onHover(null)}
                onClick={() => onSelect?.(b)}
                aria-label={`${b.label} ${b.sublabel} ${b.count > 0 ? `${b.count}场 ${fmtDur(b.dur)}` : "无记录"}`}
                className="group flex-1 min-w-[24px] h-full flex flex-col items-center justify-end gap-1.5 cursor-pointer rounded-[8px] focus-visible:outline-2 focus-visible:outline-[var(--ink-ring)]"
              >
                <span className="w-full flex-1 flex items-end justify-center px-0.5">
                  <span
                    className={`w-full max-w-[22px] h-full origin-bottom rounded-[6px] mn-chart-anim transition-[transform,opacity,background-color] duration-300 [transition-timing-function:var(--ease-spring)] ${
                      b.count > 0
                        ? active
                          ? "bg-[var(--chart-bar-today)]"
                          : "bg-[var(--chart-bar)] group-hover:bg-[var(--chart-3)]"
                        : "bg-[var(--chart-track)] group-hover:bg-[var(--fill-hover)]"
                    }`}
                    style={{ transform: `scaleY(${scaleY.toFixed(3)})` }}
                  />
                </span>
                <span
                  className={`text-xs leading-[18px] num whitespace-nowrap transition-colors ${
                    active ? "text-[var(--text)] font-medium" : "text-[var(--muted)]"
                  }`}
                >
                  {b.label}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function CompletionRing({
  done,
  total,
  label,
  sublabel,
}: {
  done: number;
  total: number;
  label: string;
  sublabel: string;
}) {
  const ratio = total > 0 ? Math.max(0, Math.min(1, done / total)) : 0;
  const pct = total > 0 ? Math.round(ratio * 100) : 0;
  const radius = 20;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - ratio);

  return (
    <div className="rounded-[12px] bg-[var(--fill)] px-3.5 py-3 flex items-center gap-3.5">
      <div className="relative w-[52px] h-[52px] shrink-0 flex items-center justify-center">
        <svg viewBox="0 0 52 52" className="w-full h-full -rotate-90" aria-hidden="true">
          <circle cx="26" cy="26" r={radius} fill="none" stroke="var(--chart-track)" strokeWidth="5" />
          <circle
            cx="26"
            cy="26"
            r={radius}
            fill="none"
            stroke="var(--ok)"
            strokeWidth="5"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
            className={`mn-chart-anim transition-[stroke-dashoffset,opacity] duration-500 [transition-timing-function:var(--ease-spring)] ${
              ratio > 0 ? "opacity-100" : "opacity-0"
            }`}
          />
        </svg>
        <span className="absolute text-xs leading-[16px] font-semibold text-[var(--text)] num">{pct}%</span>
      </div>
      <div className="min-w-0">
        <div className="text-sm leading-[20px] font-medium text-[var(--text)] num">{label}</div>
        <div className="text-xs leading-[18px] text-[var(--muted)] mt-0.5 num">{sublabel}</div>
      </div>
    </div>
  );
}

export interface CompositionSegment {
  key: string;
  label: string;
  count: number;
  color: string;
}

export function CompositionBar({ segments }: { segments: CompositionSegment[] }) {
  const total = segments.reduce((acc, s) => acc + s.count, 0);
  const activeSegments = segments.filter((s) => s.count > 0);

  if (total === 0) return null;

  return (
    <div className="space-y-2.5">
      <div className="h-2.5 w-full flex items-center gap-1" aria-hidden="true">
        {activeSegments.map((s) => (
          <span
            key={s.key}
            className="h-full rounded-full mn-chart-anim transition-[flex-grow,opacity] duration-300"
            style={{ flexGrow: s.count, backgroundColor: s.color }}
          />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs leading-[18px]">
        {segments.map((s) => {
          const pct = total > 0 ? Math.round((s.count / total) * 100) : 0;
          return (
            <div
              key={s.key}
              className="inline-flex items-center gap-1.5 text-[var(--text-2)] num whitespace-nowrap"
            >
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{ backgroundColor: s.color }}
                aria-hidden="true"
              />
              <span>{s.label}</span>
              <span className="text-[var(--muted)]">
                {s.count} 场 · {pct}%
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
