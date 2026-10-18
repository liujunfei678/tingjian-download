import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile, copyFile, access, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
export const converterFolder = path.join(root, "dist", "M4A转MP3工具");

function run(executable, args) {
  const result = spawnSync(executable, args, { encoding: "utf8", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stdout + result.stderr);
  return result.stdout.trim();
}

const psQuote = value => `'${value.replaceAll("'", "''")}'`;

export function findExecutable(name) {
  return run("powershell.exe", ["-NoProfile", "-Command", `(Get-Command ${psQuote(name)} -ErrorAction Stop).Source`]);
}

export async function buildConverter({ archive = true } = {}) {
  const ffmpeg = process.env.FFMPEG_PATH || findExecutable("ffmpeg.exe");
  const csc = process.env.CSC_PATH || path.join(process.env.WINDIR || "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
  await access(ffmpeg);
  await access(csc);
  await mkdir(converterFolder, { recursive: true });
  const exe = path.join(converterFolder, "听见批量转换.exe");
  const png = await readFile(path.join(root, "extension", "icons", "icon128.png"));
  const iconHeader = Buffer.alloc(22);
  iconHeader.writeUInt16LE(1, 2);
  iconHeader.writeUInt16LE(1, 4);
  iconHeader[6] = 128;
  iconHeader[7] = 128;
  iconHeader.writeUInt16LE(1, 10);
  iconHeader.writeUInt16LE(32, 12);
  iconHeader.writeUInt32LE(png.length, 14);
  iconHeader.writeUInt32LE(22, 18);
  const icon = path.join(root, "dist", "converter.ico");
  await writeFile(icon, Buffer.concat([iconHeader, png]));
  run(csc, ["/nologo", "/target:winexe", "/platform:x64", "/optimize+", "/codepage:65001",
    `/out:${exe}`, `/win32icon:${icon}`, `/win32manifest:${path.join(root, "converter", "app.manifest")}`,
    "/reference:System.dll", "/reference:System.Core.dll", "/reference:System.Drawing.dll", "/reference:System.Windows.Forms.dll",
    path.join(root, "converter", "ConverterCore.cs"), path.join(root, "converter", "MainForm.cs")]);
  await writeFile(exe + ".config", '<?xml version="1.0"?><configuration><startup><supportedRuntime version="v4.0" sku=".NETFramework,Version=v4.5" /></startup></configuration>');
  await copyFile(ffmpeg, path.join(converterFolder, "ffmpeg.exe"));
  await copyFile(path.join(root, "converter", "使用说明.txt"), path.join(converterFolder, "使用说明.txt"));
  const thirdParty = path.join(converterFolder, "third-party");
  const source = path.join(converterFolder, "source");
  await mkdir(thirdParty, { recursive: true });
  await mkdir(source, { recursive: true });
  const ffmpegRoot = path.dirname(path.dirname(ffmpeg));
  // Keep the actual vendor license and build/source information alongside the binary.
  await copyFile(path.join(ffmpegRoot, "LICENSE"), path.join(thirdParty, "LICENSE-FFmpeg.txt"));
  await copyFile(path.join(ffmpegRoot, "README.txt"), path.join(thirdParty, "FFmpeg-build.txt"));
  for (const name of ["ConverterCore.cs", "MainForm.cs", "app.manifest"]) {
    await copyFile(path.join(root, "converter", name), path.join(source, name));
  }
  await copyFile(path.join(root, "scripts", "build-converter.mjs"), path.join(source, "build-converter.mjs"));
  await writeFile(path.join(thirdParty, "转换参考.txt"), "FFmpeg 官方转换及进度参数文档：https://ffmpeg.org/ffmpeg.html\r\nMP3 编码器文档：https://ffmpeg.org/ffmpeg-codecs.html#libmp3lame\r\n");
  if (archive) {
    const zip = path.join(root, "dist", "M4A转MP3工具.zip");
    await rm(zip, { force: true });
    run("powershell.exe", ["-NoProfile", "-Command", `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory(${psQuote(converterFolder)}, ${psQuote(zip)}, [System.IO.Compression.CompressionLevel]::Optimal, $false, [System.Text.Encoding]::UTF8)`]);
    process.stdout.write(`安装包：${zip}\n`);
  }
  process.stdout.write(`程序：${exe}\n`);
  return { exe, ffmpeg, csc };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildConverter({ archive: !process.argv.includes("--no-zip") });
}
