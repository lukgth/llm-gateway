// One-time DB migration: the "claude-code" catalogId switched from a plain
// apiKeys-based provider to a fully managed-auth provider (see
// services/provider-auth/integrations/claude-code.ts - same unified,
// import-only pattern as Codex/openai-codex). The engine picks credential
// source (plain apiKeys table vs. managed-auth candidates()) PER CATALOG ID
// (gateway/engine.ts requiresManagedAuth), not per provider row, so any
// existing "claude-code" provider with plain API keys configured would go
// dark the instant this ships - the engine would simply stop reading them.
//
// This migration keeps those keys working with zero action required: every
// plain-text key on a "claude-code" provider row is re-inserted as an
// encrypted managed-auth credential (via the same createProviderOAuth() path
// the import UI uses) and the original plaintext row is removed.
//
// All pre-existing "claude-code" keys are migrated as plain, non-refreshing
// Console API-key credentials (tokenKind: "long_lived", authKind:
// "api_key") - NOT as OAuth tokens. Every real Claude Code OAuth token
// starts with the sk-ant-oat01- prefix (see
// providers/claude-code-oauth.ts's CLAUDE_OAUTH_TOKEN_PREFIX); a key that
// predates this migration and doesn't carry that prefix is definitionally a
// plain key, so there is no ambiguity to detect here.

import type { Database as DB } from "better-sqlite3";
import type { ProviderAuthCrypto } from "../services/provider-auth/crypto";
import { createProviderOAuth } from "../repo/provider-oauth";
import {
  listProviderKeys,
  deleteProviderKeysByProvider,
} from "../repo/provider-keys";
import { NEVER_EXPIRES, type ProviderAuthCredential } from "../services/provider-auth/types";
import { CLAUDE_OAUTH_TOKEN_PREFIX } from "../providers/claude-code-oauth";

export function migrateClaudeCodePlainKeysToManagedAuth(
  db: DB,
  crypto: ProviderAuthCrypto,
): void {
  const providers = db
    .prepare(`SELECT id FROM providers WHERE catalog_id = 'claude-code'`)
    .all() as Array<{ id: string }>;
  if (!providers.length) return;

  for (const { id: providerId } of providers) {
    const keys = listProviderKeys(db, providerId);
    if (!keys.length) continue;

    const tx = db.transaction(() => {
      for (const key of keys) {
        // Every real OAuth-derived token (long-lived or refreshable) carries
        // this prefix; a pre-migration key without it is a plain Console API
        // key by definition - not a heuristic, an invariant of the prefix's
        // own design (CLAUDE_OAUTH_TOKEN_PREFIX doc comment).
        const isOAuthToken = key.credential.startsWith(CLAUDE_OAUTH_TOKEN_PREFIX);
        const credential: ProviderAuthCredential = {
          integrationId: "claude-code",
          secrets: { accessToken: key.credential },
          expiresAt: NEVER_EXPIRES,
          account: {
            tokenKind: "long_lived",
            authKind: isOAuthToken ? "oauth_token" : "api_key",
            label: key.label ?? undefined,
          },
        };
        createProviderOAuth(db, crypto, providerId, credential);
      }
      deleteProviderKeysByProvider(db, providerId);
    });
    tx();
  }
}
