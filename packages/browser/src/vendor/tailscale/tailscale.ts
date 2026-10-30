/* ══ Tailscale — sign in to a tailnet from the browser, without React ══
   const tailscale = createTailscale({ client: () => createTailscaleConnectClient({ wasmURL }) })
   tailscale.signIn()            // opens the control server's sign-in page in a popup; status → signing-in → connected
   await tailscale.fetch({ url: 'http://nas.tail1234.ts.net/' })

   The tailnet client itself (Tailscale's Go code compiled to WebAssembly, about 26 MB) sits behind a small structural
   interface, `TailscaleClient`, and is created only when someone signs in or a saved session is restored: a page that
   never does never downloads it. `lib/tailscale-connect` adapts `@agent-wasm/tailscale-connect` (the build almostnode
   uses) to it; `lib/tailscale-fake` is an in-memory stand-in for tests, stories and demos.

   The model follows almostnode (github.com/blamy/almostnode, packages/almostnode/src/network): the client reports the
   backend's state (NeedsLogin, Starting, Running …), a login URL to open, and the network map; its node keys live in a
   string map the client reads synchronously (`stateStorage`), which the controller loads before start and persists
   (debounced) through a `TailscalePersistence`. Unlike almostnode, nothing is persisted unless you choose where, and
   the choice that encrypts it is the passkey vault (`vaultTailscalePersistence`). Nothing touches `window`,
   `navigator` or storage at import time. */

import { matchTailscalePolicy, resolveTailscalePolicy, type ResolvedTailscalePolicy, type TailscalePolicy } from './tailscale-policy';

/* ── the client interface ── */

/** The backend states Tailscale's client reports (ipn/backend.go). */
export type TailscaleClientState = 'NoState' | 'InUseOtherUser' | 'NeedsLogin' | 'NeedsMachineAuth' | 'Stopped' | 'Starting' | 'Running';

export interface TailscaleNode {
  name: string;
  addresses: string[];
  online?: boolean;
  /** The node's stable id: what `setExitNode` takes. */
  id?: string;
  /** This node offers to carry the tailnet's traffic to the public internet (an exit node). */
  exitNodeOption?: boolean;
}

export interface TailscaleNetMap {
  self: TailscaleNode;
  peers: TailscaleNode[];
  /** Tailnet lock is on and this node is not signed. */
  lockedOut?: boolean;
  /** The exit node in use, if any. */
  selectedExitNodeId?: string | null;
}

export interface TailscaleClientEvent {
  state?: TailscaleClientState;
  /** The control server wants the person to visit this URL (notifyBrowseToURL). */
  loginUrl?: string | null;
  netMap?: TailscaleNetMap | null;
  /** The client crashed or panicked; it is unusable until restarted. */
  error?: string;
}

export interface TailscaleClientStartOptions {
  hostname: string;
  /** A Headscale or other control server. Default: Tailscale's. */
  controlUrl?: string;
  /** A pre-auth key: sign in without a person. */
  authKey?: string;
  /** The saved state map (node keys, profile), or null for a new node. */
  state: Record<string, string> | null;
  /** The exit node to start with (a restored session's choice); the controller also sets it again once running. */
  exitNodeId?: string | null;
  /** Called with the whole map after the client writes to it. */
  onState: (state: Record<string, string>) => void;
  onEvent: (event: TailscaleClientEvent) => void;
}

/** A request as the tailnet client takes it. Header names are lower case; `body` is absent for GET and HEAD. */
export interface TailscaleRequest {
  url: string;
  method?: string;
  headers?: Array<[string, string]>;
  body?: Uint8Array | null;
  redirect?: RequestRedirect;
  signal?: AbortSignal;
}

export interface TailscaleResponse {
  url?: string;
  status: number;
  statusText?: string;
  headers: Array<[string, string]>;
  /** Bytes, or a stream for a client that can stream (the WebAssembly client cannot: it returns the whole body). */
  body: Uint8Array | ReadableStream<Uint8Array> | null;
}

/** What BL UI needs from a tailnet client. `createTailscaleConnectClient` and `createFakeTailscaleClient` make one. */
export interface TailscaleClient {
  start(options: TailscaleClientStartOptions): Promise<void>;
  /** Ask for an interactive sign-in; the client answers with a `loginUrl` event. */
  login(): Promise<void> | void;
  logout(): Promise<void> | void;
  fetch(request: TailscaleRequest): Promise<TailscaleResponse>;
  /** Send all traffic through this exit node (an id from the net map), or stop with `null`. Optional: a client without it cannot. */
  setExitNode?(id: string | null): Promise<void> | void;
  dispose(): Promise<void> | void;
}

/* ── persistence ── */

/** What is kept between visits. `state` holds the node's private keys: whoever has it can act as this device. */
export interface TailscaleSession {
  v: 1;
  hostname: string;
  state: Record<string, string>;
  /** The exit node in use when it was saved; chosen again when the session is restored. */
  exitNodeId?: string | null;
}

export interface TailscalePersistence {
  load(): Promise<TailscaleSession | null>;
  save(session: TailscaleSession): Promise<void>;
  clear(): Promise<void>;
}

function readSession(value: unknown): TailscaleSession | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Partial<TailscaleSession>;
  if (v.v !== 1 || typeof v.hostname !== 'string' || !v.state || typeof v.state !== 'object') return null;
  const state: Record<string, string> = {};
  for (const [k, s] of Object.entries(v.state)) {
    if (typeof s !== 'string') return null;
    state[k] = s;
  }
  return { v: 1, hostname: v.hostname, state, ...(typeof v.exitNodeId === 'string' ? { exitNodeId: v.exitNodeId } : {}) };
}

/** Nothing outlives the page (the default when no persistence is given). Every visit is a new device. */
export function memoryTailscalePersistence(): TailscalePersistence {
  let saved: TailscaleSession | null = null;
  return {
    load: async () => saved,
    save: async (s) => { saved = { ...s, state: { ...s.state } }; },
    clear: async () => { saved = null; },
  };
}

/** A `Storage` (sessionStorage, localStorage). **Plain text**: any script on the origin, and anyone with the profile's files, can read the node keys. */
export function webStorageTailscalePersistence(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>, key = 'bl-tailscale-session'): TailscalePersistence {
  return {
    load: async () => {
      try {
        return readSession(JSON.parse(storage.getItem(key) ?? 'null'));
      } catch {
        return null;
      }
    },
    save: async (s) => storage.setItem(key, JSON.stringify(s)),
    clear: async () => storage.removeItem(key),
  };
}

/** The part of a passkey vault (`createVault` in lib/vault) this needs. */
export interface TailscaleVaultLike {
  get<T = unknown>(name: string): Promise<T | undefined>;
  put(name: string, value: unknown): Promise<void>;
  delete(name: string): Promise<void>;
}

/** Encrypted at rest in a passkey vault. The vault must be unlocked: load and save fail while it is locked. */
export function vaultTailscalePersistence(vault: TailscaleVaultLike, name = 'tailscale-session'): TailscalePersistence {
  return {
    load: async () => readSession(await vault.get(name)),
    save: (s) => vault.put(name, s),
    clear: () => vault.delete(name),
  };
}

/* ── errors ── */

export type TailscaleErrorReason =
  | 'no-client' | 'client' | 'auth-key' | 'login-url' | 'not-connected' | 'other-tab' | 'storage' | 'locked-out' | 'in-use';

export class TailscaleError extends Error {
  readonly reason: TailscaleErrorReason;
  constructor(reason: TailscaleErrorReason, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TailscaleError';
    this.reason = reason;
  }
}

/** A sentence for the person using the app. Replace it to localise. */
export function tailscaleErrorMessage(error: unknown): string {
  if (error instanceof TailscaleError) {
    switch (error.reason) {
      case 'no-client': return 'Tailscale is not set up on this page.';
      case 'auth-key': return "Couldn't sign in with the auth key. It may have expired or been used already.";
      case 'login-url': return 'The sign-in page address was not safe to open.';
      case 'not-connected': return 'Not connected to Tailscale.';
      case 'other-tab': return 'Tailscale is already running in another tab of this app.';
      case 'storage': return "Couldn't read or save the Tailscale session.";
      case 'locked-out': return 'Tailnet lock: an administrator has to sign this device.';
      case 'in-use': return 'This Tailscale session belongs to a different user.';
      default: return error.message || 'Tailscale stopped unexpectedly.';
    }
  }
  return 'Something went wrong with Tailscale. Try again.';
}

/* ── the controller ── */

export type TailscaleStatus =
  | 'idle' | 'loading' | 'needs-login' | 'signing-in' | 'starting' | 'needs-approval' | 'connected' | 'error';

export interface TailscalePeer {
  name: string;
  addresses: string[];
  online: boolean;
  /** The node's id, when the client reports one. */
  id: string | null;
  /** It offers to be an exit node. */
  exitNode: boolean;
}

export interface TailscaleSnapshot {
  status: TailscaleStatus;
  /** While signing in: the page to open (https, or http on loopback for a local control server). */
  loginUrl: string | null;
  error: TailscaleError | null;
  /** A problem that did not stop the connection (saving the session failed). */
  warning: string | null;
  /** This device's MagicDNS name, its tailnet (`tail1234.ts.net`) and addresses. */
  selfName: string | null;
  tailnet: string | null;
  addresses: string[];
  peers: TailscalePeer[];
  /** The exit node in use: all traffic, public sites included, goes through it. Null: only the tailnet is reachable. */
  exitNodeId: string | null;
  /** A saved session exists: `connect()` restores it without a sign-in. */
  hasSession: boolean;
}

export type TailscaleAuth =
  | { mode: 'interactive' }
  /** A pre-auth key, or a function that fetches one (from your server, for the signed-in user). It is passed to the client and never stored. */
  | { mode: 'auth-key'; authKey: string | ((signal: AbortSignal) => Promise<string>) };

/** Just enough of a window for the sign-in popup. */
export interface TailscalePopup {
  closed?: boolean;
  opener?: unknown;
  close(): void;
  location: { replace(url: string): void } | Location;
  document?: { title: string; body: { textContent: string | null } | null } | Document;
}

export interface TailscaleEnv {
  /** `window.open`; return null where popups are blocked. */
  open?: ((url: string, target: string, features: string) => TailscalePopup | null) | null;
  /** `navigator.locks`, to keep one tailnet node per origin. */
  locks?: Pick<LockManager, 'request'> | null;
}

export interface TailscaleOptions {
  /** The tailnet client, or a function that makes it (called on first use, so its code loads lazily). */
  client?: TailscaleClient | (() => TailscaleClient | Promise<TailscaleClient>);
  /** Default interactive. */
  auth?: TailscaleAuth;
  /** Where the node's keys are kept. Default: memory (every visit is a new device). */
  persistence?: TailscalePersistence;
  /** This device's name on the tailnet. Default `bl-` and six random letters, kept with the session. */
  hostname?: string;
  /** A Headscale (or other) control server URL. */
  controlUrl?: string;
  /** Restore a saved session on activation. Default true. */
  autoConnect?: boolean;
  /** Called with the sign-in URL when no popup could be opened (the snapshot's `loginUrl` has it too). */
  onLoginUrl?: (url: string) => void;
  /** Open the sign-in page in a popup on `signIn()` (opened at once, so the press counts as the user gesture). Default true. */
  popup?: boolean;
  /** Hold a Web Lock named `bl-tailscale:<lockName>` while connected, so two tabs never run the same node. `false` to skip. Default `default`. */
  lockName?: string | false;
  /** How long an auth-key sign-in may take before it is reported as failed (ms). Default 30 000. */
  authKeyTimeoutMs?: number;
  /** How long Sign In waits for a saved session to sign itself back in before asking for an interactive login. Default 20 s. */
  restoreTimeoutMs?: number;
  /** The default policy for `fetch` and `matches` (the service-worker router takes its own). */
  policy?: TailscalePolicy;
  env?: TailscaleEnv;
}

export interface Tailscale {
  getSnapshot(): TailscaleSnapshot;
  getServerSnapshot(): TailscaleSnapshot;
  subscribe(listener: () => void): () => void;
  /** Starts using it (reads whether a session is saved; restores it when `autoConnect`). Returns the matching release. Providers call this. */
  activate(): () => void;
  /** Restore the saved session, if any. */
  connect(): Promise<void>;
  /** Sign in (interactive or with the auth key). Call it from a press handler so the popup is allowed. */
  signIn(): Promise<void>;
  /** Give up a sign-in in progress. */
  cancel(): void;
  /** Stop the client but keep the session (`connect()` resumes it). */
  disconnect(): Promise<void>;
  /** Log the node out and forget the session. */
  signOut(): Promise<void>;
  /** A request through the tailnet. Rejects with `TailscaleError('not-connected')` unless connected. */
  fetch(request: TailscaleRequest): Promise<TailscaleResponse>;
  /** Route everything through an exit node (its `id` from `getSnapshot().peers`), or `null` to go back to the tailnet alone.
      Rejects unless connected, the client supports it, and the id is a peer that offers to be an exit node. */
  setExitNode(id: string | null): Promise<void>;
  /** Whether `url` matches this controller's policy. */
  matches(url: string | URL, method?: string): boolean;
  readonly policy: ResolvedTailscalePolicy;
  /** Stops everything; the controller can be activated again. */
  dispose(): Promise<void>;
}

const IDLE: TailscaleSnapshot = Object.freeze({
  status: 'idle', loginUrl: null, error: null, warning: null, selfName: null, tailnet: null, addresses: [], peers: [], exitNodeId: null, hasSession: false,
}) as TailscaleSnapshot;

/** https anywhere; http only on loopback (a local Headscale). Anything else (javascript:, data:) is refused. */
export function isSafeLoginUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]');
  } catch {
    return false;
  }
}

function randomHostname(): string {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  return `bl-${Array.from(bytes, (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('')}`;
}

function tailnetOf(name: string | null): string | null {
  if (!name) return null;
  const parts = name.replace(/\.$/, '').split('.');
  return parts.length > 2 ? parts.slice(1).join('.') : null;
}

export function createTailscale(options: TailscaleOptions = {}): Tailscale {
  const policy = resolveTailscalePolicy(options.policy);
  const auth: TailscaleAuth = options.auth ?? { mode: 'interactive' };
  const persistence = options.persistence ?? memoryTailscalePersistence();
  const lockName = options.lockName === false ? null : `bl-tailscale:${options.lockName ?? 'default'}`;
  const listeners = new Set<() => void>();
  let snap: TailscaleSnapshot = IDLE;

  let client: TailscaleClient | null = null;
  let starting: Promise<TailscaleClient> | null = null;
  let generation = 0; // bumped on every stop, so late events from a stopped client are ignored
  let clientState: TailscaleClientState = 'NoState';
  let loginRequested = false;
  let popup: TailscalePopup | null = null;
  let popupAway = false; // the popup has been sent to the sign-in page (cross-origin, opener cleared)
  /** Resolved by the client's next settled state (signIn waits for it before asking for an interactive login). */
  let stateWaiters: Array<(state: TailscaleClientState) => void> = [];
  let lastCrash = 0;
  let currentHostname: string | null = null; // the running client's, for saving state that arrives before a session exists
  let session: TailscaleSession | null = null;
  let sessionLoaded: Promise<void> | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingState: Record<string, string> | null = null;
  let releaseLock: (() => void) | null = null;
  let authAbort: AbortController | null = null;
  let authTimer: ReturnType<typeof setTimeout> | null = null;
  let active = 0;
  let disposeTimer: ReturnType<typeof setTimeout> | null = null;

  const env = (): TailscaleEnv => ({
    open: options.env?.open !== undefined ? options.env.open : typeof window !== 'undefined' ? (u, t, f) => window.open(u, t, f) : null,
    locks: options.env?.locks !== undefined ? options.env.locks : typeof navigator !== 'undefined' && navigator.locks ? navigator.locks : null,
  });

  function set(patch: Partial<TailscaleSnapshot>) {
    const next = { ...snap, ...patch };
    if ((Object.keys(patch) as Array<keyof TailscaleSnapshot>).every((k) => Object.is(next[k], snap[k]))) return;
    snap = next;
    listeners.forEach((l) => l());
  }

  function fail(error: TailscaleError) {
    closePopup();
    clearAuthTimer();
    loginRequested = false;
    set({ status: 'error', error, loginUrl: null });
  }

  /* ── session ── */

  function loadSession(): Promise<void> {
    if (!sessionLoaded) {
      sessionLoaded = persistence.load().then(
        (s) => { session = s; set({ hasSession: s !== null }); },
        (e: unknown) => { sessionLoaded = null; throw new TailscaleError('storage', 'Could not read the saved Tailscale session.', { cause: e }); },
      );
    }
    return sessionLoaded;
  }

  function scheduleSave(state: Record<string, string>, hostname: string) {
    pendingState = state;
    if (saveTimer) return;
    saveTimer = setTimeout(() => void flush(hostname), 250);
  }

  async function flush(hostname: string) {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    const state = pendingState;
    pendingState = null;
    if (!state) return;
    session = { v: 1, hostname, state, ...(session?.exitNodeId ? { exitNodeId: session.exitNodeId } : {}) };
    try {
      await persistence.save(session);
      set({ hasSession: true, warning: null });
    } catch {
      set({ warning: "The Tailscale session couldn't be saved; you will be asked to sign in again next time." });
    }
  }

  /* ── popup ── */

  function openPopup() {
    if (options.popup === false) return;
    const open = env().open;
    if (!open || (popup && !popup.closed)) return;
    try {
      popup = open('', 'bl-tailscale-login', 'popup,width=520,height=720');
    } catch {
      popup = null;
    }
    if (!popup) return;
    try {
      const doc = popup.document;
      if (doc) {
        doc.title = 'Tailscale';
        if (doc.body) doc.body.textContent = 'Waiting for Tailscale…';
      }
    } catch { /* cross-origin already, or no document: fine */ }
  }

  function closePopup() {
    const p = popup;
    const away = popupAway;
    popup = null;
    popupAway = false;
    // Once it shows login.tailscale.com (opener cleared) the page no longer owns it: closing or navigating it then only earns
    // the browser's "unsafe attempt" warning. Tailscale's page says when it is done; a blank one is still ours to close.
    if (away) return;
    try {
      if (p && !p.closed) p.close();
    } catch { /* ignore */ }
  }

  function showLoginUrl(url: string | null) {
    if (url === null) return set({ loginUrl: null });
    if (!isSafeLoginUrl(url)) return fail(new TailscaleError('login-url', `Refused to open the sign-in URL ${JSON.stringify(url.slice(0, 80))}.`));
    const repeat = snap.loginUrl === url;
    set({ loginUrl: url });
    const p = popup;
    if (p && !popupAway && !p.closed) {
      try {
        p.opener = null;
        p.location.replace(url);
        popupAway = true;
        return;
      } catch {
        popup = null;
      }
    }
    // The popup already shows a sign-in page: the same URL again needs nothing; a new one goes to the badge's link.
    if (popupAway && repeat) return;
    options.onLoginUrl?.(url);
  }

  /* ── state ── */

  function derive(): TailscaleStatus {
    switch (clientState) {
      case 'Running': return 'connected';
      case 'Starting': return loginRequested ? 'signing-in' : 'starting';
      case 'NeedsMachineAuth': return 'needs-approval';
      case 'NeedsLogin':
      case 'Stopped':
      case 'NoState':
        return loginRequested ? 'signing-in' : starting || client ? 'needs-login' : 'idle';
      default: return 'error';
    }
  }

  function onEvent(gen: number, event: TailscaleClientEvent) {
    if (gen !== generation) return;
    if (event.error) {
      // The Go runtime exits on a panic. With a saved session, start a fresh client once (not twice in a minute) and pick the
      // exit node again; otherwise report it.
      const wasRunning = clientState === 'Running';
      void stop(false).then(() => { // stop() saves state still waiting to be written, so `session` is current here
        set({ exitNodeId: null });
        if (wasRunning && session && Date.now() - lastCrash > 60_000) {
          lastCrash = Date.now();
          set({ status: 'loading', warning: 'Tailscale stopped unexpectedly and is reconnecting.' });
          ensureClient().catch((e: unknown) => fail(e instanceof TailscaleError ? e : new TailscaleError('client', event.error!)));
        } else {
          fail(new TailscaleError('client', event.error!));
        }
      });
      return;
    }
    if (event.netMap !== undefined) {
      const nm = event.netMap;
      if (nm?.lockedOut) {
        fail(new TailscaleError('locked-out', 'Tailnet lock: this device is not signed.'));
        return;
      }
      const selfName = nm?.self.name.replace(/\.$/, '') || null;
      set({
        selfName,
        tailnet: tailnetOf(selfName),
        addresses: nm?.self.addresses ?? [],
        peers: (nm?.peers ?? []).map((p) => ({ name: p.name.replace(/\.$/, ''), addresses: p.addresses, online: p.online === true, id: p.id ?? null, exitNode: p.exitNodeOption === true })),
        // A net map that says nothing about it leaves the choice as it was; one that does (even null) settles it.
        ...(nm?.selectedExitNodeId !== undefined ? { exitNodeId: nm.selectedExitNodeId } : nm === null ? { exitNodeId: null } : {}),
      });
    }
    if (event.loginUrl !== undefined) showLoginUrl(event.loginUrl);
    if (event.state) {
      clientState = event.state;
      if (clientState !== 'NoState' && clientState !== 'Starting') {
        const waiters = stateWaiters;
        stateWaiters = [];
        waiters.forEach((w) => w(clientState));
      }
      if (clientState === 'InUseOtherUser') return fail(new TailscaleError('in-use', 'The session belongs to a different user.'));
      if (clientState === 'Running') {
        loginRequested = false;
        clearAuthTimer();
        closePopup();
        set({ loginUrl: null });
        restoreExitNode(gen);
      }
    }
    if (snap.status !== 'error' || event.state === 'Running') set({ status: derive(), ...(event.state === 'Running' ? { error: null } : {}) });
  }

  /** Picks the saved exit node again once a restored client is running (the client starts without one). */
  function restoreExitNode(gen: number) {
    const id = session?.exitNodeId;
    if (!id || snap.exitNodeId === id || !client?.setExitNode) return;
    const c = client;
    // The net map with the peers may arrive just after Running: give it a moment.
    setTimeout(() => {
      if (gen !== generation || client !== c || snap.exitNodeId === id) return;
      if (!snap.peers.some((p) => p.id === id && p.exitNode)) return;
      Promise.resolve(c.setExitNode!(id)).then(() => { if (gen === generation) set({ exitNodeId: id, warning: null }); }, () => {});
    }, 250);
  }

  /** The client's next settled state (anything past Starting), or null after `ms`. */
  function waitForState(ms: number): Promise<TailscaleClientState | null> {
    if (clientState !== 'NoState' && clientState !== 'Starting') return Promise.resolve(clientState);
    return new Promise((resolve) => {
      const t = setTimeout(() => { stateWaiters = stateWaiters.filter((w) => w !== done); resolve(null); }, ms);
      const done = (s: TailscaleClientState) => { clearTimeout(t); resolve(s); };
      stateWaiters.push(done);
    });
  }

  function clearAuthTimer() {
    if (authTimer) clearTimeout(authTimer);
    authTimer = null;
  }

  async function takeLock(): Promise<boolean> {
    if (!lockName || releaseLock) return true;
    const locks = env().locks;
    if (!locks) return true; // no Web Locks: fail open
    return new Promise<boolean>((resolve) => {
      locks.request(lockName, { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(false);
          return undefined;
        }
        resolve(true);
        return new Promise<void>((release) => { releaseLock = release; });
      }).catch(() => resolve(true));
    });
  }

  async function ensureClient(authKey?: string): Promise<TailscaleClient> {
    if (client) return client;
    if (starting) return starting;
    const gen = ++generation;
    starting = (async () => {
      set({ status: 'loading', error: null });
      if (!(await takeLock())) throw new TailscaleError('other-tab', 'Tailscale is running in another tab.');
      await loadSession();
      const make = options.client;
      if (!make) throw new TailscaleError('no-client', 'No Tailscale client: pass `client` to createTailscale (for example createTailscaleConnectClient).');
      let c: TailscaleClient;
      try {
        c = typeof make === 'function' ? await make() : make;
      } catch (e) {
        throw new TailscaleError('client', `The Tailscale client failed to load: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
      }
      if (gen !== generation) {
        void c.dispose();
        throw new TailscaleError('client', 'Stopped while starting.');
      }
      const hostname = session?.hostname ?? options.hostname ?? randomHostname();
      currentHostname = hostname;
      clientState = 'NoState';
      try {
        await c.start({
          hostname,
          controlUrl: options.controlUrl,
          authKey,
          state: session?.state ?? null,
          exitNodeId: session?.exitNodeId ?? null,
          onState: (state) => { if (gen === generation) scheduleSave(state, hostname); },
          onEvent: (e) => onEvent(gen, e),
        });
      } catch (e) {
        void c.dispose();
        throw new TailscaleError('client', `The Tailscale client failed to start: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
      }
      if (gen !== generation) {
        void c.dispose();
        throw new TailscaleError('client', 'Stopped while starting.');
      }
      client = c;
      set({ status: derive() });
      return c;
    })();
    try {
      return await starting;
    } catch (e) {
      if (gen === generation) {
        releaseLock?.();
        releaseLock = null;
      }
      throw e;
    } finally {
      if (gen === generation) starting = null;
    }
  }

  async function stop(keepLock: boolean) {
    generation++;
    clearAuthTimer();
    authAbort?.abort();
    authAbort = null;
    const c = client;
    client = null;
    starting = null;
    clientState = 'NoState';
    loginRequested = false;
    const waiters = stateWaiters;
    stateWaiters = [];
    waiters.forEach((w) => w('Stopped'));
    const host = session?.hostname ?? currentHostname;
    if (pendingState && host) await flush(host);
    if (!keepLock) {
      releaseLock?.();
      releaseLock = null;
    }
    if (c) await c.dispose();
  }

  const reset = () => set({ status: 'idle', loginUrl: null, selfName: null, tailnet: null, addresses: [], peers: [], exitNodeId: null });

  const api: Tailscale = {
    policy,
    getSnapshot: () => snap,
    getServerSnapshot: () => IDLE,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    activate() {
      active++;
      if (disposeTimer) clearTimeout(disposeTimer);
      disposeTimer = null;
      loadSession().then(
        () => { if (active > 0 && session && options.autoConnect !== false && snap.status === 'idle') void api.connect(); },
        (e: unknown) => set({ warning: e instanceof Error ? e.message : String(e) }),
      );
      let released = false;
      return () => {
        if (released) return;
        released = true;
        active--;
        // A StrictMode remount activates again straight away: wait a tick before stopping.
        if (active === 0) disposeTimer = setTimeout(() => { disposeTimer = null; if (active === 0) void api.dispose(); }, 0);
      };
    },
    async connect() {
      if (client || starting) return;
      try {
        await loadSession();
        if (!session) return;
        await ensureClient();
      } catch (e) {
        fail(e instanceof TailscaleError ? e : new TailscaleError('client', String(e)));
      }
    },
    async signIn() {
      if (snap.status === 'connected') return;
      const interactive = auth.mode === 'interactive';
      if (interactive) openPopup(); // synchronously, inside the press
      loginRequested = true;
      set({ status: 'signing-in', error: null, loginUrl: null });
      try {
        let authKey: string | undefined;
        if (auth.mode === 'auth-key') {
          if (client) await stop(true); // a running client without the key: restart it with one
          authAbort = new AbortController();
          try {
            authKey = typeof auth.authKey === 'function' ? await auth.authKey(authAbort.signal) : auth.authKey;
          } catch (e) {
            throw new TailscaleError('auth-key', `Could not get an auth key: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
          }
          if (!authKey) throw new TailscaleError('auth-key', 'The auth key is empty.');
          const gen = generation;
          clearAuthTimer();
          authTimer = setTimeout(() => {
            if (gen <= generation && snap.status !== 'connected' && loginRequested) {
              void stop(false);
              fail(new TailscaleError('auth-key', 'Signing in with the auth key did not finish in time.'));
            }
          }, options.authKeyTimeoutMs ?? 30_000);
        }
        loginRequested = true;
        try { await loadSession(); } catch { /* ensureClient reports it */ }
        const restoring = !!session && !client && !starting;
        const c = await ensureClient(authKey);
        set({ status: derive() });
        // A saved session usually signs straight back in: asking for an interactive login now would cancel that (and its
        // control-key fetch). Wait for the client to say whether it needs one.
        if (interactive && restoring) await waitForState(options.restoreTimeoutMs ?? 20_000);
        if (interactive && clientState !== 'Running' && loginRequested) await c.login();
      } catch (e) {
        if (!loginRequested && !(e instanceof TailscaleError)) return; // cancelled
        fail(e instanceof TailscaleError ? e : new TailscaleError('client', e instanceof Error ? e.message : String(e), { cause: e }));
      }
    },
    cancel() {
      if (snap.status !== 'signing-in' && snap.status !== 'loading') return;
      loginRequested = false;
      clearAuthTimer();
      authAbort?.abort();
      closePopup();
      set({ loginUrl: null, status: client ? derive() : 'idle' });
    },
    async disconnect() {
      closePopup();
      await stop(false);
      reset();
      set({ error: null });
    },
    async signOut() {
      closePopup();
      const c = client;
      try {
        if (c) await c.logout();
      } catch { /* logging out of a broken client still forgets the session below */ }
      pendingState = null;
      await stop(false);
      session = null;
      try {
        await persistence.clear();
      } catch {
        set({ warning: "The saved session couldn't be deleted." });
      }
      reset();
      set({ hasSession: false, error: null });
    },
    async fetch(request) {
      if (!client || clientState !== 'Running') throw new TailscaleError('not-connected', 'Not connected to Tailscale.');
      return client.fetch(request);
    },
    async setExitNode(id) {
      if (!client || clientState !== 'Running') throw new TailscaleError('not-connected', 'Not connected to Tailscale.');
      if (!client.setExitNode) throw new TailscaleError('client', 'This Tailscale client cannot use an exit node.');
      if (id !== null && !snap.peers.some((p) => p.id === id && p.exitNode)) throw new TailscaleError('client', 'That device is not an exit node on this tailnet.');
      await client.setExitNode(id);
      set({ exitNodeId: id });
      if (pendingState && currentHostname) await flush(currentHostname);
      if (session) {
        session = { ...session, exitNodeId: id };
        try { await persistence.save(session); } catch { /* the choice still holds for this visit */ }
      }
    },
    matches(url, method = 'GET') {
      return matchTailscalePolicy(url, method, policy, typeof location !== 'undefined' ? location.origin : undefined).route;
    },
    async dispose() {
      closePopup();
      await stop(false);
      reset();
    },
  };
  return api;
}

/* ── fetch helpers ── */

/** A `Request` (or fetch's arguments) as a `TailscaleRequest`: the body is read into memory. */
export async function toTailscaleRequest(input: RequestInfo | URL, init?: RequestInit): Promise<TailscaleRequest> {
  const req = new Request(input, init);
  const headers: Array<[string, string]> = [];
  req.headers.forEach((value, name) => headers.push([name, value]));
  const method = req.method.toUpperCase();
  const body = method === 'GET' || method === 'HEAD' ? null : new Uint8Array(await req.arrayBuffer());
  return { url: req.url, method, headers, body: body && body.byteLength ? body : null, redirect: req.redirect, signal: init?.signal ?? undefined };
}

const NULL_BODY = new Set([101, 103, 204, 205, 304]);

/** A `TailscaleResponse` as a `Response`. Statuses a `Response` cannot carry become 502. */
export function toResponse(res: TailscaleResponse): Response {
  const status = res.status >= 200 && res.status <= 599 ? res.status : 502;
  const headers = new Headers();
  for (const [k, v] of res.headers) {
    try { headers.append(k, v); } catch { /* a header the platform forbids */ }
  }
  const body = NULL_BODY.has(status) ? null : (res.body as BodyInit | null);
  return new Response(body, { status, statusText: res.statusText ?? '', headers });
}

/**
 * A `fetch` that sends what matches the policy through the tailnet and the rest to `fallback` (default: the global
 * fetch). While disconnected, matching requests go to the fallback too, unless the policy says `whenUnavailable: 'error'`.
 */
export function createTailscaleFetch(tailscale: Tailscale, fallback: typeof fetch = globalThis.fetch.bind(globalThis)): typeof fetch {
  return Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    if (!tailscale.matches(req.url, req.method)) return fallback(input, init);
    if (tailscale.getSnapshot().status !== 'connected') {
      if (tailscale.policy.whenUnavailable === 'error') return new Response('Tailscale is not connected.', { status: 503, headers: { 'content-type': 'text/plain' } });
      return fallback(input, init);
    }
    return toResponse(await tailscale.fetch(await toTailscaleRequest(req)));
  }, { preconnect: () => undefined });
}
