import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const sharp = require(process.env.SHARP_MODULE || "sharp");
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect width="128" height="128" rx="30" fill="#116d60"/><g stroke="#fffdf2" stroke-width="9" stroke-linecap="round"><path d="M30 55v18M47 42v44M64 28v72M81 42v44M98 55v18"/></g><circle cx="99" cy="27" r="8" fill="#e3bd78"/></svg>`;
await mkdir(new URL("../extension/icons/", import.meta.url), { recursive: true });
for (const size of [16, 32, 48, 128]) {
  await sharp(Buffer.from(svg)).resize(size, size).png().toFile(fileURLToPath(new URL(`../extension/icons/icon${size}.png`, import.meta.url)));
}
process.stdout.write("已生成 16 / 32 / 48 / 128 像素图标。\n");
