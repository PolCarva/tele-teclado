// Pushes the App Store listing in store/app-store.json through the App Store Connect API.
//   node scripts/app-store.mjs listing       text, URLs, categories, age rating, review notes, price, availability
//   node scripts/app-store.mjs screenshots   replaces the screenshots with the ones in store/screenshots
//   node scripts/app-store.mjs videos        uploads the header and search results videos (store/header) and places them
//   node scripts/app-store.mjs build [n]     attaches build n (default: newest valid) to the version
//   node scripts/app-store.mjs status        what is still missing
//   node scripts/app-store.mjs cancel        takes the version out of App Review so it can be edited
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
    res = await fetch(url, { method, headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000) });
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

class AlreadySubmitted extends Error {
  constructor(version) {
    const { versionString, appStoreState } = version.attributes;
    super(`version ${versionString} is already ${appStoreState}: nothing to edit or submit (bump expo.version and store.version for a new one)`);
  }
}
const app = store.appId;

async function editableVersion() {
  const { data } = await api('GET', `/v1/apps/${app}/appStoreVersions?filter[platform]=IOS&limit=10`);
  const open = data.find((v) => ['PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'REJECTED', 'METADATA_REJECTED', 'INVALID_BINARY'].includes(v.attributes.appStoreState));
  if (open) return open;
  // store.version already went to review or is out: there is nothing to edit (Apple won't reuse the number).
  const same = data.find((v) => v.attributes.versionString === store.version);
  if (same) throw new AlreadySubmitted(same);
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
  // Apple returns an (empty) schedule even before a price is set: look for actual prices.
  const hasSchedule = await api('GET', `/v1/apps/${app}/appPriceSchedule?include=manualPrices`).then(
    (r) => (r.data?.relationships?.manualPrices?.data?.length ?? 0) > 0,
    () => false,
  );
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

// Creative assets (iOS 27+): videos in the app's Asset Library, placed on the version. The upload
// works any time; placing them needs a version that can be edited (this never creates one).
const creatives = [['header', 'PRODUCT_PAGE_HEADER_ASSET'], ['searchResults', 'APP_STORE_SEARCH_RESULTS_ASSET']];
async function videos() {
  const library = (await api('GET', `/v1/apps/${app}/assetLibrary`)).data;
  const { data: versions } = await api('GET', `/v1/apps/${app}/appStoreVersions?filter[platform]=IOS&limit=1`);
  const version = ['PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'REJECTED', 'METADATA_REJECTED'].includes(versions[0].attributes.appStoreState) ? versions[0] : null;
  const verLocs = version ? (await api('GET', `/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations`)).data : [];
  const existing = (await api('GET', `/v1/appAssetLibraries/${library.id}/videos?limit=200`)).data;
  for (const [locale, l] of Object.entries(store.locales)) {
    for (const [field, placementType] of creatives) {
      const asset = l[field];
      if (!asset) continue;
      const path = join(ROOT, asset.file);
      const bytes = readFileSync(path);
      // Reuse the same file if it is already in the library (a re-run must not pile up copies).
      let video = existing.find((v) => v.attributes.fileName === basename(path) && v.attributes.fileSize === bytes.length && !['FAILED', 'ARCHIVED'].includes(v.attributes.state));
      if (!video) {
        video = (await api('POST', '/v1/appAssetLibraryVideos', { data: { type: 'appAssetLibraryVideos', attributes: { category: 'CREATIVE_ASSETS', fileName: basename(path), fileSize: bytes.length, referenceName: asset.name, previewFrameTimeCode: asset.posterTimeCode }, relationships: { assetLibrary: ref('appAssetLibraries', library.id) } } })).data;
        for (const op of video.attributes.uploadOperations) {
          const headers = Object.fromEntries(op.requestHeaders.map((h) => [h.name, h.value]));
          const res = await fetch(op.url, { method: op.method, headers, body: bytes.subarray(op.offset, op.offset + op.length) });
          if (!res.ok) throw new Error(`upload ${basename(path)}: ${res.status}`);
        }
        await api('PATCH', `/v1/appAssetLibraryVideos/${video.id}`, { data: { type: 'appAssetLibraryVideos', id: video.id, attributes: { uploaded: true } } });
        console.log(`${locale} ${field}: ${basename(path)} uploaded`);
      }
      // Apple checks it against the spec in the background (minutes).
      for (let i = 0; i < 200 && ['AWAITING_UPLOAD', 'UPLOAD_COMPLETE'].includes(video.attributes.state); i++) {
        await new Promise((r) => setTimeout(r, 6000));
        video = (await api('GET', `/v1/appAssetLibraryVideos/${video.id}`)).data;
      }
      console.log(`  ${field} processed: ${video.attributes.state}${video.attributes.stateDetails?.length ? ` ${JSON.stringify(video.attributes.stateDetails)}` : ''}`);
      if (['AWAITING_UPLOAD', 'UPLOAD_COMPLETE', 'FAILED'].includes(video.attributes.state)) throw new Error(`${basename(path)} is not ready (${video.attributes.state})`);
      const loc = verLocs.find((x) => x.attributes.locale === locale);
      if (!loc) {
        console.log(`  not placed: version ${versions[0].attributes.versionString} is ${versions[0].attributes.appStoreState} (run cancel, or wait for the next version)`);
        continue;
      }
      const placements = (await api('GET', `/v1/appStoreVersionLocalizations/${loc.id}/placements?limit=50`)).data.filter((p) => p.attributes.placementType === placementType);
      if (placements.some((p) => p.relationships?.video?.data?.id === video.id)) {
        console.log(`  already placed as ${placementType}`);
        continue;
      }
      for (const p of placements) await api('DELETE', `/v1/appAssetLibraryPlacements/${p.id}`);
      await api('POST', '/v1/appAssetLibraryPlacements', { data: { type: 'appAssetLibraryPlacements', attributes: { placementType }, relationships: { video: ref('appAssetLibraryVideos', video.id), appStoreVersionLocalization: ref('appStoreVersionLocalizations', loc.id) } } });
      console.log(`  placed as ${locale} ${placementType}`);
    }
  }
}

// Takes the version out of App Review so its metadata can change again (submit sends it back).
async function cancel() {
  const { data } = await api('GET', `/v1/reviewSubmissions?filter[app]=${app}&filter[platform]=IOS&filter[state]=WAITING_FOR_REVIEW,IN_REVIEW,UNRESOLVED_ISSUES`);
  if (!data.length) console.log('nothing in review');
  for (const s of data) {
    await api('PATCH', `/v1/reviewSubmissions/${s.id}`, { data: { type: 'reviewSubmissions', id: s.id, attributes: { canceled: true } } });
    console.log(`canceled review submission ${s.id} (was ${s.attributes.state})`);
  }
  let last = '';
  for (let i = 0; i < 60; i++) {
    const v = (await api('GET', `/v1/apps/${app}/appStoreVersions?filter[platform]=IOS&limit=1`)).data[0];
    if (v.attributes.appStoreState !== last) console.log(`version ${v.attributes.versionString}: ${(last = v.attributes.appStoreState)}`);
    if (['PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'REJECTED', 'METADATA_REJECTED'].includes(last)) return;
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error('the version did not become editable yet; run status in a minute');
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
  // The newest version, whatever its state (don't create one just to look).
  const { data: versions } = await api('GET', `/v1/apps/${app}/appStoreVersions?filter[platform]=IOS&limit=1`);
  const version = versions[0];
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

async function builds() {
  const r = await api('GET', `/v1/builds?filter[app]=${app}&sort=-uploadedDate&limit=5&include=preReleaseVersion,buildBetaDetail&fields[builds]=version,processingState,uploadedDate,preReleaseVersion,buildBetaDetail`);
  const byId = Object.fromEntries((r.included ?? []).map((i) => [`${i.type}:${i.id}`, i.attributes]));
  for (const b of r.data) {
    const pre = byId[`preReleaseVersions:${b.relationships.preReleaseVersion.data?.id}`];
    const beta = byId[`buildBetaDetails:${b.relationships.buildBetaDetail.data?.id}`];
    console.log(`${pre?.version ?? '?'} (${b.attributes.version}): ${b.attributes.processingState}, TestFlight ${beta?.internalBuildState ?? '?'}`);
  }
}

async function submit() {
  const version = await editableVersion();
  const pending = (await api('GET', `/v1/reviewSubmissions?filter[app]=${app}&filter[platform]=IOS&filter[state]=READY_FOR_REVIEW`)).data[0];
  const submission = pending ?? (await api('POST', '/v1/reviewSubmissions', { data: { type: 'reviewSubmissions', attributes: { platform: 'IOS' }, relationships: { app: ref('apps', app) } } })).data;
  // A submission left over from a failed attempt may be empty: add the version if it isn't in it.
  const items = pending ? (await api('GET', `/v1/reviewSubmissions/${submission.id}/items?include=appStoreVersion`)).data : [];
  if (!items.some((i) => i.relationships?.appStoreVersion?.data?.id === version.id)) {
    await api('POST', '/v1/reviewSubmissionItems', { data: { type: 'reviewSubmissionItems', relationships: { reviewSubmission: ref('reviewSubmissions', submission.id), appStoreVersion: ref('appStoreVersions', version.id) } } });
  }
  await api('PATCH', `/v1/reviewSubmissions/${submission.id}`, { data: { type: 'reviewSubmissions', id: submission.id, attributes: { submitted: true } } });
  console.log(`submitted ${store.version} for review (${submission.id})`);
}

const [command, arg] = process.argv.slice(2);
const commands = { listing, screenshots, videos, header: videos, build: () => build(arg), builds, status, cancel, submit };
if (!commands[command]) {
  console.log('usage: node scripts/app-store.mjs listing|screenshots|videos|build [n]|builds|status|cancel|submit');
  process.exit(1);
}
commands[command]().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
