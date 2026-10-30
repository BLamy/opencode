/* ══ tailscale-exit — choosing an exit node ══
   Pure helpers over a snapshot's peers: which devices could carry the traffic to the public internet, which one to use,
   and what to call it. Nothing here talks to the controller; call `tailscale.setExitNode(pickExitNode(snapshot))`. */
import type { TailscalePeer, TailscaleSnapshot } from './tailscale';

type WithPeers = Pick<TailscaleSnapshot, 'peers'>;

/** A peer's first DNS label: `bretts-macbook-pro.tail1234.ts.net` → `bretts-macbook-pro`. */
export const exitNodeName = (p: Pick<TailscalePeer, 'name'>): string => p.name.split('.')[0] ?? p.name;

/** Devices that offer to be an exit node and can be chosen (they report an id), online or not, sorted by name. */
export function exitNodePeers(snapshot: WithPeers): TailscalePeer[] {
  return snapshot.peers
    .filter((p) => p.exitNode && p.id)
    .sort((a, b) => exitNodeName(a).localeCompare(exitNodeName(b)));
}

/** Whether the exit node in use is known to be up: false when it is offline or no longer on the tailnet, and for no exit node. */
export function exitNodeOnline(snapshot: Pick<TailscaleSnapshot, 'peers' | 'exitNodeId'>): boolean {
  return snapshot.exitNodeId !== null && snapshot.peers.some((p) => p.id === snapshot.exitNodeId && p.online);
}

export interface PickExitNodeOptions {
  /** Ids to leave out: the node that just failed, so a retry tries another. A string or a list. */
  exclude?: string | readonly string[] | null;
  /** The node used before: chosen if it is still a candidate. */
  prefer?: string | null;
}

/** The exit node to use: only a peer that offers to be one, has an id and is online; the one named by `prefer` if it qualifies,
    else the first by name. Null when none qualifies (the caller shows why). An excluded id never qualifies. */
export function pickExitNode(snapshot: WithPeers, { exclude, prefer }: PickExitNodeOptions = {}): string | null {
  const skip = new Set(typeof exclude === 'string' ? [exclude] : exclude ?? []);
  const candidates = exitNodePeers(snapshot).filter((p) => p.online && !skip.has(p.id as string));
  return (prefer ? candidates.find((p) => p.id === prefer)?.id : null) ?? candidates[0]?.id ?? null;
}
