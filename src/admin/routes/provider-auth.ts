import type { AdminRequest } from "../../auth/admin-auth";
import { KeyHealthStore } from "../../gateway/key-health";
import { getProvider } from "../../repo/providers";
import { getProviderTemplate } from "../../providers";
import { keyStats } from "../../repo/request-logs";
import {
  batchProviderOAuth,
  deleteProviderOAuth,
  setProviderOAuthEnabled,
  type BatchOAuthOps,
} from "../../repo/provider-oauth";
import { str } from "./parsers";
import { bad } from "./respond";
import type { RouteCtx } from "./types";

function owner(req: AdminRequest): string {
  if (!req.__adminSessionBinding) throw new Error("Admin session binding missing");
  return req.__adminSessionBinding;
}

function parseBatchOAuth(value: unknown): BatchOAuthOps {
  const input = value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
  const ids = (name: string): string[] | undefined => {
    const raw = input[name];
    if (raw === undefined) return undefined;
    if (!Array.isArray(raw) || raw.some((id) => typeof id !== "string"))
      throw new Error(`${name} must be an array of account ids`);
    return raw as string[];
  };
  return {
    enable: ids("enable"),
    disable: ids("disable"),
    remove: ids("remove"),
  };
}

export function registerProviderAuthRoutes(ctx: RouteCtx): void {
  const { r, requireAdmin, providerAuth, providerCredentials } = ctx;

  const reload = () => {
    ctx.router.reload();
    ctx.broadcast(["providers", "overview"], "provider:auth-update");
  };

  const provider = (id: string) => getProvider(ctx.db, id);
  const oauthProvider = (id: string, res: import("express").Response) => {
    const current = provider(id);
    if (!current) {
      res.status(404).json({ error: { message: "not found" } });
      return null;
    }
    if (
      !current.catalogId ||
      getProviderTemplate(current.catalogId)?.supportsOAuth !== true
    ) {
      res.status(400).json({
        error: { message: "Provider does not support managed OAuth" },
      });
      return null;
    }
    return current;
  };

  r.post("/provider-auth/sessions", requireAdmin, async (req, res) => {
    try {
      const catalogId = str((req.body as Record<string, unknown>)?.catalogId);
      if (!catalogId) throw new Error("catalogId is required");
      res.status(201).json(await providerAuth.begin(catalogId, owner(req)));
    } catch (error) {
      bad(res, error);
    }
  });

  r.get("/provider-auth/sessions/:id", requireAdmin, (req, res) => {
    try {
      res.json(providerAuth.get(String(req.params.id), owner(req)));
    } catch (error) {
      bad(res, error);
    }
  });

  r.post("/provider-auth/sessions/:id/poll", requireAdmin, async (req, res) => {
    try {
      res.json(await providerAuth.poll(String(req.params.id), owner(req)));
    } catch (error) {
      bad(res, error);
    }
  });

  r.post("/provider-auth/sessions/:id/test", requireAdmin, async (req, res) => {
    try {
      res.json(await providerAuth.test(String(req.params.id), owner(req)));
    } catch (error) {
      bad(res, error);
    }
  });

  r.delete("/provider-auth/sessions/:id", requireAdmin, (req, res) => {
    try {
      providerAuth.cancel(String(req.params.id), owner(req));
      res.status(204).end();
    } catch (error) {
      bad(res, error);
    }
  });

  r.get("/providers/:id/auth", requireAdmin, (req, res) => {
    const current = oauthProvider(String(req.params.id), res);
    if (!current)
      return res.status(404).json({ error: { message: "not found" } });
    const accounts = providerCredentials.adminViews(current.id);
    const health = new KeyHealthStore(ctx.db);
    const stats = new Map(
      keyStats(ctx.db, current.id).map((value) => [value.credHash, value]),
    );
    res.json({
      accounts: accounts.map((account) => {
        const snapshot = health.snapshot(current.id, account.credHash);
        const usage = stats.get(account.credHash);
        return {
          ...account,
          health: {
            usable: snapshot.usable,
            dead: snapshot.authFailed,
            ...(snapshot.rateLimitedUntilIso
              ? { rateLimitedUntil: snapshot.rateLimitedUntilIso }
              : {}),
            ...(snapshot.lastErrorStatus !== null
              ? { lastErrorStatus: snapshot.lastErrorStatus }
              : {}),
            ...(snapshot.lastError ? { lastError: snapshot.lastError } : {}),
            ...(snapshot.lastErrorAt
              ? { lastErrorAt: snapshot.lastErrorAt }
              : {}),
          },
          stats: {
            success: usage?.success ?? 0,
            errors: (usage?.errors ?? 0) + snapshot.authFailCount,
          },
        };
      }),
    });
  });

  r.post("/providers/:id/auth", requireAdmin, (req, res) => {
    try {
      const current = oauthProvider(String(req.params.id), res);
      if (!current)
        return res.status(404).json({ error: { message: "not found" } });
      const sessionId = str((req.body as Record<string, unknown>)?.sessionId);
      if (!sessionId) throw new Error("sessionId is required");
      const view = providerAuth.addAccount(
        sessionId,
        owner(req),
        current.id,
        current.catalogId,
      );
      reload();
      res.status(201).json(view);
    } catch (error) {
      bad(res, error);
    }
  });

  r.post("/providers/:id/auth/batch", requireAdmin, (req, res) => {
    const current = oauthProvider(String(req.params.id), res);
    if (!current)
      return res.status(404).json({ error: { message: "not found" } });
    try {
      const result = batchProviderOAuth(
        ctx.db,
        current.id,
        parseBatchOAuth(req.body),
      );
      reload();
      res.json(result);
    } catch (error) {
      bad(res, error);
    }
  });

  r.put("/providers/:id/auth/:accountId", requireAdmin, (req, res) => {
    try {
      const current = oauthProvider(String(req.params.id), res);
      if (!current)
        return res.status(404).json({ error: { message: "not found" } });
      const enabled = (req.body as Record<string, unknown>)?.enabled;
      if (typeof enabled !== "boolean") throw new Error("enabled is required");
      const view = setProviderOAuthEnabled(
        ctx.db,
        current.id,
        String(req.params.accountId),
        enabled,
      );
      if (!view)
        return res.status(404).json({ error: { message: "not found" } });
      reload();
      res.json(view);
    } catch (error) {
      bad(res, error);
    }
  });

  r.post("/providers/:id/auth/:accountId/test", requireAdmin, async (req, res) => {
    const current = oauthProvider(String(req.params.id), res);
    if (!current)
      return res.status(404).json({ error: { message: "not found" } });
    try {
      const accountId = String(req.params.accountId);
      const result = await providerCredentials.testManaged(current.id, accountId);
      if (result.ok) {
        const account = providerCredentials
          .views(current.id)
          .find((item) => item.id === accountId);
        if (account)
          new KeyHealthStore(ctx.db).recordSuccess(
            current.id,
            account.credHash,
            null,
          );
      }
      ctx.broadcast(["providers"], "provider:auth-test");
      res.json(result);
    } catch (error) {
      bad(res, error);
    }
  });

  r.post(
    "/providers/:id/auth/:accountId/reconnect",
    requireAdmin,
    (req, res) => {
      try {
        const current = oauthProvider(String(req.params.id), res);
        if (!current)
          return res.status(404).json({ error: { message: "not found" } });
        const sessionId = str((req.body as Record<string, unknown>)?.sessionId);
        if (!sessionId) throw new Error("sessionId is required");
        const view = providerAuth.reconnect(
          sessionId,
          owner(req),
          current.id,
          String(req.params.accountId),
          current.catalogId,
        );
        reload();
        res.json(view);
      } catch (error) {
        bad(res, error);
      }
    },
  );

  r.delete("/providers/:id/auth/:accountId", requireAdmin, (req, res) => {
    const current = oauthProvider(String(req.params.id), res);
    if (!current)
      return res.status(404).json({ error: { message: "not found" } });
    if (
      !deleteProviderOAuth(
        ctx.db,
        current.id,
        String(req.params.accountId),
      )
    )
      return res.status(404).json({ error: { message: "not connected" } });
    reload();
    res.status(204).end();
  });
}
