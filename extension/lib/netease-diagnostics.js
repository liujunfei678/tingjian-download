// These summaries are for local troubleshooting only. The fingerprint is not
// an identity check and must never replace full URL matching for song naming.
export function summarizeNeteaseURL(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    const normalized = url.href;
    let fingerprint = 2166136261;
    // A serialized HTTP URL contains only ASCII code units (non-ASCII path and
    // query text is percent encoded), so these are its UTF-8 bytes as well.
    for (let index = 0; index < normalized.length; index++) {
      fingerprint = Math.imul(fingerprint ^ normalized.charCodeAt(index), 16777619);
    }
    return {
      protocol: url.protocol,
      host: url.host,
      path: url.pathname,
      queryKeys: [...new Set(url.searchParams.keys())],
      fingerprint: (fingerprint >>> 0).toString(16).padStart(8, '0'),
      length: normalized.length
    };
  } catch { return null; }
}

const STORAGE_KEY = 'neteaseDiagnostics';
const MAX_EVENTS = 32;
const MAX_EVENTS_PER_KIND = 16;
const boundedEvents = events => {
  const counts = { response: 0, playback: 0 };
  const retained = [];
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event?.event === 'response' || event?.event === 'playback') {
      if (++counts[event.event] > MAX_EVENTS_PER_KIND) continue;
    }
    retained.push(event);
    if (retained.length === MAX_EVENTS) break;
  }
  return retained.reverse();
};
const signature = event => {
  const { at, ...content } = event;
  return JSON.stringify(content);
};

export class NeteaseDiagnostics {
  constructor(chrome) {
    this.storage = chrome.storage.local;
    this.queue = Promise.resolve();
  }

  async record(event) {
    // The caller supplies a redacted event. Capture it before waiting on other
    // writes so later caller mutations cannot change a pending diagnostic.
    const captured = JSON.parse(JSON.stringify(event));
    captured.at ??= Date.now();
    const next = this.queue.catch(() => {}).then(async () => {
      const stored = (await this.storage.get(STORAGE_KEY))[STORAGE_KEY];
      const events = Array.isArray(stored?.events) ? stored.events.slice(-MAX_EVENTS) : [];
      if (events.length && signature(events[events.length - 1]) === signature(captured)) return;
      events.push(captured);
      await this.storage.set({ [STORAGE_KEY]: { updatedAt: Date.now(), events: boundedEvents(events) } });
    });
    this.queue = next;
    return next;
  }
}
