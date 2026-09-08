// The conversion runs entirely in the browser, so the site can be hosted as
// static files on GitHub Pages with no backend.
//
// This works because api.komoot.de sends `Access-Control-Allow-Origin: *`,
// which lets a page on another origin read the tour directly. The same modules
// run unchanged on the server (see server.js) — they have no Node-specific
// dependencies.

import { tourFromUrl, fetchTour } from './lib/komoot.js';
import { buildGpx, gpxFilename } from './lib/gpx.js';
import { SourceError } from './lib/errors.js';

const form = document.getElementById('convert-form');
const input = document.getElementById('url');
const button = document.getElementById('submit');
const status = document.getElementById('status');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  setStatus('', null);

  const raw = input.value.trim();
  // The form is novalidate so the error lands in our own live region rather
  // than a browser bubble, which screen readers announce inconsistently.
  if (!raw) {
    setStatus('Paste a Komoot tour link first.', 'error');
    input.focus();
    return;
  }

  button.disabled = true;
  button.textContent = 'Fetching…';
  form.setAttribute('aria-busy', 'true');

  try {
    const { tourId, shareToken } = tourFromUrl(raw);
    const tour = await fetchTour(tourId, shareToken);
    const filename = gpxFilename(tour.name);
    downloadBlob(new Blob([buildGpx(tour)], { type: 'application/gpx+xml' }), filename);
    setStatus(`Downloaded ${filename}`, 'ok');
  } catch (err) {
    setStatus(messageFor(err), 'error');
    input.focus();
  } finally {
    button.disabled = false;
    button.textContent = 'Get GPX';
    form.removeAttribute('aria-busy');
  }
});

/**
 * A SourceError is something we diagnosed and can explain. Anything else is
 * either the network being down or the browser refusing the request, and
 * showing its raw text ("Failed to fetch") tells the user nothing useful.
 */
function messageFor(err) {
  if (err instanceof SourceError) return err.message;
  console.error(err);
  return "Couldn't reach Komoot. Check your connection and try again.";
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function setStatus(message, state) {
  status.textContent = message;
  if (state) {
    status.dataset.state = state;
  } else {
    delete status.dataset.state;
  }
  // Ties the message to the field for assistive tech, and drives the red border.
  if (state === 'error') {
    input.setAttribute('aria-invalid', 'true');
  } else {
    input.removeAttribute('aria-invalid');
  }
}
