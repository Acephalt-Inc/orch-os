// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
/** Provider-neutral capability manifests and local registry. No provider is built in. */
import { readFileSync, mkdirSync, statSync, openSync, writeSync, fsyncSync, closeSync, renameSync, unlinkSync } from "node:fs";
import { BlockList, isIP } from "node:net";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { request } from "node:https";
import { Ajv2020, type SchemaObject } from "ajv/dist/2020.js";
import { orchHome } from "./config.js";
import { withLock } from "./lock.js";
import { atomicWrite, isPlainObject } from "./util.js";

export class CapError extends Error {
  constructor(message: string) { super(message); this.name = "CapError"; }
}
export class CapAuditUncertain extends CapError {
  constructor() { super("cap usage commit uncertain after rename; inspect local usage before retry"); this.name = "CapAuditUncertain"; }
}

export interface Capability {
  id: string;
  description: string;
  method: "POST";
  path: string;
  pricing_unit: "credits";
  max_rows: number;
  mode: "sync" | "async";
  input_schema: Record<string, unknown>;
  output_envelope: "orch-cap-envelope-v1";
}

export interface Manifest {
  schema_version: 1;
  provider: { id: string; name: string; base_url: string; auth: { type: "bearer"; env_var: string } };
  capabilities: Capability[];
}

export interface RegistryEntry { source: string; manifest: Manifest }

/** Observations, never invoices. Null means unknown; numeric zero means explicitly not charged. */
export interface UsageRow {
  attempted_at: string;
  call_id: string;
  provider_id: string;
  capability_id: string;
  task_id: string | null;
  outcome: string;
  http_status: number | null;
  credits: number | null;
  pages: number | null;
  model_tokens: number | null;
}

export interface HttpReply { status: number; body: string }
export type Transport = (url: URL, method: "GET" | "POST", body: string | null, token: string | null, maxBytes: number, timeoutMs: number) => Promise<HttpReply>;

const MAX_MANIFEST_BYTES = 512 * 1024;
const MAX_USAGE_BYTES = 16 * 1024 * 1024;
const MAX_USAGE_EVENT_BYTES = 2048;
// Conservative special-use denylist. IPv6 and IP literals in manifests are unsupported in v1.
const NON_PUBLIC_V4 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) NON_PUBLIC_V4.addSubnet(network, prefix);

/** Only globally routable IPv4 destinations may be used by the HTTPS transport. */
export function isPublicIPv4(address: string): boolean {
  return isIP(address) === 4 && !NON_PUBLIC_V4.check(address);
}
const ajv = new Ajv2020({ strict: true, allErrors: true });
const checkedInSchema = (name: string): SchemaObject => {
  const raw: unknown = JSON.parse(readFileSync(fileURLToPath(new URL(`../schemas/${name}.schema.json`, import.meta.url)), "utf8"));
  if (!isPlainObject(raw) || raw.$async === true) throw new CapError(`checked-in ${name} must be a synchronous JSON Schema object`);
  return raw;
};
const manifestSchema = checkedInSchema("cap-manifest-v1");
const validateShape = ajv.compile(manifestSchema);
const validateJobHandle = ajv.compile(checkedInSchema("cap-job-handle-v1"));
const validateJobStatus = ajv.compile(checkedInSchema("cap-job-status-v1"));
const validateEnvelopeShape = ajv.compile(checkedInSchema("cap-envelope-v1"));

const SCHEMA_KEYS = new Set(["$schema", "type", "properties", "required", "additionalProperties", "items", "enum", "minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems"]);
/** The embedded input schema is intentionally a small, local-only Draft 2020-12 subset. */
function validateInputSchema(schema: Record<string, unknown>, depth = 0): void {
  if (depth > 12) throw new CapError("manifest input_schema exceeds nesting limit");
  if (depth === 0 && schema.type !== "object") throw new CapError("manifest input_schema root type must be object");
  for (const [key, value] of Object.entries(schema)) {
    if (!SCHEMA_KEYS.has(key)) throw new CapError(`manifest input_schema keyword ${key} is unsupported`);
    if (key === "$schema" && value !== "https://json-schema.org/draft/2020-12/schema") throw new CapError("manifest input_schema must use Draft 2020-12");
    if (key === "properties") {
      if (!isPlainObject(value) || Object.keys(value).length > 100) throw new CapError("manifest input_schema properties must be a bounded object");
      for (const child of Object.values(value)) {
        if (!isPlainObject(child)) throw new CapError("manifest input_schema property must be an object schema");
        validateInputSchema(child, depth + 1);
      }
    }
    if (key === "items") {
      if (!isPlainObject(value)) throw new CapError("manifest input_schema items must be an object schema");
      validateInputSchema(value, depth + 1);
    }
    if (key === "additionalProperties" && isPlainObject(value)) validateInputSchema(value, depth + 1);
    if (key === "enum" && Array.isArray(value) && value.length > 100) throw new CapError("manifest input_schema enum is too large");
  }
  if (!ajv.validateSchema(schema)) throw new CapError("manifest input_schema is not valid JSON Schema");
  try { ajv.compile(schema); } catch { throw new CapError("manifest input_schema cannot be compiled"); }
}

function checkedOrigin(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new CapError("manifest provider base_url is invalid"); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash || url.pathname !== "/" || url.port) {
    throw new CapError("manifest provider base_url must be an HTTPS origin without credentials, path, query or port");
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (isIP(hostname.replace(/^\[|\]$/g, "")) || !hostname.includes(".") || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    throw new CapError("manifest provider base_url must name a public DNS host");
  }
  return url;
}

/** URL path accepted for capability POST, async status GET, and remote manifest GET. */
export function checkedPath(origin: URL, path: string): URL {
  if (!path.startsWith("/") || path.startsWith("//") || /[\\?#%]/.test(path) || path.split("/").some((x) => x === ".." || x === ".")) {
    throw new CapError("path must be a canonical same-origin absolute path without query or encoding");
  }
  const url = new URL(path, origin);
  if (url.origin !== origin.origin || url.pathname !== path || url.search || url.hash) throw new CapError("path escapes provider origin");
  return url;
}

/** HTTPS only, DNS address checked and pinned, no redirect/retry/proxy, bounded body/time. */
export const secureRequest: Transport = async (url, method, body, token, maxBytes, timeoutMs) => {
  if (url.username || url.password) throw new CapError("URL credentials are not allowed");
  const origin = checkedOrigin(url.origin);
  checkedPath(origin, url.pathname);
  if (url.search || url.hash) throw new CapError("URL query and fragment are not allowed");
  if (body !== null && Buffer.byteLength(body, "utf8") > 1024 * 1024) throw new CapError("request body exceeds 1 MiB");
  let addresses: LookupAddress[];
  let dnsTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    addresses = await Promise.race([
      lookup(origin.hostname, { all: true }),
      new Promise<never>((_, reject) => { dnsTimer = setTimeout(() => reject(new CapError("DNS lookup timed out")), Math.min(timeoutMs, 8000)); }),
    ]);
  } catch { throw new CapError("public DNS lookup failed"); }
  finally { if (dnsTimer) clearTimeout(dnsTimer); }
  const ipv4 = addresses.filter((a) => a.family === 4);
  if (!ipv4.length || ipv4.some((a) => !isPublicIPv4(a.address))) throw new CapError("provider DNS did not resolve exclusively to public IPv4 addresses");
  const address = ipv4[0].address;
  return await new Promise<HttpReply>((resolve, reject) => {
    const headers: Record<string, string> = { Host: origin.hostname, Accept: "application/json" };
    if (body !== null) headers["Content-Type"] = "application/json";
    if (token !== null) headers.Authorization = `Bearer ${token}`;
    let settled = false;
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      reject(new CapError(message));
    };
    const req = request({
      hostname: address, port: 443, servername: origin.hostname, method, path: url.pathname,
      headers, agent: false, rejectUnauthorized: true,
    }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) return fail("redirect refused");
      let size = 0;
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) return fail("response body exceeds limit");
        chunks.push(chunk);
      });
      res.on("end", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ status, body: Buffer.concat(chunks).toString("utf8") });
      });
      res.on("error", () => fail("network response failed"));
    });
    const timer = setTimeout(() => fail("network request timed out"), timeoutMs);
    req.on("error", () => fail("network request failed"));
    req.end(body ?? undefined);
  });
};

/** Checked-in JSON Schema validates shape; code enforces URL and embedded-schema constraints. */
export function validateManifest(value: unknown): Manifest {
  if (!validateShape(value)) throw new CapError("manifest does not match v1 schema: " + ajv.errorsText(validateShape.errors, { separator: "; " }));
  const manifest = value as Manifest;
  checkedOrigin(manifest.provider.base_url);
  const seen = new Set<string>();
  for (const cap of manifest.capabilities) {
    if (seen.has(cap.id)) throw new CapError(`manifest duplicate capability id: ${cap.id}`);
    seen.add(cap.id);
    const base = new URL(manifest.provider.base_url);
    checkedPath(base, cap.path);
    validateInputSchema(cap.input_schema);
  }
  return manifest;
}

function capDir(): string { return join(orchHome(), "cap"); }
function registryPath(): string { return join(capDir(), "registry.json"); }
function usagePath(): string { return join(capDir(), "usage.jsonl"); }

export function readUsage(): UsageRow[] {
  let raw: string;
  try {
    if (statSync(usagePath()).size > MAX_USAGE_BYTES) throw new CapError("cap usage log exceeds 16 MiB; no changes made");
    raw = readFileSync(usagePath(), "utf8");
  } catch (e: any) {
    if (e?.code === "ENOENT") return [];
    if (e instanceof CapError) throw e;
    throw new CapError("cap usage log is unreadable; no changes made");
  }
  try {
    const latest = new Map<string, UsageRow>();
    for (const line of raw.split("\n").filter(Boolean)) {
      const row = JSON.parse(line) as UsageRow;
      if (!isPlainObject(row) || typeof row.call_id !== "string") throw new Error("invalid usage row");
      latest.set(row.call_id, row);
    }
    return [...latest.values()];
  } catch { throw new CapError("cap usage log is invalid JSON; no changes made"); }
}

/** Append an event atomically so an incomplete completion never damages an earlier intent. */
export function recordUsage(row: UsageRow, beforeCommitForTest?: (temporaryPath: string) => void, beforeDirectoryFsyncForTest?: () => void): void {
  mkdirSync(capDir(), { recursive: true, mode: 0o700 });
  let renamed = false;
  try { withLock(join(capDir(), "usage.lock"), () => {
    const path = usagePath();
    const event = JSON.stringify(row) + "\n";
    const eventBytes = Buffer.byteLength(event, "utf8");
    if (eventBytes > MAX_USAGE_EVENT_BYTES) throw new CapError("cap usage event exceeds 2 KiB; no request sent");
    let size = 0;
    try { size = statSync(path).size; }
    catch (e: any) { if (e?.code !== "ENOENT") throw e; }
    if (size + eventBytes > MAX_USAGE_BYTES) throw new CapError("cap usage log exceeds 16 MiB; no request sent");
    const latest = readUsage(); // malformed history is a fail-closed audit error
    const prior = latest.find((entry) => entry.call_id === row.call_id);
    let pending = latest.filter((entry) => entry.outcome === "pending").length;
    if (row.outcome === "pending" && prior?.outcome !== "pending") pending++;
    if (row.outcome !== "pending" && prior?.outcome === "pending") pending--;
    if (size + eventBytes + pending * MAX_USAGE_EVENT_BYTES > MAX_USAGE_BYTES) {
      throw new CapError("cap usage log exceeds 16 MiB including pending completion reservations; no request sent");
    }
    const previous = size ? readFileSync(path, "utf8") : "";
    const content = Buffer.from(previous + event, "utf8");
    const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
    let fd: number | null = null;
    try {
      fd = openSync(temporary, "wx", 0o600);
      let offset = 0;
      while (offset < content.length) {
        const written = writeSync(fd, content, offset, content.length - offset);
        if (written <= 0) throw new CapError("cap usage log write made no progress");
        offset += written;
      }
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
      beforeCommitForTest?.(temporary);
      renameSync(temporary, path);
      renamed = true;
      const directoryFd = openSync(capDir(), "r");
      try {
        beforeDirectoryFsyncForTest?.();
        fsyncSync(directoryFd);
      } finally { closeSync(directoryFd); }
    } finally {
      if (fd !== null) closeSync(fd);
      if (!renamed) { try { unlinkSync(temporary); } catch { /* no temporary file remains */ } }
    }
  }); }
  catch (e) { if (renamed) throw new CapAuditUncertain(); throw e; }
}

export function newUsageRow(providerId: string, capabilityId: string, taskId: string | null): UsageRow {
  return {
    attempted_at: new Date().toISOString(), call_id: randomUUID(), provider_id: providerId,
    capability_id: capabilityId, task_id: taskId, outcome: "not_dispatched", http_status: null,
    credits: null, pages: null, model_tokens: null,
  };
}

export function findCapability(providerId: string, capabilityId: string): { manifest: Manifest; capability: Capability } {
  const entry = list().find((x) => x.manifest.provider.id === providerId);
  if (!entry) throw new CapError(`provider ${providerId} not found`);
  const capability = entry.manifest.capabilities.find((x) => x.id === capabilityId);
  if (!capability) throw new CapError(`capability ${capabilityId} not found in provider ${providerId}`);
  return { manifest: entry.manifest, capability };
}

export function credential(manifest: Manifest, callerEnvName: string | null): string {
  const { env_var } = manifest.provider.auth;
  if (callerEnvName !== env_var) {
    throw new CapError(`call requires --auth-env ${env_var} to authorize sending that env value to ${manifest.provider.base_url}`);
  }
  const token = process.env[env_var];
  if (!token) throw new CapError(`credential environment variable ${env_var} is unset`);
  if (token.length > 8192 || /[\r\n\0]/.test(token)) throw new CapError(`credential environment variable ${env_var} is unusable`);
  return token;
}

export function prepareCall(manifest: Manifest, capability: Capability, rawInput: string, taskId: string | null, callerEnvName: string | null): { input: Record<string, unknown>; token: string } {
  if (taskId !== null && (!/^[A-Za-z0-9_.-]{1,128}$/.test(taskId))) throw new CapError("task id must be 1-128 safe characters");
  if (Buffer.byteLength(rawInput, "utf8") > 1024 * 1024) throw new CapError("call input exceeds 1 MiB");
  let input: unknown;
  try { input = JSON.parse(rawInput); } catch { throw new CapError("call input is not valid JSON"); }
  const validate = ajv.compile(capability.input_schema);
  if (!validate(input) || !isPlainObject(input)) throw new CapError("call input does not match capability input_schema");
  const token = credential(manifest, callerEnvName);
  return { input, token };
}

/** Read only numeric provider-reported usage; malformed/missing amounts remain unknown. */
export function reportedUsage(body: string): Pick<UsageRow, "credits" | "pages" | "model_tokens"> {
  let data: unknown;
  try { data = JSON.parse(body); } catch { data = null; }
  const usage = isPlainObject(data) && isPlainObject(data.usage) ? data.usage : {};
  const amount = (key: string): number | null => {
    const value = usage[key];
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  };
  return { credits: amount("credits"), pages: amount("pages"), model_tokens: amount("model_tokens") };
}

export function parseJobHandle(body: string, origin: URL): { job_id: string; status_path: string } {
  let raw: unknown;
  try { raw = JSON.parse(body); } catch { throw new CapError("async job handle is not valid JSON"); }
  if (!validateJobHandle(raw)) throw new CapError("async job handle does not match v1 contract");
  const handle = raw as { job_id: string; status_path: string };
  checkedPath(origin, handle.status_path);
  return handle;
}

export function parseJobStatus(body: string): { status: "queued" | "running" | "succeeded" | "failed"; result?: unknown } {
  let raw: unknown;
  try { raw = JSON.parse(body); } catch { throw new CapError("async job status is not valid JSON"); }
  if (!validateJobStatus(raw)) throw new CapError("async job status does not match v1 contract");
  return raw as { status: "queued" | "running" | "succeeded" | "failed"; result?: unknown };
}

/** Validate only the wire shape and declared row cap; provenance and billing remain unverified. */
export function parseEnvelope(value: unknown, maxRows: number): Record<string, unknown> {
  if (!validateEnvelopeShape(value)) throw new CapError("capability response envelope does not match v1 contract");
  const envelope = value as { citations: unknown[]; conflicts: unknown[] };
  if (envelope.citations.length > maxRows || envelope.conflicts.length > maxRows) {
    throw new CapError("capability response envelope exceeds manifest max_rows");
  }
  return value as Record<string, unknown>;
}

export function parseEnvelopeBody(body: string, maxRows: number): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(body); } catch { throw new CapError("capability response envelope is not valid JSON"); }
  return parseEnvelope(value, maxRows);
}

export function list(): RegistryEntry[] {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(registryPath(), "utf8")); }
  catch (e: any) {
    if (e?.code === "ENOENT") return [];
    throw new CapError("cap registry is unreadable; no changes made");
  }
  if (!Array.isArray(raw) || !raw.every((x) => isPlainObject(x) && typeof x.source === "string" && x.source.length <= 2048 && Object.keys(x).length === 2)) {
    throw new CapError("cap registry is invalid; no changes made");
  }
  const entries = raw as RegistryEntry[];
  const ids = new Set<string>();
  for (const entry of entries) {
    validateManifest(entry.manifest);
    if (ids.has(entry.manifest.provider.id)) throw new CapError("cap registry has duplicate provider IDs");
    ids.add(entry.manifest.provider.id);
  }
  return entries;
}

function save(entries: RegistryEntry[]): void {
  mkdirSync(capDir(), { recursive: true, mode: 0o700 });
  atomicWrite(registryPath(), JSON.stringify(entries, null, 2) + "\n", { mode: 0o600, fsync: true });
}

export function addFile(source: string): Manifest {
  const path = resolve(source);
  let raw: string;
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size > MAX_MANIFEST_BYTES) throw new CapError("manifest file must be a regular file of at most 512 KiB");
    raw = readFileSync(path, "utf8");
  } catch (e: any) {
    if (e instanceof CapError) throw e;
    throw new CapError("manifest file cannot be read");
  }
  return addText(raw, path);
}

function addText(raw: string, source: string): Manifest {
  if (Buffer.byteLength(raw, "utf8") > MAX_MANIFEST_BYTES) throw new CapError("manifest exceeds 512 KiB");
  let data: unknown;
  try { data = JSON.parse(raw); } catch { throw new CapError("manifest is not valid JSON"); }
  const manifest = validateManifest(data);
  withLock(join(capDir(), "registry.lock"), () => {
    const entries = list();
    if (entries.some((x) => x.manifest.provider.id === manifest.provider.id)) throw new CapError(`provider ${manifest.provider.id} already exists`);
    entries.push({ source, manifest });
    save(entries);
  });
  return manifest;
}

export async function add(source: string, transport: Transport = secureRequest): Promise<Manifest> {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) return addFile(source);
  let url: URL;
  try { url = new URL(source); } catch { throw new CapError("manifest URL is invalid"); }
  if (url.username || url.password) throw new CapError("manifest URL credentials are not allowed");
  const origin = checkedOrigin(url.origin);
  checkedPath(origin, url.pathname);
  if (url.search || url.hash) throw new CapError("manifest URL query and fragment are not allowed");
  const reply = await transport(url, "GET", null, null, MAX_MANIFEST_BYTES, 8000);
  if (reply.status !== 200) throw new CapError(`manifest fetch returned HTTP ${reply.status}`);
  let data: unknown;
  try { data = JSON.parse(reply.body); } catch { throw new CapError("manifest is not valid JSON"); }
  const manifest = validateManifest(data);
  if (new URL(manifest.provider.base_url).origin !== origin.origin) throw new CapError("remote manifest provider origin differs from its source origin");
  return addText(reply.body, url.toString());
}

export function remove(id: string): void {
  withLock(join(capDir(), "registry.lock"), () => {
    const entries = list();
    const next = entries.filter((x) => x.manifest.provider.id !== id);
    if (next.length === entries.length) throw new CapError(`provider ${id} not found`);
    save(next);
  });
}
