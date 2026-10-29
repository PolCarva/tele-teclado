// Tiny URL parser (Hermes' URL support is partial): just what TV protocols need.

export type ParsedUrl = {
  scheme: 'http' | 'https' | 'ws' | 'wss';
  secure: boolean;
  host: string;
  port: number;
  /** Path plus query, always starting with "/". */
  path: string;
};

export function parseUrl(url: string): ParsedUrl {
  const m = /^(https?|wss?):\/\/(\[[^\]]+\]|[^/:?#]+)(?::(\d+))?([^#]*)/i.exec(url.trim());
  if (!m) throw new Error(`URL inválida: ${url}`);
  const scheme = m[1].toLowerCase() as ParsedUrl['scheme'];
  const secure = scheme === 'https' || scheme === 'wss';
  let path = m[4] || '/';
  if (!path.startsWith('/')) path = '/' + path;
  const host = m[2].replace(/^\[|\]$/g, '');
  return { scheme, secure, host, port: m[3] ? Number(m[3]) : secure ? 443 : 80, path };
}

/** Host header value: the port is left out when it's the scheme's default. */
export function hostHeader(url: ParsedUrl): string {
  const host = url.host.includes(':') ? `[${url.host}]` : url.host;
  return url.port === (url.secure ? 443 : 80) ? host : `${host}:${url.port}`;
}
