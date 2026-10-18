import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as api from '../extension/lib/netease.js';
const signedURL = 'https://m804.music.126.net/media/obj_w5rDlsOJwrLDjj7Cm.m4a?token=a%2Bb&x=1';
const fixture = ({ id = 123, stateId = id, url = signedURL, name = '晴天', artists = [{ name: '示例歌手' }] } = {}) => ({
  player: { getPlaying() { return { track: { id, name, artists }, playing: true }; } },
  nm: { w: { gi8O: Object.assign(function Player() {}, { fa6K: { cx2e: { id: stateId, playUrl: url } } }) } }
});

function read(window = fixture(), href = 'https://music.163.com/#/my/m/music/playlist?id=7106006414', diagnostics = false) {
  assert.equal(typeof api.readNeteasePlayback, 'function', 'implement the serialized playback reader');
  const location = new URL(href);
  // A fresh realm is essential: executeScript serializes the function without
  // the module's helpers, imports, or lexical closure.
  return JSON.parse(JSON.stringify(vm.runInNewContext(`(${api.readNeteasePlayback.toString()})(${diagnostics})`, { window, location, URL }, { timeout: 1000 })));
}

test('diagnostics distinguish missing player, mismatched IDs, rejected URLs and usable bindings', () => {
  const diagnostic = window => read(window, 'https://music.163.com/', true);
  assert.equal(diagnostic({}).diagnostic.reason, 'no-getPlaying');
  assert.equal(diagnostic(fixture({ name: '' })).diagnostic.reason, 'invalid-track');
  const switched = diagnostic(fixture({ stateId: 456 }));
  assert.deepEqual(switched.bindings, []);
  assert.equal(switched.diagnostic.states[0].stateId, '456');
  assert.equal(switched.diagnostic.states[0].reason, 'state-id-mismatch');
  const rejected = diagnostic(fixture({ url: 'blob:https://music.163.com/id' }));
  assert.equal(rejected.diagnostic.states[0].reason, 'invalid-media-url');
  const valid = diagnostic(fixture());
  assert.equal(valid.diagnostic.reason, 'binding-found');
  assert.equal(valid.diagnostic.trackId, '123');
  assert.equal(valid.diagnostic.states[0].playURL, signedURL);
  assert.deepEqual(valid.bindings, read());
});

test('diagnostic state errors cannot copy signed URLs through free-form strings', () => {
  const window = fixture();
  Object.assign(window.nm.w.gi8O.fa6K.cx2e, {
    error: 'https://m10.music.126.net/a.m4a?token=privateValue',
    mediaType: 'audio', loadState: 2, Fj8W: false
  });
  const value = read(window, 'https://music.163.com/', true).diagnostic.states[0];
  assert.equal(value.error, 'other');
  assert.equal(value.mediaType, 'audio');
  assert.equal(value.loadState, 2);
  assert.equal(value.Fj8W, false);
  assert.doesNotMatch(JSON.stringify(value), /privateValue/);
});

test('the serialized reader joins a detached player URL to its exact song ID', () => {
  assert.deepEqual(read(), [{ url: signedURL, title: '晴天', artist: '示例歌手', trackId: '123' }]);
});

test('song metadata normalizes whitespace and combines multiple artists', () => {
  assert.deepEqual(read(fixture({ name: '  中文\n歌曲  ', artists: [{ name: '甲' }, { name: ' 乙 ' }] }))[0],
    { url: signedURL, title: '中文 歌曲', artist: '甲 / 乙', trackId: '123' });
});

test('a song switch cannot give the new title to the previous source', () => {
  assert.deepEqual(read(fixture({ id: 124, stateId: 123, name: '下一首' })), []);
  assert.deepEqual(read(fixture({ url: '' })), []);
});

test('only valid positive integer IDs can establish a song association', () => {
  for (const id of ['', 0, -1, NaN, {}, true, '123other', '1e3', 1.2]) assert.deepEqual(read(fixture({ id })), []);
  assert.equal(read(fixture({ stateId: '123' }))[0].trackId, '123');
  assert.deepEqual(read(fixture({ stateId: '0123' })), []);
});

test('only the exact NetEase web origin can request player metadata', () => {
  for (const href of ['https://other.test/', 'https://music.163.com.evil.test/', 'https://163.com/', 'https://sub.music.163.com/', 'ftp://music.163.com/']) {
    assert.deepEqual(read(fixture(), href), [], href);
  }
  assert.equal(read(fixture(), 'http://music.163.com/')[0].title, '晴天');
});

test('the reader rejects nonaudio URLs, other hosts, credentials, and fragments', () => {
  for (const url of ['https://evil.test/track.m4a', 'https://m10.music.126.net.evil.test/track.m4a',
    'https://user:secret@m10.music.126.net/track.m4a', 'blob:https://music.163.com/id',
    'https://music.163.com/song?id=123', 'https://music.163.com/api/song/detail?id=123',
    'https://m10.music.126.net/playlist.m3u8', 'https://m10.music.126.net/part.m4s']) {
    assert.deepEqual(read(fixture({ url })), [], url);
  }
  assert.equal(read(fixture({ url: signedURL + '#t=2' }))[0].url, signedURL);
  assert.equal(read(fixture({ url: 'https://m1.music.163.com/track.mp3?token=a%2Bb' }))[0].url,
    'https://m1.music.163.com/track.mp3?token=a%2Bb');
  assert.equal(read(fixture({ url: 'https://music.163.com/track.mp3' }))[0].url, 'https://music.163.com/track.mp3');
});

test('no player initialization, private methods, or unknown getters run', () => {
  const window = fixture();
  let calls = 0;
  window.nm.w.gi8O.fI4S = () => { throw new Error('must not initialize a player'); };
  Object.defineProperty(window.nm.w, 'hostile', { get() { calls++; throw new Error('getter'); } });
  Object.defineProperty(window.nm.w.gi8O, 'hostile', { get() { calls++; throw new Error('getter'); } });
  Object.defineProperty(window.nm.w.gi8O.fa6K, 'hostile', { get() { calls++; throw new Error('getter'); } });
  assert.equal(read(window)[0].title, '晴天');
  assert.equal(calls, 0);
});

test('metadata and namespace getters are not evaluated', () => {
  let calls = 0;
  for (const key of ['player', 'nm']) {
    const window = fixture();
    Object.defineProperty(window, key, { get() { calls++; throw new Error('getter'); } });
    assert.deepEqual(read(window), []);
  }
  const window = fixture();
  Object.defineProperty(window.player, 'getPlaying', { get() { calls++; throw new Error('getter'); } });
  assert.deepEqual(read(window), []);
  assert.equal(calls, 0);
});

test('a hostile function call property cannot run a getter', () => {
  const window = fixture();
  let calls = 0;
  Object.defineProperty(window.player.getPlaying, 'call', { get() { calls++; throw new Error('getter'); } });
  assert.equal(read(window)[0]?.title, '晴天');
  assert.equal(calls, 0);
});

test('fallback discovers renamed existing singleton fields without getters', () => {
  const window = fixture();
  const old = window.nm.w.gi8O.fa6K;
  window.nm.w = { renamedClass: Object.assign(function ExistingPlayer() {}, { renamedSingleton: { renamedState: old.cx2e } }) };
  let calls = 0;
  Object.defineProperty(window.nm.w.renamedClass, 'hostile', { enumerable: true, get() { calls++; } });
  assert.equal(read(window)[0].title, '晴天');
  assert.equal(calls, 0);
});

test('fallback remains inside bounded namespace, class, singleton, and state layers', () => {
  const window = fixture();
  const source = window.nm.w.gi8O;
  window.nm.w = {};
  for (let index = 0; index < 1000; index++) window.nm.w['Class' + index] = function Empty() {};
  window.nm.w.tooLate = source;
  window.outsideNamespace = source;
  assert.deepEqual(read(window), []);
  window.nm.w = { tooDeep: Object.assign(function Deep() {}, { singleton: { one: { two: source.fa6K.cx2e } } }) };
  assert.deepEqual(read(window), []);
});

test('missing or unavailable playback information safely returns an empty result', () => {
  assert.deepEqual(read({}), []);
  const window = fixture();
  window.player.getPlaying = () => { throw new Error('site not ready'); };
  assert.deepEqual(read(window), []);
  assert.deepEqual(read(fixture({ name: '' })), []);
  assert.deepEqual(read(fixture({ artists: [] }))[0].artist, '');
});

test('URL helpers restrict the page and match complete observed URLs without rewriting signatures', () => {
  assert.equal(typeof api.isNeteasePageURL, 'function');
  assert.equal(typeof api.matchingNeteasePlaybackURL, 'function');
  assert.equal(api.isNeteasePageURL('https://music.163.com/#/my/m/music/playlist?id=7106006414'), true);
  for (const value of ['https://evil.test/', 'https://music.163.com.evil.test/', 'ftp://music.163.com/', null]) {
    assert.equal(api.isNeteasePageURL(value), false);
  }
  assert.equal(api.matchingNeteasePlaybackURL(signedURL + '#t=2', signedURL), true);
  assert.equal(api.matchingNeteasePlaybackURL(signedURL.replace('a%2Bb', 'other'), signedURL), false);
  assert.equal(api.matchingNeteasePlaybackURL(signedURL.replace('m804.', 'm10.'), signedURL), false);
  assert.equal(api.matchingNeteasePlaybackURL('blob:https://music.163.com/id', signedURL), false);
});

test('QuickTime exceptions require a NetEase CDN .m4a response and still require separate player proof', () => {
  const check = api.needsNeteaseM4APlaybackProof;
  assert.equal(typeof check, 'function');
  assert.equal(check(signedURL, 'video/quicktime;charset=UTF-8'), true);
  for (const url of [signedURL.replace('.m4a', '.mp4'), signedURL.replace('.m4a', '.mov'),
    signedURL.replace('m804.music.126.net', 'other.test'), signedURL.replace('m804.music.126.net', 'm804.music.126.net.evil.test'),
    signedURL.replace('https://', 'https://user:secret@'), 'blob:https://music.163.com/id']) {
    assert.equal(check(url, 'video/quicktime'), false, url);
  }
  for (const mime of ['video/mp4', 'text/html', 'video/webm', '']) assert.equal(check(signedURL, mime), false);
});
