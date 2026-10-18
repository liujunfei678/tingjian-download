import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { createDemoServer, makeWav } from "../scripts/demo-server.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = fileURLToPath(new URL("../", import.meta.url));
const resultDir = path.join(root, "test-results");
const profileDir = path.join(root, ".test-profile", String(Date.now()));
const namedDownloadDir = path.join(resultDir, "named-downloads", String(Date.now()));
await mkdir(resultDir, { recursive: true });
await mkdir(namedDownloadDir, { recursive: true });
await mkdir(path.join(profileDir, "Default"), { recursive: true });
await writeFile(path.join(profileDir, "Default", "Preferences"), JSON.stringify({
  download: { default_directory: namedDownloadDir, prompt_for_download: false, directory_upgrade: true }
}));
const server = createDemoServer();
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const baseURL = `http://127.0.0.1:${server.address().port}`;
const passed = [];
const errors = [];
let context;

async function check(name, operation) {
  await operation();
  passed.push(name);
  process.stdout.write(`PASS ${name}\n`);
}

async function waitForDownloads(popup, expectedCount) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const all = await popup.evaluate(() => chrome.downloads.search({}));
    if (all.length === expectedCount && all.every(item => item.state === "complete")) return all;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`未在 30 秒内完成 ${expectedCount} 个下载。`);
}

try {
  const extension = path.join(root, "extension");
  context = await chromium.launchPersistentContext(profileDir, {
    channel: "chromium", headless: true, acceptDownloads: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    viewport: { width: 1024, height: 820 }
  });
  context.on("page", page => page.on("pageerror", error => errors.push(error.message)));
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 15000 });
  worker.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  const extensionId = worker.url().split("/")[2];
  await worker.evaluate(() => chrome.runtime.getManifest());
  const page = await context.newPage();
  const session = await context.browser().newBrowserCDPSession();
  const downloadDir = path.join(resultDir, "downloads");
  await mkdir(downloadDir, { recursive: true });
  await session.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: downloadDir, eventsEnabled: true });
  await page.goto(baseURL);
  const popup = await context.newPage();
  await page.bringToFront();
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await popup.waitForFunction(() => document.querySelector("#count").textContent === "3");

  await check("页面音频、download 文件名、子框架与去重", async () => {
    assert.equal(await popup.locator(".audio-card").count(), 3);
    assert.equal(await popup.locator('.audio-card[data-url$="/tone.wav"]').count(), 1);
    assert.equal(await popup.locator('.audio-card[data-url$="/iframe.wav"]').count(), 1);
    assert.equal(await popup.locator('.audio-card[data-url$="/download-hint"] .file-name').textContent(), "提示音.wav");
    assert.equal(await popup.locator('.audio-card[data-url$="/video.mp4"]').count(), 0);
    assert.equal(await popup.locator('.audio-card[data-url$="/stream.m3u8"]').count(), 0);
  });

  await check("动态 DOM 音频链接无需手动扫描", async () => {
    await page.locator("#add-dynamic").click();
    await popup.waitForFunction(() => document.querySelector("#count").textContent === "4");
    assert.equal(await popup.locator('.audio-card[data-url$="/dynamic.wav"]').count(), 1);
  });

  await check("无后缀网络音频、中文响应文件名和签名参数", async () => {
    await page.locator("#load-network").click();
    await popup.waitForFunction(() => document.querySelector("#count").textContent === "5");
    const card = popup.locator('.audio-card[data-url*="/audio-endpoint?"]');
    assert.equal(await card.locator(".file-name").textContent(), "网络提示音.wav");
    assert.equal(await card.locator(".source").textContent(), "网络已识别");
    assert.equal(await card.locator(".file-size").textContent(), "43.1 KB");
    assert.ok((await card.getAttribute("data-url")).endsWith("token=test%2Bsigned"));
    assert.equal(await popup.evaluate(() => document.body.scrollHeight), 600, "Popup fits the browser's height limit");
    await popup.screenshot({ path: path.join(resultDir, "popup.png"), clip: { x: 0, y: 0, width: 440, height: 600 } });
  });

  await check("搜索与全选只选择匹配的音频", async () => {
    await popup.locator("#search").fill("网络提示音");
    assert.equal(await popup.locator(".audio-card").count(), 1);
    await popup.locator("#select-all").check();
    assert.equal(await popup.locator("#selected-count").textContent(), "已选 1 个");
    await popup.locator("#search").fill("");
    assert.equal(await popup.locator(".item-select:checked").count(), 1);
  });

  await check("实际下载生成完整 WAV 文件且显示完成状态", async () => {
    await popup.locator("#download-selected").click();
    const downloads = await waitForDownloads(popup, 1);
    const actual = downloads.find(download => download.url.includes("/audio-endpoint?"));
    assert.deepEqual(await readFile(actual.filename), makeWav());
    await popup.locator('.audio-card[data-url*="/audio-endpoint?"] .download-state').filter({ hasText: "已下载" }).waitFor();
  });

  await check("二进制附件通过响应文件名识别；HTML 伪音频被过滤", async () => {
    await page.evaluate(async () => {
      await (await fetch("/attachment")).arrayBuffer();
      await (await fetch("/not-audio.mp3")).text();
    });
    await popup.waitForFunction(() => document.querySelector("#count").textContent === "6");
    assert.equal(await popup.locator('.audio-card[data-url$="/attachment"] .file-name').textContent(), "attachment-tone.wav");
    assert.equal(await popup.locator('.audio-card[data-url$="/not-audio.mp3"]').count(), 0);
  });

  await check("下载多个文件", async () => {
    await popup.locator("#select-all").check();
    await popup.locator("#download-selected").click();
    const all = await waitForDownloads(popup, 7);
    for (const item of all) assert.deepEqual(await readFile(item.filename), makeWav());
  });

  await check("重新打开面板保留识别和下载状态", async () => {
    await page.bringToFront();
    await popup.reload();
    await popup.waitForFunction(() => document.querySelector("#count").textContent === "6");
    assert.equal(await popup.locator(".download-state").filter({ hasText: "已下载" }).count(), 6);
  });

  await check("页面跳转清理旧链接并隔离标签页", async () => {
    const second = await context.newPage();
    await second.goto(`${baseURL}/empty`);
    await page.bringToFront();
    await popup.reload();
    await popup.waitForFunction(() => document.querySelector("#count").textContent === "6");
    await page.goto(`${baseURL}/empty`);
    await popup.waitForFunction(() => document.querySelector("#count").textContent === "0");
    assert.equal(await popup.locator(".audio-card").count(), 0);
  });

  await check("清空后手动重新扫描恢复页面链接", async () => {
    await page.goto(baseURL);
    await popup.waitForFunction(() => document.querySelector("#count").textContent === "3");
    await popup.locator("#clear").click();
    await popup.waitForFunction(() => document.querySelector("#count").textContent === "0");
    await popup.locator("#scan").click();
    await popup.waitForFunction(() => document.querySelector("#count").textContent === "3");
    assert.equal(await popup.locator(".download-state:not([hidden])").count(), 0);
  });

  const cardFor = digit => popup.locator(`.audio-card[data-url$="/${digit.repeat(32)}.wav"]`);
  await check("歌曲名、链接标题与网页备用名称按各自音频匹配", async () => {
    await page.goto(`${baseURL}/naming`);
    await popup.waitForFunction(() => document.querySelector("#count").textContent === "8");
    assert.equal(await cardFor("1").locator(".file-name").textContent(), "晨光 - 示例歌手.wav");
    assert.equal(await cardFor("2").locator(".file-name").textContent(), "雨声 - 环境录音.wav");
    assert.equal(await cardFor("3").locator(".file-name").textContent(), "声音课堂 · 音频合集.wav");
    assert.equal(await cardFor("5").locator(".file-name").textContent(), "星河.wav");
    assert.equal(await cardFor("6").locator(".file-name").textContent(), "晚风 - 示例歌手.wav");
    assert.equal(await popup.locator('.audio-card[data-url$="/readable-track.wav"] .file-name').textContent(), "readable-track.wav");
  });

  await check("播放器歌曲名和歌手覆盖随机资源名且不影响其他音频", async () => {
    await page.locator("#play-media").click();
    await popup.waitForFunction(() => Array.from(document.querySelectorAll(".file-name")).some(element => element.textContent === "远方 - 示例歌手.wav"));
    assert.equal(await cardFor("7").locator(".file-name").textContent(), "远方 - 示例歌手.wav");
    assert.equal(await cardFor("6").locator(".file-name").textContent(), "晚风 - 示例歌手.wav");
    await popup.locator("#scan").click();
    await popup.waitForFunction(() => document.querySelector("#scan").textContent === "重新扫描");
    assert.equal(await cardFor("7").locator(".file-name").textContent(), "远方 - 示例歌手.wav");
  });

  await check("播放器标题动态变化后自动更新文件名", async () => {
    await page.locator("#named-player").evaluate(element => element.title = "更新后的晚风");
    await popup.waitForFunction(() => Array.from(document.querySelectorAll(".file-name")).some(element => element.textContent === "更新后的晚风.wav"));
  });

  await check("旧播放器的全局歌曲名不会覆盖通知音自身的名称", async () => {
    await page.evaluate(async () => {
      document.querySelectorAll("audio").forEach(audio => audio.pause());
      navigator.mediaSession.metadata = new MediaMetadata({ title: "晚风", artist: "示例歌手" });
      await document.querySelector("#notification-player").play();
    });
    await popup.locator("#scan").click();
    await popup.waitForFunction(() => document.querySelector("#scan").textContent === "重新扫描");
    assert.equal(await cardFor("9").locator(".file-name").textContent(), "通知提示音.wav");
  });

  await check("服务器可读文件名优于页面标题，匿名网络请求使用备用名", async () => {
    await page.locator("#load-server-name").click();
    await popup.waitForFunction(() => document.querySelector("#count").textContent === "9");
    assert.equal(await popup.locator('.audio-card[data-url$="/server-name"] .file-name').textContent(), "可读服务器名.wav");
    await page.locator("#load-unnamed").click();
    await popup.waitForFunction(() => document.querySelector("#count").textContent === "10");
    assert.equal(await cardFor("8").locator(".file-name").textContent(), "声音课堂 · 音频合集.wav");
  });

  await check("无后缀播放器的网页、播放列表和失败响应不会留作可下载音频", async () => {
    const paths = ["/not-audio-endpoint", "/playlist-endpoint", "/missing-audio-endpoint"];
    const responses = Promise.all(paths.map(url => page.waitForResponse(response => response.url() === `${baseURL}${url}`)));
    await page.evaluate(paths => {
      for (const path of paths) {
        const audio = document.createElement("audio");
        audio.src = path;
        audio.preload = "auto";
        document.body.append(audio);
        audio.load();
      }
    }, paths);
    await responses;
    await popup.locator("#scan").click();
    await popup.waitForFunction(() => document.querySelector("#scan").textContent === "重新扫描");
    for (const path of paths) assert.equal(await popup.locator(`.audio-card[data-url$="${path}"]`).count(), 0);
    assert.equal(await popup.locator("#count").textContent(), "10");
  });

  await check("多播放器页面的匿名提示音不会继承另一首歌的元数据", async () => {
    await page.evaluate(async () => {
      document.querySelectorAll("audio").forEach(audio => audio.pause());
      navigator.mediaSession.metadata = new MediaMetadata({ title: "另一首歌曲", artist: "另一个歌手" });
      const audio = document.querySelector("#notification-player");
      audio.removeAttribute("title");
      audio.src = "/unlabelled-bell.wav";
      await audio.play();
    });
    await popup.locator("#scan").click();
    await popup.waitForFunction(() => document.querySelector("#scan").textContent === "重新扫描");
    assert.equal(await popup.locator('.audio-card[data-url$="/unlabelled-bell.wav"] .file-name').textContent(), "unlabelled-bell.wav");
    assert.equal(await popup.locator("#count").textContent(), "11");
  });

  await check("下载文件实际使用歌曲名称并保持音频内容完整", async () => {
    // CDP's allow/allowAndName overrides the browser's normal name selection.
    // Restore normal downloads against the independent test profile's directory.
    await session.send("Browser.setDownloadBehavior", { behavior: "default" });
    await cardFor("1").locator(".download-button").click();
    const all = await waitForDownloads(popup, 8);
    const song = all.find(item => item.url.endsWith(`/${"1".repeat(32)}.wav`));
    assert.equal(path.basename(song.filename), "晨光 - 示例歌手.wav");
    assert.deepEqual(await readFile(song.filename), makeWav());
    await page.bringToFront();
    await popup.reload();
    await popup.waitForFunction(() => document.querySelector("#count").textContent === "11");
    assert.equal(await cardFor("1").locator(".file-name").textContent(), "晨光 - 示例歌手.wav");
    await popup.screenshot({ path: path.join(resultDir, "naming-popup.png"), clip: { x: 0, y: 0, width: 440, height: 600 } });
  });

  await check("暂停的 blob 主播放器也阻止匿名提示音继承旧歌曲名", async () => {
    await page.goto(`${baseURL}/empty`);
    await page.evaluate(async bytes => {
      const main = document.createElement("audio");
      main.preload = "none";
      main.src = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "audio/wav" }));
      const bell = document.createElement("audio");
      bell.preload = "none";
      bell.src = "/unlabelled-bell.wav";
      document.body.append(main, bell);
      navigator.mediaSession.metadata = new MediaMetadata({ title: "另一首歌曲", artist: "另一个歌手" });
      await bell.play();
    }, Array.from(makeWav()));
    await popup.locator("#scan").click();
    await popup.waitForFunction(() => document.querySelector("#scan").textContent === "重新扫描");
    assert.equal(await popup.locator('.audio-card[data-url$="/unlabelled-bell.wav"] .file-name').textContent(), "unlabelled-bell.wav");
    assert.equal(await popup.locator("#count").textContent(), "1");
  });

  assert.deepEqual(errors, [], "Browser JavaScript errors");
  await writeFile(path.join(resultDir, "report.json"), JSON.stringify({ passed, errors, browser: await context.browser().version() }, null, 2));
  process.stdout.write(`完成：${passed.length} 项浏览器验证，未发现脚本错误。\n`);
} catch (error) {
  const extensionPage = context?.pages().find(page => page.url().startsWith("chrome-extension:"));
  const debugDownloads = extensionPage ? await extensionPage.evaluate(() => chrome.downloads.search({})) : [];
  const files = await readdir(path.join(resultDir, "downloads")).catch(() => []);
  await writeFile(path.join(resultDir, "report.json"), JSON.stringify({ passed, errors, debugDownloads, files, failure: error.stack }, null, 2));
  throw error;
} finally {
  if (context) await context.close();
  await new Promise(resolve => server.close(resolve));
}
