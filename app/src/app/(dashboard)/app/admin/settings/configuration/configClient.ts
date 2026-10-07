// /app/src/app/(dashboard)/app/admin/settings/configuration/configClient.ts
//
// Thin fetch wrappers over /api/admin/config/**, shared by every panel on
// this page. One copy of each call so the request/response shapes (from
// lib/config/presetApiTypes.ts) are used consistently rather than each
// panel hand-rolling its own axios call.

import axios from "axios";

import type { PresetBundle } from "@/lib/config/presetSchema";
import type { PresetFormat } from "@/lib/config/presetSerialize";
import type {
  ApplyRequestBody,
  ApplyResponse,
  ChangesResponse,
  PresetsGetResponse,
  ValidateResponse,
} from "@/lib/config/presetApiTypes";

export async function fetchConfigState(): Promise<PresetsGetResponse> {
  const res = await axios.get<PresetsGetResponse>("/api/admin/config/presets");
  return res.data;
}

/**
 * Preview or apply a bundle. `dryRun: true` (the default everywhere this is
 * called from) computes and returns the diff without writing -- see
 * pages/api/admin/config/presets/apply.ts for why the server enforces this
 * default too, not just the callers here.
 */
export async function applyConfigBundle(
  bundle: PresetBundle,
  dryRun: boolean,
): Promise<ApplyResponse> {
  const body: ApplyRequestBody = { bundle, dryRun };
  const res = await axios.post<ApplyResponse>("/api/admin/config/presets/apply", body);
  return res.data;
}

export async function validateConfigText(
  text: string,
  format?: PresetFormat,
): Promise<ValidateResponse> {
  const res = await axios.post<ValidateResponse>("/api/admin/config/presets/validate", {
    text,
    format,
  });
  return res.data;
}

export async function fetchConfigChanges(page: number, limit: number): Promise<ChangesResponse> {
  const res = await axios.get<ChangesResponse>("/api/admin/config/changes", {
    params: { page, limit },
  });
  return res.data;
}

export function exportUrl(format: PresetFormat): string {
  return `/api/admin/config/presets/export?format=${format}`;
}
