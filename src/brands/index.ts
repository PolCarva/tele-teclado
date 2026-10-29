// Every supported TV brand. Order doesn't matter: `priority` decides when one address
// answers to several connectors.

import { androidTv } from './androidtv';
import { lg } from './lg';
import { panasonic } from './panasonic';
import { roku } from './roku';
import { samsung } from './samsung';
import { sony } from './sony';
import type { BrandId, Driver } from './types';

export const DRIVERS: Driver[] = [androidTv, samsung, lg, roku, sony, panasonic];

export function driverFor(brand: BrandId, drivers: Driver[] = DRIVERS): Driver | undefined {
  return drivers.find((d) => d.brand === brand);
}

export * from './types';
