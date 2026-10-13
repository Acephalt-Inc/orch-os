// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0

export const preferenceValues = {
  "response-language": ["en", "zh"],
  "answer-length": ["short", "normal"],
} as const;

export type PreferenceKey = keyof typeof preferenceValues;
export type PreferenceValue<K extends PreferenceKey = PreferenceKey> = (typeof preferenceValues)[K][number];
export type PreferenceSettings = Partial<{ [K in PreferenceKey]: (typeof preferenceValues)[K][number] }>;

export interface StoredPreference {
  value: PreferenceValue;
  expires_at: string;
}

export interface PreferenceState {
  version: 1;
  revision: number;
  preferences: Partial<Record<PreferenceKey, StoredPreference>>;
}

export interface PreferenceView {
  source: "explicit-command";
  revision: number;
  preferences: PreferenceSettings;
  expiry: Partial<Record<PreferenceKey, string>>;
}

/** A refusal with the status the command reports: invalid 2, conflict 3, unavailable 4. Messages are fixed text. */
export class PreferenceError extends Error {
  constructor(readonly status: "invalid" | "conflict" | "unavailable", message: string) {
    super(message);
    this.name = "PreferenceError";
  }
}

export function isPreferenceKey(value: string): value is PreferenceKey {
  return Object.hasOwn(preferenceValues, value);
}

export function assertPreference(key: string, value: string): asserts key is PreferenceKey {
  if (!isPreferenceKey(key) || !(preferenceValues[key] as readonly string[]).includes(value)) {
    throw new PreferenceError("invalid", "invalid preference key or value");
  }
}

export function parseState(input: string): PreferenceState {
  let raw: unknown;
  try { raw = JSON.parse(input); } catch { throw new PreferenceError("unavailable", "preference state is corrupt"); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PreferenceError("unavailable", "preference state is corrupt");
  const object = raw as Record<string, unknown>;
  if (Object.keys(object).some((key) => !["version", "revision", "preferences"].includes(key)) ||
      object.version !== 1 || !Number.isSafeInteger(object.revision) || (object.revision as number) < 0 ||
      !object.preferences || typeof object.preferences !== "object" || Array.isArray(object.preferences)) {
    throw new PreferenceError("unavailable", "preference state is corrupt");
  }
  const preferences = object.preferences as Record<string, unknown>;
  for (const [key, entry] of Object.entries(preferences)) {
    if (!isPreferenceKey(key) || !entry || typeof entry !== "object" || Array.isArray(entry)) throw new PreferenceError("unavailable", "preference state is corrupt");
    const item = entry as Record<string, unknown>;
    if (Object.keys(item).some((field) => !["value", "expires_at"].includes(field)) ||
        typeof item.value !== "string" || !(preferenceValues[key] as readonly string[]).includes(item.value) ||
        typeof item.expires_at !== "string" || !Number.isFinite(Date.parse(item.expires_at))) throw new PreferenceError("unavailable", "preference state is corrupt");
  }
  return raw as PreferenceState;
}

/**
 * A pure filter over labels the caller supplies. It reads nothing and enforces nothing by itself:
 * whether a task is shared, and whether the host can keep contexts apart, is the caller's statement.
 */
export function personalDisplaySettings(view: PreferenceView, context: "personal" | "shared", hostCanSeparate: boolean): PreferenceSettings {
  if (context === "shared" || !hostCanSeparate) return {};
  return { ...view.preferences };
}
