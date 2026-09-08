const form = document.getElementById('convert-form');
const input = document.getElementById('url');
const button = document.getElementById('submit');
const status = document.getElementById('status');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  setStatus('', null);

  // The form is novalidate so the error lands in our own live region rather
  // than a browser bubble, which screen readers announce inconsistently.
  if (!input.value.trim()) {
    setStatus('Paste a Komoot tour link first.', 'error');
    input.focus();
    return;
  }

  button.disabled = true;
  button.textContent = 'Fetching…';
  form.setAttribute('aria-busy', 'true');

  try {
    const res = await fetch('/api/convert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: input.value.trim() }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Request failed (${res.status}).`);
    }

    const disposition = res.headers.get('Content-Disposition') || '';
    const filenameMatch = disposition.match(/filename="([^"]+)"/);
    const filename = filenameMatch ? filenameMatch[1] : 'tour.gpx';

    const blob = await res.blob();
    downloadBlob(blob, filename);
    setStatus(`Downloaded ${filename}`, 'ok');
  } catch (err) {
    setStatus(err.message || 'Something went wrong.', 'error');
    input.focus();
  } finally {
    button.disabled = false;
    button.textContent = 'Get GPX';
    form.removeAttribute('aria-busy');
  }
});

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

