# komoot-gpx

Paste a Komoot tour link, get a `.gpx` file back. No account, no browser extension.

## Run it

```
npm install
npm start
```

Then open http://localhost:3000, paste a tour link (e.g.
`https://www.komoot.com/tour/123456789`), and click **Get GPX**.

## What's tested and what isn't

- **Tested and passing:** URL parsing (`parseTourId`, `resolveShareLink`),
  GPX assembly (`buildGpx`) including elevation and timestamps, XML
  escaping, static file serving, and the error-handling paths in
  `server.js`. Run `npm test` to see these.
- **Verified against a live response:** `fetchTour()` was checked against
  the public Komoot tour `api.komoot.de/v007/tours/1`, which returns 551
  track points. Summing great-circle distances over those points gives
  13.62 km against the 13.73 km Komoot reports for the tour — the ~0.8%
  gap is the expected shortfall from straight-line segments across a
  curved track, which confirms the geometry is complete rather than
  sampled.

## Getting the full track: `_embedded=coordinates`

This is the one thing worth understanding before touching `fetchTour()`.

The tour object at `/v007/tours/{id}` does **not** include track geometry
by default. You have to ask for it:

    https://api.komoot.de/v007/tours/{id}?_embedded=coordinates

The failure mode here is nasty because it is silent. Request the wrong
parameter — an earlier version of this code sent `?fields=timeline,path,coordinates`,
which the API ignores entirely — and you still get `200 OK` with a
complete-looking tour object. It just has no `_embedded.coordinates`, so
the track is empty. On planned tours the response also carries a top-level
`path` array, but those are **routing waypoints** (start, vias, finish): a
handful of points for a 60 km ride. Fall back to them and you produce a
valid GPX with a start, a finish, and nothing in between.

So `extractTrackPoints()` reads `_embedded.coordinates.items` and nothing
else, and `fetchTour()` throws `no_geometry` rather than emitting a sparse
track. A clear error beats a plausible-looking, useless file.

Two other details that bite:

- **`t` is in milliseconds**, even though the tour's `duration` field is in
  seconds. On tour 1 the final point's `t` is `4928000` against a
  `duration` of `4928`. Reading `t` as seconds turns an 82-minute ride into
  57 days of timestamps.
- **The headers matter.** Komoot returns HAL+JSON and rejects requests that
  only offer `application/json`; Node's default fetch User-Agent draws 403s
  on its own. Both are set in `API_HEADERS`.

## If the live fetch breaks

All of the Komoot-specific logic is isolated in `lib/komoot.js`, per the
comments at the top of that file. If `fetchTour()` starts failing or
returning empty tracks:

1. Hit `https://api.komoot.de/v007/tours/1?_embedded=coordinates` directly
   (in a browser or with `curl`) — that tour is public, so it works as a
   control. Compare its shape against a failing tour.
2. Update `extractTrackPoints()` / `normalizePoint()` in `lib/komoot.js` to
   match. There is also a fallback to the `/tours/{id}/coordinates`
   sub-resource, which returns the same `{items: [...]}` payload.
3. Add the new fixture to `test/mock-tour-response.json` (or a second
   fixture) and extend `test/build-gpx.test.js` so the fix is covered going
   forward.

## Deployment

The site is **static** and published to GitHub Pages from `public/` by
`.github/workflows/pages.yml` on every push to `main`. There is no build step:
what you serve locally is byte-for-byte what ships.

**One-time setup:** repo Settings → Pages → Source → **GitHub Actions**.
Without that the workflow runs green and nothing is served.

Live at <https://jasperbrumter.github.io/tour-gpx/>.

### Why a static site can do this at all

The conversion runs in the browser. That is only possible because
`api.komoot.de` sends `Access-Control-Allow-Origin: *`, so a page on another
origin may read a tour directly. `public/lib/` holds plain ES modules with no
Node-specific dependencies, so the same code runs in the browser and under
`server.js`.

### The subpath trap

Pages serves a project repo at `/tour-gpx/`, not at the domain root, so every
root-absolute path (`/style.css`, `/fonts/…`) resolves to the wrong place and
404s. All asset references are therefore **relative**.

Note that the HTML and the CSS are separate problems. Fixing `index.html` and
forgetting `style.css` leaves the page working but silently falling back to
Arial, because only the `@font-face` URLs are broken — which is exactly what
happened here the first time. Two tests now guard it, plus one that checks
every referenced asset actually exists.

### What a static host cannot do

- **Short `komoot.com/s/…` share links.** Resolving one means reading that
  page's HTML, and `www.komoot.com` sends no `Access-Control-Allow-Origin`
  header, so the browser is not allowed to. The app detects these and tells the
  user to open the link and copy the full address. `server.js` still handles
  them properly, because a server is not bound by CORS.
- **Response headers.** Pages sets its own and allows no additions, so the CSP
  ships in a `<meta http-equiv>` tag instead. `frame-ancestors` is ignored in a
  meta CSP and is the single directive lost by moving off a server. HSTS is
  moot: `github.io` is HSTS-preloaded.
- **Per-request values.** The canonical and Open Graph URLs are hardcoded, and
  the inline JSON-LD is allowed by **hash** rather than a per-request nonce.
  Change that block without recomputing the hash and it is silently blocked in
  production, so `test/build-gpx.test.js` fails if the two drift — in
  `index.html` or in `server.js`.

### Self-hosting instead

`server.js` still runs the whole thing on any Node host and is the better
option if short share links matter: it serves the same `public/` tree, adds the
real response headers, and keeps `POST /api/convert` for server-side
conversion.

    npm start

## Output compatibility

The GPX validated against the GPX 1.1 schema before these changes too, so this
is about what real importers accept rather than what the schema permits:

- **Timestamps only for recorded tours.** Strava reads a GPX containing
  `<time>` as an *activity* and derives pace from it. A Komoot planned route's
  `t` values are Komoot's estimates, so writing them produced an activity that
  never happened. Without `<time>` the same file imports cleanly as a Strava
  route, and Maps.me / Organic Maps ignore time either way.
- **No fractional seconds.** `xsd:dateTime` allows them and Komoot's values are
  whole seconds anyway, but a number of GPS tools reject `…54.000Z` while
  accepting `…54Z`.
- **Times dropped entirely if they ever run backwards.** Strava rejects an
  upload whose timestamps decrease, so one bad point would fail the whole file;
  degrading to a valid untimed route is better than a rejected upload.
- `<bounds>`, `<desc>`, a `<link>` back to the tour on Komoot, `<type>` from the
  sport, and an `xsi:schemaLocation` declaration.

Element order is load-bearing: GPX 1.1 declares `<metadata>` and `<trk>`
children as `xsd:sequence`, so name/desc/link/time/bounds must appear in that
order or a validating importer rejects the file.
`test/build-gpx.test.js` validates the output against the schema vendored in
`test/fixtures/` (offline, via `xmllint`; skipped if `xmllint` is absent), and
that test was confirmed to fail when the element order is deliberately broken.

The resulting file is intended to open in Garmin Connect, Strava, AllTrails,
Maps.me / Organic Maps and most GPS devices. **Not verified by live import** —
it is schema-valid and follows each importer's documented requirements, but it
has not been uploaded to a real Strava account or opened on a device.

### Input

Komoot only. `resolveShareLink()` rejects anything else with
`link_not_recognized`, and it handles both full tour URLs and the short
`komoot.com/s/…` share links, which Komoot resolves client-side rather than
with an HTTP redirect.

## Fonts

Fjalla One and Karla are **self-hosted** from `public/fonts/` (74 KB total,
woff2). They used to load from Google Fonts, which caused a visible flash on a
cold hard-refresh: the browser had to resolve DNS and complete a TLS handshake
with `fonts.googleapis.com` for the stylesheet, then do it again for
`fonts.gstatic.com` before the first font byte could arrive. Text painted in a
fallback and then re-painted when the real face landed.

Three things remove the flash, and all three are needed:

1. **Self-hosting** puts the fonts on a connection the browser has already
   opened, so they arrive in the same round trip as the CSS.
2. **`font-display: optional`** is what actually guarantees no flash. It gives
   the browser roughly 100 ms; if the font isn't ready, the fallback is used
   *for that page load and not swapped out*. `swap` — what the old Google
   Fonts URL requested — does the opposite, and is precisely what caused the
   re-paint.
3. **`<link rel="preload">`** on the two latin files starts them at the top of
   the document so they usually win that 100 ms race. Note the `crossorigin`
   attribute: font preloads are CORS requests even same-origin, and the
   preload is silently ignored without it.

On the rare miss, the `Karla Fallback` / `Fjalla Fallback` faces stand in.
Their `size-adjust` and ascent/descent overrides were measured from the real
fonts against Arial, so advance widths match and the layout doesn't move —
verified at 2 px worst-case vertical movement with the font files blocked
entirely, and an identical total page height.

Karla is a variable font, so one file covers the 400–700 range. Only the
weights actually used are shipped; the old Google Fonts URL also requested a
500 weight that no rule referenced.

Fonts are served `immutable` with a one-year max-age, so a repeat visit never
re-fetches and never risks the fallback.

Both faces are SIL OFL licensed, which permits redistribution.
`public/fonts/karla-OFL.txt` and `public/fonts/fjalla-one-OFL.txt` carry the
licences — they have different copyright holders, so both are kept.

Self-hosting also removed the last third-party request on the site, which let
the CSP tighten to `style-src 'self'; font-src 'self'` and closed the one gap
in the page's privacy claim — Google no longer sees visitors' IP addresses.

## Accessibility notes

- A skip link is the first tab stop, jumping past the two decorative SVGs to
  the form.
- Both background SVGs are `aria-hidden` with `focusable="false"`.
- The input is labelled and `aria-describedby` points at both the hint and the
  status region, so an error is announced with the field.
- The form is `novalidate`: errors go to our own live region rather than a
  browser validation bubble, which screen readers announce inconsistently.
- `--moss` is `#74997a` rather than a darker green so the status line and the
  privacy heading clear 4.5:1 against the background.
- `<noscript>` explains that the converter needs JavaScript.

## A few things worth knowing

- **This uses an unofficial endpoint.** Komoot has no public API for
  exporting arbitrary tours as GPX. This reads the same internal API their
  own web app uses. It works as of the community tools this was modeled
  on, but Komoot can change it at any time, and using it may be outside
  their terms of service — worth checking if you plan to run this for
  anyone beyond yourself.
- **Private tours** need the `share_token` from a share link
  (`komoot.com/tour/{id}?share_token=...`), not just the plain tour URL —
  the code reads that token if it's present in the pasted link.
- **No routing/regeneration happens.** Unlike a Google Maps-style
  converter, this just reads back the track geometry Komoot already
  computed — so the GPX should match the tour exactly, elevation included.

## Next steps if you want to keep going

- Deploy it somewhere Komoot is actually reachable and confirm a real
  tour link end-to-end.
- If it's solid, an iOS Share Extension wrapping the same `/api/convert`
  logic would let you share straight out of the Komoot app rather than
  copy-pasting URLs.
