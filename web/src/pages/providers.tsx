import { memo, useCallback, useEffect, useState } from "react";
import { Plus, Pencil, Trash2, Zap, Check, X } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import type {
  Provider,
  ProviderInput,
  ProviderTestResult,
  ProviderFormat,
} from "@/lib/types";
import { ENDPOINTS } from "@/lib/types";
import {
  PageHeader,
  Spinner,
  EmptyState,
  Field,
  Pagination,
} from "@/components/shared";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const SCHEMES = ["bearer", "xapikey", "both", "passthrough"] as const;

const PAGE_SIZE = 15;

export default function Providers() {
  const [items, setItems] = useState<Provider[] | null>(null);
  const [editing, setEditing] = useState<Provider | null>(null);
  const [creating, setCreating] = useState(false);
  const [page, setPage] = useState(0);

  const load = useCallback(
    () => api.listProviders().then(setItems).catch(toast.error),
    [],
  );
  useEffect(() => {
    load();
  }, [load]);

  const pageCount = Math.max(1, Math.ceil((items?.length ?? 0) / PAGE_SIZE));
  const visible = items?.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE) ?? [];

  return (
    <div>
      <PageHeader
        title="Providers"
        desc="Upstream LLM endpoints with retry, key rotation and fallback"
        meta={<Badge variant="secondary">{items?.length ?? 0} total</Badge>}
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-3.5 w-3.5" />
            New Provider
          </Button>
        }
      />

      <Card>
        <CardContent className="p-0">
          {!items ? (
            <Spinner />
          ) : items.length === 0 ? (
            <EmptyState msg="No providers yet — create one to route models through it" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Base URL</TableHead>
                  <TableHead>Format</TableHead>
                  <TableHead className="text-right">Keys</TableHead>
                  <TableHead className="text-right">Retries</TableHead>
                  <TableHead>Enabled</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((p) => (
                  <ProviderRow
                    key={p.id}
                    provider={p}
                    onChanged={load}
                    onEdit={setEditing}
                  />
                ))}
              </TableBody>
            </Table>
          )}
          {items && (
            <Pagination page={page} pageCount={pageCount} onChange={setPage} />
          )}
        </CardContent>
      </Card>

      {(creating || editing) && (
        <ProviderDialog
          provider={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={() => {
            setCreating(false);
            setEditing(null);
            load();
          }}
        />
      )}
    </div>
  );
}

const ProviderRow = memo(function ProviderRow({
  provider,
  onChanged,
  onEdit,
}: {
  provider: Provider;
  onChanged: () => void;
  onEdit: (p: Provider) => void;
}) {
  const [testing, setTesting] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [result, setResult] = useState<ProviderTestResult | null>(null);

  const toggle = async (enabled: boolean) => {
    setToggling(true);
    try {
      await api.updateProvider(provider.id, {
        name: provider.name,
        baseUrl: provider.baseUrl,
        enabled,
      });
      toast.success(
        enabled ? `${provider.name} enabled` : `${provider.name} disabled`,
      );
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setToggling(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      const r = await api.testProvider(provider.id);
      setResult(r);
      if (r.ok) toast.success(`${provider.name}: reachable (${r.ms}ms)`);
      else toast.error(`${provider.name}: ${r.error || `status ${r.status}`}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setTesting(false);
    }
  };

  const del = async () => {
    if (
      !confirm(
        `Delete provider '${provider.name}'? Models using it will lose this route.`,
      )
    )
      return;
    try {
      await api.deleteProvider(provider.id);
      toast.success("Provider deleted");
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <TableRow>
      <TableCell className="font-medium">{provider.name}</TableCell>
      <TableCell className="font-mono text-muted-foreground text-[0.7rem]">
        {provider.baseUrl}
      </TableCell>
      <TableCell>
        <Badge variant="secondary" className="capitalize">
          {provider.format}
        </Badge>
        {provider.nativeConversion && (
          <Badge variant="default" className="ml-1">
            Native
          </Badge>
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {provider.apiKeys.length}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {provider.retryAttempts}×{Math.round(provider.retryIntervalMs / 1000)}s
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-2">
          <Switch
            checked={provider.enabled}
            disabled={toggling}
            onCheckedChange={toggle}
            title={provider.enabled ? "Disable" : "Enable"}
          />
          {result && (
            <Badge variant={result.ok ? "success" : "destructive"}>
              {result.ok ? `${result.ms}ms` : "Failed"}
            </Badge>
          )}
        </div>
      </TableCell>
      <TableCell className="text-right">
        <div className="flex justify-end gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={test}
            disabled={testing}
            title="Test"
          >
            <Zap className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onEdit(provider)}
            title="Edit"
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="icon" onClick={del} title="Delete">
            <Trash2 className="h-3.5 w-3.5 text-destructive" />
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
});

function ProviderDialog({
  provider,
  onClose,
  onSaved,
}: {
  provider: Provider | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<ProviderInput>(() => ({
    name: provider?.name ?? "",
    baseUrl: provider?.baseUrl ?? "",
    host: provider?.host ?? "",
    authScheme: provider?.authScheme ?? "bearer",
    apiKeys: provider?.apiKeys ?? [],
    retryAttempts: provider?.retryAttempts ?? 1,
    retryIntervalMs: provider?.retryIntervalMs ?? 3000,
    requestTimeoutMs: provider?.requestTimeoutMs ?? 600000,
    tlsVerify: provider?.tlsVerify ?? true,
    enabled: provider?.enabled ?? true,
    extraHeaders: provider?.extraHeaders ?? {},
    format: provider?.format ?? "openai",
    endpoints: provider?.endpoints ?? ["/v1/chat/completions"],
    nativeConversion: provider?.nativeConversion ?? false,
  }));
  const [keysText, setKeysText] = useState(form.apiKeys!.join("\n"));
  const [headersText, setHeadersText] = useState(
    JSON.stringify(form.extraHeaders ?? {}, null, 2),
  );
  const [saving, setSaving] = useState(false);

  const set = <K extends keyof ProviderInput>(k: K, v: ProviderInput[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const changeFormat = (fmt: ProviderFormat) =>
    setForm((f) => ({
      ...f,
      format: fmt,
      endpoints:
        fmt === "anthropic" ? ["/v1/messages"] : ["/v1/chat/completions"],
    }));

  const toggleEndpoint = (ep: string) =>
    setForm((f) => {
      const has = (f.endpoints ?? []).includes(ep);
      return {
        ...f,
        endpoints: has
          ? (f.endpoints ?? []).filter((x) => x !== ep)
          : [...(f.endpoints ?? []), ep],
      };
    });

  const save = async () => {
    setSaving(true);
    let extraHeaders: Record<string, string> = {};
    try {
      extraHeaders = headersText.trim() ? JSON.parse(headersText) : {};
    } catch {
      toast.error("extra headers must be valid JSON");
      setSaving(false);
      return;
    }
    const payload: ProviderInput = {
      ...form,
      apiKeys: keysText
        .split("\n")
        .map((k) => k.trim())
        .filter(Boolean),
      extraHeaders,
    };
    try {
      if (provider) await api.updateProvider(provider.id, payload);
      else await api.createProvider(payload);
      toast.success(provider ? "Provider updated" : "Provider created");
      onSaved();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {provider ? "Edit Provider" : "New Provider"}
          </DialogTitle>
          <DialogDescription>
            An upstream OpenAI/Anthropic-compatible endpoint. Multiple keys are
            round-robin rotated; transient failures retry then fail over.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Name">
            <Input
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="openai"
            />
          </Field>
          <Field label="Base URL">
            <Input
              value={form.baseUrl}
              onChange={(e) => set("baseUrl", e.target.value)}
              placeholder="https://api.openai.com"
            />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Field
            label="Host header override"
            hint="blank = derive from base URL"
          >
            <Input
              value={form.host ?? ""}
              onChange={(e) => set("host", e.target.value || null)}
            />
          </Field>
          <Field label="Auth scheme">
            <Select
              value={form.authScheme}
              onValueChange={(v) =>
                set("authScheme", v as ProviderInput["authScheme"])
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SCHEMES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s === "bearer"
                      ? "Bearer"
                      : s === "xapikey"
                        ? "X-API-Key"
                        : s === "both"
                          ? "Both"
                          : "Passthrough"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>

        <div className="rounded-lg border border-border bg-card p-4 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Field
              label="Wire format"
              hint="anthropic = /v1/messages · openai = chat (and responses)"
            >
              <Select
                value={form.format}
                onValueChange={(v) => changeFormat(v as ProviderFormat)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="openai">OpenAI-Compatible</SelectItem>
                  <SelectItem value="anthropic">
                    Anthropic-Compatible
                  </SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Conversion policy">
              <Select
                value={form.nativeConversion ? "native" : "gateway"}
                onValueChange={(v) => set("nativeConversion", v === "native")}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="gateway">Gateway Converts</SelectItem>
                  <SelectItem value="native">
                    Provider Converts (Native)
                  </SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>

          <div>
            <span className="text-xs font-medium text-foreground">
              Supported endpoints
            </span>
            <p className="text-[0.65rem] text-muted-foreground mt-0.5 mb-2">
              {form.nativeConversion
                ? "Provider accepts either format and converts internally — the gateway forwards client requests unchanged."
                : "Gateway translates the client's request into the endpoint chosen per model below."}
            </p>
            <div className="flex flex-wrap gap-2">
              {ENDPOINTS.map((ep) => {
                const on = (form.endpoints ?? []).includes(ep);
                return (
                  <button
                    key={ep}
                    type="button"
                    onClick={() => toggleEndpoint(ep)}
                    className={
                      "cursor-pointer rounded-md border px-3 py-1.5 text-xs font-mono transition-colors " +
                      (on
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground")
                    }
                  >
                    {ep}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <Field
          label="API keys"
          hint="one per line — rotated round-robin across requests"
        >
          <Textarea
            value={keysText}
            onChange={(e) => setKeysText(e.target.value)}
            rows={3}
            placeholder={"sk-...\nsk-..."}
            className="font-mono"
          />
        </Field>

        <div className="grid grid-cols-3 gap-4">
          <Field label="Retry attempts">
            <Input
              type="number"
              min={1}
              value={form.retryAttempts}
              onChange={(e) => set("retryAttempts", Number(e.target.value))}
            />
          </Field>
          <Field label="Retry interval (ms)">
            <Input
              type="number"
              min={0}
              value={form.retryIntervalMs}
              onChange={(e) => set("retryIntervalMs", Number(e.target.value))}
            />
          </Field>
          <Field label="Timeout (ms)">
            <Input
              type="number"
              min={1000}
              value={form.requestTimeoutMs}
              onChange={(e) => set("requestTimeoutMs", Number(e.target.value))}
            />
          </Field>
        </div>

        <Field
          label="Extra upstream headers"
          hint="JSON object — merged onto every request"
        >
          <Textarea
            value={headersText}
            onChange={(e) => setHeadersText(e.target.value)}
            rows={3}
            className="font-mono"
            placeholder={'{\n  "anthropic-version": "2023-06-01"\n}'}
          />
        </Field>

        <div className="flex items-center gap-6">
          <label className="flex items-center gap-2">
            <Switch
              checked={form.tlsVerify}
              onCheckedChange={(v) => set("tlsVerify", v)}
            />
            <span className="text-xs font-medium text-muted-foreground normal-case">
              TLS verify
            </span>
          </label>
          <label className="flex items-center gap-2">
            <Switch
              checked={form.enabled}
              onCheckedChange={(v) => set("enabled", v)}
            />
            <span className="text-xs font-medium text-muted-foreground normal-case">
              Enabled
            </span>
          </label>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            <X className="h-3.5 w-3.5" />
            Cancel
          </Button>
          <Button
            onClick={save}
            disabled={saving || !form.name || !form.baseUrl}
          >
            <Check className="h-3.5 w-3.5" />
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
