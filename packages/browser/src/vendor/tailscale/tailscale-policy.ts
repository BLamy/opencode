/* ══ Tailscale routing policy — which requests belong on the tailnet ══
   Pure functions, no browser APIs, safe on the server. The service worker (lib/tailscale-router/tailscale-sw.js) carries
   its own copy of `matchTailscalePolicy` (it is a classic script and cannot import this file); both are run against the
   same test vectors, so they must agree.

   The default is an allowlist: a request is routed only if its host looks like it lives on a tailnet (`*.ts.net`,
   100.64.0.0/10, fd7a:115c:a1e0::/48) or you named it (`hosts`, `cidrs`). Routing every cross-origin request is a
   separate, explicit choice (`intercept: 'all'`). Never routed, whatever the policy says: the page's own origin
   (unless `sameOrigin`), loopback, Tailscale's own services (`*.tailscale.com`, `*.tailscale.io`), anything that is not http(s), and what `exclude` names. */

/** `tailnet` (default): the built-in tailnet names and addresses plus `hosts` and `cidrs`. `all`: every cross-origin http(s) request. */
export type TailscaleIntercept = 'tailnet' | 'all';

/** What a matched request does while the tailnet connection is down: go to the normal network, or fail with a 503. */
export type TailscaleUnavailable = 'network' | 'error';

export interface TailscalePolicy {
  /** Default `tailnet`. `all` routes everything except the exclusions below, so it needs an exit node (or a client that resolves public names). */
  intercept?: TailscaleIntercept;
  /** Extra hosts: `api.internal` (exact), `*.corp.example` (subdomains), `.corp.example` (the domain and its subdomains), or an IP or CIDR (the same as `cidrs`). */
  hosts?: string[];
  /** Subnet routes your tailnet advertises, for example `192.168.1.0/24` or `fd00:1::/64`. A bare address is a /32 (/128). */
  cidrs?: string[];
  /** Route MagicDNS short names (`http://nas/`: one label, no dot). Off by default: a typo in a URL should not leave the browser. */
  shortNames?: boolean;
  /** Hosts and CIDRs that are never routed, even when `intercept` is `all`. */
  exclude?: string[];
  /** Default both. */
  schemes?: Array<'http' | 'https'>;
  /** Only these methods (upper case). Default all. */
  methods?: string[];
  /** Also route requests to the page's own origin. Default false: the app's own files and dev-server traffic must not leave. */
  sameOrigin?: boolean;
  /** Default `network`. `error` fails closed: a matched request never reaches the public network by accident. */
  whenUnavailable?: TailscaleUnavailable;
  /** The largest request body the worker will buffer and send (bytes). Bigger ones are not routed. Default 32 MiB. */
  maxBodyBytes?: number;
  /** How long the worker waits for the tailnet client's response headers (ms). Default 60 000. */
  timeoutMs?: number;
  /** Serve whole sites through the tailnet under this path of the worker's scope, e.g. `__tailnet/`: a frame opened at
   *  `<scope>__tailnet/https/example.com/a?b` loads https://example.com/a?b, its scripts run, and every request it makes (its
   *  relative URLs included) is routed, whatever the rest of the policy says. Default none. See `tailscaleProxyUrl`. */
  proxyPath?: string;
}

export interface ResolvedTailscalePolicy {
  v: 1;
  intercept: TailscaleIntercept;
  /** Host patterns, lower case, punycode. */
  hosts: string[];
  cidrs: string[];
  shortNames: boolean;
  exclude: string[];
  schemes: Array<'http' | 'https'>;
  methods: string[] | null;
  sameOrigin: boolean;
  whenUnavailable: TailscaleUnavailable;
  maxBodyBytes: number;
  timeoutMs: number;
  proxyPath: string | null;
}

export type TailscaleMatchReason =
  | 'tailnet-name' | 'tailnet-address' | 'host' | 'cidr' | 'short-name' | 'all'
  | 'invalid-url' | 'scheme' | 'same-origin' | 'loopback' | 'tailscale' | 'method' | 'excluded' | 'no-match';

export interface TailscaleMatch {
  route: boolean;
  reason: TailscaleMatchReason;
}

export class TailscalePolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TailscalePolicyError';
  }
}

export const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 60_000;

/* ── addresses ── */

type Family = 4 | 6;
interface Address { family: Family; value: bigint }
interface Cidr extends Address { prefix: number }

const bits = (family: Family) => (family === 4 ? 32 : 128);

function parseIPv4(text: string): bigint | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = (value << 8n) | BigInt(n);
  }
  return value;
}

function parseIPv6(input: string): bigint | null {
  let text = input;
  if (!/^[0-9a-f:.]+$/i.test(text) || !text.includes(':')) return null;
  // a trailing dotted quad stands for the last two groups
  const dot = text.lastIndexOf('.');
  if (dot >= 0) {
    const colon = text.lastIndexOf(':');
    const v4 = parseIPv4(text.slice(colon + 1));
    if (v4 === null) return null;
    text = `${text.slice(0, colon + 1)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const groups = (s: string) => (s === '' ? [] : s.split(':'));
  const head = groups(halves[0] ?? '');
  const tail = halves.length === 2 ? groups(halves[1] ?? '') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const all = [...head, ...(halves.length === 2 ? Array<string>(missing).fill('0') : []), ...tail];
  let value = 0n;
  for (const g of all) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    value = (value << 16n) | BigInt(parseInt(g, 16));
  }
  return value;
}

/** An IPv4 or IPv6 literal (a URL host in brackets is accepted), or null. */
function parseAddress(host: string): Address | null {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  const v4 = parseIPv4(bare);
  if (v4 !== null) return { family: 4, value: v4 };
  const v6 = parseIPv6(bare);
  return v6 !== null ? { family: 6, value: v6 } : null;
}

function parseCidr(text: string): Cidr | null {
  const [addr, len, ...rest] = text.split('/');
  if (rest.length || addr === undefined) return null;
  const a = parseAddress(addr);
  if (!a) return null;
  const prefix = len === undefined ? bits(a.family) : /^\d{1,3}$/.test(len) ? Number(len) : -1;
  if (prefix < 0 || prefix > bits(a.family)) return null;
  return { ...a, prefix };
}

function inCidr(a: Address, c: Cidr): boolean {
  if (a.family !== c.family) return false;
  const shift = BigInt(bits(a.family) - c.prefix);
  return a.value >> shift === c.value >> shift;
}

/** Tailscale's CGNAT range and its IPv6 ULA prefix. */
const TAILNET_V4: Cidr = { family: 4, value: 100n << 24n | 64n << 16n, prefix: 10 };
const TAILNET_V6: Cidr = { family: 6, value: 0xfd7a115ca1e0n << 80n, prefix: 48 };
const LOOPBACK_V4: Cidr = { family: 4, value: 127n << 24n, prefix: 8 };
const LOOPBACK_V6: Cidr = { family: 6, value: 1n, prefix: 128 };

export function isTailnetAddress(host: string): boolean {
  const a = parseAddress(host);
  return a !== null && (inCidr(a, TAILNET_V4) || inCidr(a, TAILNET_V6));
}

/** `*.ts.net` (every tailnet's MagicDNS suffix), or a Tailscale IP. */
export function isTailnetHost(host: string): boolean {
  const h = host.toLowerCase();
  return h.endsWith('.ts.net') || isTailnetAddress(h);
}

/* ── host patterns ── */

function normalizeHost(raw: string): string {
  try {
    return new URL(`http://${raw}`).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** A host pattern, in the form stored in a resolved policy: `exact`, `*.suffix` or `.suffix`. */
function normalizePattern(raw: string, field: string): string {
  const text = raw.trim().toLowerCase();
  if (!text || text === '*' || text === '.' || text === '*.') {
    throw new TailscalePolicyError(`${field}: "${raw}" is not a host. To route everything use intercept: 'all'.`);
  }
  const prefix = text.startsWith('*.') ? '*.' : text.startsWith('.') ? '.' : '';
  const host = normalizeHost(text.slice(prefix.length));
  if (!host || /[/\s]/.test(text)) throw new TailscalePolicyError(`${field}: "${raw}" is not a valid host pattern.`);
  return prefix + host;
}

function matchesPattern(host: string, pattern: string): boolean {
  if (pattern.startsWith('*.')) return host.endsWith(pattern.slice(1));
  if (pattern.startsWith('.')) return host === pattern.slice(1) || host.endsWith(pattern);
  return host === pattern;
}

const looksLikeAddress = (text: string) => parseCidr(text) !== null;

/** Splits a mixed list of host patterns and CIDRs. */
function splitList(list: string[] | undefined, field: string): { hosts: string[]; cidrs: string[] } {
  const hosts: string[] = [];
  const cidrs: string[] = [];
  for (const raw of list ?? []) {
    const text = raw.trim();
    if (looksLikeAddress(text)) cidrs.push(canonicalCidr(text));
    else hosts.push(normalizePattern(raw, field));
  }
  return { hosts, cidrs };
}

function canonicalCidr(text: string): string {
  const c = parseCidr(text);
  if (!c) throw new TailscalePolicyError(`"${text}" is not a CIDR range.`);
  return text.trim().toLowerCase().includes('/') ? text.trim().toLowerCase() : `${text.trim().toLowerCase()}/${c.prefix}`;
}

const uniq = (list: string[]) => [...new Set(list)];

/** Fills in the defaults and checks the lists. Throws `TailscalePolicyError` for a host or range that cannot be read. */
export function resolveTailscalePolicy(policy: TailscalePolicy = {}): ResolvedTailscalePolicy {
  const intercept = policy.intercept ?? 'tailnet';
  if (intercept !== 'tailnet' && intercept !== 'all') throw new TailscalePolicyError(`intercept must be 'tailnet' or 'all', not "${String(intercept)}".`);
  const include = splitList([...(policy.hosts ?? []), ...(policy.cidrs ?? [])], 'hosts');
  const exclude = splitList(policy.exclude, 'exclude');
  for (const raw of policy.cidrs ?? []) if (!looksLikeAddress(raw.trim())) throw new TailscalePolicyError(`cidrs: "${raw}" is not a CIDR range.`);
  const whenUnavailable = policy.whenUnavailable ?? 'network';
  if (whenUnavailable !== 'network' && whenUnavailable !== 'error') throw new TailscalePolicyError(`whenUnavailable must be 'network' or 'error'.`);
  const schemes = uniq(policy.schemes ?? ['http', 'https']) as Array<'http' | 'https'>;
  if (!schemes.length || schemes.some((s) => s !== 'http' && s !== 'https')) throw new TailscalePolicyError(`schemes may contain 'http' and 'https' only.`);
  return {
    v: 1,
    intercept,
    hosts: uniq(include.hosts),
    cidrs: uniq(include.cidrs),
    shortNames: policy.shortNames === true,
    exclude: uniq([...exclude.hosts, ...exclude.cidrs]),
    schemes,
    methods: policy.methods?.length ? uniq(policy.methods.map((m) => m.toUpperCase())) : null,
    sameOrigin: policy.sameOrigin === true,
    whenUnavailable,
    maxBodyBytes: positive(policy.maxBodyBytes, DEFAULT_MAX_BODY_BYTES),
    timeoutMs: positive(policy.timeoutMs, DEFAULT_TIMEOUT_MS),
    proxyPath: proxyPath(policy.proxyPath),
  };
}

function proxyPath(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (!/^[A-Za-z0-9_-]+\/$/.test(value)) throw new TailscalePolicyError(`proxyPath must be one path segment ending in "/", like "__tailnet/", not "${value}".`);
  return value;
}

/** The address a frame opens to load `target` through the tailnet: `<scope><proxyPath><scheme>/<host><path>`. */
export function tailscaleProxyUrl(target: string | URL, scope: string, path = '__tailnet/'): string {
  const u = new URL(target);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new TailscalePolicyError(`Only http(s) can be proxied, not ${u.protocol}`);
  return new URL(`${path}${u.protocol.slice(0, -1)}/${u.host}${u.pathname}${u.search}${u.hash}`, scope).href;
}

/** The inverse of `tailscaleProxyUrl`: the site a proxy address loads, or null when `url` is not one. */
export function tailscaleProxyTarget(url: string, scope: string, path = '__tailnet/'): string | null {
  const prefix = new URL(path, scope).href;
  if (!url.startsWith(prefix)) return null;
  const m = /^(https?)\/([^/?#]+)(.*)$/.exec(url.slice(prefix.length));
  if (!m) return null;
  const rest = m[3] ?? '';
  return `${m[1]}://${m[2]}${rest.startsWith('/') ? rest : `/${rest}`}`;
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/* ── matching ── */

const isTailscaleService = (host: string) => /(^|\.)tailscale\.(com|io)$/.test(host);

const isLoopback = (host: string, a: Address | null) =>
  host === 'localhost' || host.endsWith('.localhost') || (a !== null && (inCidr(a, LOOPBACK_V4) || inCidr(a, LOOPBACK_V6)));

/**
 * Would a request for `url` be routed? `origin` is the page's origin (to leave its own requests alone).
 * Decisions are made in a fixed order, so `reason` says which rule decided: not a URL, scheme, same origin, loopback,
 * Tailscale's own services, method, `exclude`, then the inclusions.
 */
export function matchTailscalePolicy(url: string | URL, method: string, policy: ResolvedTailscalePolicy, origin?: string): TailscaleMatch {
  let u: URL;
  try {
    u = typeof url === 'string' ? new URL(url, origin) : url;
  } catch {
    return { route: false, reason: 'invalid-url' };
  }
  const scheme = u.protocol.slice(0, -1);
  if ((scheme !== 'http' && scheme !== 'https') || !policy.schemes.includes(scheme)) return { route: false, reason: 'scheme' };
  if (!policy.sameOrigin && origin !== undefined && u.origin === origin) return { route: false, reason: 'same-origin' };
  const host = u.hostname.toLowerCase();
  const addr = parseAddress(host);
  if (isLoopback(host, addr)) return { route: false, reason: 'loopback' };
  // The client's own connections (control, DERP, logs) cannot go through the tailnet they set up.
  if (isTailscaleService(host)) return { route: false, reason: 'tailscale' };
  if (policy.methods && !policy.methods.includes(method.toUpperCase())) return { route: false, reason: 'method' };
  if (hostIn(host, addr, policy.exclude)) return { route: false, reason: 'excluded' };

  if (policy.intercept === 'all') return { route: true, reason: 'all' };
  if (host.endsWith('.ts.net')) return { route: true, reason: 'tailnet-name' };
  if (addr && (inCidr(addr, TAILNET_V4) || inCidr(addr, TAILNET_V6))) return { route: true, reason: 'tailnet-address' };
  if (hostIn(host, addr, policy.hosts)) return { route: true, reason: 'host' };
  if (hostIn(host, addr, policy.cidrs)) return { route: true, reason: 'cidr' };
  if (policy.shortNames && addr === null && !host.includes('.') && host !== '') return { route: true, reason: 'short-name' };
  return { route: false, reason: 'no-match' };
}

/** A pattern list holds host patterns and CIDRs; check the host against whichever applies. */
function hostIn(host: string, addr: Address | null, list: string[]): boolean {
  for (const entry of list) {
    if (entry.includes('/')) {
      const c = parseCidr(entry);
      if (c && addr && inCidr(addr, c)) return true;
    } else if (matchesPattern(host, entry)) return true;
  }
  return false;
}

/* ── the worker's copy ── */

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** The resolved policy as the `p` query parameter of the worker's script URL (the worker reads it back, so it cannot be changed by a message). */
export function encodeTailscalePolicy(policy: ResolvedTailscalePolicy): string {
  return toBase64Url(new TextEncoder().encode(JSON.stringify(policy)));
}

/** The inverse of `encodeTailscalePolicy`; null when the text is not a policy. */
export function decodeTailscalePolicy(text: string): ResolvedTailscalePolicy | null {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(fromBase64Url(text)));
    if (!parsed || typeof parsed !== 'object' || (parsed as { v?: unknown }).v !== 1) return null;
    return resolveTailscalePolicy(parsed as TailscalePolicy);
  } catch {
    return null;
  }
}

/** A short sentence for the docs and the demos: what a policy routes. */
export function describeTailscalePolicy(policy: ResolvedTailscalePolicy): string {
  const parts: string[] = [];
  if (policy.intercept === 'all') parts.push('every cross-origin request');
  else {
    parts.push('*.ts.net and Tailscale addresses');
    if (policy.hosts.length) parts.push(policy.hosts.join(', '));
    if (policy.cidrs.length) parts.push(policy.cidrs.join(', '));
    if (policy.shortNames) parts.push('short names');
  }
  const out = `Routes ${parts.join(', ')}`;
  return policy.exclude.length ? `${out}, except ${policy.exclude.join(', ')}.` : `${out}.`;
}
