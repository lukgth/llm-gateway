import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Check,
  Copy,
  Download,
  Eye,
  EyeOff,
  FlaskConical,
  Loader2,
  Pencil,
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
import {
  EmptyState,
  Field,
  GridRowsSkeleton,
  TableSearch,
} from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
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
  "grid gap-3 grid-cols-[2.75rem_minmax(140px,1fr)_9rem_3rem_9rem] md:grid-cols-[2.75rem_13rem_minmax(7rem,0.7fr)_minmax(5rem,0.5fr)_8rem_11rem_3rem_3.5rem_3.5rem_11rem]";

function mask(token: string): string {
  if (token.length <= 10) return `${token.slice(0, 2)}…`;
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}

function relativeTime(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms)) return "-";
  const past = ms <= 0;
  const abs = Math.abs(ms);
  const min = Math.round(abs / 60000);
  if (min < 1) return "now";
  const unit =
    min < 60
      ? `${min}m`
      : min < 24 * 60
        ? `${Math.floor(min / 60)}h ${min % 60}m`
        : `${Math.round(min / 60 / 24)}d`;
  return past ? `${unit} ago` : `in ${unit}`;
}

function resetLabel(iso: string): string {
  const rt = relativeTime(iso);
  if (rt === "-") return "reset -";
  if (rt === "now") return "resets now";
  return rt.endsWith("ago") ? `reset ${rt}` : `resets ${rt}`;
}

// A token this integration never resolves an identity for (no email, no
// display name) - a long-lived, non-profile-scoped credential. For these the
// admin's own label doubles as the ONLY human-readable description of the
// account (there's nothing else to show), so the edit dialog treats it as a
// "what is this for" field rather than a cosmetic nickname.
function isUnidentified(account: ProviderOAuthAccount): boolean {
  return !account.account.email && !account.account.accountId;
}

interface MetadataEntry {
  key: string;
  value: string;
}

function metadataEntries(
  metadata: Record<string, string> | undefined,
): MetadataEntry[] {
  return Object.entries(metadata ?? {}).map(([key, value]) => ({ key, value }));
}

function buildMetadata(entries: MetadataEntry[]): {
  metadata?: Record<string, string>;
  error?: string;
} {
  const metadata: Record<string, string> = {};
  for (const entry of entries) {
    const key = entry.key.trim();
    if (!key) return { error: "Tag keys cannot be blank" };
    if (Object.hasOwn(metadata, key))
      return { error: `Duplicate tag key "${key}"` };
    metadata[key] = entry.value;
  }
  return { metadata };
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
  const [results, setResults] = useState<Map<string, ProviderTestProbe>>(
    new Map(),
  );
  const [testingAll, setTestingAll] = useState(false);
  const [session, setSession] = useState<ProviderAuthSession | null>(null);
  const [connectMode, setConnectMode] = useState<"add" | string | null>(null);
  const [saving, setSaving] = useState(false);
  const [editingAccount, setEditingAccount] =
    useState<ProviderOAuthAccount | null>(null);
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
        ...Object.entries(account.account.tags ?? {}).flat(),
      ].some((value) => value?.toLowerCase().includes(query)),
    );
  }, [accounts, filter]);
  const activeCount = accounts.filter(
    (account) => account.status === "active",
  ).length;
  const disabledCount = accounts.filter(
    (account) => account.status === "disabled",
  ).length;
  const visibleIds = useMemo(
    () => new Set(filteredRows.map((row) => row.id)),
    [filteredRows],
  );
  const visibleFailedIds = useMemo(
    () =>
      [...results.entries()]
        .filter(([id, result]) => visibleIds.has(id) && !result.ok)
        .map(([id]) => id),
    [results, visibleIds],
  );
  const selectedAccounts = accounts.filter((account) =>
    selected.has(account.id),
  );
  const canEnableSelected = selectedAccounts.some(
    (account) => account.status === "disabled",
  );
  const canDisableSelected = selectedAccounts.some(
    (account) => account.status === "active",
  );
  const allVisibleSelected =
    filteredRows.length > 0 &&
    filteredRows.every((row) => selected.has(row.id));

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
              : result.error ||
                  `Test failed${result.status ? ` (${result.status})` : ""}`,
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
    const workers = Array.from(
      { length: Math.min(5, queue.length) },
      async () => {
        while (queue.length) {
          const account = queue.shift();
          if (!account) return;
          if ((await testAccount(account.id))?.ok) passed++;
        }
      },
    );
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
      const label =
        account.account.email ||
        account.account.label ||
        mask(account.accessToken);
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
    if (
      operation === "remove" &&
      !confirm(`Remove ${ids.length} selected account(s)?`)
    )
      return;
    try {
      await api.batchProviderAuth(provider.id, { [operation]: ids });
      setSelected(new Set());
      toast.success(
        `${ids.length} account(s) ${operation === "remove" ? "removed" : `${operation}d`}`,
      );
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
      else
        await api.reconnectProviderAuth(provider.id, connectMode, session.id);
      setSession(null);
      setConnectMode(null);
      toast.success(
        connectMode === "add" ? "Account added" : "Account reconnected",
      );
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

  const selectFailed = () => {
    setSelected((current) => {
      const next = new Set(current);
      for (const id of visibleFailedIds) next.add(id);
      return next;
    });
  };

  const exportAccounts = (exportedAccounts: ProviderOAuthAccount[]) => {
    const content = exportedAccounts
      .map((account) => account.accessToken) // raw access tokens only; no labels/metadata
      .join("\n")
      .concat("\n");
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const safeProviderId =
      provider.id.replace(/[^a-zA-Z0-9._-]+/g, "-") || "provider";
    anchor.href = url;
    anchor.download = `${safeProviderId}-accounts.txt`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    toast.success(
      `Exported ${exportedAccounts.length} account${exportedAccounts.length === 1 ? "" : "s"}`,
    );
  };

  return (
    <div className="space-y-6">
      <Card className="gap-0 overflow-hidden p-0">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
          {selected.size > 0 ? (
            <>
              <span className="mr-1 text-xs font-medium">
                {selected.size} selected
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={!canEnableSelected}
                onClick={() => void runBulk("enable")}
              >
                <Power className="h-3.5 w-3.5" /> Enable
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!canDisableSelected}
                onClick={() => void runBulk("disable")}
              >
                <PowerOff className="h-3.5 w-3.5" /> Disable
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => void runBulk("remove")}
              >
                <Trash2 className="h-3.5 w-3.5" /> Remove
              </Button>
            </>
          ) : (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="success">{activeCount} active</Badge>
              {disabledCount > 0 && (
                <Badge variant="secondary">{disabledCount} disabled</Badge>
              )}
              {visibleFailedIds.length > 0 && (
                <Button variant="ghost" size="sm" onClick={selectFailed}>
                  Select {visibleFailedIds.length} failed
                </Button>
              )}
            </div>
          )}
          <div className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-2 sm:flex-none">
            <TableSearch
              value={filter}
              onChange={setFilter}
              placeholder="Search accounts…"
            />
            <Button
              variant="outline"
              size="sm"
              disabled={loading || accounts.length === 0}
              onClick={() =>
                exportAccounts(selected.size > 0 ? selectedAccounts : accounts)
              }
            >
              <Download className="h-3.5 w-3.5" />
              <span className="hidden lg:inline">
                Export {selected.size > 0 ? "selected" : "all"}
              </span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void testAll()}
              disabled={testingAll || activeCount === 0}
            >
              {testingAll ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <FlaskConical className="h-3.5 w-3.5" />
              )}
              <span className="hidden lg:inline">Test active</span>
            </Button>
            <Button size="sm" onClick={() => setConnectMode("add")}>
              <Plus className="h-3.5 w-3.5" /> Add account
            </Button>
          </div>
        </div>

        {loading ? (
          <div className="min-w-0" role="table" aria-label="OAuth accounts">
            <div className="no-scrollbar max-h-[28rem] overflow-x-auto overflow-y-auto">
              <div role="rowgroup">
                <div
                  role="row"
                  className={cn(
                    GRID,
                    "sticky top-0 z-10 h-8 items-center border-b border-border bg-muted/30 px-4 text-xs font-medium text-muted-foreground",
                  )}
                >
                  <div role="columnheader" className="flex justify-start pr-2">
                    <Checkbox
                      disabled
                      aria-label="Select all visible accounts"
                    />
                  </div>
                  <div role="columnheader">Access token</div>
                  <div role="columnheader" className="hidden md:block">
                    Email
                  </div>
                  <div role="columnheader" className="hidden md:block">
                    Info
                  </div>
                  <div role="columnheader" className="hidden md:block">
                    Expires
                  </div>
                  <div role="columnheader">Status</div>
                  <div role="columnheader">Active</div>
                  <div
                    role="columnheader"
                    className="hidden text-right md:block"
                  >
                    Success
                  </div>
                  <div
                    role="columnheader"
                    className="hidden text-right md:block"
                  >
                    Errors
                  </div>
                  <div role="columnheader" className="text-right">
                    Actions
                  </div>
                </div>
              </div>
              <GridRowsSkeleton
                gridClassName={GRID}
                cols={10}
                widths={[
                  "1.25rem",
                  "70%",
                  "60%",
                  "50%",
                  "40%",
                  "5rem",
                  "1.75rem",
                  "20%",
                  "20%",
                  "5rem",
                ]}
              />
            </div>
          </div>
        ) : accounts.length === 0 ? (
          <EmptyState msg="No connected accounts yet - add an account to begin routing requests" />
        ) : filteredRows.length === 0 ? (
          <EmptyState msg="No accounts match your search" />
        ) : (
          <div className="min-w-0" role="table" aria-label="OAuth accounts">
            <div
              ref={parentRef}
              className="no-scrollbar max-h-[28rem] overflow-x-auto overflow-y-auto"
            >
              <div role="rowgroup">
                <div
                  role="row"
                  className={cn(
                    GRID,
                    "sticky top-0 z-10 h-8 items-center border-b border-border bg-muted/30 px-4 text-xs font-medium text-muted-foreground",
                  )}
                >
                  <div role="columnheader" className="flex justify-start pr-2">
                    <Checkbox
                      checked={allVisibleSelected}
                      onCheckedChange={(checked) =>
                        setSelected((current) => {
                          const next = new Set(current);
                          for (const row of filteredRows)
                            checked ? next.add(row.id) : next.delete(row.id);
                          return next;
                        })
                      }
                      aria-label="Select all visible accounts"
                    />
                  </div>
                  <div role="columnheader">Access token</div>
                  <div role="columnheader" className="hidden md:block">
                    Email
                  </div>
                  <div role="columnheader" className="hidden md:block">
                    Info
                  </div>
                  <div role="columnheader" className="hidden md:block">
                    Expires
                  </div>
                  <div role="columnheader">Status</div>
                  <div role="columnheader">Active</div>
                  <div
                    role="columnheader"
                    className="hidden text-right md:block"
                  >
                    Success
                  </div>
                  <div
                    role="columnheader"
                    className="hidden text-right md:block"
                  >
                    Errors
                  </div>
                  <div role="columnheader" className="text-right">
                    Actions
                  </div>
                </div>
              </div>
              <div
                role="rowgroup"
                style={{
                  height: `${virtualizer.getTotalSize()}px`,
                  position: "relative",
                }}
              >
                {virtualizer.getVirtualItems().map((virtualRow) => {
                  const account = filteredRows[virtualRow.index];
                  return (
                    <div
                      key={account.id}
                      role="presentation"
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "100%",
                        height: `${virtualRow.size}px`,
                        transform: `translateY(${virtualRow.start - HEADER_HEIGHT}px)`,
                      }}
                    >
                      <AccountRow
                        account={account}
                        selected={selected.has(account.id)}
                        revealed={revealed.has(account.id)}
                        testing={testing.has(account.id)}
                        toggling={toggling.has(account.id)}
                        result={results.get(account.id)}
                        onSelect={() =>
                          setSelected((current) => {
                            const next = new Set(current);
                            next.has(account.id)
                              ? next.delete(account.id)
                              : next.add(account.id);
                            return next;
                          })
                        }
                        onReveal={() =>
                          setRevealed((current) => {
                            const next = new Set(current);
                            next.has(account.id)
                              ? next.delete(account.id)
                              : next.add(account.id);
                            return next;
                          })
                        }
                        onToggle={(enabled) =>
                          void toggleAccount(account.id, enabled)
                        }
                        onTest={() => void testAccount(account.id, true)}
                        onReconnect={() => {
                          setSession(null);
                          setConnectMode(account.id);
                        }}
                        onRemove={() => void removeAccount(account)}
                        onEdit={() => setEditingAccount(account)}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </Card>

      {connectMode === "add" && template.authentication?.flow === "import" && (
        <Card className="p-4">
          <div className="mb-4">
            <div className="font-medium">Add account(s)</div>
            <p className="text-sm text-muted-foreground">
              Paste credential JSON, or one or more bare tokens - one per line -
              to add several accounts at once.
            </p>
          </div>
          <BulkImportFlow
            providerId={provider.id}
            tpl={template}
            onDone={() => {
              setConnectMode(null);
              void reload();
            }}
            onCancel={cancelConnect}
          />
        </Card>
      )}

      {connectMode && connectMode !== "add" && template.authentication && (
        <Card className="p-4">
          <div className="mb-4">
            <div className="font-medium">Reconnect account</div>
            <p className="text-sm text-muted-foreground">
              Complete device authorization, then save the connection.
            </p>
          </div>
          <AuthStep tpl={template} session={session} onSession={setSession} />
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={cancelConnect}>
              Cancel
            </Button>
            {session?.state === "ready" && (
              <Button
                size="sm"
                onClick={() => void finishConnect()}
                disabled={saving}
              >
                {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save
                connection
              </Button>
            )}
          </div>
        </Card>
      )}

      {editingAccount && (
        <AccountEditDialog
          providerId={provider.id}
          account={editingAccount}
          onClose={() => setEditingAccount(null)}
          onSaved={async () => {
            setEditingAccount(null);
            await reload();
          }}
        />
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
  onEdit,
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
  onEdit: () => void;
}) {
  const tagCount = Object.keys(account.account.tags ?? {}).length;
  const dead = account.status === "reauth_required" || !!account.health?.dead;
  const rateLimitedUntil = account.health?.rateLimitedUntil;
  const rateLimited =
    !!rateLimitedUntil && new Date(rateLimitedUntil).getTime() > Date.now();
  const healthDetail = [
    account.health?.lastErrorStatus
      ? `Status ${account.health.lastErrorStatus}`
      : null,
    account.health?.lastError,
    account.health?.lastErrorAt
      ? `Observed ${new Date(account.health.lastErrorAt).toLocaleString()}`
      : null,
    rateLimited && !dead
      ? `Resets ${new Date(rateLimitedUntil!).toLocaleString()}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const status = testing
    ? {
        dot: "bg-muted-foreground animate-pulse",
        tone: "text-muted-foreground",
        label: "Testing…",
        title: "Running a live credential test",
      }
    : dead
      ? {
          dot: "bg-destructive",
          tone: "text-destructive",
          label: account.health?.lastErrorStatus
            ? `Reconnect required (${account.health.lastErrorStatus})`
            : "Reconnect required",
          title: healthDetail || "Credential rejected by the provider",
        }
      : rateLimited
        ? {
            dot: "bg-amber-500",
            tone: "text-amber-700 dark:text-amber-300",
            label: `Rate limited · ${resetLabel(rateLimitedUntil!)}`,
            title: healthDetail || "Rate limited by the provider",
          }
        : result
          ? result.ok
            ? {
                dot: "bg-success",
                tone: "text-success",
                label: `${result.ms} ms`,
                title: "Credential is reachable",
              }
            : {
                dot: "bg-destructive",
                tone: "text-destructive",
                label: result.status
                  ? `Failed (${result.status})`
                  : "Test failed",
                title: result.error || undefined,
              }
          : account.status === "disabled"
            ? {
                dot: "bg-muted-foreground/50",
                tone: "text-muted-foreground",
                label: "Disabled",
                title: undefined,
              }
            : {
                dot: "bg-success",
                tone: "text-success",
                label: "Connected",
                title: undefined,
              };
  return (
    <div
      role="row"
      className={cn(
        GRID,
        "h-14 items-center border-b border-border/70 px-4 text-sm transition-colors hover:bg-muted/30",
        selected && "bg-primary/5",
        dead && "bg-destructive/5",
        account.status === "disabled" && "text-muted-foreground",
      )}
    >
      <div role="cell" className="flex justify-start pr-2">
        <Checkbox
          checked={selected}
          onCheckedChange={onSelect}
          aria-label={`Select ${account.account.email || mask(account.accessToken)}`}
        />
      </div>
      <div role="cell" className="flex min-w-0 items-center gap-1 pr-3">
        <span className="min-w-0 truncate font-mono text-sm text-foreground">
          {revealed ? account.accessToken : mask(account.accessToken)}
        </span>
        <ActionButton
          label="Copy access token"
          onClick={() => {
            void navigator.clipboard.writeText(account.accessToken);
            toast.success("Access token copied");
          }}
        >
          <Copy />
        </ActionButton>
      </div>
      <div role="cell" className="hidden min-w-0 truncate md:block">
        {account.account.email || "-"}
      </div>
      <div
        role="cell"
        className="hidden min-w-0 flex-col justify-center gap-0.5 md:flex"
      >
        <span
          className="min-w-0 truncate"
          title={account.account.label || undefined}
        >
          {account.account.label || <span className="opacity-50">-</span>}
        </span>
        {(account.account.subscriptionType || tagCount > 0) && (
          <span className="flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground">
            {account.account.subscriptionType && (
              <span className="min-w-0 shrink truncate capitalize">
                {account.account.subscriptionType}
              </span>
            )}
            {tagCount > 0 && (
              <Badge
                variant="secondary"
                className="shrink-0 px-1 py-0 text-[10px] leading-4"
              >
                {tagCount} tag{tagCount === 1 ? "" : "s"}
              </Badge>
            )}
          </span>
        )}
      </div>
      <div
        role="cell"
        className="hidden min-w-0 truncate text-xs md:block"
        title={
          account.account.tokenKind === "long_lived"
            ? "This credential does not expire"
            : new Date(account.expiresAt).toLocaleString()
        }
      >
        {account.account.tokenKind === "long_lived"
          ? "Never"
          : new Date(account.expiresAt).toLocaleDateString()}
      </div>
      <div role="cell" className="min-w-0" title={status.title}>
        <span
          className={cn(
            "flex min-w-0 items-center gap-1.5 text-xs",
            status.tone,
          )}
        >
          <span
            className={cn("h-1.5 w-1.5 shrink-0 rounded-full", status.dot)}
          />
          <span className="truncate whitespace-nowrap">{status.label}</span>
        </span>
      </div>
      <div role="cell" className="flex items-center">
        <Switch
          checked={account.status === "active"}
          disabled={toggling || account.status === "reauth_required"}
          onCheckedChange={onToggle}
          aria-label={`${account.status === "active" ? "Disable" : "Enable"} account`}
        />
      </div>
      <div
        role="cell"
        className="hidden text-right font-mono text-success md:block"
      >
        {account.stats.success}
      </div>
      <div
        role="cell"
        className={cn(
          "hidden text-right font-mono md:block",
          account.stats.errors > 0
            ? "text-destructive"
            : "text-muted-foreground",
        )}
      >
        {account.stats.errors}
      </div>
      <div role="cell" className="flex items-center justify-end gap-1">
        <ActionButton
          label={revealed ? "Hide access token" : "Reveal access token"}
          onClick={onReveal}
        >
          {revealed ? <EyeOff /> : <Eye />}
        </ActionButton>
        <ActionButton label="Edit description and tags" onClick={onEdit}>
          <Pencil />
        </ActionButton>
        <ActionButton
          label="Test account"
          disabled={testing || account.status !== "active"}
          onClick={onTest}
        >
          {testing ? <Loader2 className="animate-spin" /> : <FlaskConical />}
        </ActionButton>
        <ActionButton label="Reconnect account" onClick={onReconnect}>
          <RefreshCw />
        </ActionButton>
        <ActionButton label="Remove account" destructive onClick={onRemove}>
          <Trash2 />
        </ActionButton>
      </div>
    </div>
  );
}

function ActionButton({
  label,
  destructive,
  children,
  ...props
}: React.ComponentProps<typeof Button> & {
  label: string;
  destructive?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className={cn(
            "text-muted-foreground hover:text-foreground",
            destructive && "hover:text-destructive",
          )}
          aria-label={label}
          {...props}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

// Edit an account's admin-owned display fields - never touches secrets,
// status, or expiry. For an unidentified credential (no email/accountId -
// see isUnidentified()) the label field IS the account's only description,
// so the copy below reframes accordingly instead of calling it a "label"
// the way the identified case would.
function AccountEditDialog({
  providerId,
  account,
  onClose,
  onSaved,
}: {
  providerId: string;
  account: ProviderOAuthAccount;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const unidentified = isUnidentified(account);
  const [label, setLabel] = useState(account.account.label ?? "");
  const [entries, setEntries] = useState<MetadataEntry[]>(() =>
    metadataEntries(account.account.tags),
  );
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const built = buildMetadata(entries);
    if (built.error) return toast.error(built.error);
    setSaving(true);
    try {
      await api.updateProviderAuthMetadata(providerId, account.id, {
        label: label.trim() || null,
        tags: built.metadata,
      });
      toast.success("Account updated");
      await onSaved();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit account</DialogTitle>
          <DialogDescription>
            {unidentified
              ? "This credential has no email or account id to identify it - the description below is the only way to tell it apart from others."
              : "Update the description and tags shown for this account."}
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className="grid gap-4">
            <Field label="Access token">
              <div className="relative">
                <Input
                  value={account.accessToken}
                  readOnly
                  className="pr-10 font-mono text-sm"
                  aria-label="Full access token"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Copy full token"
                  title="Copy full token"
                  className="absolute right-0.5 top-1/2 -translate-y-1/2"
                  onClick={() => {
                    void navigator.clipboard.writeText(account.accessToken);
                    toast.success("Token copied");
                  }}
                >
                  <Copy />
                </Button>
              </div>
            </Field>
            <Field label={unidentified ? "Description" : "Label"}>
              <Input
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder={
                  unidentified
                    ? 'What is this account for? e.g. "personal - max plan"'
                    : "Optional human-readable label"
                }
                autoFocus
              />
            </Field>
          </div>

          <div className="border-t border-border pt-4">
            <MetadataFields entries={entries} onChange={setEntries} />
          </div>

          <DialogFooter className="border-t border-border pt-4">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Check className="h-3.5 w-3.5" />
              )}
              Save changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function MetadataFields({
  entries,
  onChange,
}: {
  entries: MetadataEntry[];
  onChange: (entries: MetadataEntry[]) => void;
}) {
  const add = () => onChange([...entries, { key: "", value: "" }]);
  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <div>
          <div className="text-xs font-medium">Tags</div>
          <div className="text-xs text-muted-foreground">
            Optional values such as uuid, tier, or region.
          </div>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={add}>
          <Plus className="h-3.5 w-3.5" /> Add tag
        </Button>
      </div>
      {entries.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-3 text-xs text-muted-foreground">
          No tags.
        </p>
      ) : (
        <div className="max-h-56 space-y-3 overflow-y-auto pr-1">
          {entries.map((entry, index) => (
            <div
              key={index}
              className="grid grid-cols-[minmax(0,0.7fr)_minmax(0,1fr)_32px] gap-2"
            >
              <Input
                value={entry.key}
                onChange={(event) =>
                  onChange(
                    entries.map((item, itemIndex) =>
                      itemIndex === index
                        ? { ...item, key: event.target.value }
                        : item,
                    ),
                  )
                }
                placeholder="name"
                className="font-mono text-xs"
              />
              <Input
                value={entry.value}
                onChange={(event) =>
                  onChange(
                    entries.map((item, itemIndex) =>
                      itemIndex === index
                        ? { ...item, value: event.target.value }
                        : item,
                    ),
                  )
                }
                placeholder="value"
                className="font-mono text-xs"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Remove tag"
                className="text-muted-foreground hover:text-destructive"
                onClick={() =>
                  onChange(
                    entries.filter((_, itemIndex) => itemIndex !== index),
                  )
                }
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Splits pasted text into candidate credential blobs: one JSON object stays
// a single entry (a credential's own JSON can obviously contain newlines),
// while non-JSON input is split one entry per line so several bare tokens
// can be pasted and added at once. Blank lines and dupes are dropped.
function splitCredentials(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  try {
    JSON.parse(trimmed);
    return [trimmed];
  } catch {
    // not a single JSON blob - fall through to per-line splitting
  }
  return [
    ...new Set(
      trimmed
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
}

// Add one or more accounts to an existing provider. A single JSON blob (or a
// single bare token) behaves like the old one-shot import; several bare
// tokens - one per line - are imported and added one at a time, with a
// per-line result so a bad token in the middle of a big paste doesn't hide
// which ones actually failed.
function BulkImportFlow({
  providerId,
  tpl,
  onDone,
  onCancel,
}: {
  providerId: string;
  tpl: ProviderTemplate;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);

  const entries = useMemo(() => splitCredentials(value), [value]);

  const run = async () => {
    if (!entries.length || running) return;
    setRunning(true);
    setProgress({ done: 0, total: entries.length });
    let added = 0;
    const failures: string[] = [];
    for (const entry of entries) {
      try {
        const importedSession = await api.importProviderAuth(tpl.id, entry);
        await api.addProviderAuth(providerId, importedSession.id);
        added++;
      } catch (error) {
        failures.push((error as Error).message);
      }
      setProgress((current) => ({
        done: (current?.done ?? 0) + 1,
        total: entries.length,
      }));
    }
    setRunning(false);
    if (added) toast.success(`Added ${added} account${added === 1 ? "" : "s"}`);
    if (failures.length)
      toast.error(
        entries.length === 1
          ? failures[0]
          : `${failures.length} of ${entries.length} failed: ${failures[0]}`,
      );
    if (added) {
      setValue("");
      onDone();
    }
  };

  return (
    <div className="space-y-3">
      <Textarea
        value={value}
        onChange={(event) => setValue(event.target.value)}
        rows={8}
        spellCheck={false}
        autoComplete="off"
        autoFocus
        placeholder={
          tpl.id === "openai-codex"
            ? '{ "tokens": { "access_token": "…" } }\n\nor one or more bare personal access tokens, one per line'
            : '{ "claudeAiOauth": { "accessToken": "…" } }\n\nor one or more bare sk-ant-oat01-… tokens, one per line'
        }
        className="font-mono text-xs"
        disabled={running}
      />
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {entries.length === 0
            ? "Nothing to add yet"
            : entries.length === 1
              ? "1 credential ready"
              : `${entries.length} bare tokens ready - will be added as ${entries.length} separate accounts`}
        </span>
        {progress && (
          <span>
            {progress.done}/{progress.total} processed
          </span>
        )}
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={running}>
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={() => void run()}
          disabled={!entries.length || running}
        >
          {running && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {entries.length > 1
            ? `Add ${entries.length} accounts`
            : "Add account"}
        </Button>
      </div>
    </div>
  );
}
