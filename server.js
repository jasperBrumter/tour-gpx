import express from 'express';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildGpx } from './lib/gpx.js';
import { SourceError } from './lib/errors.js';
import { resolveShareLink, parseTourId, fetchTour } from './lib/komoot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const app = express();

// Behind a proxy (Fly, Render, Heroku, nginx) the protocol and host arrive as
// X-Forwarded-* headers. Without this, req.protocol reads "http" and every
// canonical/og:image URL we emit would be wrong.
app.set('trust proxy', true);
app.disable('x-powered-by');

/**
 * Absolute origin for canonical, og:image and sitemap URLs.
 *
 * SITE_URL is authoritative when set, and on a live site it SHOULD be set:
 * deriving the origin from the Host header means anything that can reach the
 * app can make it emit canonicals pointing at a domain we don't control, which
 * is a way to get a copy of the site indexed instead of the real one. The
 * request-derived value is a development convenience, not the production path.
 */
const SITE_URL = (process.env.SITE_URL || '').trim().replace(/\/+$/, '');
function originFor(req) {
  return SITE_URL || `${req.protocol}://${req.get('host')}`;
}

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  // The site makes a privacy claim, so don't leak our URL to Google Fonts.
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=(), interest-cohort=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (req.secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

app.use(express.json({ limit: '4kb' }));

// Must precede express.static: `index: false` only stops directory-index
// serving, so an explicit GET /index.html would still hit the file on disk and
// return the raw, untemplated page under a duplicate URL.
app.get('/index.html', (req, res) => res.redirect(301, '/'));

// index.html is templated per request (origin + CSP nonce), so it must not be
// served as a static file — hence index: false.
app.use(
  express.static(PUBLIC_DIR, {
    index: false,
    maxAge: '1d',
    setHeaders(res, filePath) {
      if (filePath.endsWith('.webmanifest')) {
        res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
      }
      if (filePath.endsWith('.woff2')) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  })
);

const TEMPLATE_PATH = path.join(PUBLIC_DIR, 'index.html');
// Cached in production, re-read per request in dev so edits show up on reload.
let cachedTemplate = null;
function template() {
  if (process.env.NODE_ENV === 'production') {
    cachedTemplate ??= readFileSync(TEMPLATE_PATH, 'utf8');
    return cachedTemplate;
  }
  return readFileSync(TEMPLATE_PATH, 'utf8');
}

function sendIndex(req, res) {
  const nonce = randomBytes(16).toString('base64');
  const origin = originFor(req);

  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "base-uri 'none'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "script-src 'self' 'nonce-" + nonce + "'",
      // Fonts are self-hosted now, so no third-party origin is needed here.
      "style-src 'self'",
      "font-src 'self'",
      "img-src 'self' data:",
      "connect-src 'self'",
    ].join('; ')
  );
  // The nonce changes every request, so this document must never be reused.
  res.setHeader('Cache-Control', 'no-store');
  res.type('html').send(
    template()
      .replaceAll('{{ORIGIN}}', origin)
      .replaceAll('{{NONCE}}', nonce)
  );
}

app.get('/', sendIndex);

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(
    [
      'User-agent: *',
      'Allow: /',
      // Nothing under /api is a page; keeping it out of the index avoids
      // crawlers burning budget on endpoints that only answer POST.
      'Disallow: /api/',
      '',
      `Sitemap: ${originFor(req)}/sitemap.xml`,
      '',
    ].join('\n')
  );
});

app.get('/sitemap.xml', (req, res) => {
  const origin = originFor(req);
  let lastmod;
  try {
    lastmod = statSync(TEMPLATE_PATH).mtime.toISOString().slice(0, 10);
  } catch {
    lastmod = undefined;
  }
  res.type('application/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${origin}/</loc>${lastmod ? `\n    <lastmod>${lastmod}</lastmod>` : ''}
    <changefreq>monthly</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>
`
  );
});

app.get('/healthz', (req, res) => res.type('text/plain').send('ok'));

app.post('/api/convert', async (req, res) => {
  const rawUrl = (req.body?.url || '').trim();

  if (!rawUrl) {
    return res.status(400).json({ error: 'Paste a Komoot tour link first.' });
  }

  try {
    const resolvedUrl = await resolveShareLink(rawUrl);
    const { tourId, shareToken } = parseTourId(resolvedUrl);
    const tour = await fetchTour(tourId, shareToken);
    const gpx = buildGpx(tour);

    const filename = `${slugify(tour.name)}.gpx`;
    res.setHeader('Content-Type', 'application/gpx+xml');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(gpx);
  } catch (err) {
    if (err instanceof SourceError) {
      return res.status(422).json({ error: err.message, code: err.code });
    }
    console.error(err);
    res.status(500).json({ error: 'Something went wrong converting that link.' });
  }
});

// Unknown paths: JSON for the API, the app shell for everything else. Both
// carry a real 404 so crawlers don't index empty URLs as duplicates of "/".
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found.' });
  }
  res.status(404);
  sendIndex(req, res);
});

function slugify(name) {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'tour'
  );
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`komoot-gpx listening on http://localhost:${PORT}`);
  if (!SITE_URL) {
    console.log('SITE_URL is not set — canonical and og:image URLs will follow the Host header. Set it in production.');
  }
});
