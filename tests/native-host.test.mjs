import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = path.join(root, 'test-results', `native-host-${Date.now()}`);
let built;
function run(exe, args) {
  const r = spawnSync(exe, args, { encoding: 'utf8', windowsHide: true, timeout: 120000 });
  if (r.error) throw r.error;
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return r.stdout;
}
function frame(value) {
  const data = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4); header.writeUInt32LE(data.length);
  return Buffer.concat([header, data]);
}
function subprocess(exe, args, bytes) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true });
    const output = [], errors = [];
    child.on('error', reject);
    child.stdout.on('data', b => output.push(b)); child.stderr.on('data', b => errors.push(b));
    child.on('exit', code => resolve({ code, output: Buffer.concat(output), errors: Buffer.concat(errors).toString() }));
    child.stdin.on('error', () => {});
    // Exercise short reads without assuming pipe chunk boundaries.
    for (let n = 0; n < bytes.length; n += 3) child.stdin.write(bytes.subarray(n, n + 3));
    child.stdin.end();
  });
}
function decode(buffer) {
  const result = [];
  for (let n = 0; n < buffer.length;) {
    const len = buffer.readUInt32LE(n); n += 4;
    assert.ok(len > 0 && len <= 1024 * 1024);
    result.push(JSON.parse(buffer.subarray(n, n + len).toString('utf8'))); n += len;
  }
  return result;
}

test('native host build and trusted framed subprocess reject malformed boundaries', async () => {
  const { buildNativeHost } = await import('../scripts/build-native-host.mjs');
  built = await buildNativeHost({ archive: false });
  const denied = await subprocess(built.exe, ['chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/'], frame({id:'x',command:'hello'}));
  assert.equal(denied.code, 2); assert.equal(denied.output.length, 0);
  const accepted = await subprocess(built.exe, [built.origin], Buffer.concat([frame({id:'bad',command:'anything'}), frame({id:'hello',command:'hello'})]));
  assert.equal(accepted.code, 0, accepted.errors);
  const messages = decode(accepted.output);
  assert.equal(messages.find(m => m.id === 'bad').ok, false);
  assert.equal(messages.find(m => m.id === 'hello').data.version, '2.0.0');
  assert.ok(messages.find(m => m.id === 'hello').data.defaultDownloadDirectory);
  for (const invalid of [Buffer.from([0,0,0,0]), Buffer.from([1,0,16,0]), Buffer.from([5,0,0,0,123])]) {
    const response = await subprocess(built.exe, [built.origin], invalid);
    assert.equal(response.code, 1); assert.equal(response.output.length, 0);
  }
});

test('native host core protects selected paths and performs persisted AAC/ALAC conversion', async () => {
  if (!built) { const { buildNativeHost } = await import('../scripts/build-native-host.mjs'); built = await buildNativeHost({ archive: false }); }
  await mkdir(path.join(fixture, 'inputs'), { recursive: true });
  for (const [name, codec] of [['中文 & AAC.m4a','aac'],['ALAC.m4a','alac']]) {
    run(built.ffmpeg, ['-v','error','-nostdin','-f','lavfi','-i','sine=frequency=440:duration=2', '-c:a',codec,'-metadata','title=夏日练习',path.join(fixture,'inputs',name)]);
  }
  run(built.ffmpeg, ['-v','error','-nostdin','-stream_loop','899','-i',path.join(fixture,'inputs','中文 & AAC.m4a'),'-c','copy',path.join(fixture,'inputs','long.m4a')]);
  await writeFile(path.join(fixture, 'inputs', 'bad.m4a'), 'not audio');
  const harness = path.join(fixture, 'native-host-tests.exe');
  run(built.csc, ['/nologo','/target:exe','/platform:x64','/codepage:65001','/main:NativeHostTests',`/out:${harness}`, '/reference:System.dll','/reference:System.Core.dll','/reference:System.Windows.Forms.dll','/reference:System.Web.Extensions.dll',path.join(root,'converter','ConverterCore.cs'),path.join(root,'native-host','HostCore.cs'),path.join(root,'tests','native-host-tests.cs')]);
  process.stdout.write(run(harness, [built.ffmpeg, fixture]));
  const outputs = JSON.parse(await readFile(path.join(fixture,'outputs.json'),'utf8'));
  const ffprobe = built.ffmpeg.replace(/ffmpeg\.exe$/i,'ffprobe.exe');
  for (const output of outputs) {
    const result = JSON.parse(run(ffprobe, ['-v','error','-show_entries','stream=codec_name,sample_rate,channels,bit_rate:format_tags=title','-of','json',output]));
    assert.deepEqual(result.streams.map(s => [s.codec_name,s.sample_rate,s.channels,s.bit_rate]), [['mp3','44100',2,'320000']]);
    assert.equal(result.format.tags.title,'夏日练习');
    run(built.ffmpeg, ['-v','error','-nostdin','-i',output,'-f','null','-']);
  }
});

test('test-only native integration adapter retains production path authority', async () => {
  const {buildNativeHostIntegration}=await import('./native-host-integration.mjs');
  const adapter=await buildNativeHostIntegration({fixtureRoot:path.join(fixture,'adapter'),build:built});
  const requests=[{id:'hello',command:'hello'},{id:'pick',command:'chooseDirectory',purpose:'download'}, {id:'open',command:'open',path:path.join(fixture,'anything.exe')}];
  const result=await subprocess(adapter.exe,adapter.args,Buffer.from(requests.map(r=>JSON.stringify(r)).join('\n')+'\n'));
  assert.equal(result.code,0,result.errors);
  const replies=result.output.toString('utf8').replace(/^\uFEFF/,'').trim().split(/\r?\n/).map(line=>JSON.parse(line));
  assert.equal(replies.find(r=>r.id==='pick').data.path,path.join(fixture,'adapter','output'));
  assert.equal(replies.find(r=>r.id==='open').ok,false);
});

test('native setup validates packaged manifests and uninstallation preserves user files without registry access', async () => {
  const folder=path.join(fixture,'setup-cleanup'); await mkdir(folder,{recursive:true});
  const exe=path.join(folder,'setup-tests.exe');
  run(built.csc,['/nologo','/target:exe','/platform:x64','/codepage:65001','/main:NativeSetupTests',`/out:${exe}`,
    '/reference:System.dll','/reference:System.Core.dll','/reference:System.Windows.Forms.dll','/reference:System.Web.Extensions.dll',
    path.join(root,'dist','NativeHostOrigin.cs'),path.join(root,'native-host','Setup.cs'),path.join(root,'tests','native-host-setup-tests.cs')]);
  process.stdout.write(run(exe,[folder]));
});
