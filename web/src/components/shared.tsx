import { memo, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn, fmtTokens } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export function PageHeader({
  title,
  desc,
  meta,
  actions,
}: {
  title: string;
  desc?: string;
  // Rendered next to the title — e.g. a count badge that used to live in a
  // redundant card header below.
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <div className="flex items-center gap-2.5">
          <h1 className="text-xl font-semibold tracking-tight text-foreground">
            {title}
          </h1>
          {meta}
        </div>
        {desc && <p className="text-xs text-muted-foreground mt-1">{desc}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export const Stat = memo(function Stat({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  accent?: boolean;
}) {
  return (
    <Card className="gap-1 p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={cn(
          "text-2xl font-bold tabular-nums",
          accent ? "text-primary" : "text-foreground",
        )}
      >
        {value}
      </div>
      {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
    </Card>
  );
});

// Footer pagination bar. Client-side tables pass pageCount; server-side lists
// (offset queries with unknown total) pass hasNext instead. Renders nothing
// when there is only one page.
export function Pagination({
  page,
  pageCount,
  hasNext,
  onChange,
  className,
}: {
  page: number;
  pageCount?: number;
  hasNext?: boolean;
  onChange: (page: number) => void;
  className?: string;
}) {
  const more = pageCount != null ? page < pageCount - 1 : !!hasNext;
  if (page === 0 && !more) return null;
  return (
    <div
      className={cn(
        "flex items-center justify-between border-t border-border px-4 py-2",
        className,
      )}
    >
      <span className="text-xs tabular-nums text-muted-foreground">
        {pageCount != null
          ? `page ${page + 1} of ${pageCount}`
          : `page ${page + 1}`}
      </span>
      <div className="flex gap-1">
        <Button
          variant="ghost"
          size="sm"
          disabled={page === 0}
          onClick={() => onChange(page - 1)}
        >
          <ChevronLeft className="h-3.5 w-3.5" />
          Prev
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={!more}
          onClick={() => onChange(page + 1)}
        >
          Next
          <ChevronRight className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 p-8 justify-center text-muted-foreground text-xs">
      <span className="inline-block h-3 w-3 animate-spin border border-primary border-t-transparent" />
      {label || "Loading\u2026"}
    </div>
  );
}

export function EmptyState({ msg }: { msg: string }) {
  return (
    <div className="p-8 text-center text-xs text-muted-foreground">{msg}</div>
  );
}

// Round a raw max up to a "nice" axis ceiling (1/2/5 × 10ⁿ), so gridline
// labels land on readable round numbers (10, 20, 50, 100, 200, 500, 1k, …)
// rather than arbitrary values. Returns at least 10 so an empty/tiny chart
// still shows a sane axis.
function niceCeil(max: number): number {
  if (max <= 10) return 10;
  const pow = Math.pow(10, Math.floor(Math.log10(max)));
  const frac = max / pow;
  const mult = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
  return mult * pow;
}

// A compact filled area/line chart with a labelled, auto-scaled Y-axis.
// Reads well for both trending and sparse data — a single non-zero bucket
// still shows a clear peak with filled area beneath, rather than one lone bar.
// Values are scaled against a "nice" round ceiling; points are evenly spaced
// across the width so the series always fills the plot. `highlightLast` marks
// the final point (e.g. the still-accumulating current hour/day) with a dot.
// `label(point)` builds each point's hover tooltip.
export function TokenChart<T extends { tokens: number }>({
  data,
  label,
  axisTicks = 4,
  highlightLast = true,
  height = "h-40",
}: {
  data: T[];
  label: (point: T, isLast: boolean) => string;
  axisTicks?: number;
  highlightLast?: boolean;
  height?: string;
}) {
  const rawMax = Math.max(0, ...data.map((d) => d.tokens));
  const ceil = niceCeil(rawMax);
  // Gridline values from top (ceil) down to 0, inclusive.
  const ticks = Array.from(
    { length: axisTicks + 1 },
    (_, i) => (ceil / axisTicks) * (axisTicks - i),
  );

  const n = data.length;
  // Point coordinates in a 100×100 viewBox (y inverted: 0 = top = ceil).
  const x = (i: number) => (n <= 1 ? 50 : (i / (n - 1)) * 100);
  const y = (v: number) => 100 - (v / ceil) * 100;
  const pts = data.map((d, i) => ({ x: x(i), y: y(d.tokens) }));

  const linePath = pts.length
    ? pts.map((p, i) => `${i ? "L" : "M"}${p.x},${p.y}`).join(" ")
    : "";
  // Close the area down to the baseline at both ends so the fill sits under
  // the line.
  const areaPath = pts.length
    ? `${linePath} L${pts[pts.length - 1].x},100 L${pts[0].x},100 Z`
    : "";
  const last = pts[pts.length - 1];

  return (
    <div className="flex gap-2">
      {/* Y-axis: nice round tick labels aligned to the gridlines. */}
      <div
        className={cn(
          "flex shrink-0 flex-col justify-between text-right text-[0.6rem] tabular-nums text-muted-foreground",
          height,
        )}
      >
        {ticks.map((t, i) => (
          <span key={i} className="leading-none">
            {fmtTokens(t)}
          </span>
        ))}
      </div>

      {/* Plot: gridlines behind, area+line SVG, invisible hover cells on top. */}
      <div className={cn("relative flex-1", height)}>
        <div className="absolute inset-0 flex flex-col justify-between">
          {ticks.map((_, i) => (
            <div key={i} className="border-t border-border/40" />
          ))}
        </div>

        <svg
          className="absolute inset-0 h-full w-full overflow-visible"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          aria-hidden
        >
          <defs>
            <linearGradient id="tokenFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-violet-500)" stopOpacity="0.35" />
              <stop offset="100%" stopColor="var(--color-violet-500)" stopOpacity="0.02" />
            </linearGradient>
          </defs>
          {areaPath && <path d={areaPath} fill="url(#tokenFill)" stroke="none" />}
          {linePath && (
            <path
              d={linePath}
              fill="none"
              stroke="var(--color-violet-500)"
              strokeWidth="1.5"
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          )}
          {highlightLast && last && (
            <circle
              cx={last.x}
              cy={last.y}
              r="2.5"
              fill="var(--color-violet-500)"
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>

        {/* Per-point hover targets for tooltips (invisible, full-height). */}
        <div className="absolute inset-0 flex">
          {data.map((d, i) => (
            <div
              key={i}
              className="h-full flex-1"
              title={label(d, i === n - 1)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <div>
      <label className="text-xs font-medium text-foreground mb-1.5 block">
        {label}
      </label>
      {children}
      {hint && (
        <p className="mt-1 text-[0.65rem] text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}
