import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { ProviderAuthSession, ProviderTemplate } from "@/lib/types";
import { ProviderIcon } from "@/components/model-icon";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export function AuthStep({
  tpl,
  session,
  onSession,
}: {
  tpl: ProviderTemplate;
  session: ProviderAuthSession | null;
  onSession: (session: ProviderAuthSession | null) => void;
}) {
  const [starting, setStarting] = useState(false);
  const polling = useRef(false);

  const start = useCallback(async () => {
    setStarting(true);
    try {
      if (session) await api.cancelProviderAuth(session.id).catch(() => {});
      onSession(await api.startProviderAuth(tpl.id));
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setStarting(false);
    }
  }, [onSession, session, tpl.id]);

  useEffect(() => {
    if (!session || session.state !== "pending") return;
    const next = session.nextPollAt
      ? Math.max(250, Date.parse(session.nextPollAt) - Date.now())
      : 1_000;
    const timer = window.setTimeout(async () => {
      if (polling.current) return;
      polling.current = true;
      try {
        onSession(await api.pollProviderAuth(session.id));
      } catch (error) {
        toast.error((error as Error).message);
      } finally {
        polling.current = false;
      }
    }, next);
    return () => window.clearTimeout(timer);
  }, [onSession, session]);

  const auth = tpl.authentication!;
  const verification = session?.verification;
  const terminal =
    session &&
    ["denied", "expired", "failed", "cancelled"].includes(session.state);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/30 p-3">
        <ProviderIcon brand={tpl.brand} name={tpl.label} className="size-5" />
        <div>
          <div className="text-sm font-medium">{auth.title}</div>
          <div className="text-xs text-muted-foreground">{auth.description}</div>
        </div>
      </div>

      {!session && (
        <div className="space-y-3 rounded-lg border border-border p-5 text-center">
          <p className="text-sm text-muted-foreground">
            This provider uses a device code, so no provider token is exposed to
            this browser.
          </p>
          <Button onClick={() => void start()} disabled={starting}>
            {starting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ExternalLink className="h-4 w-4" />
            )}
            {auth.actionLabel ?? "Connect account"}
          </Button>
        </div>
      )}

      {session?.state === "pending" && verification && (
        <div className="space-y-4 rounded-lg border border-border p-4">
          <div className="flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
            <span className="text-sm font-medium">Waiting for approval</span>
            <Badge variant="secondary" className="ml-auto">
              Device code
            </Badge>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Verification code</div>
            <div className="mt-1 flex items-center gap-2">
              <code className="flex-1 rounded-md bg-muted px-3 py-2 text-center text-lg font-semibold tracking-widest">
                {verification.userCode}
              </code>
              <Button
                variant="outline"
                size="icon"
                onClick={() => {
                  void navigator.clipboard.writeText(verification.userCode);
                  toast.success("Code copied");
                }}
                aria-label="Copy verification code"
              >
                <Copy className="h-4 w-4" />
              </Button>
            </div>
          </div>
          <Button
            className="w-full"
            onClick={() =>
              window.open(
                verification.uriComplete ?? verification.uri,
                "_blank",
                "noopener,noreferrer",
              )
            }
          >
            <ExternalLink className="h-4 w-4" />
            Open sign-in
          </Button>
          <p className="text-center text-xs text-muted-foreground">
            Complete sign-in in the new tab. This screen updates automatically.
          </p>
        </div>
      )}

      {session?.state === "ready" && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4">
          <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-300">
            <Check className="h-4 w-4" />
            <span className="text-sm font-medium">Account connected</span>
          </div>
          {(session.account?.email || session.account?.label) && (
            <p className="mt-1 pl-6 text-xs text-muted-foreground">
              {session.account.email ?? session.account.label}
            </p>
          )}
        </div>
      )}

      {terminal && (
        <div className="space-y-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4">
          <div className="text-sm font-medium">Authentication did not complete</div>
          <p className="text-xs text-muted-foreground">
            {session.error?.message ?? "Start a new device authorization."}
          </p>
          <Button
            variant="outline"
            onClick={() => void start()}
            disabled={starting}
          >
            <RefreshCw className="h-4 w-4" />
            Restart authentication
          </Button>
        </div>
      )}
    </div>
  );
}
