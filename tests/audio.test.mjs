import test from "node:test";
import assert from "node:assert/strict";
import "../extension/lib/audio.js";
const A = globalThis.AudioTools;

test("relative URLs resolve; signed queries survive; fragments deduplicate", () => {
  assert.equal(A.normalizeURL("../sound.mp3?token=a%2Bb&x=1#t=20", "https://example.com/path/page"), "https://example.com/sound.mp3?token=a%2Bb&x=1");
  for (const url of ["javascript:alert(1)", "blob:https://a/id", "data:audio/wav,abc", "https://user:password@example.com/a.mp3"]) assert.equal(A.normalizeURL(url), null);
});

test("detect real audio, binary filename hints, and extensionless MIME responses", () => {
  assert.equal(A.isAudioURL("https://a/file.MP3?sig=1"), true);
  assert.equal(A.isAudioURL("https://a/endpoint", "audio/wav; charset=binary"), true);
  assert.equal(A.isAudioURL("https://a/endpoint?format=flac"), true);
  assert.equal(A.isAudioURL("https://a/endpoint", "application/octet-stream", "歌.wav"), true);
  assert.equal(A.isAudioURL("https://a/file.mp3", "text/html"), false);
  for (const [url, mime] of [["https://a/video.mp4", "video/mp4"], ["https://a/stream.m3u8", "audio/x-mpegurl"], ["https://a/fragment.m4s", "audio/mp4"], ["https://a/part.ts", "audio/aac"], ["https://a/stream", "audio/x-scpls"]]) assert.equal(A.isAudioURL(url, mime), false);
});

test("Content-Disposition Unicode filenames and unsafe paths are handled", () => {
  assert.equal(A.dispositionFilename("attachment; filename*=UTF-8''%E6%B5%8B%E8%AF%95.wav"), "测试.wav");
  assert.equal(A.dispositionFilename('inline; filename="track.mp3"'), "track.mp3");
  const item = A.candidate({ url: "https://a/audio", mime: "audio/mpeg", disposition: 'attachment; filename="../../NUL.exe"' });
  assert.ok(item.filename.endsWith(".mp3"));
  assert.ok(!/[\\/:*?"<>|]/.test(item.filename));
  assert.equal(A.sanitizeFilename("NUL.wav"), "_NUL.wav");
  assert.equal(A.candidate({ url: "https://a/attachment", filenameHint: "提示音.wav" }).format, "WAV");
});

test("range responses use total file size; invalid sizes remain unknown", () => {
  assert.equal(A.responseSize([{ name: "CONTENT-RANGE", value: "bytes 0-1023/12345" }, { name: "Content-Length", value: "1024" }]), 12345);
  assert.equal(A.responseSize([{ name: "Content-Length", value: "NaN" }]), null);
});

test("network metadata enriches one page record without losing its display title", () => {
  const page = A.candidate({ url: "https://a/audio.wav#one", title: "提示音", source: "page" });
  const network = A.candidate({ url: "https://a/audio.wav", mime: "audio/wav", size: 44144, source: "network", verified: true });
  const merged = A.merge(page, network);
  assert.equal(merged.url, page.url);
  assert.equal(merged.title, "提示音");
  assert.equal(merged.size, 44144);
  assert.equal(merged.verified, true);
  assert.equal(merged.source, "network");
});

// These cases catch URL-first naming, unfiltered action captions, and treating
// a document title as if it were metadata for every individual audio file.
test("audio-specific names win over opaque URL and response filenames", () => {
  const cases = [
    { raw: { title: "晴天 - 示例歌手" }, want: "晴天 - 示例歌手.mp3" },
    { raw: { title: "夜曲", disposition: 'attachment; filename="8e3ab817d9017f6f4feadbca.mp3"' }, want: "夜曲.mp3" },
    { raw: { title: "Play It Again", titleSource: "link" }, want: "Play It Again.mp3" }
  ];
  for (const { raw, want } of cases) {
    assert.equal(A.candidate({ url: "https://a/5f8b19e47bcd43ac91ee2d69d2c707c8.mp3", ...raw }).filename, want);
  }
});

test("generic captions and opaque server filenames fall back to the page title", () => {
  for (const title of ["播放", "下载音频", "点击下载", "Download", "Listen", "5f8b19e47bcd43ac91ee2d69d2c707c8"]) {
    const item = A.candidate({ url: "https://a/5f8b19e47bcd43ac91ee2d69d2c707c8.mp3", title,
      pageTitle: "声音课堂 · 第一讲", disposition: 'inline; filename="8e3ab817d9017f6f4feadbca.mp3"' });
    assert.equal(item.filename, "声音课堂 · 第一讲.mp3", title);
  }
});

test("readable file hints precede link captions and page fallback", () => {
  const cases = [
    { raw: { filenameHint: "提示音.wav", title: "带 download 文件名的链接", titleSource: "link" }, want: "提示音.wav" },
    { raw: { disposition: 'inline; filename="lecture-01.wav"', title: "播放" }, want: "lecture-01.wav" },
    { raw: { disposition: 'inline; filename="%E7%AC%AC%E4%B8%80%E8%AE%B2.wav"' }, want: "第一讲.wav" }
  ];
  for (const { raw, want } of cases) {
    assert.equal(A.candidate({ url: "https://a/endpoint", mime: "audio/wav", pageTitle: "音频列表", ...raw }).filename, want);
  }
  assert.equal(A.candidate({ url: "https://a/lecture-01.wav", pageTitle: "音频列表" }).filename, "lecture-01.wav");
});

test("extensionless audio endpoints use a page fallback with the real format", () => {
  assert.equal(A.candidate({ url: "https://a/audio-endpoint", mime: "audio/wav", pageTitle: "声音课堂" }).filename, "声音课堂.wav");
});

test("weak repeated reports cannot replace a player's specific title", () => {
  const player = A.candidate({ url: "https://a/5f8b19e47bcd43ac91ee2d69d2c707c8.mp3", title: "夜曲 - 示例歌手", titleSource: "media" });
  const link = A.candidate({ url: player.url, title: "试听夜曲", titleSource: "link", pageTitle: "音乐合集" });
  assert.equal(A.merge(player, link).filename, "夜曲 - 示例歌手.mp3");
  assert.equal(A.merge(link, player).filename, "夜曲 - 示例歌手.mp3");
});

test("an unknown title retains the original filename without inventing a song name", () => {
  const hash = "5f8b19e47bcd43ac91ee2d69d2c707c8";
  assert.equal(A.candidate({ url: `https://a/${hash}.mp3` }).filename, `${hash}.mp3`);
});

test("an extensionless native audio element keeps its title when network format arrives", () => {
  const page = A.candidate({ url: "https://a/playback/123", fromAudioElement: true, source: "page", title: "远方" });
  assert.equal(page?.filename, "远方");
  const network = A.candidate({ url: "https://a/playback/123", mime: "audio/wav", source: "network", verified: true });
  assert.equal(A.merge(page, network).filename, "远方.wav");
  assert.equal(A.candidate({ url: "https://a/playlist", mime: "audio/x-mpegurl", fromAudioElement: true, source: "page" }), null);
});

test("an empty player source never treats its containing HTML page as audio", () => {
  for (const url of ["", " ", "\n\t"]) {
    assert.equal(A.candidate({ url, fromAudioElement: true, source: "page", pageTitle: "歌曲列表" }, "https://a/music"), null);
  }
});

test("script and binary suffixes do not disguise generic or opaque filenames", () => {
  const cases = [
    { url: "https://a/download.php" },
    { url: "https://a/endpoint", disposition: 'inline; filename="5f8b19e47bcd43ac91ee2d69d2c707c8.bin"' },
    { url: "https://a/stream.ashx" }
  ];
  for (const raw of cases) {
    assert.equal(A.candidate({ ...raw, mime: "audio/mpeg", pageTitle: "星河 - 示例歌手" }).filename, "星河 - 示例歌手.mp3");
  }
  assert.equal(A.candidate({ url: "https://a/download.php", mime: "audio/mpeg", title: "Vol.1" }).filename, "Vol.1.mp3");
});

test("a name attached to the audio itself corrects inferred global player metadata", () => {
  const global = A.candidate({ url: "https://a/bell.mp3", title: "歌曲 A - 歌手 A", titleSource: "media" });
  const own = A.candidate({ url: global.url, title: "通知提示音", titleSource: "element" });
  assert.equal(A.merge(global, own).filename, "通知提示音.mp3");
});

test("a matching player can add an artist without losing it on a later element scan", () => {
  const element = A.candidate({ url: "https://a/track.wav", title: "远方", titleSource: "element" });
  const player = A.candidate({ url: element.url, title: "远方", artist: "示例歌手", titleSource: "element" });
  const enriched = A.merge(element, player);
  assert.equal(enriched.filename, "远方 - 示例歌手.wav");
  assert.equal(A.merge(enriched, element).filename, "远方 - 示例歌手.wav");
  const corrected = A.candidate({ url: element.url, title: "另一首歌", titleSource: "element" });
  assert.equal(A.merge(enriched, corrected).filename, "另一首歌.wav");
});

// Grouping follows the winning name, independently of response verification.
test("audio-specific titles record the selected element, media or link source", () => {
  for (const titleSource of ["element", "media", "link"]) {
    const item = A.candidate({ url: "https://a/5f8b19e47bcd43ac91ee2d69d2c707c8.mp3",
      title: "远方", artist: "示例歌手", titleSource, pageTitle: "音乐合集", verified: false });
    assert.equal(item.filename, "远方 - 示例歌手.mp3");
    assert.equal(item.nameSource, titleSource);
    assert.equal(item.nameRecognized, true);
  }
});

test("readable filename evidence records download, disposition, query or path provenance", () => {
  const cases = [
    { raw: { url: "https://a/endpoint", filenameHint: "提示音.wav", title: "下载链接", titleSource: "link" }, filename: "提示音.wav", source: "download" },
    { raw: { url: "https://a/endpoint", disposition: 'inline; filename="lecture-01.wav"' }, filename: "lecture-01.wav", source: "disposition" },
    { raw: { url: "https://a/endpoint?filename=%E7%AC%AC%E4%B8%80%E8%AE%B2.wav" }, filename: "第一讲.wav", source: "query" },
    { raw: { url: "https://a/endpoint?file=lecture-02.wav" }, filename: "lecture-02.wav", source: "query" },
    { raw: { url: "https://a/endpoint?name=lecture-03.wav" }, filename: "lecture-03.wav", source: "query" },
    { raw: { url: "https://a/endpoint?download=lecture-04.wav" }, filename: "lecture-04.wav", source: "query" },
    { raw: { url: "https://a/lecture-05.wav" }, filename: "lecture-05.wav", source: "path" }
  ];
  for (const { raw, filename, source } of cases) {
    const item = A.candidate({ mime: "audio/wav", pageTitle: "声音课堂", ...raw });
    assert.equal(item.filename, filename);
    assert.equal(item.nameSource, source);
    assert.equal(item.nameRecognized, true);
  }
});

test("page fallbacks and opaque or generic filenames remain unrecognized even after verification", () => {
  const cases = [
    { raw: { url: "https://a/5f8b19e47bcd43ac91ee2d69d2c707c8.mp3", pageTitle: "音乐合集" }, filename: "音乐合集.mp3", source: "page" },
    { raw: { url: "https://a/5f8b19e47bcd43ac91ee2d69d2c707c8.mp3" }, filename: "5f8b19e47bcd43ac91ee2d69d2c707c8.mp3", source: "path" },
    { raw: { url: "https://a/123456789.mp3" }, filename: "123456789.mp3", source: "path" },
    { raw: { url: "https://a/audio.mp3", title: "播放" }, filename: "audio.mp3", source: "path" },
    { raw: { url: "https://a/", mime: "audio/mpeg" }, filename: "音频.mp3", source: "fallback" }
  ];
  for (const { raw, filename, source } of cases) {
    const item = A.candidate({ verified: true, ...raw });
    assert.equal(item.filename, filename);
    assert.equal(item.nameSource, source);
    assert.equal(item.nameRecognized, false);
    assert.equal(item.verified, true);
  }
});

test("merge recomputes provenance when better names arrive and preserves a stronger title", () => {
  const initial = A.candidate({ url: "https://a/5f8b19e47bcd43ac91ee2d69d2c707c8.mp3", pageTitle: "音乐合集" });
  const server = A.candidate({ url: initial.url, disposition: 'inline; filename="远方.mp3"', source: "network", verified: true });
  const named = A.merge(initial, server);
  assert.equal(named.filename, "远方.mp3");
  assert.equal(named.nameSource, "disposition");
  assert.equal(named.nameRecognized, true);
  const player = A.candidate({ url: initial.url, title: "播放器中的远方", titleSource: "element" });
  const merged = A.merge(A.merge(named, player), initial);
  assert.equal(merged.filename, "播放器中的远方.mp3");
  assert.equal(merged.nameSource, "element");
  assert.equal(merged.nameRecognized, true);
});

test("legacy cache naming is recalculated from evidence rather than old filename or flags", () => {
  assert.equal(typeof A.namingFor, "function");
  const legacy = { url: "https://a/5f8b19e47bcd43ac91ee2d69d2c707c8.mp3", pageTitle: "声音课堂",
    filename: "过时歌曲名.mp3", verified: true, nameRecognized: true, nameSource: "element" };
  assert.deepEqual(A.namingFor(legacy), { filename: "声音课堂.mp3", nameSource: "page", nameRecognized: false });
  assert.equal(A.filenameFor(legacy), "声音课堂.mp3");
  assert.deepEqual(A.namingFor({ url: "https://a/lecture-01.wav", verified: false }),
    { filename: "lecture-01.wav", nameSource: "path", nameRecognized: true });
});

test('NetEase object filenames stay unchanged while awaiting a real song title', () => {
  const filename = 'obj_w5rDlsOJwrLDjj7Cm.m4a';
  const item = A.candidate({ url: `https://m804.music.126.net/media/${filename}`, verified: true, pageTitle: '网易云音乐' });
  assert.equal(item.filename, filename);
  assert.equal(item.nameRecognized, false);
  assert.equal(item.verified, true);
  const named = A.merge(item, A.candidate({ url: item.url, title: '补全的中文歌', artist: '示例歌手', titleSource: 'media' }));
  assert.equal(named.filename, '补全的中文歌 - 示例歌手.m4a');
  assert.equal(named.nameRecognized, true);
});

test('object IDs in filename hints are unrecognized without weakening actual player titles', () => {
  const filename = 'obj_wonDkMOGw6XDiTrandom.m4a';
  for (const raw of [{ url: 'https://m10.music.126.net/audio', filenameHint: filename },
    { url: 'https://m10.music.126.net/audio', disposition: `inline; filename="${filename}"` },
    { url: `https://m10.music.126.net/audio?filename=${filename}` }]) {
    const item = A.candidate({ ...raw, mime: 'audio/mp4' });
    assert.equal(item.filename, filename);
    assert.equal(item.nameRecognized, false);
  }
  const title = A.candidate({ url: 'https://example.test/track.m4a', title: 'obj_这是一首真实的歌', titleSource: 'element' });
  assert.equal(title.filename, 'obj_这是一首真实的歌.m4a');
  assert.equal(title.nameRecognized, true);
});
