import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
// Deliberately read the entry point before launching: the test must fail while the new UI is absent.
await readFile(path.join(root, 'extension/panel/panel.html'));
const results = path.join(root, 'test-results/panel');
await mkdir(results, { recursive: true });
const server = createServer(async (req, res) => {
  try {
    const target = path.join(root, 'extension', decodeURIComponent(new URL(req.url, 'http://local').pathname));
    const data = await readFile(target);
    res.setHeader('Content-Type', target.endsWith('.js') ? 'text/javascript' : target.endsWith('.css') ? 'text/css' : target.endsWith('.png') ? 'image/png' : 'text/html');
    res.end(data);
  } catch { res.writeHead(404); res.end('Not found'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
const errors = [], passed = [];
const context = await browser.newContext({ viewport: { width: 420, height: 820 } });
await context.addInitScript(() => {
  const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); }, emit(...args) { this.listeners.forEach(fn => fn(...args)); } });
  const audio = (url, filename, nameRecognized, extra = {}) => ({ url: 'https://example.music/' + url, filename, nameRecognized, format: filename.split('.').pop(), size: 43210, source: 'page', ...extra });
  const mock = window.__mock = {
    tab: { id: 1, windowId: 10, title: '声音课堂 · 音频合集', url: 'https://example.music/list' },
    resources: { 1: { items: [audio('morning.m4a', '晨光 - 示例歌手.m4a', true), audio('away.mp3', '远方 - 示例歌手.mp3', true), audio('hash.wav', '音乐合集.wav', false, { verified: true })] }, 2: { items: [audio('second.m4a', '另一个页面.m4a', true)] }, 3: { items: [audio('third.wav', '第三个页面.wav', true)] } },
    workbench: { prefs: { downloadMode: 'browser', downloadDirectory: '', conversionDirectory: '', bitrate: 320, saveAs: false, recursive: false }, host: { connected: false, error: '' }, downloads: [], conversions: [] },
    calls: [], delays: {}, nativeInstalled: false,
    activate(id, windowId = 10) { this.tab = { id, windowId, title: '页面 ' + id, url: 'https://example.music/' + id }; chrome.tabs.onActivated.emit({ tabId: id, windowId }); },
    update() { chrome.storage.onChanged.emit({ workbench: { newValue: structuredClone(this.workbench) } }, 'local'); }
  };
  window.chrome = {
    windows: { getCurrent: async () => ({ id: 10 }) },
    tabs: { query: async () => [mock.tab], get: async id => ({ ...mock.tab, id }), onActivated: event(), onUpdated: event(), onRemoved: event(), create: async data => mock.calls.push({ type: 'CREATE_TAB', ...data }) },
    runtime: { sendMessage: async message => {
      mock.calls.push(structuredClone(message));
      if (message.type === 'GET_AUDIO' || message.type === 'SCAN_TAB' || message.type === 'CLEAR_TAB') {
        const snapshot = structuredClone(message.type === 'CLEAR_TAB' ? { items: [] } : mock.resources[message.tabId] || { items: [] });
        if (mock.delays[message.tabId]) await new Promise(resolve => setTimeout(resolve, mock.delays[message.tabId]));
        return { ok: true, data: snapshot };
      }
      if (message.type === 'GET_WORKBENCH') return { ok: true, data: structuredClone(mock.workbench) };
      if (message.type === 'SAVE_SETTINGS') { Object.assign(mock.workbench.prefs, message.settings); mock.update(); return { ok: true, data: structuredClone(mock.workbench) }; }
      if (message.type === 'NATIVE_CONNECT') { if (mock.delays.native) await new Promise(resolve => setTimeout(resolve, mock.delays.native)); if (!mock.nativeInstalled) return { ok: false, error: '未找到本地组件。' }; mock.workbench.host = { connected: true, version: '2.0.0' }; mock.update(); return { ok: true, data: structuredClone(mock.workbench) }; }
      if (message.type === 'CHOOSE_DIRECTORY') { mock.workbench.prefs[message.purpose === 'download' ? 'downloadDirectory' : 'conversionDirectory'] = 'C:\\Music'; if (message.purpose === 'download') mock.workbench.prefs.downloadMode = 'custom'; mock.update(); return { ok: true, data: structuredClone(mock.workbench) }; }
      if (message.type === 'ADD_CONVERSION_FILES') { mock.workbench.conversions.push({ id: 'conversion-1', name: '本地晨光.m4a', inputPath: 'C:\\Music\\本地晨光.m4a', state: 'pending', progress: 0 }); mock.update(); return { ok: true, data: structuredClone(mock.workbench) }; }
      if (message.type === 'START_CONVERSION') { mock.workbench.conversions[0].state = 'running'; mock.workbench.conversions[0].progress = .64; mock.update(); return { ok: true, data: structuredClone(mock.workbench) }; }
      if (message.type === 'CANCEL_CONVERSION') { mock.workbench.conversions[0].state = 'cancelled'; mock.update(); return { ok: true, data: structuredClone(mock.workbench) }; }
      if (message.type === 'RETRY_CONVERSION') { mock.workbench.conversions[0].state = 'pending'; mock.update(); return { ok: true, data: structuredClone(mock.workbench) }; }
      if (message.type === 'DOWNLOAD_AUDIO') return { ok: true, data: message.urls.map((url, id) => ({ url, id })) };
      return { ok: true, data: {} };
    }, getURL: p => p },
    storage: { local: { get: async () => ({ workbench: structuredClone(mock.workbench) }) }, session: { get: async () => ({}) }, onChanged: event() }
  };
});
const page = await context.newPage();
page.on('pageerror', error => errors.push(error.message));
async function check(name, fn) { await fn(); passed.push(name); process.stdout.write('PASS ' + name + '\n'); }
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/panel/panel.html`);
  await page.waitForFunction(() => document.querySelector('#count')?.textContent === '3');
  await check('name provenance groups, independent network verification and group selection', async () => {
    assert.equal(await page.locator('[data-group="recognized"] .audio-card').count(), 2);
    assert.equal(await page.locator('[data-group="unrecognized"] .audio-card').count(), 1);
    await page.locator('[data-group="recognized"] .group-select').check();
    assert.equal(await page.locator('#selected-count').textContent(), '已选 2 个');
    await page.locator('#search').fill('合集');
    assert.equal(await page.locator('.audio-card').count(), 1);
    assert.equal(await page.locator('[data-group="recognized"] .group-count').textContent(), '0 / 2');
    assert.equal(await page.locator('[data-group="unrecognized"] .group-count').textContent(), '1 / 1');
    await page.locator('#search').fill('');
    await page.screenshot({ path: path.join(results, 'resources.png') });
  });
  await check('per-tab selections, stale-response guard and owner-window isolation', async () => {
    await page.evaluate(() => __mock.activate(2));
    await page.waitForFunction(() => document.querySelector('#count').textContent === '1');
    assert.equal(await page.locator('#selected-count').textContent(), '已选 0 个');
    await page.evaluate(() => __mock.activate(1));
    await page.waitForFunction(() => document.querySelector('#count').textContent === '3');
    assert.equal(await page.locator('#selected-count').textContent(), '已选 2 个');
    await page.evaluate(() => { __mock.delays[2] = 300; __mock.activate(2); });
    await page.waitForTimeout(40);
    await page.evaluate(() => __mock.activate(3));
    await page.waitForTimeout(400);
    assert.equal(await page.locator('.file-name').textContent(), '第三个页面.wav');
    await page.evaluate(() => __mock.activate(2, 99));
    await page.waitForTimeout(80);
    assert.equal(await page.locator('.file-name').textContent(), '第三个页面.wav');
    await page.evaluate(() => __mock.activate(1));
    await page.waitForFunction(() => document.querySelector('#count').textContent === '3');
  });
  await check('browser download and M4A-only conversion requests', async () => {
    await page.locator('#download-selected').click();
    const download = await page.evaluate(() => __mock.calls.find(call => call.type === 'DOWNLOAD_AUDIO'));
    assert.equal(download.tabId, 1);
    assert.equal(download.urls.length, 2);
    assert.equal(download.convert, false);
    assert.equal(await page.locator('.convert-button:visible').count(), 1);
    await page.locator('.convert-button:visible').click();
    await page.locator('#nav-settings').waitFor({ state: 'visible' });
    assert.match(await page.locator('#notice').textContent(), /本地组件/);
  });
  await check('settings persist, native missing helper and native directory selection', async () => {
    await page.locator('#nav-settings').click();
    assert.match(await page.locator('#host-status').textContent(), /尚未配置/);
    await page.screenshot({ path: path.join(results, 'settings-missing.png') });
    await page.evaluate(() => { __mock.nativeInstalled = true; });
    await page.locator('#native-connect').click();
    await page.waitForFunction(() => document.querySelector('#host-status').textContent.includes('已连接'));
    await page.locator('#choose-download-directory').click();
    await page.waitForFunction(() => document.querySelector('#download-directory').textContent.includes('C:\\Music'));
    await page.locator('#save-as').check();
    await page.locator('#settings-bitrate').selectOption('192');
    assert.equal(await page.evaluate(() => __mock.workbench.prefs.saveAs), true);
    assert.equal(await page.evaluate(() => __mock.workbench.prefs.bitrate), 192);
    await page.evaluate(() => { __mock.workbench.host.connected = false; __mock.update(); });
    await page.locator('#nav-resources').click();
    await page.locator('.convert-button:visible').click();
    const convert = await page.evaluate(() => __mock.calls.filter(call => call.type === 'DOWNLOAD_AUDIO').at(-1));
    assert.equal(convert.convert, true); assert.deepEqual(convert.urls, ['https://example.music/morning.m4a']);
    assert.equal(await page.evaluate(() => __mock.workbench.host.connected), true, 'Installed helper reconnects automatically when needed');
  });
  await check('local files, folder recursion, queue progress, cancel, retry and open/reveal', async () => {
    await page.locator('#nav-conversion').click();
    await page.locator('#recursive').check();
    await page.locator('#add-folder').click();
    assert.equal(await page.locator('.conversion-task').count(), 1);
    const add = await page.evaluate(() => __mock.calls.find(call => call.type === 'ADD_CONVERSION_FILES'));
    assert.equal(add.folder, true); assert.equal(add.recursive, true);
    await page.locator('#start-conversion').click();
    await page.waitForFunction(() => document.querySelector('.conversion-task').textContent.includes('64%'));
    await page.locator('#dismiss-notice').click();
    await page.screenshot({ path: path.join(results, 'conversion.png') });
    await page.locator('#cancel-conversion').click();
    await page.locator('.retry-conversion').click();
    await page.evaluate(() => { __mock.workbench.conversions[0].state = 'complete'; __mock.workbench.conversions[0].outputPath = 'C:\\Music\\本地晨光.mp3'; __mock.update(); });
    await page.locator('.open-task').click(); await page.locator('.reveal-task').click();
    const opens = await page.evaluate(() => __mock.calls.filter(call => call.type === 'OPEN_TASK'));
    assert.deepEqual(opens.map(call => call.reveal), [false, true]);
  });
  await check('submitted pending tasks cannot restart; latest download state wins over older completed task', async () => {
    await page.evaluate(() => {
      __mock.workbench.conversions[0].state = 'pending';
      __mock.workbench.conversions[0].submitted = true;
      __mock.workbench.downloads = [
        { id: 'new', tabId: 1, url: 'https://example.music/away.mp3', name: '远方 - 示例歌手.mp3', state: 'downloading', progress: .2 },
        { id: 'old', tabId: 1, url: 'https://example.music/away.mp3', name: '远方 - 示例歌手.mp3', state: 'complete', path: 'C:\\Music\\远方.mp3' }
      ];
      __mock.update();
    });
    assert.equal(await page.locator('#start-conversion').isDisabled(), true);
    assert.equal(await page.locator('#cancel-conversion').isEnabled(), true);
    await page.locator('#nav-resources').click();
    assert.equal(await page.locator('.audio-card[data-url$="away.mp3"] .download-state').textContent(), '下载中');
    await page.evaluate(() => { __mock.workbench.downloads[0].state = 'failed'; __mock.workbench.downloads[0].error = '测试保存失败'; __mock.update(); });
    await page.locator('.retry-download').click();
    assert.equal(await page.evaluate(() => __mock.calls.some(call => call.type === 'RETRY_DOWNLOAD' && call.id === 'new')), true);
    await page.locator('#dismiss-notice').click();
  });
  await check('native reconnect cannot move a requested download to another tab', async () => {
    await page.evaluate(() => { __mock.workbench.host.connected = false; __mock.delays.native = 200; __mock.update(); });
    await page.locator('.convert-button:visible').click();
    await page.evaluate(() => __mock.activate(3));
    await page.waitForTimeout(350);
    const latest = await page.evaluate(() => __mock.calls.filter(call => call.type === 'DOWNLOAD_AUDIO').at(-1));
    assert.equal(latest.tabId, 1); assert.deepEqual(latest.urls, ['https://example.music/morning.m4a']);
    await page.evaluate(() => __mock.activate(1));
    await page.waitForFunction(() => document.querySelector('#count').textContent === '3');
    await page.locator('#dismiss-notice').click();
  });
  await check('responsive 320×560 and 620×900 contain primary controls without horizontal scroll', async () => {
    for (const viewport of [{ width: 320, height: 560 }, { width: 620, height: 900 }]) {
      await page.setViewportSize(viewport);
      for (const nav of ['resources', 'conversion', 'settings']) {
        await page.locator('#nav-' + nav).click();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        if (nav !== 'settings') {
          const box = await page.locator(nav === 'resources' ? '#download-selected' : '#start-conversion').boundingBox();
          assert.ok(box.y >= 0 && box.y + box.height <= viewport.height);
        }
      }
    }
    await page.setViewportSize({ width: 320, height: 560 }); await page.locator('#nav-resources').click();
    await page.locator('#resource-scroll').evaluate(node => { node.scrollTop = 0; });
    await page.screenshot({ path: path.join(results, 'narrow.png') });
  });
  await check('explicit close passes owner window and gracefully explains unsupported browser close API', async () => {
    await page.locator('#close-panel').click();
    assert.equal(await page.evaluate(() => __mock.calls.find(call => call.type === 'CLOSE_PANEL').windowId), 10);
    assert.match(await page.locator('#notice').textContent(), /浏览器侧栏/);
  });
  await check('tab activation during initial session-cache read cannot restore the initial old tab', async () => {
    const early = await context.newPage();
    early.on('pageerror', error => errors.push(error.message));
    await early.addInitScript(() => { chrome.storage.session.get = async () => { setTimeout(() => __mock.activate(2), 10); await new Promise(resolve => setTimeout(resolve, 250)); return {}; }; });
    await early.goto(`http://127.0.0.1:${server.address().port}/panel/panel.html`);
    await early.waitForTimeout(500);
    assert.equal(await early.locator('.file-name').textContent(), '另一个页面.m4a');
    assert.equal(await early.locator('#page-title').textContent(), '页面 2');
    await early.close();
  });
  assert.deepEqual(errors, []);
  await writeFile(path.join(results, 'report.json'), JSON.stringify({ passed, errors, browser: browser.version(), fallback: 'Browser plugin not available' }, null, 2));
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
