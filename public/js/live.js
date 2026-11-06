// The live feed: Server-Sent Events from /api/izleme/akis.
// The first event (durum) is the whole picture; every later one (etkinlik) is one changed read.

const MAX_WAIT_MS = 30_000;

/**
 * onState gets 'connecting', 'live' or 'down'. The browser reconnects by itself after a dropped
 * connection; when it gives up (the server answered with an error, e.g. 401 after the session
 * ended), this tries again with backoff. close() stops it for good (sign-out).
 */
export function connectLive({ onSnapshot, onEvent, onState }) {
  let source = null;
  let attempts = 0;
  let timer = null;
  let closed = false;

  const parse = (e) => {
    try {
      return JSON.parse(e.data);
    } catch {
      return null;
    }
  };

  const open = () => {
    timer = null;
    if (closed) return;
    onState('connecting');
    source = new EventSource('/api/izleme/akis');
    source.addEventListener('durum', (e) => {
      const snapshot = parse(e);
      if (!snapshot || closed) return;
      attempts = 0;
      onState('live');
      onSnapshot(snapshot);
    });
    source.addEventListener('etkinlik', (e) => {
      const event = parse(e);
      if (event && !closed) onEvent(event);
    });
    source.addEventListener('error', () => {
      if (closed) return;
      onState('down');
      if (source.readyState === EventSource.CLOSED && timer === null) {
        timer = setTimeout(open, Math.min(MAX_WAIT_MS, 2000 * 2 ** attempts++));
      }
    });
  };

  open();

  return {
    close() {
      closed = true;
      clearTimeout(timer);
      timer = null;
      source?.close();
      source = null;
    },
  };
}
