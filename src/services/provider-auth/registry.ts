import { clinefreeAuth } from "./integrations/clinefree";
import { codexAuth } from "./integrations/codex";
import type { ProviderAuthIntegration } from "./types";

const INTEGRATIONS = new Map<string, ProviderAuthIntegration>([
  [clinefreeAuth.catalogId, clinefreeAuth],
  [codexAuth.catalogId, codexAuth],
]);

export function providerAuthIntegration(
  catalogId: string,
): ProviderAuthIntegration | undefined {
  return INTEGRATIONS.get(catalogId);
}

export function providerAuthIntegrationById(
  integrationId: string,
): ProviderAuthIntegration | undefined {
  for (const integration of INTEGRATIONS.values())
    if (integration.id === integrationId) return integration;
  return undefined;
}
