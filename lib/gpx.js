// GPX 1.1 document assembly. Source-agnostic: providers hand it a normalised
// tour and it produces the file. No network here, so it is unit-testable on
// its own, including against the GPX 1.1 schema (see test/build-gpx.test.js).

/**
 * Builds a GPX 1.1 document (as a string) from tour points.
 *
 * The output validates against the GPX 1.1 schema. The choices below are about
 * what real importers accept rather than what the schema permits:
 *
 * - Timestamps are written only for recorded tours. Strava reads a GPX with
 *   <time> as an activity and computes pace from it; giving it a planned
 *   route's estimated times produces an activity that never happened. Without
 *   <time> the same file imports cleanly as a Strava route, and Maps.me /
 *   Organic Maps ignore time either way.
 * - Fractional seconds are dropped. xsd:dateTime allows them and the source
 *   values are whole seconds anyway, but a number of GPS tools reject
 *   "…54.000Z" while accepting "…54Z", and nothing is lost by trimming.
 * - Times are emitted only if they never run backwards. Strava rejects a file
 *   whose timestamps decrease, so one bad point would fail the whole upload;
 *   dropping time degrades it to a valid route instead.
 *
 * Child element order matters: GPX 1.1 declares <metadata> and <trk> children
 * as xsd:sequence, so name/desc/link/time/bounds must appear in that order or
 * a validating importer rejects the file.
 */
export function buildGpx({ name, points, startTime, recorded = false, sport, sourceUrl, sourceLabel }) {
  const startMs = startTime ? Date.parse(startTime) : NaN;
  const withTime = recorded && Number.isFinite(startMs) && hasUsableTimes(points);

  const trkpts = points
    .map((p) => {
      const lines = [`      <trkpt lat="${p.lat}" lon="${p.lng}">`];
      if (p.ele !== undefined) lines.push(`        <ele>${p.ele.toFixed(1)}</ele>`);
      if (withTime && p.t !== undefined) {
        lines.push(`        <time>${gpxTime(startMs + p.t)}</time>`);
      }
      lines.push('      </trkpt>');
      return lines.join('\n');
    })
    .join('\n');

  const bounds = boundsOf(points);
  const meta = [
    `    <name>${escapeXml(name)}</name>`,
    `    <desc>${escapeXml(describe(sport, recorded, sourceLabel))}</desc>`,
    sourceUrl
      ? `    <link href="${escapeXml(sourceUrl)}">\n      <text>View on ${escapeXml(sourceLabel || 'the source')}</text>\n    </link>`
      : null,
    withTime ? `    <time>${gpxTime(startMs)}</time>` : null,
    bounds
      ? `    <bounds minlat="${bounds.minlat}" minlon="${bounds.minlon}" maxlat="${bounds.maxlat}" maxlon="${bounds.maxlon}" />`
      : null,
  ]
    .filter(Boolean)
    .join('\n');

  const trkType = sport ? `\n    <type>${escapeXml(sport)}</type>` : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="komoot-gpx"
     xmlns="http://www.topografix.com/GPX/1/1"
     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
     xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
${meta}
  </metadata>
  <trk>
    <name>${escapeXml(name)}</name>${trkType}
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>
`;
}

/**
 * True only if every point carries a timestamp and they never run backwards.
 * Equal consecutive values are fine — real GPS traces contain them and
 * importers cope — but a decrease fails a Strava upload outright.
 */
function hasUsableTimes(points) {
  let previous = -Infinity;
  for (const p of points) {
    if (typeof p.t !== 'number') return false;
    if (p.t < previous) return false;
    previous = p.t;
  }
  return points.length > 0;
}

/** ISO 8601 in UTC, without the fractional seconds some parsers choke on. */
function gpxTime(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function boundsOf(points) {
  if (!points.length) return null;
  const lats = points.map((p) => p.lat);
  const lngs = points.map((p) => p.lng);
  return {
    minlat: Math.min(...lats),
    minlon: Math.min(...lngs),
    maxlat: Math.max(...lats),
    maxlon: Math.max(...lngs),
  };
}

function describe(sport, recorded, sourceLabel) {
  const kind = recorded ? 'Recorded tour' : 'Planned route';
  const from = sourceLabel ? ` exported from ${sourceLabel}` : '';
  return sport ? `${kind} (${sport})${from}.` : `${kind}${from}.`;
}

export function escapeXml(str) {
  return String(str).replace(/[<>&'"]/g, (c) => ({
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    "'": '&apos;',
    '"': '&quot;',
  })[c]);
}
