import { memo, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
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
