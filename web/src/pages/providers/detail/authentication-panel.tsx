import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Copy,
  Eye,
  EyeOff,
  FlaskConical,
  Loader2,
  Plus,
  Power,
  PowerOff,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type {
  Provider,
  ProviderAuthSession,
  ProviderOAuthAccount,
  ProviderTemplate,
  ProviderTestProbe,
} from "@/lib/types";
import { EmptyState, TableSearch } from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { AuthStep } from "../add-provider-dialog/auth-step";

const ROW_HEIGHT = 56;
const HEADER_HEIGHT = 33;
const GRID =
  "grid gap-3 grid-cols-[2.75rem_minmax(140px,1fr)_9rem_3rem_9rem] md:grid-cols-[2.75rem_13rem_minmax(10rem,1fr)_minmax(8rem,1fr)_8rem_9rem_3rem_3.5rem_3.5rem_9rem]";

function mask(token: string): string {
  if (token.length <= 10) return `${token.slice(0, 2)}…`;
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}

export function AuthenticationPanel({
  provider,
  template,
  onSaved,
}: {
  provider: Provider;
  template: ProviderTemplate;
  onSaved: () => void;
}) {
  const [accounts, setAccounts] = useState<ProviderOAuthAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [testing, setTesting] = useState<Set<string>>(new Set());
  const [toggling, setToggling] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<Map<string, ProviderTestProbe>>(new Map());
  const [testingAll, setTestingAll] = useState(false);
  const [session, setSession] = useState<ProviderAuthSession | null>(null);
  const [connectMode, setConnectMode] = useState<"add" | string | null>(null);
  const [saving, setSaving] = useState(false);
  const parentRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const response = await api.providerAuth(provider.id);
      setAccounts(response.accounts);
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, [provider.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const reload = useCallback(async () => {
    await load();
    onSaved();
  }, [load, onSaved]);

  const filteredRows = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return accounts;
    return accounts.filter((account) =>
      [
        account.accessToken,
        account.account.email,
        account.account.label,
        account.account.accountId,
        account.status,
      ].some((value) => value?.toLowerCase().includes(query)),
    );
  }, [accounts, filter]);
  const activeCount = accounts.filter((account) => account.status === "active").length;
  const disabledCount = accounts.filter((account) => account.status === "disabled").length;
  const selectedAccounts = accounts.filter((account) => selected.has(account.id));
  const canEnableSelected = selectedAccounts.some(
    (account) => account.status === "disabled",
  );
  const canDisableSelected = selectedAccounts.some(
    (account) => account.status === "active",
  );
  const allVisibleSelected =
    filteredRows.length > 0 && filteredRows.every((row) => selected.has(row.id));

  const virtualizer = useVirtualizer({
    count: filteredRows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
    scrollMargin: HEADER_HEIGHT,
  });

  const testAccount = useCallback(
    async (id: string, notify = false) => {
      setTesting((current) => new Set(current).add(id));
      try {
        const result = await api.testProviderAuthConnection(provider.id, id);
        setResults((current) => new Map(current).set(id, result));
        if (notify)
          toast[result.ok ? "success" : "error"](
            result.ok
              ? `Reachable · ${result.ms}ms`
              : result.error || `Test failed${result.status ? ` (${result.status})` : ""}`,
          );
        return result;
      } catch (error) {
        const result: ProviderTestProbe = {
          ok: false,
          status: null,
          ms: 0,
          error: (error as Error).message,
          models: [],
        };
        setResults((current) => new Map(current).set(id, result));
        if (notify) toast.error(result.error);
        return result;
      } finally {
        setTesting((current) => {
          const next = new Set(current);
          next.delete(id);
          return next;
        });
      }
    },
    [provider.id],
  );

  const testAll = async () => {
    const queue = accounts.filter((account) => account.status === "active");
    if (!queue.length) return;
    setTestingAll(true);
    let passed = 0;
    const workers = Array.from({ length: Math.min(5, queue.length) }, async () => {
      while (queue.length) {
        const account = queue.shift();
        if (!account) return;
        if ((await testAccount(account.id))?.ok) passed++;
      }
    });
    try {
      await Promise.all(workers);
      toast[passed === activeCount ? "success" : "error"](
        `${passed}/${activeCount} active account(s) reachable`,
      );
      await reload();
    } finally {
      setTestingAll(false);
    }
  };

  const toggleAccount = useCallback(
    async (id: string, enabled: boolean) => {
      setToggling((current) => new Set(current).add(id));
      try {
        await api.updateProviderAuth(provider.id, id, enabled);
        await reload();
      } catch (error) {
        toast.error((error as Error).message);
      } finally {
        setToggling((current) => {
          const next = new Set(current);
          next.delete(id);
          return next;
        });
      }
    },
    [provider.id, reload],
  );

  const removeAccount = useCallback(
    async (account: ProviderOAuthAccount) => {
      const label = account.account.email || account.account.label || mask(account.accessToken);
      if (!confirm(`Remove ${label}?`)) return;
      try {
        await api.deleteProviderAuth(provider.id, account.id);
        toast.success("Account removed");
        await reload();
      } catch (error) {
        toast.error((error as Error).message);
      }
    },
    [provider.id, reload],
  );

  const runBulk = async (operation: "enable" | "disable" | "remove") => {
    const ids = [...selected].filter((id) => {
      const account = accounts.find((item) => item.id === id);
      if (operation === "enable") return account?.status === "disabled";
      if (operation === "disable") return account?.status === "active";
      return !!account;
    });
    if (!ids.length) return;
    if (operation === "remove" && !confirm(`Remove ${ids.length} selected account(s)?`))
      return;
    try {
      await api.batchProviderAuth(provider.id, { [operation]: ids });
      setSelected(new Set());
      toast.success(`${ids.length} account(s) ${operation === "remove" ? "removed" : `${operation}d`}`);
      await reload();
    } catch (error) {
      toast.error((error as Error).message);
    }
  };

  const finishConnect = async () => {
    if (!session || session.state !== "ready" || !connectMode) return;
    setSaving(true);
    try {
      if (connectMode === "add")
        await api.addProviderAuth(provider.id, session.id);
      else await api.reconnectProviderAuth(provider.id, connectMode, session.id);
      setSession(null);
      setConnectMode(null);
      toast.success(connectMode === "add" ? "Account added" : "Account reconnected");
      await reload();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const cancelConnect = () => {
    if (session && session.state !== "consumed")
      void api.cancelProviderAuth(session.id).catch(() => {});
    setSession(null);
    setConnectMode(null);
  };

  return (
    <div className="space-y-6">
      <Card className="gap-0 overflow-hidden p-0">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
          {selected.size > 0 ? (
            <>
              <span className="mr-1 text-xs font-medium">{selected.size} selected</span>
              <Button variant="outline" size="sm" disabled={!canEnableSelected} onClick={() => void runBulk("enable")}>
                <Power className="h-3.5 w-3.5" /> Enable
              </Button>
              <Button variant="outline" size="sm" disabled={!canDisableSelected} onClick={() => void runBulk("disable")}>
                <PowerOff className="h-3.5 w-3.5" /> Disable
              </Button>
              <Button variant="destructive" size="sm" onClick={() => void runBulk("remove")}>
                <Trash2 className="h-3.5 w-3.5" /> Remove
              </Button>
            </>
          ) : (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="success">{activeCount} active</Badge>
              {disabledCount > 0 && <Badge variant="secondary">{disabledCount} disabled</Badge>}
            </div>
          )}
          <div className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-2 sm:flex-none">
            <TableSearch value={filter} onChange={setFilter} placeholder="Search accounts…" />
            <Button variant="outline" size="sm" onClick={() => void testAll()} disabled={testingAll || activeCount === 0}>
              {testingAll ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FlaskConical className="h-3.5 w-3.5" />}
              <span className="hidden lg:inline">Test active</span>
            </Button>
            <Button size="sm" onClick={() => setConnectMode("add")}>
              <Plus className="h-3.5 w-3.5" /> Add account
            </Button>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading accounts…
          </div>
        ) : accounts.length === 0 ? (
          <EmptyState msg="No connected accounts yet - add an account to begin routing requests" />
        ) : filteredRows.length === 0 ? (
          <EmptyState msg="No accounts match your search" />
        ) : (
          <div className="min-w-0" role="table" aria-label="OAuth accounts">
            <div ref={parentRef} className="no-scrollbar max-h-[28rem] overflow-x-auto overflow-y-auto">
              <div role="rowgroup">
                <div role="row" className={cn(GRID, "sticky top-0 z-10 h-8 items-center border-b border-border bg-muted/30 px-4 text-xs font-medium text-muted-foreground")}>
                  <div role="columnheader" className="flex justify-start pr-2">
                    <Checkbox checked={allVisibleSelected} onCheckedChange={(checked) => setSelected((current) => {
                      const next = new Set(current);
                      for (const row of filteredRows) checked ? next.add(row.id) : next.delete(row.id);
                      return next;
                    })} aria-label="Select all visible accounts" />
                  </div>
                  <div role="columnheader">Access token</div>
                  <div role="columnheader" className="hidden md:block">Email</div>
                  <div role="columnheader" className="hidden md:block">Name</div>
                  <div role="columnheader" className="hidden md:block">Expires</div>
                  <div role="columnheader">Status</div>
                  <div role="columnheader">Active</div>
                  <div role="columnheader" className="hidden text-right md:block">Success</div>
                  <div role="columnheader" className="hidden text-right md:block">Errors</div>
                  <div role="columnheader" className="text-right">Actions</div>
                </div>
              </div>
              <div role="rowgroup" style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative" }}>
                {virtualizer.getVirtualItems().map((virtualRow) => {
                  const account = filteredRows[virtualRow.index];
                  return (
                    <div key={account.id} role="presentation" style={{ position: "absolute", top: 0, left: 0, width: "100%", height: `${virtualRow.size}px`, transform: `translateY(${virtualRow.start - HEADER_HEIGHT}px)` }}>
                      <AccountRow
                        account={account}
                        selected={selected.has(account.id)}
                        revealed={revealed.has(account.id)}
                        testing={testing.has(account.id)}
                        toggling={toggling.has(account.id)}
                        result={results.get(account.id)}
                        onSelect={() => setSelected((current) => {
                          const next = new Set(current);
                          next.has(account.id) ? next.delete(account.id) : next.add(account.id);
                          return next;
                        })}
                        onReveal={() => setRevealed((current) => {
                          const next = new Set(current);
                          next.has(account.id) ? next.delete(account.id) : next.add(account.id);
                          return next;
                        })}
                        onToggle={(enabled) => void toggleAccount(account.id, enabled)}
                        onTest={() => void testAccount(account.id, true)}
                        onReconnect={() => {
                          setSession(null);
                          setConnectMode(account.id);
                        }}
                        onRemove={() => void removeAccount(account)}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </Card>

      {connectMode && template.authentication && (
        <Card className="p-4">
          <div className="mb-4">
            <div className="font-medium">{connectMode === "add" ? "Add account" : "Reconnect account"}</div>
            <p className="text-sm text-muted-foreground">Complete device authorization, then save the connection.</p>
          </div>
          <AuthStep tpl={template} session={session} onSession={setSession} />
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={cancelConnect}>Cancel</Button>
            {session?.state === "ready" && (
              <Button size="sm" onClick={() => void finishConnect()} disabled={saving}>
                {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save connection
              </Button>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}

function AccountRow({
  account,
  selected,
  revealed,
  testing,
  toggling,
  result,
  onSelect,
  onReveal,
  onToggle,
  onTest,
  onReconnect,
  onRemove,
}: {
  account: ProviderOAuthAccount;
  selected: boolean;
  revealed: boolean;
  testing: boolean;
  toggling: boolean;
  result?: ProviderTestProbe;
  onSelect: () => void;
  onReveal: () => void;
  onToggle: (enabled: boolean) => void;
  onTest: () => void;
  onReconnect: () => void;
  onRemove: () => void;
}) {
  const dead = account.status === "reauth_required" || !!account.health?.dead;
  const rateLimited = !!account.health?.rateLimitedUntil && new Date(account.health.rateLimitedUntil).getTime() > Date.now();
  const status = testing
    ? { dot: "bg-muted-foreground animate-pulse", tone: "text-muted-foreground", label: "Testing…" }
    : dead
      ? { dot: "bg-destructive", tone: "text-destructive", label: "Reconnect required" }
      : rateLimited
        ? { dot: "bg-amber-500", tone: "text-amber-700 dark:text-amber-300", label: "Rate limited" }
        : result
          ? result.ok
            ? { dot: "bg-success", tone: "text-success", label: `${result.ms} ms` }
            : { dot: "bg-destructive", tone: "text-destructive", label: result.status ? `Failed (${result.status})` : "Test failed" }
          : account.status === "disabled"
            ? { dot: "bg-muted-foreground/50", tone: "text-muted-foreground", label: "Disabled" }
            : { dot: "bg-success", tone: "text-success", label: "Connected" };
  return (
    <div role="row" className={cn(GRID, "h-14 items-center border-b border-border/70 px-4 text-sm transition-colors hover:bg-muted/30", selected && "bg-primary/5", dead && "bg-destructive/5", account.status === "disabled" && "text-muted-foreground")}>
      <div role="cell" className="flex justify-start pr-2"><Checkbox checked={selected} onCheckedChange={onSelect} aria-label={`Select ${account.account.email || mask(account.accessToken)}`} /></div>
      <div role="cell" className="flex min-w-0 items-center gap-1 pr-3">
        <span className="min-w-0 truncate font-mono text-sm text-foreground">{revealed ? account.accessToken : mask(account.accessToken)}</span>
        <ActionButton label="Copy access token" onClick={() => { void navigator.clipboard.writeText(account.accessToken); toast.success("Access token copied"); }}><Copy /></ActionButton>
      </div>
      <div role="cell" className="hidden min-w-0 truncate md:block">{account.account.email || "-"}</div>
      <div role="cell" className="hidden min-w-0 truncate md:block">{account.account.label || "-"}</div>
      <div role="cell" className="hidden min-w-0 truncate text-xs md:block" title={new Date(account.expiresAt).toLocaleString()}>{new Date(account.expiresAt).toLocaleDateString()}</div>
      <div role="cell" className="min-w-0"><span className={cn("flex min-w-0 items-center gap-1.5 text-xs", status.tone)}><span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", status.dot)} /><span className="truncate whitespace-nowrap">{status.label}</span></span></div>
      <div role="cell" className="flex items-center"><Switch checked={account.status === "active"} disabled={toggling || account.status === "reauth_required"} onCheckedChange={onToggle} aria-label={`${account.status === "active" ? "Disable" : "Enable"} account`} /></div>
      <div role="cell" className="hidden text-right font-mono text-success md:block">{account.stats.success}</div>
      <div role="cell" className={cn("hidden text-right font-mono md:block", account.stats.errors > 0 ? "text-destructive" : "text-muted-foreground")}>{account.stats.errors}</div>
      <div role="cell" className="flex items-center justify-end gap-1">
        <ActionButton label={revealed ? "Hide access token" : "Reveal access token"} onClick={onReveal}>{revealed ? <EyeOff /> : <Eye />}</ActionButton>
        <ActionButton label="Test account" disabled={testing || account.status !== "active"} onClick={onTest}>{testing ? <Loader2 className="animate-spin" /> : <FlaskConical />}</ActionButton>
        <ActionButton label="Reconnect account" onClick={onReconnect}><RefreshCw /></ActionButton>
        <ActionButton label="Remove account" destructive onClick={onRemove}><Trash2 /></ActionButton>
      </div>
    </div>
  );
}

function ActionButton({ label, destructive, children, ...props }: React.ComponentProps<typeof Button> & { label: string; destructive?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" className={cn("text-muted-foreground hover:text-foreground", destructive && "hover:text-destructive")} aria-label={label} {...props}>{children}</Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
