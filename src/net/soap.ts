// UPnP SOAP calls (Panasonic NRC, Sony IRCC…) over the raw-socket HTTP client.

import type { Transport } from '../protocol/transport';
import { httpRequest, type HttpResponse } from './http';

export function soapEnvelope(serviceUrn: string, action: string, args: string): string {
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    `<s:Body><u:${action} xmlns:u="${serviceUrn}">${args}</u:${action}></s:Body></s:Envelope>`
  );
}

export class SoapError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** UPnP errorCode from the SOAP fault, when there is one. */
    readonly upnpCode: number | null,
    readonly body: string,
  ) {
    super(message);
  }
}

/** POSTs a SOAP action. Resolves with the response body on HTTP 200, throws SoapError otherwise. */
export async function soapCall(
  transport: Transport,
  url: string,
  serviceUrn: string,
  action: string,
  args: string,
  options: { timeoutMs?: number; headers?: Record<string, string> } = {},
): Promise<string> {
  const response: HttpResponse = await httpRequest(transport, {
    method: 'POST',
    url,
    timeoutMs: options.timeoutMs ?? 5000,
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
      SOAPAction: `"${serviceUrn}#${action}"`,
      Accept: 'text/xml',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
      ...options.headers,
    },
    body: soapEnvelope(serviceUrn, action, args),
  });
  const body = response.text();
  if (response.status !== 200) {
    const code = /<errorCode>\s*(\d+)\s*<\/errorCode>/i.exec(body);
    const description = /<errorDescription>([^<]*)<\/errorDescription>/i.exec(body)?.[1];
    throw new SoapError(
      `${action}: HTTP ${response.status}${description ? ` (${description})` : ''}`,
      response.status,
      code ? Number(code[1]) : null,
      body,
    );
  }
  return body;
}
