// Admin REST API under /api. All endpoints (except auth/login and auth/check)
// require a valid admin session token. Mutations that affect the gateway's
// live view (providers, models, settings) trigger a registry reload so changes
// take effect without a restart.
//
// Split by concern into sibling modules (settings/providers/models/users/
// usage) - this file only wires the shared RouteCtx and registers each
// group's routes onto one Router.

import { Router } from "express";
import type { Database as DB } from "better-sqlite3";
import type { Logger } from "../../logger";
import type { GatewayRouter } from "../../gateway/router";
import type { AdminAuth } from "../../auth/admin-auth";
import { adminAuthMiddleware } from "../../auth/admin-auth";
import type { KeySyncService } from "../../services/key-sync";
import type { BootstrapConfig } from "../../config";
import type { ProviderAuthService } from "../../services/provider-auth/service";
import type { ProviderCredentialService } from "../../services/provider-credentials";
import { registerProviderAuthRoutes } from "./provider-auth";
import type { RouteCtx, BroadcastFn } from "./types";
import { registerSettingsRoutes } from "./settings";
import { registerProviderRoutes } from "./providers";
import { registerProviderKeyRoutes } from "./provider-keys";
import { registerModelRoutes } from "./models";
import { registerUserRoutes } from "./users";
import { registerUsageRoutes } from "./usage";

const noop: BroadcastFn = () => {};

export interface AdminRouterDependencies {
  db: DB;
  logger: Logger;
  router: GatewayRouter;
  auth: AdminAuth;
  bootstrap: BootstrapConfig;
  providerAuth: ProviderAuthService;
  providerCredentials: ProviderCredentialService;
  broadcast?: BroadcastFn;
  keySyncService?: KeySyncService;
}

export function adminRouter({
  db,
  logger,
  router,
  auth,
  bootstrap,
  providerAuth,
  providerCredentials,
  broadcast,
  keySyncService,
}: AdminRouterDependencies): Router {
  const r = Router();
  const requireAdmin = adminAuthMiddleware(auth.secret);
  const ctx: RouteCtx = {
    db,
    logger,
    router,
    r,
    requireAdmin,
    broadcast: broadcast ?? noop,
    bootstrap,
    providerAuth,
    providerCredentials,
    keySyncService,
  };

  registerSettingsRoutes(ctx, auth);
  registerProviderAuthRoutes(ctx);
  registerProviderRoutes(ctx);
  registerProviderKeyRoutes(ctx);
  registerModelRoutes(ctx);
  registerUserRoutes(ctx);
  registerUsageRoutes(ctx);

  return r;
}
