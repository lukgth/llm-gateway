import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function fmtNum(n: number | null | undefined): string {
  if (n == null) return "—";
  return new Intl.NumberFormat("en-US").format(n);
}

// Compact token-count label. Keeps small counts exact (so a low-usage chart
// axis reads "250 / 500 / 750" instead of collapsing to "0k / 1k"), and only
// switches to k/M once the number is large enough for that to be readable:
//   0..999      -> exact           (0, 42, 750, 999)
//   1k..999k    -> k, ≤1 decimal   (1k, 1.5k, 16k, 200k)
//   ≥1M         -> M, ≤2 decimals  (1M, 1.05M, 12.5M)
// Trailing zeros are trimmed so labels stay tidy (1.0k -> 1k, 2.50M -> 2.5M).
export function fmtTokens(n: number | null | undefined): string {
  if (n == null) return "—";
  const abs = Math.abs(n);
  if (abs < 1000) return String(Math.round(n));
  if (abs < 1_000_000)
    return `${trimDecimals(n / 1000, abs < 10_000 ? 1 : 0)}k`;
  return `${trimDecimals(n / 1_000_000, abs < 10_000_000 ? 2 : 1)}M`;
}

// Round to `places` decimals, dropping only *fractional* trailing zeros so
// whole numbers keep their value (200 -> "200", 1.50 -> "1.5", 1.0 -> "1").
function trimDecimals(n: number, places: number): string {
  return String(parseFloat(n.toFixed(places)));
}

export function fmtBytes(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "2-digit",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function relTime(iso: string | null | undefined): string {
  if (!iso) return "never";
  const d = new Date(iso).getTime();
  if (Number.isNaN(d)) return "—";
  const s = Math.floor((Date.now() - d) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
