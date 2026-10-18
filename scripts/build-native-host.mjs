import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findExecutable } from './build-converter.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export const nativeHostFolder = path.join(root, 'dist', '听见本地组件');
function run(exe, args) {
  const r = spawnSync(exe,args,{encoding:'utf8',windowsHide:true});
  if(r.error) throw r.error;
  if(r.status!==0) throw new Error(r.stdout+r.stderr);
  return r.stdout;
}
const psQuote = value => `'${value.replaceAll("'", "''")}'`;

export async function buildNativeHost({ archive = true } = {}) {
  const ffmpeg = process.env.FFMPEG_PATH || findExecutable('ffmpeg.exe');
  const csc = process.env.CSC_PATH || path.join(process.env.WINDIR || 'C:\\Windows','Microsoft.NET','Framework64','v4.0.30319','csc.exe');
  await Promise.all([access(ffmpeg),access(csc)]);
  const manifest = JSON.parse(await readFile(path.join(root,'extension','manifest.json'),'utf8'));
  if(!manifest.key) throw new Error('Native host build requires a stable extension manifest key.');
  const id = [...createHash('sha256').update(Buffer.from(manifest.key,'base64')).digest().subarray(0,16)].map(byte => String.fromCharCode(97+(byte>>4),97+(byte&15))).join('');
  const origin = `chrome-extension://${id}/`;
  await mkdir(nativeHostFolder,{recursive:true});
  const generated = path.join(root,'dist','NativeHostOrigin.cs');
  await writeFile(generated,`namespace TingjianNative { internal static class TrustedOrigin { internal const string Value = "${origin}"; } }\n`);
  const references=['/reference:System.dll','/reference:System.Core.dll','/reference:System.Windows.Forms.dll','/reference:System.Web.Extensions.dll'];
  const common=['/nologo','/platform:x64','/optimize+','/codepage:65001',...references];
  const exe=path.join(nativeHostFolder,'Tingjian.NativeHost.exe');
  run(csc,[...common,'/target:exe',`/out:${exe}`,generated,path.join(root,'native-host','NativeHost.cs'),path.join(root,'native-host','HostCore.cs'),path.join(root,'converter','ConverterCore.cs')]);
  for(const [name,extra] of [['Tingjian.Setup.exe',[]],['Tingjian.Uninstall.exe',['/define:UNINSTALL']]]) run(csc,[...common,'/target:winexe',...extra,`/out:${path.join(nativeHostFolder,name)}`,generated,path.join(root,'native-host','Setup.cs')]);
  for(const name of ['Tingjian.NativeHost.exe','Tingjian.Setup.exe','Tingjian.Uninstall.exe']) await writeFile(path.join(nativeHostFolder,name+'.config'),'<?xml version="1.0"?><configuration><startup><supportedRuntime version="v4.0" sku=".NETFramework,Version=v4.5" /></startup></configuration>');
  await writeFile(path.join(nativeHostFolder,'com.tingjian.audio.json'),JSON.stringify({name:'com.tingjian.audio',description:'听见 2.0 本地音频组件',path:exe,type:'stdio',allowed_origins:[origin]},null,2));
  await copyFile(ffmpeg,path.join(nativeHostFolder,'ffmpeg.exe'));
  await copyFile(path.join(root,'native-host','README.md'),path.join(nativeHostFolder,'使用说明.md'));
  const third=path.join(nativeHostFolder,'third-party'),source=path.join(nativeHostFolder,'source');
  await Promise.all([mkdir(third,{recursive:true}),mkdir(source,{recursive:true})]);
  const ffmpegRoot=path.dirname(path.dirname(ffmpeg));
  await copyFile(path.join(ffmpegRoot,'LICENSE'),path.join(third,'LICENSE-FFmpeg.txt'));
  await copyFile(path.join(ffmpegRoot,'README.txt'),path.join(third,'FFmpeg-build-and-source.txt'));
  await writeFile(path.join(third,'源码与许可说明.txt'),'FFmpeg 随包许可及供应方构建说明保留在本目录。供应方完整对应源码获取方式见 FFmpeg-build-and-source.txt。\r\nFFmpeg 官方源码与许可：https://ffmpeg.org/download.html#releases 与 https://ffmpeg.org/legal.html\r\nFFmpeg 参数文档：https://ffmpeg.org/ffmpeg.html\r\n此组件使用独立 FFmpeg 可执行程序，不通过网络上传文件。\r\n');
  for(const name of ['NativeHost.cs','HostCore.cs','Setup.cs']) await copyFile(path.join(root,'native-host',name),path.join(source,name));
  await copyFile(generated,path.join(source,'NativeHostOrigin.cs'));
  await copyFile(path.join(root,'converter','ConverterCore.cs'),path.join(source,'ConverterCore.cs'));
  await copyFile(path.join(root,'scripts','build-native-host.mjs'),path.join(source,'build-native-host.mjs'));
  await copyFile(path.join(root,'scripts','build-converter.mjs'),path.join(source,'build-converter.mjs'));
  await writeFile(path.join(source,'rebuild.cmd'),'@echo off\r\nsetlocal\r\ncd /d "%~dp0"\r\nset "TINGJIAN_CSC=%WINDIR%\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe"\r\n"%TINGJIAN_CSC%" /nologo /target:exe /platform:x64 /optimize+ /codepage:65001 /out:Tingjian.NativeHost.exe /reference:System.dll /reference:System.Core.dll /reference:System.Windows.Forms.dll /reference:System.Web.Extensions.dll NativeHostOrigin.cs NativeHost.cs HostCore.cs ConverterCore.cs\r\nif errorlevel 1 exit /b 1\r\n"%TINGJIAN_CSC%" /nologo /target:winexe /platform:x64 /optimize+ /codepage:65001 /out:Tingjian.Setup.exe /reference:System.dll /reference:System.Core.dll /reference:System.Windows.Forms.dll /reference:System.Web.Extensions.dll NativeHostOrigin.cs Setup.cs\r\nif errorlevel 1 exit /b 1\r\n"%TINGJIAN_CSC%" /nologo /target:winexe /platform:x64 /optimize+ /codepage:65001 /define:UNINSTALL /out:Tingjian.Uninstall.exe /reference:System.dll /reference:System.Core.dll /reference:System.Windows.Forms.dll /reference:System.Web.Extensions.dll NativeHostOrigin.cs Setup.cs\r\nexit /b %errorlevel%\r\n');
  await writeFile(path.join(source,'README.txt'),'此目录包含本地组件完整 C# 源码与稳定扩展来源常量。\r\n在 Windows 10/11 x64 运行 rebuild.cmd 可独立重新编译三个程序，不执行安装或修改注册表。\r\n将重新生成的程序放回上级完整组件目录使用；FFmpeg、清单与 .config 应继续放在程序旁。\r\nJavaScript 构建脚本供原项目构建，项目完整目录中运行 node scripts/build-native-host.mjs。\r\n');
  if(archive) {
    const zip=path.join(root,'dist','听见本地组件.zip'); await rm(zip,{force:true});
    run('powershell.exe',['-NoProfile','-Command',`$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory(${psQuote(nativeHostFolder)}, ${psQuote(zip)}, [System.IO.Compression.CompressionLevel]::Optimal, $false, [System.Text.Encoding]::UTF8)`]);
    process.stdout.write(`本地组件包：${zip}\n`);
  }
  return {exe,ffmpeg,csc,origin,folder:nativeHostFolder};
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) await buildNativeHost({archive:!process.argv.includes('--no-zip')});
