// Test helpers: a transport that sends "TV address:port" to local fake TVs, and a controller
// harness that drives TvController the way the screen does.

import assert from 'node:assert/strict';

import type { Driver, TvInfo } from '../../src/brands/types';
import type { MdnsService, SsdpReply, Transport } from '../../src/protocol/transport';
import { TvController, type TvState } from '../../src/tv/TvController';
import { nodeTransport } from '../nodeTransport';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Real sockets, but "10.0.0.7:55000" goes to 127.0.0.1:<port of the fake TV>. */
export function remapTransport(
  routes: Record<string, number>,
  extras: { mdns?: MdnsService[]; ssdp?: SsdpReply[]; probe?: { host: string; port: number }[] } = {},
): Transport & { connections: string[] } {
  const connections: string[] = [];
  const route = (host: string, port: number) => {
    // A pointer/sub socket the TV hands back already points at 127.0.0.1: pass it through.
    if (host === '127.0.0.1') return port;
    const local = routes[`${host}:${port}`];
    if (local === undefined) throw Object.assign(new Error(`ECONNREFUSED ${host}:${port}`), { code: 'network' });
    return local;
  };
  return {
    connections,
    getClientKey: nodeTransport.getClientKey,
    randomBytes: nodeTransport.randomBytes,
    async connect(host, port, timeoutMs, mode) {
      connections.push(`${mode ?? 'tls-client-cert'}://${host}:${port}`);
      let local: number;
      try {
        local = route(host, port);
      } catch (e) {
        const { TransportError } = await import('../../src/protocol/transport');
        throw new TransportError((e as Error).message, 'network');
      }
      return nodeTransport.connect('127.0.0.1', local, timeoutMs, mode);
    },
    browse: async () => extras.mdns ?? [],
    ssdp: async () => extras.ssdp ?? [],
    probe: async (hosts, ports) =>
      (extras.probe ?? Object.keys(routes).map((k) => ({ host: k.split(':')[0], port: Number(k.split(':')[1]) }))).filter(
        (p) => hosts.includes(p.host) && ports.includes(p.port),
      ),
    networkInfo: async () => ({ ip: '10.0.0.2', prefixLength: 24 }),
  };
}

export function memoryStore() {
  const map = new Map<string, string | null>();
  return { map, get: (k: string) => map.get(k) ?? null, set: (k: string, v: string | null) => void map.set(k, v) };
}

export function controllerFor(transport: Transport, drivers: Driver[], store = memoryStore()) {
  const tv = new TvController(transport, store, { warmUpMs: 0, searchScreen: { alreadyOpenMs: [10], justOpenedMs: [20], retypeGapMs: 5, giveUpMs: 200 } }, drivers);
  return { tv, store, state: (): TvState => tv.getState() };
}

/** Waits until `check` passes (or fails after `ms`). */
export async function eventually(check: () => void, ms = 3000) {
  const start = Date.now();
  for (;;) {
    try {
      check();
      return;
    } catch (e) {
      if (Date.now() - start > ms) throw e;
      await sleep(20);
    }
  }
}

export function onlyTv(tvs: TvInfo[], brand: string): TvInfo {
  const matches = tvs.filter((t) => t.brand === brand);
  assert.equal(matches.length, 1, `expected one ${brand} TV, got ${JSON.stringify(tvs)}`);
  return matches[0];
}
