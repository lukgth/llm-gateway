// Interactive, collapsible JSON tree with type-based syntax highlighting.
//
// Renders a parsed JSON value as an expandable tree: objects and arrays get a
// disclosure toggle (click to open/close), and leaf values are colorized by
// type the way an editor would. Nodes below `defaultOpenDepth` start collapsed
// with a one-line preview so large payloads (e.g. a tools array) stay scannable
// until you drill in.

import { memo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [k: string]: Json };

// Root entry point. Parses the string, falling back to raw text on invalid
// JSON (the captured blobs are truncated server-side, so a clipped blob may not
// re-parse — we still show it rather than nothing).
export function JsonTree({
  json,
  defaultOpenDepth = 2,
}: {
  json: string;
  defaultOpenDepth?: number;
}) {
  let value: Json;
  try {
    value = JSON.parse(json) as Json;
  } catch {
    return (
      <pre className="whitespace-pre-wrap break-words font-mono text-[0.7rem] leading-relaxed text-foreground/80">
        {json}
      </pre>
    );
  }
  return (
    <div className="font-mono text-[0.72rem] leading-relaxed">
      <Node value={value} depth={0} defaultOpenDepth={defaultOpenDepth} isLast />
    </div>
  );
}

// A colorized scalar (string / number / boolean / null).
const Leaf = memo(function Leaf({ value }: { value: Json }) {
  if (value === null)
    return <span className="text-muted-foreground/70">null</span>;
  switch (typeof value) {
    case "string":
      return (
        <span className="whitespace-pre-wrap break-words text-emerald-600 dark:text-emerald-400">
          "{value}"
        </span>
      );
    case "number":
      return <span className="text-amber-600 dark:text-amber-400">{value}</span>;
    case "boolean":
      return (
        <span className="text-violet-600 dark:text-violet-400">
          {String(value)}
        </span>
      );
    default:
      return <span>{String(value)}</span>;
  }
});

// One-line preview shown for a collapsed object/array.
function preview(value: Json[] | { [k: string]: Json }): string {
  if (Array.isArray(value))
    return value.length === 0 ? "[]" : `[ ${value.length} ]`;
  const keys = Object.keys(value);
  if (keys.length === 0) return "{}";
  const shown = keys.slice(0, 3).join(", ");
  return `{ ${shown}${keys.length > 3 ? ", …" : ""} }`;
}

function Node({
  keyName,
  value,
  depth,
  defaultOpenDepth,
  isLast,
}: {
  keyName?: string;
  value: Json;
  depth: number;
  defaultOpenDepth: number;
  isLast: boolean;
}) {
  const isObject = value !== null && typeof value === "object";
  const [open, setOpen] = useState(depth < defaultOpenDepth);

  const keyLabel = keyName !== undefined && (
    <span className="text-sky-700 dark:text-sky-300">"{keyName}"</span>
  );
  const colon = keyName !== undefined && (
    <span className="text-muted-foreground/60">: </span>
  );
  const comma = !isLast && <span className="text-muted-foreground/60">,</span>;

  // Leaf row.
  if (!isObject) {
    return (
      <div className="pl-[1.1rem]">
        {keyLabel}
        {colon}
        <Leaf value={value} />
        {comma}
      </div>
    );
  }

  const entries: Array<[string | undefined, Json]> = Array.isArray(value)
    ? value.map((v) => [undefined, v] as [undefined, Json])
    : Object.entries(value);
  const openCh = Array.isArray(value) ? "[" : "{";
  const closeCh = Array.isArray(value) ? "]" : "}";
  const empty = entries.length === 0;

  return (
    <div>
      <div
        className={cn(
          "flex items-start rounded-sm",
          !empty && "cursor-pointer hover:bg-muted/60",
        )}
        onClick={empty ? undefined : () => setOpen((o) => !o)}
      >
        <ChevronRight
          className={cn(
            "mt-[0.15rem] h-3 w-3 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
            empty && "invisible",
          )}
        />
        <div className="min-w-0">
          {keyLabel}
          {colon}
          <span className="text-muted-foreground/60">{openCh}</span>
          {/* Collapsed (or empty): show a one-line preview + closing bracket on
              the same line. Expanded non-empty nodes render their close bracket
              in the children block below. */}
          {(!open || empty) && (
            <>
              {!empty && (
                <span className="text-muted-foreground/50">
                  {" "}
                  {preview(value)}{" "}
                </span>
              )}
              <span className="text-muted-foreground/60">{closeCh}</span>
              {comma}
            </>
          )}
        </div>
      </div>

      {open && !empty && (
        <div className="border-l border-border/50 pl-[0.6rem]">
          {entries.map(([k, v], i) => (
            <Node
              key={k ?? i}
              keyName={k}
              value={v}
              depth={depth + 1}
              defaultOpenDepth={defaultOpenDepth}
              isLast={i === entries.length - 1}
            />
          ))}
          <div className="pl-[1.1rem]">
            <span className="text-muted-foreground/60">{closeCh}</span>
            {comma}
          </div>
        </div>
      )}
    </div>
  );
}
