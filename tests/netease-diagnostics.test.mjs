import test from 'node:test';
import assert from 'node:assert/strict';

const api = await import('../extension/lib/netease-diagnostics.js').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});

function summarize(value) {
  assert.equal(typeof api.summarizeNeteaseURL, 'function');
  return api.summarizeNeteaseURL(value);
}

function storageFixture(initial = {}) {
  let state = structuredClone(initial);
  let inFlight = 0;
  let peak = 0;
  let writes = 0;
  return {
    chrome: { storage: { local: {
      async get(key) {
        peak = Math.max(peak, ++inFlight);
        await new Promise(resolve => setImmediate(resolve));
        inFlight--;
        return { [key]: structuredClone(state[key]) };
      },
      async set(value) {
        peak = Math.max(peak, ++inFlight);
        await new Promise(resolve => setImmediate(resolve));
        state = { ...state, ...structuredClone(value) };
        writes++;
        inFlight--;
      }
    } } },
    read: () => structuredClone(state),
    stats: () => ({ peak, writes })
  };
}

function diagnostics(fixture) {
  assert.equal(typeof api.NeteaseDiagnostics, 'function');
  return new api.NeteaseDiagnostics(fixture.chrome);
}

test('URL diagnostics retain structure and keys while excluding query values and fragments', () => {
  const input = 'https://m804.music.126.net:8443/media/track.m4a?token=privateValue&x=1&token=secret#t=3';
  const value = summarize(input);
  assert.deepEqual(Object.keys(value).sort(), ['fingerprint', 'host', 'length', 'path', 'protocol', 'queryKeys']);
  assert.equal(value.protocol, 'https:');
  assert.equal(value.host, 'm804.music.126.net:8443');
  assert.equal(value.path, '/media/track.m4a');
  assert.deepEqual(value.queryKeys, ['token', 'x']);
  assert.match(value.fingerprint, /^[0-9a-f]{8}$/);
  assert.equal(value.length, input.slice(0, input.indexOf('#')).length);
  assert.doesNotMatch(JSON.stringify(value), /privateValue|secret|t=3/);
});

test('fingerprints compare the complete normalized URL except its fragment', () => {
  const base = 'https://m10.music.126.net/media/track.m4a?token=a%2Bb';
  assert.equal(summarize(base).fingerprint, summarize(base + '#t=4').fingerprint);
  assert.equal(summarize('https://EXAMPLE.com:443/').fingerprint, 'e0fbd8b4');
  assert.notEqual(summarize(base).fingerprint, summarize(base.replace('a%2Bb', 'different')).fingerprint);
});

test('invalid, non-HTTP, relative, or credential-bearing URLs produce no diagnostic URL', () => {
  for (const value of [null, undefined, {}, '', '/relative.m4a', 'invalid', 'file:///a.m4a',
    'blob:https://music.163.com/id', 'ftp://example.com/a.mp3',
    'https://user:password@example.com/a.mp3', 'https://user@example.com/a.mp3']) {
    assert.equal(summarize(value), null);
  }
  assert.equal(summarize('http://example.com/a.mp3').protocol, 'http:');
});

test('diagnostic writes serialize concurrent events and retain the latest 32', async () => {
  const fixture = storageFixture();
  const recorder = diagnostics(fixture);
  await Promise.all(Array.from({ length: 45 }, (_, index) => recorder.record({ at: index, reason: 'event-' + index })));
  const state = fixture.read().neteaseDiagnostics;
  assert.equal(state.events.length, 32);
  assert.deepEqual(state.events.map(event => event.at), Array.from({ length: 32 }, (_, index) => index + 13));
  assert.equal(typeof state.updatedAt, 'number');
  assert.equal(fixture.stats().peak, 1);
});

test('only consecutive identical events deduplicate, ignoring their timestamp', async () => {
  const fixture = storageFixture();
  const recorder = diagnostics(fixture);
  await recorder.record({ at: 1, reason: 'no-player', track: { id: '276035' } });
  await recorder.record({ at: 2, reason: 'no-player', track: { id: '276035' } });
  await recorder.record({ at: 3, reason: 'matched', track: { id: '276035' } });
  await recorder.record({ at: 4, reason: 'no-player', track: { id: '276035' } });
  assert.deepEqual(fixture.read().neteaseDiagnostics.events.map(event => event.at), [1, 3, 4]);
  assert.equal(fixture.stats().writes, 3);
});

test('the bounded log resumes from existing local diagnostics without changing other state', async () => {
  const oldEvents = Array.from({ length: 40 }, (_, index) => ({ at: index, reason: 'old-' + index }));
  const fixture = storageFixture({ neteaseDiagnostics: { updatedAt: 1, events: oldEvents }, settings: { folder: 'keep' } });
  await diagnostics(fixture).record({ at: 50, reason: 'new' });
  assert.equal(fixture.read().neteaseDiagnostics.events.length, 32);
  assert.equal(fixture.read().neteaseDiagnostics.events[0].at, 9);
  assert.deepEqual(fixture.read().settings, { folder: 'keep' });
});

test('events are snapshotted when recorded so caller changes cannot rewrite queued diagnostics', async () => {
  const fixture = storageFixture();
  const recorder = diagnostics(fixture);
  const event = { at: 1, reason: 'original', track: { id: '276035' } };
  const pending = recorder.record(event);
  event.track.id = 'different';
  event.reason = 'changed';
  await pending;
  assert.deepEqual(fixture.read().neteaseDiagnostics.events[0], { at: 1, reason: 'original', track: { id: '276035' } });
});

test('response bursts preserve earlier playback snapshots while keeping event order', async () => {
  const fixture = storageFixture();
  const recorder = diagnostics(fixture);
  await recorder.record({ at: 1, event: 'playback', track: { id: '276035' } });
  await Promise.all(Array.from({ length: 45 }, (_, index) => recorder.record({ at: index + 2, event: 'response', reason: 'response-' + index })));
  const events = fixture.read().neteaseDiagnostics.events;
  assert.equal(events.filter(event => event.event === 'playback').length, 1);
  assert.equal(events.filter(event => event.event === 'response').length, 16);
  assert.equal(events[0].at, 1);
  assert.deepEqual(events.slice(1).map(event => event.at), Array.from({ length: 16 }, (_, index) => index + 31));
});

test('each classified event kind is limited to 16 under the global limit of 32', async () => {
  const fixture = storageFixture();
  const recorder = diagnostics(fixture);
  for (let index = 0; index < 20; index++) await recorder.record({ at: index - 20, event: 'playback', reason: 'old-playback-' + index });
  assert.equal(fixture.read().neteaseDiagnostics.events.length, 16);
  for (let index = 0; index < 25; index++) {
    await recorder.record({ at: index * 2, event: 'playback', reason: 'playback-' + index });
    await recorder.record({ at: index * 2 + 1, event: 'response', reason: 'response-' + index });
  }
  let events = fixture.read().neteaseDiagnostics.events;
  assert.equal(events.length, 32);
  assert.equal(events.filter(event => event.event === 'playback').length, 16);
  assert.equal(events.filter(event => event.event === 'response').length, 16);
  assert.deepEqual(events.map(event => event.at), Array.from({ length: 32 }, (_, index) => index + 18));
  for (let index = 0; index < 40; index++) await recorder.record({ at: index + 50, event: 'other', reason: 'other-' + index });
  events = fixture.read().neteaseDiagnostics.events;
  assert.equal(events.length, 32);
  assert.deepEqual(events.map(event => event.at), Array.from({ length: 32 }, (_, index) => index + 58));
});
