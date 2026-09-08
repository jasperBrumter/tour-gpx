import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGpx } from './public/lib/gpx.js';
import { SourceError } from './public/lib/errors.js';
import { resolveShareLink, parseTourId, fetchTour } from './public/lib/komoot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const app = express();

// Behind a proxy the scheme arrives as X-Forwarded-Proto; req.secure needs it
// to decide whether to send HSTS.
app.set('trust proxy', true);
app.disable('x-powered-by');

app.use((req, res, next) => {
  // Mirrors the <meta> CSP in index.html, with frame-ancestors added — that
  // directive is ignored in a meta tag, so it only takes effect when a real
  // server serves the site. Keep the hash in step with the JSON-LD block;
  // test/build-gpx.test.js fails if the two drift.
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; " +
      "form-action 'none'; script-src 'self' 'sha256-Lb4oIpxbn+nAul+V/CzKFovhgcAYky2jUOVJACneUpk='; style-src 'self'; " +
      "font-src 'self'; img-src 'self' data:; connect-src 'self' https://api.komoot.de"
  );
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

app.get('/index.html', (req, res) => res.redirect(301, '/'));

// The site is plain static files — identical to what GitHub Pages serves.
app.use(
  express.static(PUBLIC_DIR, {
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
  res.status(404).sendFile(path.join(PUBLIC_DIR, '404.html'));
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
  console.log('Serving public/ as static files — the same tree GitHub Pages publishes.');
});
