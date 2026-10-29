// End-to-end test of the NEW multi-brand stack against a real TV on the Wi-Fi, run from the Mac.
// Uses the same code the app uses (src/brands discovery + the brand connector + TvSession),
// over node:tls/dns-sd via nodeTransport. The Mac is already paired with the TCL, so no code is
// shown on the TV. Usage: npm run realtv -- "texto a escribir"   (TV_HOST optional to skip scan)

import { discoverTvs } from '../src/brands/discovery';
import { driverFor, DRIVERS } from '../src/brands';
import type { DriverContext, TvInfo, TvSession } from '../src/brands/types';
import { nodeTransport } from './nodeTransport';

const text = process.argv[2] ?? 'hola desde teclado tv';
const ctx: DriverContext = { transport: nodeTransport, clientName: 'Teclado TV (prueba Mac)' };
const log = (...a: unknown[]) => console.log(...a);

async function findTv(): Promise<TvInfo | null> {
  if (process.env.TV_HOST) {
    log(`Usando TV_HOST=${process.env.TV_HOST} (Android TV)`);
    return { brand: 'androidtv', host: process.env.TV_HOST, name: process.env.TV_HOST };
  }
  log('Buscando teles (mDNS + SSDP + sondeo de puertos)…');
  const tvs = await discoverTvs(ctx, DRIVERS, { deep: true, timeoutMs: 4000, onFound: () => {} });
  for (const tv of tvs) log(`  encontrada: [${driverFor(tv.brand)?.label}] ${tv.name} @ ${tv.host}${tv.model ? ` (${tv.model})` : ''}`);
  return tvs[0] ?? null;
}

async function main() {
  const tv = await findTv();
  if (!tv) {
    log('No encontré ninguna tele en la red.');
    process.exit(2);
  }
  const driver = driverFor(tv.brand);
  if (!driver) {
    log(`Sin conector para ${tv.brand}`);
    process.exit(2);
  }
  log(`\nConectando a [${driver.label}] ${tv.name} @ ${tv.host} …`);
  let session: TvSession;
  const closed = { reason: '' };
  try {
    const result = await driver.connect(
      tv,
      null,
      {
        onClose: (reason, detail) => {
          closed.reason = `${reason}${detail ? ` (${detail})` : ''}`;
        },
        onApp: (app) => log(`  app en la tele: ${app}`),
        onKeyboard: (k) => log(`  teclado de la tele: ${k.visible ? 'abierto' : 'cerrado'}${k.text !== undefined ? ` ("${k.text}")` : ''}`),
        onDebug: () => {},
      },
      ctx,
    );
    session = result.session;
  } catch (e) {
    log(`No pude conectar: ${(e as Error).message}. (Si pide vincular, corré antes: npm run tv -- pair)`);
    process.exit(3);
  }
  log('Conectado. Escribiendo…');
  // Give an Android TV a moment to switch to its keyboard bridge, like the app's warm-up.
  await new Promise((r) => setTimeout(r, driver.warmUpMs ?? 700));
  session.updateText('', text);
  await new Promise((r) => setTimeout(r, 1500));
  log(`Mandé "${text}". Mirá la tele: debería estar en el campo de texto abierto.`);
  session.close();
  if (closed.reason) log(`(la sesión se cerró: ${closed.reason})`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
