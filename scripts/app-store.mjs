// Pushes the App Store listing in store/app-store.json through the App Store Connect API.
//   node scripts/app-store.mjs listing       text, URLs, categories, age rating, review notes, price, availability
//   node scripts/app-store.mjs screenshots   replaces the screenshots with the ones in store/screenshots
//   node scripts/app-store.mjs build [n]     attaches build n (default: newest valid) to the version
//   node scripts/app-store.mjs status        what is still missing
//   node scripts/app-store.mjs submit        sends the version to App Review
// The API key stays in ~/.appstoreconnect/private_keys (same one eas.json uses); set ASC_PHONE for
// the review contact phone (Apple requires one; it is not public).

import { createHash, createPrivateKey, createSign } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const eas = JSON.parse(readFileSync(join(ROOT, 'eas.json'), 'utf8')).submit.production.ios;
const store = JSON.parse(readFileSync(join(ROOT, 'store/app-store.json'), 'utf8'));
const keyPath = eas.ascApiKeyPath.replace('$HOME', process.env.HOME);
const key = createPrivateKey(readFileSync(keyPath));

function token() {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: 'ES256', kid: eas.ascApiKeyId, typ: 'JWT' })}.${b64({ iss: eas.ascApiKeyIssuerId, iat: now, exp: now + 1100, aud: 'appstoreconnect-v1' })}`;
  const sign = createSign('SHA256');
  sign.update(unsigned);
  return `${unsigned}.${sign.sign({ key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}

async function api(method, path, body) {
  const url = path.startsWith('http') ? path : `https://api.appstoreconnect.apple.com${path}`;
  let res;
  // Apple's API answers the odd 500; retry the requests that are safe to repeat.
  for (let attempt = 1; ; attempt++) {
    res = await fetch(url, { method, headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (res.status < 500 || method === 'POST' || attempt === 5) break;
    await new Promise((r) => setTimeout(r, 1500 * attempt));
  }
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const detail = json?.errors?.map((e) => `${e.code}: ${e.detail ?? e.title}`).join('\n  ') ?? text;
    throw new Error(`${method} ${path} -> ${res.status}\n  ${detail}`);
  }
  return json;
}

const ref = (type, id) => ({ data: { type, id } });
const app = store.appId;

async function editableVersion() {
  const { data } = await api('GET', `/v1/apps/${app}/appStoreVersions?filter[platform]=IOS&limit=10`);
  const open = data.find((v) => ['PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'REJECTED', 'METADATA_REJECTED', 'INVALID_BINARY'].includes(v.attributes.appStoreState));
  if (open) return open;
  const created = await api('POST', '/v1/appStoreVersions', {
    data: { type: 'appStoreVersions', attributes: { platform: 'IOS', versionString: store.version }, relationships: { app: ref('apps', app) } },
  });
  return created.data;
}

async function appInfo() {
  const { data } = await api('GET', `/v1/apps/${app}/appInfos`);
  return data.find((i) => i.attributes.appStoreState !== 'READY_FOR_SALE') ?? data[0];
}

async function listing() {
  const version = await editableVersion();
  if (version.attributes.versionString !== store.version || version.attributes.copyright !== store.copyright) {
    await api('PATCH', `/v1/appStoreVersions/${version.id}`, { data: { type: 'appStoreVersions', id: version.id, attributes: { versionString: store.version, copyright: store.copyright, releaseType: 'AFTER_APPROVAL' } } });
  }
  console.log(`version ${store.version} (${version.id})`);

  await api('PATCH', `/v1/apps/${app}`, { data: { type: 'apps', id: app, attributes: { contentRightsDeclaration: store.contentRights } } });

  const info = await appInfo();
  await api('PATCH', `/v1/appInfos/${info.id}`, {
    data: { type: 'appInfos', id: info.id, relationships: { primaryCategory: ref('appCategories', store.primaryCategory), secondaryCategory: ref('appCategories', store.secondaryCategory) } },
  });
  await api('PATCH', `/v1/ageRatingDeclarations/${info.id}`, { data: { type: 'ageRatingDeclarations', id: info.id, attributes: store.ageRating } });
  console.log('categories, age rating, content rights: ok');

  const infoLocs = (await api('GET', `/v1/appInfos/${info.id}/appInfoLocalizations`)).data;
  const verLocs = (await api('GET', `/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations`)).data;
  for (const [locale, l] of Object.entries(store.locales)) {
    const infoAttrs = { name: l.name, subtitle: l.subtitle, privacyPolicyUrl: l.privacyPolicyUrl };
    const il = infoLocs.find((x) => x.attributes.locale === locale);
    if (il) await api('PATCH', `/v1/appInfoLocalizations/${il.id}`, { data: { type: 'appInfoLocalizations', id: il.id, attributes: infoAttrs } });
    else await api('POST', '/v1/appInfoLocalizations', { data: { type: 'appInfoLocalizations', attributes: { locale, ...infoAttrs }, relationships: { appInfo: ref('appInfos', info.id) } } });

    const verAttrs = { description: l.description, keywords: l.keywords, promotionalText: l.promotionalText, supportUrl: l.supportUrl, marketingUrl: l.marketingUrl };
    if (l.whatsNew && version.attributes.versionString !== '1.0') verAttrs.whatsNew = l.whatsNew;
    const vl = verLocs.find((x) => x.attributes.locale === locale);
    if (vl) await api('PATCH', `/v1/appStoreVersionLocalizations/${vl.id}`, { data: { type: 'appStoreVersionLocalizations', id: vl.id, attributes: verAttrs } });
    else await api('POST', '/v1/appStoreVersionLocalizations', { data: { type: 'appStoreVersionLocalizations', attributes: { locale, ...verAttrs }, relationships: { appStoreVersion: ref('appStoreVersions', version.id) } } });
    console.log(`${locale}: name, subtitle, description, keywords, URLs: ok`);
  }

  const review = { ...store.review, ...(process.env.ASC_PHONE ? { contactPhone: process.env.ASC_PHONE } : {}) };
  const existing = (await api('GET', `/v1/appStoreVersions/${version.id}/appStoreReviewDetail`)).data;
  if (existing) {
    await api('PATCH', `/v1/appStoreReviewDetails/${existing.id}`, { data: { type: 'appStoreReviewDetails', id: existing.id, attributes: review } });
    console.log('review notes: ok');
  } else if (review.contactPhone) {
    await api('POST', '/v1/appStoreReviewDetails', { data: { type: 'appStoreReviewDetails', attributes: review, relationships: { appStoreVersion: ref('appStoreVersions', version.id) } } });
    console.log('review notes: ok');
  } else {
    console.log('review notes: skipped (Apple requires a contact phone: run again with ASC_PHONE="+598 …")');
  }

  await priceAndAvailability();
}

async function priceAndAvailability() {
  // Free, in every territory.
  const hasSchedule = await api('GET', `/v1/apps/${app}/appPriceSchedule`).then(() => true, () => false);
  if (!hasSchedule) {
    const points = await api('GET', `/v1/apps/${app}/appPricePoints?filter[territory]=USA&limit=10`);
    const free = points.data.find((p) => Number(p.attributes.customerPrice) === 0);
    await api('POST', '/v1/appPriceSchedules', {
      data: {
        type: 'appPriceSchedules',
        relationships: { app: ref('apps', app), baseTerritory: ref('territories', 'USA'), manualPrices: { data: [{ type: 'appPrices', id: '${free}' }] } },
      },
      included: [{ type: 'appPrices', id: '${free}', attributes: { startDate: null }, relationships: { appPricePoint: ref('appPricePoints', free.id) } }],
    });
  }
  console.log('price: free');
  const hasAvailability = await api('GET', `/v1/apps/${app}/appAvailabilityV2`).then(() => true, () => false);
  if (!hasAvailability) {
    const territories = [];
    for (let url = '/v1/territories?limit=200'; url; ) {
      const page = await api('GET', url);
      territories.push(...page.data.map((t) => t.id));
      url = page.links?.next;
    }
    await api('POST', '/v2/appAvailabilities', {
      data: {
        type: 'appAvailabilities',
        attributes: { availableInNewTerritories: true },
        relationships: { app: ref('apps', app), territoryAvailabilities: { data: territories.map((t) => ({ type: 'territoryAvailabilities', id: `\${${t}}` })) } },
      },
      included: territories.map((t) => ({ type: 'territoryAvailabilities', id: `\${${t}}`, attributes: { available: true }, relationships: { territory: ref('territories', t) } })),
    });
  }
  console.log('availability: all territories');
}

async function screenshots() {
  const version = await editableVersion();
  const verLocs = (await api('GET', `/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations`)).data;
  for (const [locale, l] of Object.entries(store.locales)) {
    const loc = verLocs.find((x) => x.attributes.locale === locale);
    if (!loc) throw new Error(`no ${locale} localization yet: run "listing" first`);
    const sets = (await api('GET', `/v1/appStoreVersionLocalizations/${loc.id}/appScreenshotSets?include=appScreenshots`)).data;
    for (const [displayType, files] of Object.entries(l.screenshots)) {
      let set = sets.find((s) => s.attributes.screenshotDisplayType === displayType);
      if (!set) {
        set = (await api('POST', '/v1/appScreenshotSets', { data: { type: 'appScreenshotSets', attributes: { screenshotDisplayType: displayType }, relationships: { appStoreVersionLocalization: ref('appStoreVersionLocalizations', loc.id) } } })).data;
      }
      for (const old of set.relationships?.appScreenshots?.data ?? []) await api('DELETE', `/v1/appScreenshots/${old.id}`);
      const ids = [];
      for (const file of files) {
        const path = join(ROOT, file);
        const bytes = readFileSync(path);
        const reserved = (await api('POST', '/v1/appScreenshots', { data: { type: 'appScreenshots', attributes: { fileName: basename(path), fileSize: statSync(path).size }, relationships: { appScreenshotSet: ref('appScreenshotSets', set.id) } } })).data;
        for (const op of reserved.attributes.uploadOperations) {
          const headers = Object.fromEntries(op.requestHeaders.map((h) => [h.name, h.value]));
          const res = await fetch(op.url, { method: op.method, headers, body: bytes.subarray(op.offset, op.offset + op.length) });
          if (!res.ok) throw new Error(`upload ${file}: ${res.status}`);
        }
        const md5 = createHash('md5').update(bytes).digest('hex');
        await api('PATCH', `/v1/appScreenshots/${reserved.id}`, { data: { type: 'appScreenshots', id: reserved.id, attributes: { uploaded: true, sourceFileChecksum: md5 } } });
        ids.push(reserved.id);
        console.log(`${locale} ${displayType}: ${basename(path)} uploaded`);
      }
      await api('PATCH', `/v1/appScreenshotSets/${set.id}/relationships/appScreenshots`, { data: ids.map((id) => ({ type: 'appScreenshots', id })) });
      // Apple processes them in the background; report the result.
      for (let i = 0; i < 20; i++) {
        const shots = (await api('GET', `/v1/appScreenshotSets/${set.id}/appScreenshots`)).data;
        const states = shots.map((s) => s.attributes.assetDeliveryState?.state);
        if (states.every((s) => s === 'COMPLETE' || s === 'FAILED')) {
          for (const s of shots) if (s.attributes.assetDeliveryState.state === 'FAILED') console.log(`  ${s.attributes.fileName} FAILED: ${JSON.stringify(s.attributes.assetDeliveryState.errors)}`);
          console.log(`  processed: ${states.join(', ')}`);
          break;
        }
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }
}

async function build(number) {
  const version = await editableVersion();
  const { data } = await api('GET', `/v1/builds?filter[app]=${app}&filter[preReleaseVersion.version]=${store.version}&filter[processingState]=VALID&sort=-uploadedDate&limit=20`);
  const chosen = number ? data.find((b) => b.attributes.version === String(number)) : data[0];
  if (!chosen) throw new Error(`no valid build${number ? ` ${number}` : ''} for ${store.version} yet`);
  await api('PATCH', `/v1/appStoreVersions/${version.id}/relationships/build`, ref('builds', chosen.id));
  console.log(`build ${chosen.attributes.version} attached to ${store.version}`);
}

async function status() {
  const version = await editableVersion();
  const v = version.attributes;
  console.log(`version ${v.versionString}: ${v.appStoreState}`);
  const b = (await api('GET', `/v1/appStoreVersions/${version.id}/build`)).data;
  console.log(`build: ${b ? b.attributes.version : 'none attached'}`);
  const r = (await api('GET', `/v1/appStoreVersions/${version.id}/appStoreReviewDetail`)).data;
  console.log(`review contact phone: ${r?.attributes.contactPhone ? 'set' : 'missing'}`);
  const locs = (await api('GET', `/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations`)).data;
  for (const loc of locs) {
    const sets = (await api('GET', `/v1/appStoreVersionLocalizations/${loc.id}/appScreenshotSets?include=appScreenshots`)).data;
    console.log(`${loc.attributes.locale}: ${sets.map((s) => `${s.attributes.screenshotDisplayType} x${s.relationships.appScreenshots.data.length}`).join(', ') || 'no screenshots'}`);
  }
}

async function submit() {
  const version = await editableVersion();
  const pending = (await api('GET', `/v1/reviewSubmissions?filter[app]=${app}&filter[platform]=IOS&filter[state]=READY_FOR_REVIEW`)).data[0];
  const submission = pending ?? (await api('POST', '/v1/reviewSubmissions', { data: { type: 'reviewSubmissions', attributes: { platform: 'IOS' }, relationships: { app: ref('apps', app) } } })).data;
  if (!pending) {
    await api('POST', '/v1/reviewSubmissionItems', { data: { type: 'reviewSubmissionItems', relationships: { reviewSubmission: ref('reviewSubmissions', submission.id), appStoreVersion: ref('appStoreVersions', version.id) } } });
  }
  await api('PATCH', `/v1/reviewSubmissions/${submission.id}`, { data: { type: 'reviewSubmissions', id: submission.id, attributes: { submitted: true } } });
  console.log(`submitted ${store.version} for review (${submission.id})`);
}

const [command, arg] = process.argv.slice(2);
const commands = { listing, screenshots, build: () => build(arg), status, submit };
if (!commands[command]) {
  console.log('usage: node scripts/app-store.mjs listing|screenshots|build [n]|status|submit');
  process.exit(1);
}
commands[command]().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
