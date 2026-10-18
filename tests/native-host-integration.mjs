// Test utility only: deterministic OS-picker dependencies, real production HostService.
import { spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildNativeHost } from '../scripts/build-native-host.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
export async function buildNativeHostIntegration({fixtureRoot,build}={}) {
  if(!fixtureRoot) throw new Error('fixtureRoot is required for isolated native integration tests.');
  const built=build || await buildNativeHost({archive:false});
  await mkdir(fixtureRoot,{recursive:true});
  const exe=path.join(fixtureRoot,'native-host-integration.exe');
  const result=spawnSync(built.csc,['/nologo','/target:exe','/platform:x64','/codepage:65001','/main:NativeHostIntegration',`/out:${exe}`,
    '/reference:System.dll','/reference:System.Core.dll','/reference:System.Windows.Forms.dll','/reference:System.Web.Extensions.dll',
    path.join(root,'converter','ConverterCore.cs'),path.join(root,'native-host','HostCore.cs'),path.join(root,'tests','native-host-integration.cs')],{encoding:'utf8',windowsHide:true});
  if(result.error) throw result.error;
  if(result.status!==0) throw new Error(result.stdout+result.stderr);
  return {exe,args:[path.resolve(fixtureRoot),built.ffmpeg],ffmpeg:built.ffmpeg,csc:built.csc};
}
