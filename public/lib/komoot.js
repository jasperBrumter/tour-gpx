// Everything that talks to Komoot lives in this one file, on purpose.
// Komoot has no public API for this — we're reading the same endpoint their
// own web app uses. That endpoint is not a contract, so if it changes shape,
// this is the only file that should need edits.
//
// Pipeline: raw URL -> resolveShareLink -> parseTourId -> fetchTour -> buildGpx

import { SourceError } from './errors.js';

const API_BASE = 'https://api.komoot.de/v007';

// Matches a tour ID anywhere in a URL's path, regardless of locale prefixes
// (komoot.com/tour/123, komoot.com/en-us/tour/123, komoot.de/de/smarttour/123).
const TOUR_URL_RE = /komoot\.(?:com|de)\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:tour|smarttour)\/(\d+)/i;

// Komoot's API returns HAL+JSON and appears to reject requests that only offer
// plain application/json. Node's default fetch User-Agent also looks like a
// bot, which draws 403s on its own regardless of Accept.
const API_HEADERS = {
  Accept: 'application/hal+json, application/json;q=0.9, */*;q=0.8',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
};

/**
 * Komoot tour links are already full URLs, but people sometimes paste a short
 * share link (komoot.com/s/AbCdEf) that Komoot resolves client-side with
 * JavaScript rather than an HTTP redirect — so a plain server-side fetch lands
 * on the short URL's HTML shell, not the real tour URL. Handle both: follow
 * real HTTP redirects first, then fall back to scanning that page's HTML.
 */
export async function resolveShareLink(rawUrl) {
  if (TOUR_URL_RE.test(rawUrl)) return rawUrl;

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SourceError('link_not_recognized', "That doesn't look like a valid URL.");
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SourceError('link_not_recognized', "That doesn't look like a valid URL.");
  }
  if (!/komoot\.(com|de)$/i.test(parsed.hostname.replace(/^www\./, ''))) {
    throw new SourceError('link_not_recognized', "That's not a komoot.com or komoot.de link.");
  }

  const res = await fetch(rawUrl, { method: 'GET', redirect: 'follow' });

  if (TOUR_URL_RE.test(res.url)) return res.url;

  const html = await res.text().catch(() => '');
  const match = html.match(TOUR_URL_RE);
  if (match) return match[0].startsWith('http') ? match[0] : `https://${match[0]}`;

  throw new SourceError(
    'link_not_recognized',
    `Followed the link to ${res.url}, but couldn't find a tour ID there — the link may not point to a single tour, or Komoot may have changed how it renders share pages.`
  );
}

/**
 * Pulls the numeric tour ID and, if present, a share_token (needed to read
 * tours shared privately rather than published publicly) out of a Komoot URL.
 */
export function parseTourId(url) {
  const match = url.match(TOUR_URL_RE);
  if (!match) {
    throw new SourceError('link_not_recognized', "That doesn't look like a Komoot tour link.");
  }
  const tourId = match[1];

  let shareToken;
  try {
    shareToken = new URL(url).searchParams.get('share_token') || undefined;
  } catch {
    // A URL-parsing edge case shouldn't take down the request over an
    // optional field.
  }

  return { tourId, shareToken };
}

/**
 * Works out the tour from a pasted URL with NO network call, so it runs in the
 * browser as well as on the server.
 *
 * Short komoot.com/s/… links can't be handled here: resolving one means
 * reading that page's HTML, and www.komoot.com sends no
 * Access-Control-Allow-Origin header, so a browser is not allowed to read the
 * response. (api.komoot.de does send one, which is why the tour fetch itself
 * works client-side.) Rather than let that surface as an opaque CORS failure,
 * detect the case and say what to do about it. On the server,
 * resolveShareLink() still handles these properly.
 */
export function tourFromUrl(rawUrl) {
  if (TOUR_URL_RE.test(rawUrl)) return parseTourId(rawUrl);

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SourceError('link_not_recognized', "That doesn't look like a valid URL.");
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SourceError('link_not_recognized', "That doesn't look like a valid URL.");
  }
  if (!/komoot\.(com|de)$/i.test(parsed.hostname.replace(/^www\./, ''))) {
    throw new SourceError('link_not_recognized', "That's not a komoot.com or komoot.de link.");
  }

  throw new SourceError(
    'share_link_unsupported',
    'Short Komoot share links can\'t be opened from the browser. Open the link first, then copy the full address — it looks like komoot.com/tour/123456789.'
  );
}

/** One GET against the Komoot API, with the status-code -> SourceError mapping. */
async function apiGet(pathname, { shareToken, params } = {}) {
  const url = new URL(API_BASE + pathname);
  for (const [key, value] of Object.entries(params || {})) {
    url.searchParams.set(key, value);
  }
  if (shareToken) url.searchParams.set('share_token', shareToken);

  const res = await fetch(url, { headers: API_HEADERS });

  if (res.status === 404) {
    throw new SourceError('not_found', "Komoot doesn't have a tour at that link.");
  }
  if (res.status === 403 || res.status === 401) {
    throw new SourceError(
      'private_tour',
      'This tour looks private. It may need a share link (with a share_token) rather than the plain tour URL, or it may require the owner to make it public.'
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new SourceError(
      'upstream_error',
      `Komoot's API returned ${res.status}.${body ? ` Response: ${body.slice(0, 300)}` : ''}`
    );
  }

  return res.json();
}

/**
 * Fetches tour geometry + metadata from Komoot's internal API.
 *
 * The full track lives in a sub-resource that is NOT returned by default — you
 * have to ask for it with `_embedded=coordinates`. Without that parameter the
 * tour object still comes back 200 OK, just with no geometry beyond
 * `start_point` and (on planned tours) a short `path` array of routing
 * waypoints. Asking for the wrong parameter is therefore silent: you get a
 * valid-looking response and a near-empty track.
 */
export async function fetchTour(tourId, shareToken) {
  const data = await apiGet(`/tours/${tourId}`, {
    shareToken,
    params: { _embedded: 'coordinates' },
  });

  let points = extractTrackPoints(data);

  // The same geometry is also exposed as its own sub-resource. If the embed
  // came back empty (older tours, shape changes), try it before giving up.
  if (!points.length) {
    const coords = await apiGet(`/tours/${tourId}/coordinates`, { shareToken }).catch(() => null);
    points = normalizeItems(coords?.items);
  }

  if (!points.length) {
    throw new SourceError(
      'no_geometry',
      "Got a response from Komoot, but it contained no track coordinates. The API response shape may have changed — see lib/komoot.js."
    );
  }

  return {
    name: data.name || `Komoot tour ${tourId}`,
    // `t` on each point is a millisecond offset from this timestamp.
    startTime: typeof data.date === 'string' ? data.date : undefined,
    // Only a recording carries real timestamps. A planned tour's `t` values
    // are Komoot's *estimated* durations; see buildGpx() in lib/gpx.js.
    recorded: data.type === 'tour_recorded',
    sport: typeof data.sport === 'string' ? data.sport : undefined,
    sourceUrl: `https://www.komoot.com/tour/${tourId}`,
    sourceLabel: 'Komoot',
    points,
  };
}

/**
 * Reads the full track out of a tour response.
 *
 * Deliberately narrow: only the `coordinates` collection is real track
 * geometry. A tour object may also carry a top-level `path` array, but those
 * are ROUTING WAYPOINTS (start, vias, finish) — a handful of points for a 60km
 * ride. Treating them as track geometry produces a GPX with a start and a
 * finish and nothing in between, so we do not fall back to them: an explicit
 * error beats a plausible-looking, useless file.
 */
function extractTrackPoints(data) {
  return normalizeItems(data?._embedded?.coordinates?.items);
}

function normalizeItems(items) {
  if (!Array.isArray(items)) return [];
  return items.map(normalizePoint).filter(Boolean);
}

function normalizePoint(raw) {
  const lat = raw?.lat ?? raw?.location?.lat;
  const lng = raw?.lng ?? raw?.location?.lng;
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  const alt = raw.alt ?? raw.location?.alt;
  return {
    lat,
    lng,
    ele: typeof alt === 'number' ? alt : undefined,
    // Milliseconds from tour start, despite `duration` on the tour being
    // seconds. Verified against tour 1: last t = 4928000, duration = 4928.
    t: typeof raw.t === 'number' ? raw.t : undefined,
  };
}
