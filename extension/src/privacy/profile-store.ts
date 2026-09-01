import type { SensitiveEntityType } from "./privacy-types";

export type LocalProfileField = string;
export type LocalProfileValues = Record<string, string | undefined>;

export interface LocalProfileEntry {
  id: string;
  label: string;
  createdAt: number;
  values: LocalProfileValues;
}

interface EncryptedProfileEntry {
  id: string;
  createdAt: number;
  cipherText: string;
  iv: string;
  version: 2;
}

export const LOCAL_PROFILE_STORE_KEY = "rv_local_profiles_v2";
export const LEGACY_LOCAL_PROFILE_STORE_KEY = "rv_local_profiles_v1";
export const LOCAL_SELECTED_PROFILE_KEY = "rv_selected_profile_id";

const DB_NAME = "redactvision-private-vault";
const DB_VERSION = 1;
const KEY_STORE = "keys";
const PROFILE_KEY_ID = "profile-aes-gcm-v1";

const FIELD_ALIASES: Record<string, string> = {
  full_name: "name",
  fullname: "name",
  "full-name": "name",
  e_mail: "email",
  "e-mail": "email",
  mobile: "phone",
  telephone: "phone",
  tel: "phone",
  pan: "pan_card",
  "pan card": "pan_card",
  pancard: "pan_card",
  aadhaar: "aadhaar",
  aadhar: "aadhaar",
  job_title: "job_title",
  "job-title": "job_title",
};

function hasChromeStorage(): boolean {
  return (
    typeof chrome !== "undefined" &&
    !!chrome.storage?.local &&
    typeof chrome.storage.local.get === "function"
  );
}

function isPlainString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function normalizeFieldKey(field: string): string {
  const compact = field
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return FIELD_ALIASES[compact] || compact || "field";
}

export function normalizeProfileValues(values: LocalProfileValues): LocalProfileValues {
  const normalized: LocalProfileValues = {};
  for (const [field, value] of Object.entries(values || {})) {
    if (!isPlainString(value)) continue;
    normalized[normalizeFieldKey(field)] = value.trim();
  }
  return normalized;
}

function renderProfileLabel(values: LocalProfileValues, fallback = "Saved profile"): string {
  const preferred = values.name || values.email || values.phone;
  if (preferred && preferred.trim()) return preferred.trim();
  const first = Object.values(values).find((value) => value && value.trim());
  return first?.trim() || fallback;
}

function normalizeProfile(profile: Partial<LocalProfileEntry>): LocalProfileEntry | null {
  if (!profile || typeof profile !== "object") return null;
  const id = typeof profile.id === "string" ? profile.id : null;
  const createdAt = typeof profile.createdAt === "number" ? profile.createdAt : Date.now();
  const values =
    profile.values && typeof profile.values === "object"
      ? normalizeProfileValues(profile.values as LocalProfileValues)
      : {};
  const label = isPlainString(profile.label)
    ? profile.label.trim()
    : renderProfileLabel(values);

  if (!id || Object.keys(values).length === 0) return null;

  return { id, label, createdAt, values };
}

async function openVaultDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(KEY_STORE)) {
        db.createObjectStore(KEY_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("Could not open profile vault"));
  });
}

async function idbGet<T>(key: string): Promise<T | null> {
  const db = await openVaultDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KEY_STORE, "readonly");
    const req = tx.objectStore(KEY_STORE).get(key);
    req.onsuccess = () => resolve((req.result as T | undefined) ?? null);
    req.onerror = () => reject(req.error || new Error("Could not read profile key"));
    tx.oncomplete = () => db.close();
  });
}

async function idbSet<T>(key: string, value: T): Promise<void> {
  const db = await openVaultDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KEY_STORE, "readwrite");
    tx.objectStore(KEY_STORE).put(value, key);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error || new Error("Could not persist profile key"));
    };
  });
}

async function getVaultKey(): Promise<CryptoKey> {
  if (!globalThis.crypto?.subtle || typeof indexedDB === "undefined") {
    throw new Error("WebCrypto and IndexedDB are required for secure profile storage");
  }

  const existing = await idbGet<CryptoKey>(PROFILE_KEY_ID);
  if (existing) return existing;

  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
  await idbSet(PROFILE_KEY_ID, key);
  return key;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64ToArrayBuffer(value: string): ArrayBuffer {
  const bytes = base64ToBytes(value);
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

async function encryptProfile(profile: LocalProfileEntry): Promise<EncryptedProfileEntry> {
  const key = await getVaultKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plainText = new TextEncoder().encode(
    JSON.stringify({
      label: profile.label,
      values: normalizeProfileValues(profile.values),
    })
  );
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plainText);
  return {
    id: profile.id,
    createdAt: profile.createdAt,
    cipherText: bytesToBase64(new Uint8Array(cipher)),
    iv: bytesToBase64(iv),
    version: 2,
  };
}

async function decryptProfile(entry: EncryptedProfileEntry): Promise<LocalProfileEntry | null> {
  try {
    const key = await getVaultKey();
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToArrayBuffer(entry.iv) },
      key,
      base64ToArrayBuffer(entry.cipherText)
    );
    const decoded = JSON.parse(new TextDecoder().decode(plain)) as Partial<LocalProfileEntry>;
    return normalizeProfile({
      id: entry.id,
      createdAt: entry.createdAt,
      label: decoded.label,
      values: decoded.values,
    });
  } catch {
    return null;
  }
}

async function loadLegacyProfiles(): Promise<LocalProfileEntry[]> {
  if (!hasChromeStorage()) return [];
  try {
    const stored = await chrome.storage.local.get(LEGACY_LOCAL_PROFILE_STORE_KEY);
    const list = stored?.[LEGACY_LOCAL_PROFILE_STORE_KEY];
    if (!Array.isArray(list)) return [];
    return list
      .map((entry) => normalizeProfile(entry as Partial<LocalProfileEntry>))
      .filter((entry): entry is LocalProfileEntry => entry !== null);
  } catch {
    return [];
  }
}

export async function loadLocalProfiles(): Promise<LocalProfileEntry[]> {
  if (!hasChromeStorage()) return [];

  try {
    const stored = await chrome.storage.local.get(LOCAL_PROFILE_STORE_KEY);
    const encrypted = stored?.[LOCAL_PROFILE_STORE_KEY];
    if (Array.isArray(encrypted) && encrypted.length > 0) {
      const profiles = await Promise.all(
        encrypted.map((entry) => decryptProfile(entry as EncryptedProfileEntry))
      );
      return profiles
        .filter((entry): entry is LocalProfileEntry => entry !== null)
        .sort((a, b) => a.createdAt - b.createdAt);
    }
  } catch {
    return [];
  }

  const legacy = await loadLegacyProfiles();
  if (legacy.length > 0) {
    await saveLocalProfiles(legacy);
    try {
      await chrome.storage.local.remove(LEGACY_LOCAL_PROFILE_STORE_KEY);
    } catch {
      /* ignore */
    }
  }
  return legacy;
}

export async function saveLocalProfiles(profiles: LocalProfileEntry[]): Promise<void> {
  if (!hasChromeStorage()) return;
  const normalized = profiles
    .map((entry) => normalizeProfile(entry))
    .filter((entry): entry is LocalProfileEntry => entry !== null);
  const encrypted = await Promise.all(normalized.map((entry) => encryptProfile(entry)));
  await chrome.storage.local.set({ [LOCAL_PROFILE_STORE_KEY]: encrypted });
}

export async function getSelectedProfileId(): Promise<string | null> {
  if (!hasChromeStorage()) return null;
  try {
    const stored = await chrome.storage.local.get(LOCAL_SELECTED_PROFILE_KEY);
    const profileId = stored?.[LOCAL_SELECTED_PROFILE_KEY];
    return typeof profileId === "string" && profileId.length > 0 ? profileId : null;
  } catch {
    return null;
  }
}

export async function setSelectedProfileId(profileId: string | null): Promise<void> {
  if (!hasChromeStorage()) return;
  try {
    if (profileId) {
      await chrome.storage.local.set({ [LOCAL_SELECTED_PROFILE_KEY]: profileId });
      return;
    }
    await chrome.storage.local.remove(LOCAL_SELECTED_PROFILE_KEY);
  } catch {
    /* ignore */
  }
}

export async function getSelectedProfile(): Promise<LocalProfileEntry | null> {
  const profiles = await loadLocalProfiles();
  if (profiles.length === 0) return null;

  const selectedId = await getSelectedProfileId();
  if (selectedId) {
    const selected = profiles.find((profile) => profile.id === selectedId);
    if (selected) return selected;
  }

  // Fallback: if no profile is selected but profiles exist, auto-select the first one.
  // This handles the case where a profile was created/imported without explicit selection.
  const firstProfile = profiles[0];
  await setSelectedProfileId(firstProfile.id);
  return firstProfile;
}

export async function upsertLocalProfile(profile: LocalProfileEntry): Promise<void> {
  const normalized = normalizeProfile(profile);
  if (!normalized) return;
  const profiles = await loadLocalProfiles();
  const next = profiles.filter((entry) => entry.id !== normalized.id);
  next.push(normalized);
  await saveLocalProfiles(next);
}

export async function removeLocalProfile(profileId: string): Promise<void> {
  const profiles = await loadLocalProfiles();
  const next = profiles.filter((entry) => entry.id !== profileId);
  await saveLocalProfiles(next);
  if ((await getSelectedProfileId()) === profileId) {
    await setSelectedProfileId(next.length === 1 ? next[0].id : null);
  }
}

export function getProfileFieldForSensitiveType(type: SensitiveEntityType): keyof LocalProfileValues | null {
  switch (type) {
    case "PERSON":
      return "name";
    case "EMAIL":
      return "email";
    case "PHONE":
      return "phone";
    case "PASSWORD":
      return "password";
    case "CARD":
      return "card";
    case "AADHAAR":
      return "aadhaar";
    default:
      return null;
  }
}

export function findProfilesContainingValue(
  profiles: LocalProfileEntry[],
  field: keyof LocalProfileValues,
  value: string
): LocalProfileEntry[] {
  const normalized = value.trim().toLowerCase();
  const key = normalizeFieldKey(String(field));
  return profiles.filter((profile) => {
    const candidate = profile.values[key]?.trim().toLowerCase();
    return !!candidate && candidate === normalized;
  });
}

export function getMatchingProfileCandidates(
  profiles: LocalProfileEntry[],
  type: SensitiveEntityType,
  originalValue: string
): LocalProfileEntry[] {
  const field = getProfileFieldForSensitiveType(type);
  if (!field) return [];
  return findProfilesContainingValue(profiles, field, originalValue);
}

export function buildProfileToken(field: string): string {
  return `[PROFILE:${normalizeFieldKey(field)}]`;
}

export function parseProfileToken(token: string): string | null {
  const match = token.match(/^\[PROFILE:([a-z0-9_ -]+)\]$/i);
  return match ? normalizeFieldKey(match[1]) : null;
}

export function buildProfileTokenMap(profile: LocalProfileEntry | null): Record<string, string> {
  const tokenMap: Record<string, string> = {};
  if (!profile) return tokenMap;
  for (const [field, value] of Object.entries(normalizeProfileValues(profile.values))) {
    if (!value) continue;
    tokenMap[buildProfileToken(field)] = value;
  }
  return tokenMap;
}

export async function getSelectedProfileTokenMap(): Promise<Record<string, string>> {
  const profile = await getSelectedProfile();
  return buildProfileTokenMap(profile);
}

/**
 * Returns the currently selected profile entry with values loaded.
 *
 * The profile system originally stored encrypted profiles that were
 * decrypted and cached in getSelectedProfile(). This function exists for
 * compatibility with older code that still calls it, but the main way to
 * get a profile now is via getSelectedProfile().
 */
export async function getSelectedProfileEntry(): Promise<LocalProfileEntry | null> {
  return await getSelectedProfile();
}

export interface ProfileResolutionCandidate {
  profileId: string;
  profileLabel: string;
  field: string;
  masked: string;
}

export interface ProfileResolutionResult {
  value: string | null;
  status: "resolved" | "missing" | "ambiguous";
  field: string | null;
  candidates: ProfileResolutionCandidate[];
}

export function maskProfileValue(value: string): string {
  if (value.length <= 4) return "*".repeat(value.length);
  return `${value.slice(0, 2)}${"*".repeat(Math.min(value.length - 3, 10))}${value.slice(-1)}`;
}

export async function resolveTokenFromProfile(token: string): Promise<string | null> {
  const result = await resolveTokenFromProfiles(token);
  return result.value;
}

export async function resolveTokenFromProfiles(token: string): Promise<ProfileResolutionResult> {
  const field = parseProfileToken(token) || legacyTokenToField(token);
  if (!field) {
    console.warn(`[ProfileStore] Could not parse field from token: ${token}`);
    return { value: null, status: "missing", field: null, candidates: [] };
  }

  const profiles = await loadLocalProfiles();
  const selectedId = await getSelectedProfileId();

  console.log(`[ProfileStore] resolveTokenFromProfiles("${token}") → field="${field}", profiles=${profiles.length}, selectedId=${selectedId ?? "null"}`);
  for (const p of profiles) {
    console.log(`[ProfileStore]   Profile "${p.label}" (id=${p.id}) fields=${Object.keys(p.values).join(",")}`);
  }

  const candidates: ProfileResolutionCandidate[] = [];

  for (const profile of profiles) {
    const value = profile.values[field];
    if (!value) {
      console.log(`[ProfileStore]   Profile "${profile.label}" missing field "${field}"`);
      continue;
    }
    candidates.push({
      profileId: profile.id,
      profileLabel: profile.label,
      field,
      masked: maskProfileValue(value),
    });
  }

  // Priority 1: Use explicitly selected profile if it has the field
  if (selectedId) {
    const selected = profiles.find((profile) => profile.id === selectedId);
    if (selected) {
      const selectedValue = selected.values[field];
      if (selectedValue) {
        console.log(`[ProfileStore] ✅ Resolved from selected profile "${selected.label}": ${field}="${maskProfileValue(selectedValue)}"`);
        return { value: selectedValue, status: "resolved", field, candidates };
      }
      console.log(`[ProfileStore] Selected profile "${selected.label}" exists but missing field "${field}" (has: ${Object.keys(selected.values).join(",")})`);
    } else {
      console.log(`[ProfileStore] selectedId=${selectedId} not found in ${profiles.length} profiles`);
    }
  }

  // Priority 2: If only one profile exists and it has the field, auto-select and use it
  if (profiles.length === 1 && profiles[0].values[field]) {
    await setSelectedProfileId(profiles[0].id);
    console.log(`[ProfileStore] ✅ Auto-selected single profile "${profiles[0].label}": ${field}="${maskProfileValue(profiles[0].values[field]!)}"`);
    return {
      value: profiles[0].values[field] || null,
      status: "resolved",
      field,
      candidates,
    };
  }

  // Priority 3: If only one candidate has this field, use it
  if (candidates.length === 1) {
    const profile = profiles.find((entry) => entry.id === candidates[0].profileId);
    if (profile?.values[field]) {
      await setSelectedProfileId(profile.id);
      console.log(`[ProfileStore] ✅ Resolved from single candidate "${profile.label}": ${field}="${maskProfileValue(profile.values[field]!)}"`);
      return {
        value: profile.values[field],
        status: "resolved",
        field,
        candidates,
      };
    }
  }

  console.warn(`[ProfileStore] ❌ Could not resolve token="${token}" field="${field}" candidates=${candidates.length}`);
  return {
    value: null,
    status: candidates.length > 1 ? "ambiguous" : "missing",
    field,
    candidates,
  };
}

export async function getProfileTokenHints(): Promise<Array<{ token: string; field: string }>> {
  const profiles = await loadLocalProfiles();
  const fields = new Set<string>();
  for (const profile of profiles) {
    for (const field of Object.keys(profile.values)) fields.add(normalizeFieldKey(field));
  }
  return Array.from(fields)
    .sort()
    .map((field) => ({ field, token: buildProfileToken(field) }));
}

function legacyTokenToField(token: string): string | null {
  const match = token.match(/^\[([A-Z_]+)_\d+\]$/);
  if (!match) return null;
  const raw = match[1].toLowerCase();
  if (raw === "person") return "name";
  if (raw === "card") return "card";
  if (raw === "aadhaar") return "aadhaar";
  return normalizeFieldKey(raw);
}
