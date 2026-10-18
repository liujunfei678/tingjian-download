import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DIAGNOSTIC_KEY = "neteaseDiagnostics";
const EXTENSION_ID = "lncnlaidcmglpbnfmikaocnhocjifghn";
const BLOCK_SIZE = 32768;
const KEY_BYTES = Buffer.from(DIAGNOSTIC_KEY);
const MAX_RECORD_SIZE = 64 * 1024 * 1024;

function diagnosticEntries(batch) {
  if (batch.length < 12) return [];
  const sequence = batch.readBigUInt64LE(0);
  const count = batch.readUInt32LE(8);
  if (count > 1000000 || count > batch.length - 12) return [];
  let offset = 12;
  const entries = [];
  const field = () => {
    let length = 0;
    for (let shift = 0; shift <= 28; shift += 7) {
      if (offset >= batch.length) throw new Error("truncated varint");
      const byte = batch[offset++];
      if (shift === 28 && (byte & 0xf0)) throw new Error("oversized varint");
      length += (byte & 127) * (2 ** shift);
      if (!(byte & 128)) {
        if (length > batch.length - offset) throw new Error("truncated field");
        const value = batch.subarray(offset, offset + length);
        offset += length;
        return value;
      }
    }
    throw new Error("invalid varint");
  };
  try {
    for (let index = 0; index < count; index++) {
      if (offset >= batch.length) return [];
      const tag = batch[offset++];
      if (tag !== 0 && tag !== 1) return [];
      const key = field();
      const value = tag === 1 ? field() : null;
      if (key.equals(KEY_BYTES)) {
        entries.push({
          sequence: sequence + BigInt(index),
          value: value === null ? null : JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value)),
          deleted: tag === 0,
        });
      }
    }
  } catch { return []; }
  // A WriteBatch is atomic; never accept a partially decoded or corrupt batch.
  return offset === batch.length ? entries : [];
}

export function parseNeteaseDiagnosticsLog(bytes) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  const entries = [];
  let offset = 0;
  let fragments = null;
  let fragmentSize = 0;
  const reset = () => { fragments = null; fragmentSize = 0; };
  while (offset + 7 <= bytes.length) {
    const blockRemaining = BLOCK_SIZE - (offset % BLOCK_SIZE);
    if (blockRemaining < 7) { offset += blockRemaining; continue; }
    const length = bytes.readUInt16LE(offset + 4);
    const type = bytes[offset + 6];
    if (length === 0 && type === 0) { offset += blockRemaining; reset(); continue; }
    if (length + 7 > blockRemaining) { offset += blockRemaining; reset(); continue; }
    if (offset + 7 + length > bytes.length) break; // The open log may have an unfinished final write.
    const expectedChecksum = bytes.readUInt32LE(offset);
    const data = bytes.subarray(offset + 7, offset + 7 + length);
    offset += 7 + length;
    if (type < 1 || type > 4 || expectedChecksum !== maskChecksum(crc32c(Buffer.concat([Buffer.from([type]), data])))) {
      reset();
      continue;
    }
    if (type === 1) {
      reset();
      entries.push(...diagnosticEntries(data));
    } else if (type === 2) {
      fragments = [data];
      fragmentSize = data.length;
    } else if (fragments) {
      fragments.push(data);
      fragmentSize += data.length;
      if (fragmentSize > MAX_RECORD_SIZE) { reset(); continue; }
      if (type === 4) {
        entries.push(...diagnosticEntries(Buffer.concat(fragments, fragmentSize)));
        reset();
      }
    }
  }
  return entries;
}

function crc32c(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0x82f63b78 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function maskChecksum(checksum) {
  return (((checksum >>> 15) | (checksum << 17)) + 0xa282ead8) >>> 0;
}

function selfTest() {
  let assertions = 0;
  const equal = (actual, expected) => { assert.deepEqual(actual, expected); assertions++; };
  const varint = value => {
    const bytes = [];
    do { bytes.push((value & 127) | (value > 127 ? 128 : 0)); value >>>= 7; } while (value);
    return Buffer.from(bytes);
  };
  const field = value => {
    const bytes = Buffer.from(value);
    return Buffer.concat([varint(bytes.length), bytes]);
  };
  const put = (key, value) => Buffer.concat([Buffer.from([1]), field(key), field(JSON.stringify(value))]);
  const del = key => Buffer.concat([Buffer.from([0]), field(key)]);
  const batch = (sequence, entries) => {
    const header = Buffer.alloc(12);
    header.writeBigUInt64LE(BigInt(sequence), 0);
    header.writeUInt32LE(entries.length, 8);
    return Buffer.concat([header, ...entries]);
  };
  const physical = (type, data) => {
    const header = Buffer.alloc(7);
    header.writeUInt32LE(maskChecksum(crc32c(Buffer.concat([Buffer.from([type]), data]))), 0);
    header.writeUInt16LE(data.length, 4);
    header[6] = type;
    return Buffer.concat([header, data]);
  };
  const full = (sequence, entries) => physical(1, batch(sequence, entries));
  equal(crc32c(Buffer.from("123456789")), 0xe3069283);
  const expected = { sequence: 8n, value: { reason: "matched", title: "爱一点" }, deleted: false };
  const complete = full(7, [put("unrelated", { mustNotAppear: true }), put(DIAGNOSTIC_KEY, expected.value)]);
  equal(parseNeteaseDiagnosticsLog(complete), [expected]);
  equal(parseNeteaseDiagnosticsLog(full(9, [put("unrelated", "ignored")])), []);
  equal(parseNeteaseDiagnosticsLog(full(10, [del(DIAGNOSTIC_KEY)])), [{ sequence: 10n, value: null, deleted: true }]);
  equal(parseNeteaseDiagnosticsLog(complete.subarray(0, complete.length - 1)), []);
  const corrupt = Buffer.from(complete);
  corrupt[corrupt.length - 1] ^= 1;
  equal(parseNeteaseDiagnosticsLog(corrupt), []);
  const longValue = { reason: "a".repeat(BLOCK_SIZE * 2), title: "Only One" };
  const longBatch = batch(20, [put(DIAGNOSTIC_KEY, longValue)]);
  const capacity = BLOCK_SIZE - 7;
  const fragmented = Buffer.concat([
    physical(2, longBatch.subarray(0, capacity)),
    physical(3, longBatch.subarray(capacity, capacity * 2)),
    physical(4, longBatch.subarray(capacity * 2)),
  ]);
  equal(parseNeteaseDiagnosticsLog(fragmented), [{ sequence: 20n, value: longValue, deleted: false }]);
  equal(parseNeteaseDiagnosticsLog(fragmented.subarray(0, fragmented.length - 1)), []);
  equal(parseNeteaseDiagnosticsLog(physical(3, longBatch.subarray(0, 20))), []);
  const trailingBatch = batch(30, [put(DIAGNOSTIC_KEY, { reason: "after-trailer" })]);
  const initial = full(29, [put("unrelated", "x".repeat(BLOCK_SIZE - 7 - 12 - 1 - 10 - 3 - 5))]);
  const padded = Buffer.concat([initial, Buffer.alloc(BLOCK_SIZE - initial.length), physical(1, trailingBatch)]);
  equal(parseNeteaseDiagnosticsLog(padded), [{ sequence: 30n, value: { reason: "after-trailer" }, deleted: false }]);
  const malformedBatch = batch(40, [put(DIAGNOSTIC_KEY, { shouldNotSurviveMalformedBatch: true }), Buffer.from([2])]);
  equal(parseNeteaseDiagnosticsLog(physical(1, malformedBatch)), []);
  const invalidJson = Buffer.concat([Buffer.from([1]), field(DIAGNOSTIC_KEY), field("{not json}")]);
  equal(parseNeteaseDiagnosticsLog(physical(1, batch(41, [invalidJson]))), []);
  const oversizedVarint = Buffer.from([1, 0xff, 0xff, 0xff, 0xff, 0xff]);
  equal(parseNeteaseDiagnosticsLog(physical(1, batch(42, [oversizedVarint]))), []);
  equal(parseNeteaseDiagnosticsLog(Buffer.concat([corrupt, full(43, [put(DIAGNOSTIC_KEY, { reason: "recovered" })])])), [
    { sequence: 43n, value: { reason: "recovered" }, deleted: false },
  ]);
  equal(parseNeteaseDiagnosticsLog(full(44, [put(DIAGNOSTIC_KEY, { reason: "old" }), del(DIAGNOSTIC_KEY)])), [
    { sequence: 44n, value: { reason: "old" }, deleted: false },
    { sequence: 45n, value: null, deleted: true },
  ]);
  equal(parseNeteaseDiagnosticsLog(Buffer.alloc(0)), []);
  process.stdout.write(`${JSON.stringify({ selfTest: "passed", assertions })}\n`);
}

async function main() {
  if (process.argv[2] === "--self-test" && process.argv.length === 3) return selfTest();
  if (process.argv.length !== 2) throw new Error("仅支持默认读取或 --self-test。");
  if (!process.env.LOCALAPPDATA) throw new Error("未找到当前 Windows 用户的本地应用目录。");
  const directory = path.join(process.env.LOCALAPPDATA, "Microsoft", "Edge", "User Data", "Default", "Local Extension Settings", EXTENSION_ID);
  let files;
  try { files = await readdir(directory); } catch (error) {
    if (error.code === "ENOENT") { process.stdout.write("null\n"); return; }
    throw new Error("无法读取听见扩展的自有诊断目录。");
  }
  let latest;
  for (const filename of files.filter(name => /^\d+\.log$/.test(name)).sort()) {
    let bytes;
    try { bytes = await readFile(path.join(directory, filename)); } catch (error) {
      if (error.code === "ENOENT") continue;
      throw new Error("无法读取听见扩展的自有诊断日志。");
    }
    for (const entry of parseNeteaseDiagnosticsLog(bytes)) {
      if (!latest || entry.sequence >= latest.sequence) latest = entry;
    }
  }
  process.stdout.write(`${JSON.stringify(latest?.deleted ? null : (latest?.value ?? null), null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
