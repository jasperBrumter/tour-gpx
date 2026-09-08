// Offline tests for the parts of lib/komoot.js that don't need network:
// URL parsing and GPX assembly. The live fetchTour() call against Komoot's
// API is NOT exercised here — there's no way to verify that against a real
// response in this environment. Run this after any change to buildGpx or
// parseTourId to catch regressions in the parts we CAN check.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildGpx } from '../public/lib/gpx.js';
import { SourceError } from '../public/lib/errors.js';
import { parseTourId, resolveShareLink } from '../public/lib/komoot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function test(name, fn) {
  try {
    fn();
    console.log(`  ok  - ${name}`);
  } catch (err) {
    console.error(`FAIL  - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

test('parseTourId reads a plain tour URL', () => {
  const { tourId, shareToken } = parseTourId('https://www.komoot.com/tour/123456789');
  assert.equal(tourId, '123456789');
  assert.equal(shareToken, undefined);
});

test('parseTourId reads a share_token off a shared link', () => {
  const { tourId, shareToken } = parseTourId(
    'https://www.komoot.com/tour/123456789?share_token=abc123'
  );
  assert.equal(tourId, '123456789');
  assert.equal(shareToken, 'abc123');
});

test('parseTourId reads a tour URL with a locale prefix', () => {
  const { tourId } = parseTourId('https://www.komoot.com/en-us/tour/123456789');
  assert.equal(tourId, '123456789');
});

test('parseTourId rejects a non-Komoot URL', () => {
  assert.throws(() => parseTourId('https://maps.google.com/whatever'));
});

test('buildGpx produces one trkpt per point, with elevation', () => {
  const fixture = JSON.parse(
    readFileSync(path.join(__dirname, 'mock-tour-response.json'), 'utf8')
  );
  const points = fixture._embedded.coordinates.items.map((p) => ({
    lat: p.lat,
    lng: p.lng,
    ele: p.alt,
  }));

  const gpx = buildGpx({ name: fixture.name, points });

  const trkptCount = (gpx.match(/<trkpt/g) || []).length;
  assert.equal(trkptCount, points.length);
  assert.match(gpx, /<name>Mont Royal Loop<\/name>/);
  assert.match(gpx, /<ele>45\.2<\/ele>/);
  assert.match(gpx, /lat="45.5088" lon="-73.5878"/);
});

test('buildGpx escapes XML-unsafe characters in the name', () => {
  const gpx = buildGpx({
    name: 'Ride & "Fun" <Loop>',
    points: [{ lat: 1, lng: 2 }],
  });
  assert.match(gpx, /Ride &amp; &quot;Fun&quot; &lt;Loop&gt;/);
});

test('resolveShareLink rejects garbage input with a clean error, not a crash', async () => {
  await assert.rejects(() => resolveShareLink('not a komoot link'), SourceError);
});


test('buildGpx emits timestamps, treating point.t as milliseconds from the tour date', () => {
  // Verified against Komoot tour 1: final t = 4928000 while the tour's
  // `duration` is 4928 seconds. Reading `t` as seconds would stretch a
  // 82-minute ride into 57 days of timestamps.
  const gpx = buildGpx({
    name: 'Timed',
    startTime: '2009-07-22T16:11:54.000+02:00',
    recorded: true,
    points: [
      { lat: 1, lng: 2, ele: 10, t: 0 },
      { lat: 1.1, lng: 2.1, ele: 20, t: 4928000 },
    ],
  });

  assert.match(gpx, /<time>2009-07-22T14:11:54Z<\/time>/);
  assert.match(gpx, /<time>2009-07-22T15:34:02Z<\/time>/);
});

test('buildGpx writes no fractional seconds', () => {
  // xsd:dateTime permits them, but several GPS tools reject "…54.000Z" while
  // accepting "…54Z", and Komoot's values are whole seconds regardless.
  const gpx = buildGpx({
    name: 'Timed',
    startTime: '2020-01-01T00:00:00.000Z',
    recorded: true,
    points: [{ lat: 1, lng: 2, t: 1500 }],
  });
  assert.ok(!/\.\d{3}Z/.test(gpx), 'no millisecond component should appear');
  assert.match(gpx, /<time>2020-01-01T00:00:01Z<\/time>/);
});

test('buildGpx omits <time> for a planned route, so Strava imports it as a route', () => {
  // A planned tour's `t` values are Komoot's estimates. Emitting them makes
  // Strava create an activity with timing that never happened.
  const planned = {
    name: 'Planned',
    startTime: '2020-01-01T00:00:00Z',
    recorded: false,
    points: [
      { lat: 1, lng: 2, t: 0 },
      { lat: 1.1, lng: 2.1, t: 60000 },
    ],
  };
  assert.ok(!buildGpx(planned).includes('<time>'));
  // The same tour recorded does carry them.
  assert.ok(buildGpx({ ...planned, recorded: true }).includes('<time>'));
});

test('buildGpx drops all times when they run backwards', () => {
  // Strava rejects an upload whose timestamps decrease; one bad point would
  // fail the whole file, so degrade to a valid untimed route instead.
  const gpx = buildGpx({
    name: 'Rewound',
    startTime: '2020-01-01T00:00:00Z',
    recorded: true,
    points: [
      { lat: 1, lng: 2, t: 0 },
      { lat: 1.1, lng: 2.1, t: 60000 },
      { lat: 1.2, lng: 2.2, t: 30000 },
    ],
  });
  assert.ok(!gpx.includes('<time>'), 'a decreasing timestamp should drop all times');
  assert.equal((gpx.match(/<trkpt /g) || []).length, 3, 'points are still written');
});

test('buildGpx keeps times when consecutive stamps are equal', () => {
  // Equal stamps occur in real traces when a device pauses; importers cope.
  const gpx = buildGpx({
    name: 'Paused',
    startTime: '2020-01-01T00:00:00Z',
    recorded: true,
    points: [
      { lat: 1, lng: 2, t: 0 },
      { lat: 1.1, lng: 2.1, t: 1000 },
      { lat: 1.2, lng: 2.2, t: 1000 },
    ],
  });
  assert.equal((gpx.match(/<time>/g) || []).length, 4, '1 metadata + 3 trackpoints');
});

test('buildGpx drops times when any point lacks one', () => {
  const gpx = buildGpx({
    name: 'Partial',
    startTime: '2020-01-01T00:00:00Z',
    recorded: true,
    points: [{ lat: 1, lng: 2, t: 0 }, { lat: 1.1, lng: 2.1 }],
  });
  assert.ok(!gpx.includes('<time>'));
});

test('buildGpx writes bounds covering every point', () => {
  const gpx = buildGpx({
    name: 'Boxed',
    points: [
      { lat: 10, lng: -5 },
      { lat: -2, lng: 30 },
      { lat: 4, lng: 12 },
    ],
  });
  assert.match(gpx, /<bounds minlat="-2" minlon="-5" maxlat="10" maxlon="30" \/>/);
});

test('buildGpx omits <time> entirely when the tour has no start date', () => {
  const gpx = buildGpx({ name: 'Untimed', recorded: true, points: [{ lat: 1, lng: 2, t: 5000 }] });
  assert.ok(!gpx.includes('<time>'), 'should not emit a time element without a start date');
  assert.match(gpx, /<trkpt lat="1" lon="2">/);
});

test('buildGpx omits <ele> for points with no elevation', () => {
  const gpx = buildGpx({ name: 'Flat', points: [{ lat: 1, lng: 2 }] });
  assert.ok(!gpx.includes('<ele>'), 'should not emit an empty elevation element');
});

/**
 * Schema validation. The GPX 1.1 XSD is vendored in test/fixtures so this runs
 * offline. It matters because GPX 1.1 declares <metadata> and <trk> children
 * as xsd:sequence — get the element order wrong and a validating importer
 * rejects the file, which no amount of eyeballing the output would catch.
 *
 * Skipped when xmllint is unavailable rather than failing the suite.
 */
function hasXmllint() {
  try {
    execFileSync('xmllint', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function assertValidGpx(gpx, label) {
  const dir = mkdtempSync(path.join(tmpdir(), 'gpx-'));
  try {
    const file = path.join(dir, 'out.gpx');
    writeFileSync(file, gpx);
    execFileSync('xmllint', ['--noout', '--schema', path.join(__dirname, 'fixtures', 'gpx-1.1.xsd'), file], {
      stdio: 'pipe',
    });
  } catch (err) {
    throw new Error(`${label} failed GPX 1.1 schema validation:\n${err.stderr?.toString() || err.message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (hasXmllint()) {
  const sample = [
    { lat: 47.514395, lng: 10.285864, ele: 798.4, t: 0 },
    { lat: 47.514305, lng: 10.287012, ele: 798.4, t: 13000 },
    { lat: 47.51489, lng: 10.275548, ele: 767.5, t: 26000 },
  ];

  test('GPX validates against the 1.1 schema — recorded tour, all fields', () => {
    assertValidGpx(
      buildGpx({
        name: 'Ride & "Fun" <Loop>',
        startTime: '2009-07-22T16:11:54.000+02:00',
        recorded: true,
        sport: 'touringbicycle',
        sourceUrl: 'https://www.komoot.com/tour/1',
        points: sample,
      }),
      'recorded tour'
    );
  });

  test('GPX validates against the 1.1 schema — planned route, no times', () => {
    assertValidGpx(
      buildGpx({ name: 'Planned', recorded: false, sport: 'hike', points: sample }),
      'planned route'
    );
  });

  test('GPX validates against the 1.1 schema — minimal tour, no optional fields', () => {
    assertValidGpx(buildGpx({ name: 'Bare', points: [{ lat: 1, lng: 2 }] }), 'minimal tour');
  });
} else {
  console.log('  skip - GPX schema validation (xmllint not installed)');
}

/**
 * The page ships its CSP in a <meta> tag because GitHub Pages cannot set
 * response headers, and the inline JSON-LD block is allowed by hash. Edit the
 * JSON-LD without recomputing the hash and the block is silently blocked in
 * production, which no local check would otherwise catch.
 */
test('the CSP hash matches the inline JSON-LD block', () => {
  const html = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const ld = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(ld, 'no JSON-LD block found');
  JSON.parse(ld[1]);

  const actual = createHash('sha256').update(ld[1]).digest('base64');
  const declared = html.match(/'sha256-([A-Za-z0-9+/=]+)'/);
  assert.ok(declared, 'no script hash in the meta CSP');
  assert.equal(
    declared[1],
    actual,
    'JSON-LD changed without updating the CSP hash in index.html (and server.js)'
  );
});

test('server.js declares the same script hash as the page', () => {
  const html = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const server = readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const inHtml = html.match(/'sha256-([A-Za-z0-9+/=]+)'/)[1];
  const inServer = server.match(/sha256-([A-Za-z0-9+/=]+)/);
  assert.ok(inServer, 'server.js has no script hash in its CSP');
  assert.equal(inServer[1], inHtml, 'server.js and index.html CSP hashes have drifted');
});

test('no absolute asset paths — they 404 on a project-site subpath', () => {
  // GitHub Pages serves this at /tour-gpx/, so href="/style.css" resolves to
  // the domain root and misses.
  for (const file of ['index.html', '404.html']) {
    const html = readFileSync(path.join(__dirname, '..', 'public', file), 'utf8');
    const absolute = html.match(/(?:href|src)="\/(?!\/)[^"]*"/g) || [];
    assert.deepEqual(absolute, [], `${file} has root-absolute asset paths: ${absolute.join(', ')}`);
  }
});

test('no absolute url() in the stylesheet — fonts 404 on a subpath', () => {
  // The HTML paths and the CSS paths are separate: fixing one and not the
  // other silently drops back to the fallback fonts on GitHub Pages, which is
  // exactly what happened the first time.
  const css = readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
  const absolute = css.match(/url\(['"]?\/(?!\/)[^)]*\)/g) || [];
  assert.deepEqual(absolute, [], `style.css has root-absolute urls: ${absolute.join(', ')}`);
});

test('every asset referenced by the page exists on disk', () => {
  // Catches a renamed or missing file before it 404s in production.
  const pub = path.join(__dirname, '..', 'public');
  const html = readFileSync(path.join(pub, 'index.html'), 'utf8');
  const css = readFileSync(path.join(pub, 'style.css'), 'utf8');
  const refs = [
    ...[...html.matchAll(/(?:href|src)="([^"#:]+)"/g)].map((m) => m[1]),
    ...[...css.matchAll(/url\(['"]?([^)'"]+)['"]?\)/g)].map((m) => m[1]),
  ].filter((r) => !r.startsWith('http') && !r.startsWith('data:'));

  assert.ok(refs.length > 5, 'expected to find asset references');
  for (const ref of new Set(refs)) {
    assert.ok(existsSync(path.join(pub, ref)), `referenced asset is missing: ${ref}`);
  }
});

test('no unsubstituted template placeholders remain', () => {
  for (const file of ['index.html', '404.html']) {
    const html = readFileSync(path.join(__dirname, '..', 'public', file), 'utf8');
    assert.ok(!html.includes('{{'), `${file} still contains a {{placeholder}}`);
  }
});

console.log('\nDone.');
