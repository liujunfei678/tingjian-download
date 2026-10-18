export function isNeteasePageURL(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && url.hostname === 'music.163.com' && !url.username && !url.password;
  } catch { return false; }
}

export function matchingNeteasePlaybackURL(capturedURL, playbackURL) {
  const normalize = value => {
    if (typeof value !== 'string' || value.length > 16384) return '';
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
      url.hash = '';
      return url.href;
    } catch { return ''; }
  };
  const captured = normalize(capturedURL);
  return Boolean(captured && captured === normalize(playbackURL));
}

// Some NetEase AAC responses use a QuickTime container MIME despite being
// standalone .m4a songs. This only identifies responses needing player proof;
// it does not make them audio candidates by itself.
export function needsNeteaseM4APlaybackProof(value, mime) {
  if (String(mime || '').split(';')[0].trim().toLowerCase() !== 'video/quicktime') return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password &&
      url.hostname.endsWith('.music.126.net') && /\.m4a$/i.test(url.pathname);
  } catch { return false; }
}

// This function is serialized into the page's MAIN world by executeScript.
// Keep every helper inside it: module scope and imported functions do not travel
// with it. Read only the site's existing player; never initialize one or alter
// its methods, media element, network requests, or playback state.
export function readNeteasePlayback(includeDiagnostics = false) {
  const diagnostic = { reason: '', states: [] };
  const finish = (reason, bindings = []) => {
    diagnostic.reason = reason;
    return includeDiagnostics ? { bindings, diagnostic } : bindings;
  };
  try {
    if (!['http:', 'https:'].includes(location.protocol) || location.hostname !== 'music.163.com') return finish('wrong-origin');

    let descriptorBudget = 4096;
    const object = value => value !== null && (typeof value === 'object' || typeof value === 'function');
    const own = (target, key) => {
      if (!object(target) || descriptorBudget-- <= 0) return undefined;
      try {
        const descriptor = Object.getOwnPropertyDescriptor(target, key);
        return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
      } catch { return undefined; }
    };
    const names = (target, limit) => {
      if (!object(target) || descriptorBudget <= 0) return [];
      try { return Object.getOwnPropertyNames(target).slice(0, limit); } catch { return []; }
    };
    const text = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
    const songID = value => {
      if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : '';
      return typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value) ? value : '';
    };
    const audioURL = value => {
      if (typeof value !== 'string' || value.length > 16384) return '';
      try {
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
        if (url.hostname !== 'music.163.com' && !url.hostname.endsWith('.music.163.com') && !url.hostname.endsWith('.music.126.net')) return '';
        // A song page, playlist, segment, or API endpoint is not the media URL.
        if (!/\.(?:mp3|m4a|aac|wav|flac|ogg|oga|opus|weba|aiff?|wma|amr|ac3|caf|mka)$/i.test(url.pathname)) return '';
        url.hash = '';
        return url.href;
      } catch { return ''; }
    };

    const player = own(window, 'player');
    const getPlaying = own(player, 'getPlaying');
    if (typeof getPlaying !== 'function') return finish('no-getPlaying');
    const current = Reflect.apply(getPlaying, player, []);
    const track = own(current, 'track');
    const trackId = songID(own(track, 'id'));
    const title = text(own(track, 'name'));
    diagnostic.trackId = trackId;
    diagnostic.title = title;
    diagnostic.playing = own(current, 'playing') === true;
    if (!trackId || !title) return finish('invalid-track');
    const artists = own(track, 'artists');
    const artistNames = [];
    if (Array.isArray(artists)) {
      const length = Math.min(own(artists, 'length') || 0, 16);
      for (let index = 0; index < length; index++) {
        const name = text(own(own(artists, String(index)), 'name'));
        if (name) artistNames.push(name);
      }
    }
    const artist = artistNames.join(' / ').slice(0, 200);
    diagnostic.artist = artist;
    const namespace = own(own(window, 'nm'), 'w');
    if (!object(namespace)) return finish('no-namespace');
    const diagnosticStates = new Set();
    const resultFor = state => {
      const stateId = songID(own(state, 'id'));
      const playURL = own(state, 'playUrl');
      const url = audioURL(playURL);
      if (includeDiagnostics && object(state) && !diagnosticStates.has(state) && (stateId || typeof playURL === 'string') && diagnostic.states.length < 8) {
        diagnosticStates.add(state);
        const entry = { stateId, playURL: typeof playURL === 'string' ? playURL.slice(0, 16384) : '',
          reason: stateId !== trackId ? 'state-id-mismatch' : url ? 'valid-media-url' : 'invalid-media-url' };
        for (const key of ['mediaType', 'loadState', 'error', 'Fj8W']) {
          const value = own(state, key);
          if (typeof value === 'string') entry[key] = /^[a-z0-9 _.-]{0,64}$/i.test(value) ? value : 'other';
          else if (typeof value === 'number' || typeof value === 'boolean') entry[key] = value;
        }
        diagnostic.states.push(entry);
      }
      if (stateId !== trackId) return null;
      return url ? { url, title, artist, trackId } : null;
    };

    // The currently published NetEase player stores its singleton here. Looking
    // up the value does not call fI4S(), which would create a player if absent.
    const knownState = own(own(own(namespace, 'gi8O'), 'fa6K'), 'cx2e');
    const knownResult = resultFor(knownState);
    if (knownResult) return finish('binding-found', [knownResult]);

    // Minified property names can change. Examine only existing class statics,
    // their singleton objects, and those objects' immediate state fields. Do
    // not walk window, prototypes, queues, arbitrary heap objects, or getters.
    const visited = new Set();
    const results = new Map();
    const skipStatic = new Set(['prototype', 'caller', 'arguments', 'name', 'length']);
    for (const classKey of names(namespace, 128)) {
      const Type = own(namespace, classKey);
      if (typeof Type !== 'function') continue;
      for (const singletonKey of names(Type, 24)) {
        if (skipStatic.has(singletonKey)) continue;
        const singleton = own(Type, singletonKey);
        if (!singleton || typeof singleton !== 'object' || Array.isArray(singleton) || visited.has(singleton)) continue;
        if (visited.size >= 384 || descriptorBudget <= 0) return finish(results.size ? 'binding-found' : 'search-limit', Array.from(results.values()));
        visited.add(singleton);
        for (const stateKey of names(singleton, 48)) {
          const state = own(singleton, stateKey);
          if (!state || typeof state !== 'object' || Array.isArray(state)) continue;
          const result = resultFor(state);
          if (result) results.set(result.url, result);
          if (results.size >= 8) return finish('binding-found', Array.from(results.values()));
        }
      }
    }
    return finish(results.size ? 'binding-found' : diagnostic.states.length ? 'no-valid-state' : 'no-player-state', Array.from(results.values()));
  } catch { return finish('read-error'); }
}
