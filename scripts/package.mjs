import { mkdir, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const extension = path.join(root, "extension");
const manifest = JSON.parse(await readFile(path.join(extension, "manifest.json"), "utf8"));
if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error("无效版本号。");
const destination = path.join(root, "dist");
await mkdir(destination, { recursive: true });
const archive = path.join(destination, `tingjian-audio-downloader-v${manifest.version}.zip`);
await rm(archive, { force: true });
const quote = value => `'${value.replaceAll("'", "''")}'`;
const command = `$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory(${quote(extension)}, ${quote(archive)}, [System.IO.Compression.CompressionLevel]::Optimal, $false, [System.Text.Encoding]::UTF8)`;
const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], { encoding: "utf8", windowsHide: true });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(result.stderr || "打包失败。");
process.stdout.write(`${archive}\n`);
