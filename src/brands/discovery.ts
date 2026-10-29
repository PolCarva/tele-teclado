// Finds TVs of every supported brand on the Wi-Fi: mDNS / Bonjour, SSDP, and (deep search)
// a TCP probe of each brand's ports on every address of the phone's subnet.

import type { MdnsService } from '../protocol/transport';
import { ssdpHeaders, type Driver, type DriverContext, type TvInfo } from './types';

/** Services that don't identify a remote protocol but carry the TV's friendly name. */
const NAME_TYPES = ['_googlecast._tcp', '_airplay._tcp'];

export type DiscoverOptions = {
  timeoutMs?: number;
  /** Also probe ports on every address of the subnet (slower, finds TVs that don't announce themselves). */
  deep?: boolean;
  /** Called as TVs show up, before the search is over. */
  onFound?: (tvs: TvInfo[]) => void;
};

const isIp = (text: string) => /^\d+\.\d+\.\d+\.\d+$/.test(text) || text.includes(':');

/** Addresses to probe: the phone's /24 first, nearest first; at most `limit`. */
export function subnetHosts(ip: string, prefixLength: number, limit = 254): string[] {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return [];
  const own = ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
  const prefix = Math.max(16, Math.min(30, prefixLength || 24));
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = (own & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  const block24 = (own & 0xffffff00) >>> 0;
  const toText = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
  const inSubnet = (n: number) => n > network && n < broadcast && n !== own;
  const out: number[] = [];
  // The phone's own /24 first (most home routers), nearest addresses first.
  for (let d = 1; d < 256 && out.length < limit; d++) {
    for (const n of [own - d, own + d]) {
      if (n >= block24 && n <= block24 + 255 && inSubnet(n) && (n & 255) !== 0 && (n & 255) !== 255) out.push(n);
    }
  }
  // Then the rest of a bigger subnet (e.g. /22), until the limit.
  for (let d = 256; out.length < limit && (own - d > network || own + d < broadcast); d++) {
    for (const n of [own - d, own + d]) if (inSubnet(n) && !(n >= block24 && n <= block24 + 255)) out.push(n);
  }
  return out.slice(0, limit).map(toText);
}

export async function discoverTvs(ctx: DriverContext, drivers: Driver[], options: DiscoverOptions = {}): Promise<TvInfo[]> {
  const { transport } = ctx;
  const timeoutMs = options.timeoutMs ?? 3500;
  const byHost = new Map<string, { tv: TvInfo; priority: number }>();
  const names = new Map<string, string>();
  const priorityOf = new Map(drivers.map((d) => [d.brand, d.priority]));

  const report = () => options.onFound?.(results());
  const add = (tv: TvInfo | null) => {
    if (!tv?.host) return;
    const priority = priorityOf.get(tv.brand) ?? 0;
    const current = byHost.get(tv.host);
    if (!current || priority > current.priority) {
      // Keep a real name found by another connector over a bare address.
      const name = isIp(tv.name) && current && !isIp(current.tv.name) ? current.tv.name : tv.name;
      byHost.set(tv.host, { tv: { ...tv, name }, priority });
      report();
    } else if (isIp(current.tv.name) && !isIp(tv.name)) {
      current.tv = { ...current.tv, name: tv.name };
      report();
    }
  };
  const results = () =>
    [...byHost.values()]
      .map(({ tv }) => (isIp(tv.name) && names.has(tv.host) ? { ...tv, name: names.get(tv.host)! } : tv))
      .sort((a, b) => a.name.localeCompare(b.name));

  const safe = async <T>(work: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await work();
    } catch {
      return fallback;
    }
  };

  const mdnsTypes = [...new Set(drivers.flatMap((d) => d.discovery.mdnsTypes ?? []).concat(NAME_TYPES))];
  const mdns = transport.browse
    ? safe(() => transport.browse!(mdnsTypes, timeoutMs), [] as MdnsService[]).then(async (services) => {
        for (const s of services) {
          if (NAME_TYPES.includes(s.type)) {
            const name = s.txt.fn || s.name.replace(/^[0-9A-F]{12}@/, '');
            if (name && !names.has(s.host)) names.set(s.host, name);
          }
        }
        const work: Promise<void>[] = [];
        for (const s of services) {
          for (const d of drivers) {
            if (d.discovery.fromMdns) work.push(safe(async () => d.discovery.fromMdns!(s, ctx), null).then(add));
          }
          // AirPlay / Cast say who made the TV: ask that brand's ports on that address.
          const maker = s.txt.manufacturer || s.txt.md || '';
          if (NAME_TYPES.includes(s.type) && maker) {
            for (const d of drivers) {
              if (d.discovery.manufacturer?.test(maker) && d.discovery.fromPort && d.discovery.probePorts?.length) {
                work.push(probeHost(ctx, d, s.host).then(add));
              }
            }
          }
        }
        await Promise.all(work);
      })
    : Promise.resolve();

  const targets = [...new Set(drivers.flatMap((d) => d.discovery.ssdpTargets ?? []))];
  const ssdp =
    transport.ssdp && targets.length
      ? safe(() => transport.ssdp!(targets, [], timeoutMs), []).then((replies) =>
          Promise.all(
            replies.flatMap((reply) => {
              const headers = ssdpHeaders(reply.response);
              return drivers
                .filter((d) => d.discovery.fromSsdp)
                .map((d) => safe(() => d.discovery.fromSsdp!(reply, headers, ctx), null).then(add));
            }),
          ),
        )
      : Promise.resolve();

  await Promise.all([mdns, ssdp]);

  if (options.deep && transport.probe && transport.networkInfo) {
    const net = await safe(() => transport.networkInfo!(), null);
    const hosts = net ? subnetHosts(net.ip, net.prefixLength) : [];
    const ports = [...new Set(drivers.flatMap((d) => d.discovery.probePorts ?? []))];
    if (hosts.length && ports.length) {
      const open = await safe(() => transport.probe!(hosts, ports, 600, 96), []);
      await Promise.all(
        open.map(({ host, port }) =>
          Promise.all(
            drivers
              .filter((d) => d.discovery.fromPort && d.discovery.probePorts?.includes(port))
              .map((d) => safe(() => d.discovery.fromPort!(host, port, ctx), null).then(add)),
          ),
        ),
      );
    }
  }
  return results();
}

/** Tries one brand's ports on one address. */
async function probeHost(ctx: DriverContext, driver: Driver, host: string): Promise<TvInfo | null> {
  const ports = driver.discovery.probePorts ?? [];
  const open = ctx.transport.probe ? await ctx.transport.probe([host], ports, 1200, 8).catch(() => []) : ports.map((port) => ({ host, port }));
  for (const { port } of open) {
    const tv = await driver.discovery.fromPort!(host, port, ctx).catch(() => null);
    if (tv) return tv;
  }
  return null;
}

/** "Connect by address": find out which brand answers at this address. */
export async function identifyHost(ctx: DriverContext, drivers: Driver[], host: string): Promise<TvInfo | null> {
  const ports = [...new Set(drivers.flatMap((d) => d.discovery.probePorts ?? []))];
  const open = ctx.transport.probe ? await ctx.transport.probe([host], ports, 1500, 32).catch(() => []) : [];
  let best: { tv: TvInfo; priority: number } | null = null;
  await Promise.all(
    open.map(({ port }) =>
      Promise.all(
        drivers
          .filter((d) => d.discovery.fromPort && d.discovery.probePorts?.includes(port))
          .map(async (d) => {
            const tv = await d.discovery.fromPort!(host, port, ctx).catch(() => null);
            if (tv && (!best || d.priority > best.priority)) best = { tv, priority: d.priority };
          }),
      ),
    ),
  );
  return (best as { tv: TvInfo; priority: number } | null)?.tv ?? null;
}
