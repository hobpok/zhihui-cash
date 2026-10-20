// Preview events are ephemeral. Only the service's durable, revalidated result can complete a request.
import { HttpError } from './errors.js';
const encoder = new TextEncoder();
const phases = new Set(['tools', 'generating', 'validating']);
export function dialogueStreamResponse({ requestId, run, onResult = () => {} }) {
  let controller, closed = false, previewBytes = 0, previewFrames = 0, controlFrames = 0;
  let lastPreview = '', lastRound = -1, pendingPreview = null;
  const send = (event, preview = false) => {
    if (closed) return;
    const chunk = encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify({ ...event, requestId })}\n\n`);
    const control = preview && (event.type === 'phase' || event.type === 'preview' && event.text === '');
    if (control) { if (++controlFrames > 64) return; }
    else if (preview) {
      if (previewFrames >= 1024 || previewBytes + chunk.byteLength > 2 * 1024 * 1024) return;
      previewFrames++; previewBytes += chunk.byteLength;
    }
    try { controller.enqueue(chunk); } catch { closed = true; }
  };
  const flushPreview = () => {
    if (!pendingPreview) return;
    const event = pendingPreview; pendingPreview = null;
    lastPreview = event.text; lastRound = event.round; send(event, true);
  };
  const progress = event => {
    if (!event || typeof event !== 'object') return;
    if (event.type === 'phase' && phases.has(event.phase)) {
      if (event.phase === 'validating') flushPreview();
      send({ type: 'phase', phase: event.phase }, true);
    }
    if (event.type === 'preview' && typeof event.text === 'string' && event.text.length <= 4000 &&
        Number.isSafeInteger(event.round) && event.round >= 0 && event.round < 6 && event.round >= lastRound) {
      if (event.round === lastRound && event.text === lastPreview) return;
      pendingPreview = { type: 'preview', text: event.text, round: event.round };
      // Emit the first text immediately, then merge adjacent token fragments without a typing timer.
      // This keeps long Chinese answers within transport bounds and still shows text before completion.
      if (!event.text || !lastPreview || event.round !== lastRound || !event.text.startsWith(lastPreview) ||
          event.text.length - lastPreview.length >= 16) flushPreview();
    }
  };
  const body = new ReadableStream({
    start(value) { controller = value; },
    // A dropped connection never creates a new generation; the existing request remains recoverable by ID.
    cancel() { closed = true; },
  });
  const task = Promise.resolve().then(() => run(progress)).then(result => {
    flushPreview();
    try { onResult(result.value?.status); } catch { /* Optional observation. */ }
    send({ type: 'complete', httpStatus: result.httpStatus, value: result.value });
  }, error => {
    const httpStatus = error instanceof HttpError ? error.status : 503;
    send({ type: 'error', httpStatus, error: error instanceof HttpError ? error.code : 'SERVICE_UNAVAILABLE' });
  }).finally(() => {
    if (!closed) { closed = true; try { controller.close(); } catch { /* Already detached. */ } }
  });
  return { response: new Response(body, { headers: {
    'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, private, no-transform',
    'Vary': 'Cookie, Accept', 'X-Content-Type-Options': 'nosniff', 'X-Accel-Buffering': 'no',
  } }), task };
}
