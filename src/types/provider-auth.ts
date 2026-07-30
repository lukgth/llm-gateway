import type { UpstreamModel } from "../formats/wire/models";

export interface ProviderTestProbe {
  ok: boolean;
  status: number | null;
  ms: number;
  error?: string;
  sample?: string;
  keyMask?: string;
  models: UpstreamModel[];
}
