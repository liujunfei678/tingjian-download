import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile, readdir, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildConverter, findExecutable } from "../scripts/build-converter.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixture = path.join(root, "test-results", `converter-${Date.now()}`);
const inputs = path.join(fixture, "inputs");
const { ffmpeg, csc } = await buildConverter({ archive: false });
const ffprobe = process.env.FFPROBE_PATH || findExecutable("ffprobe.exe");

function run(executable, args) {
  const result = spawnSync(executable, args, { encoding: "utf8", windowsHide: true, timeout: 120000 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
}

async function audio(relative, codec, extra = []) {
  const file = path.join(inputs, relative);
  await mkdir(path.dirname(file), { recursive: true });
  run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-nostdin", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2", "-c:a", codec, ...extra, file]);
  return file;
}

await mkdir(inputs, { recursive: true });
const chinese = await audio("中文 & 空格/现场 & 笔记 (一).m4a", "aac", ["-ac", "2", "-metadata", "title=夏日练习", "-metadata", "artist=听见", "-metadata", "album=转换测试"]);
await audio("one/同名.M4A", "aac");
await audio("two/同名.m4a", "alac", ["-ar", "96000"]);
await audio("正常尾项.m4a", "aac");
await writeFile(path.join(inputs, "坏文件.m4a"), "this is not audio", "utf8");
await writeFile(path.join(inputs, "忽略.txt"), "ignored", "utf8");
run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-nostdin", "-f", "lavfi", "-i", "color=c=black:s=16x16:d=0.5", "-an", "-c:v", "mpeg4", "-f", "mp4", path.join(inputs, "无音轨.m4a")]);
run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-nostdin", "-stream_loop", "899", "-i", chinese, "-c", "copy", path.join(fixture, "long.m4a")]);
await copyFile(chinese, path.join(fixture, "deleted.m4a"));

async function sourceHashes(folder) {
  const files = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const file = path.join(folder, entry.name);
    if (entry.isDirectory()) files.push(...await sourceHashes(file));
    else files.push([file, createHash("sha256").update(await readFile(file)).digest("hex")]);
  }
  return files;
}
const before = await sourceHashes(inputs);
const harness = path.join(fixture, "converter-tests.exe");
run(csc, ["/nologo", "/target:exe", "/platform:x64", "/codepage:65001", "/main:ConverterTests", `/out:${harness}`,
  "/reference:System.dll", "/reference:System.Core.dll", "/reference:System.Drawing.dll", "/reference:System.Windows.Forms.dll",
  path.join(root, "converter", "ConverterCore.cs"), path.join(root, "converter", "MainForm.cs"), path.join(root, "tests", "ConverterTests.cs")]);
process.stdout.write(run(harness, [ffmpeg, fixture]));
assert.deepEqual(await sourceHashes(inputs), before, "Source files changed after conversion");

function probe(file) {
  return JSON.parse(run(ffprobe, ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name,sample_rate,channels,bit_rate:format=duration:format_tags=title,artist,album", "-of", "json", file]));
}

const converted = (await readFile(path.join(fixture, "verified-outputs.txt"), "utf8")).trim().split(/\r?\n/);
for (const file of converted) {
  const data = probe(file);
  assert.equal(data.streams[0].codec_name, "mp3");
  assert.equal(data.streams[0].sample_rate, "44100");
  assert.equal(data.streams[0].channels, 2);
  assert.equal(data.streams[0].bit_rate, "320000");
  assert.ok(Number(data.format.duration) >= 1.9 && Number(data.format.duration) < 2.2);
  run(ffmpeg, ["-v", "error", "-nostdin", "-i", file, "-f", "null", "-"]);
}
const tags = probe(converted.find(file => file.includes("现场"))).format.tags;
assert.equal(tags.title, "夏日练习");
assert.equal(tags.artist, "听见");
assert.equal(tags.album, "转换测试");
for (const bitrate of [128, 192, 256, 320]) {
  const file = await readFile(path.join(fixture, `bitrate-${bitrate}.txt`), "utf8");
  assert.equal(Number(probe(file).streams[0].bit_rate), bitrate * 1000);
}
assert.deepEqual((await readFile(path.join(fixture, "report.csv"))).subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]));
process.stdout.write("PASS ffprobe verifies MP3 codec, four bitrates, duration, sample rate, channels and Chinese tags\n");
process.stdout.write("PASS Complete MP3 decode, unchanged source SHA-256 hashes and CSV UTF-8 BOM\n");
process.stdout.write(`验证截图：${path.join(fixture, "converter-complete.png")}\n`);
await writeFile(path.join(root, "test-results", "converter-latest.txt"), fixture, "utf8");
