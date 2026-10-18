import "./lib/audio.js";
import { NativeBridge } from './lib/native.js';
import { Workbench } from './lib/workbench.js';
import { isTrustedUI } from './lib/access.js';
import { isNeteasePageURL, matchingNeteasePlaybackURL, needsNeteaseM4APlaybackProof, readNeteasePlayback } from './lib/netease.js';
import { NeteaseDiagnostics, summarizeNeteaseURL } from './lib/netease-diagnostics.js';

const workbench = new Workbench(chrome, new NativeBridge(chrome.runtime));
const neteaseDiagnostics = new NeteaseDiagnostics(chrome);
void workbench.ready.then(() => workbench.recover()).catch(console.error);

const queues = new Map();
const navigationRequests = new Map();
const namingRequests = new Map();
const diagnosticResponses = new Map();
const pendingNeteaseResponses = new Map();
const MAX_ITEMS = 200;
const keyFor = tabId => `audio:${tabId}`;
const emptyState = () => ({ items: [], capped: false, rejected: [] });

function serialize(tabId, operation) {
  const next = (queues.get(tabId) || Promise.resolve()).catch(() => {}).then(operation);
  queues.set(tabId, next);
  void next.finally(() => { if (queues.get(tabId) === next) queues.delete(tabId); }).catch(() => {});
  return next;
}

async function readState(tabId) {
  const key = keyFor(tabId);
  const state = (await chrome.storage.session.get(key))[key] || emptyState();
  state.items = state.items.map(item => ({...item,...AudioTools.namingFor(item)}));
  return state;
}

async function setBadge(tabId, count) {
  await Promise.allSettled([
    chrome.action.setBadgeText({ tabId, text: count ? (count > 99 ? "99+" : String(count)) : "" }),
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#116D60" }),
    chrome.action.setTitle({ tabId, title: count ? `听见 · 发现 ${count} 个音频链接` : "听见 · 查看可下载音频" })
  ]);
}

function enrichNeteaseNames(tabId, trigger = 'refresh') {
  if (namingRequests.has(tabId)) return namingRequests.get(tabId);
  const generation = navigationRequests.get(tabId);
  const request = (async () => {
    const tab = await chrome.tabs.get(tabId);
    if (!isNeteasePageURL(tab.url)) return;
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] }, world: 'MAIN', func: readNeteasePlayback, args: [true]
    });
    const bindings = results.flatMap(result => Array.isArray(result.result?.bindings) ? result.result.bindings : []).slice(0, 8);
    await serialize(tabId, async () => {
      if (generation !== navigationRequests.get(tabId)) return;
      try { await chrome.tabs.get(tabId); } catch { return; }
      const state = await readState(tabId);
      if (generation !== navigationRequests.get(tabId)) return;
      state.rejected ||= [];
      let changed = false;
      let matched = 0;
      let conflicts = 0;
      const previousCount = state.items.length;
      let correctedResponses = 0;
      const pending = pendingNeteaseResponses.get(tabId);
      for (const [url, response] of pending || []) {
        if (response.generation !== generation || Date.now() - response.at > 120000) { pending.delete(url); continue; }
        if (!response.allowed) continue;
        const existing = state.items.find(item => item.url === url);
        const binding = bindings.find(value => matchingNeteasePlaybackURL(url, value?.url));
        if (existing?.neteaseTrackId && binding && existing.neteaseTrackId !== binding.trackId) {
          pending.delete(url);
          continue;
        }
        if (!binding) {
          // Keep only the response fact for a late player snapshot. The URL
          // stays hidden until the current player proves it is this song.
          if (!existing?.neteaseTrackId) {
            state.items = state.items.filter(item => item.url !== url);
            if (existing || !state.rejected.includes(url)) changed = true;
            state.rejected = [...new Set([...state.rejected, url])].slice(-MAX_ITEMS);
          }
          continue;
        }
        if (!existing && state.items.length >= MAX_ITEMS) continue;
        const named = AudioTools.candidate({ ...response.item, mime: 'audio/mp4', source: 'network', verified: true,
          title: binding.title, artist: binding.artist, titleSource: 'media' });
        if (!named) continue;
        const next = existing ? AudioTools.merge(existing, named) : { ...named, firstSeen: response.at };
        next.neteaseTrackId = binding.trackId;
        state.items = state.items.filter(item => item.url !== url);
        state.items.push(next);
        state.rejected = state.rejected.filter(value => value !== url);
        pending.delete(url);
        correctedResponses++;
        changed = true;
      }
      state.items = state.items.map(item => {
        const binding = bindings.find(value => matchingNeteasePlaybackURL(item.url, value?.url));
        if (!binding) return item;
        matched++;
        if (item.neteaseTrackId && item.neteaseTrackId !== binding.trackId) { conflicts++; return item; }
        // Metadata can name an existing response; it must not create a new
        // candidate, change a signed URL, or mark a resource as verified.
        const named = AudioTools.candidate({ ...item, title: binding.title, artist: binding.artist,
          titleSource: 'media', source: 'page', verified: false });
        if (!named?.title) return item;
        const next = AudioTools.merge(item, named);
        // The site can receive an old URL response after switching songs.
        // A URL already associated with a song must retain that association.
        next.neteaseTrackId = binding.trackId;
        if (['filename', 'title', 'artist', 'titleSource', 'nameRecognized', 'neteaseTrackId'].some(key => next[key] !== item[key])) changed = true;
        return next;
      });
      if (changed) await chrome.storage.session.set({ [keyFor(tabId)]: state });
      if (state.items.length !== previousCount) await setBadge(tabId, state.items.length);
      await neteaseDiagnostics.record({ event: 'playback', diagnosticVersion: 1, tabId, trigger, generation,
        outcome: conflicts ? 'conflicting-track-id' : matched ? 'matched' : bindings.length ? 'no-exact-captured-url' : results[0]?.result?.diagnostic?.reason || 'no-result',
        frames: results.map(result => {
          const diagnostic = result.result?.diagnostic || { reason: 'no-result' };
          return { frameId: result.frameId, ...diagnostic,
            states: (diagnostic.states || []).map(({ playURL, ...entry }) => ({ ...entry, url: summarizeNeteaseURL(playURL) })) };
        }),
        matched, conflicts, correctedResponses, count: state.items.length,
        captured: state.items.slice(-24).map(item => ({ url: summarizeNeteaseURL(item.url),
          trackId: item.neteaseTrackId || '', named: item.nameRecognized, verified: item.verified, mime: item.mime })),
        rejected: (state.rejected || []).slice(-8).map(summarizeNeteaseURL)
      });
    });
  })().catch(error => {
    // A missing player, navigation, or changed site code leaves original
    // resources usable without inventing a song name.
    void neteaseDiagnostics.record({ event: 'reader-error', tabId, trigger, error: error?.name || 'Error' }).catch(() => {});
  });
  namingRequests.set(tabId, request);
  void request.finally(() => { if (namingRequests.get(tabId) === request) namingRequests.delete(tabId); });
  return request;
}

function awaitNeteaseM4AProof(tabId, item) {
  let pending = pendingNeteaseResponses.get(tabId);
  if (!pending) { pending = new Map(); pendingNeteaseResponses.set(tabId, pending); }
  const response = { item, at: Date.now(), generation: navigationRequests.get(tabId), allowed: false };
  pending.set(item.url, response);
  if (pending.size > 32) pending.delete(pending.keys().next().value);
  void (async () => {
    const tab = await chrome.tabs.get(tabId);
    if (pending.get(item.url) !== response || response.generation !== navigationRequests.get(tabId)) return;
    if (!isNeteasePageURL(tab.url)) {
      pending.delete(item.url);
      await rejectResponse(tabId, item.url);
      return;
    }
    response.allowed = true;
    await enrichNeteaseNames(tabId, 'mislabeled-m4a-response');
  })().catch(() => {});
}

function diagnoseNeteaseResponse(details) {
  const url = summarizeNeteaseURL(details.url);
  if (!url) return;
  const hostname = new URL(details.url).hostname;
  if (!hostname.endsWith('.music.126.net') && !hostname.endsWith('.music.163.com') && !hostname.endsWith('.00cdn.com')) return;
  const mime = AudioTools.headerValue(details.responseHeaders, 'content-type');
  if (!['media', 'xmlhttprequest', 'other'].includes(details.type) && !AudioTools.isAudioURL(details.url) && !/^(audio|video)\//i.test(mime)) return;
  void (async () => {
    const tab = await chrome.tabs.get(details.tabId);
    if (!isNeteasePageURL(tab.url)) return;
    const successful = (details.statusCode >= 200 && details.statusCode < 300) || details.statusCode === 304;
    const audio = AudioTools.isAudioURL(details.url, mime,
      AudioTools.dispositionFilename(AudioTools.headerValue(details.responseHeaders, 'content-disposition')));
    const signature = JSON.stringify([details.tabId, url.fingerprint, details.statusCode, details.type, mime,
      AudioTools.responseSize(details.responseHeaders)]);
    const now = Date.now();
    if (now - (diagnosticResponses.get(signature) || 0) < 10000) return;
    diagnosticResponses.delete(signature);
    diagnosticResponses.set(signature, now);
    if (diagnosticResponses.size > 256) diagnosticResponses.delete(diagnosticResponses.keys().next().value);
    await neteaseDiagnostics.record({ event: 'response', tabId: details.tabId, url, status: details.statusCode,
      requestType: details.type, mime, size: AudioTools.responseSize(details.responseHeaders),
      decision: !successful ? 'http-error' : audio ? 'capture' : 'not-audio',
      contentRange: AudioTools.headerValue(details.responseHeaders, 'content-range').slice(0, 100) });
    // Observe rejected responses too: otherwise an entirely missing resource
    // would leave no player snapshot explaining why it was rejected.
    if (!successful || !audio) await enrichNeteaseNames(details.tabId, 'rejected-response');
  })().catch(() => {});
}

function recordItems(tabId, rawItems, base, trusted = false) {
  return serialize(tabId, async () => {
    // Closed tabs must not leave a new session cache behind.
    let tab;
    try { tab = await chrome.tabs.get(tabId); } catch { return; }
    const state = await readState(tabId);
    const items = new Map(state.items.map(item => [item.url, item]));
    for (const raw of rawItems.slice(0, 100)) {
      const item = AudioTools.candidate({ ...raw, pageTitle: raw.pageTitle || tab.title,
        verified: trusted, source: trusted ? "network" : raw.source }, base);
      if (!item) continue;
      if (!trusted && state.rejected?.includes(item.url)) continue;
      if (trusted && state.rejected) state.rejected = state.rejected.filter(url => url !== item.url);
      if (items.has(item.url)) {
        items.set(item.url, AudioTools.merge(items.get(item.url), item));
      } else if (items.size < MAX_ITEMS) {
        items.set(item.url, { ...item, firstSeen: Date.now() });
      } else {
        state.capped = true;
      }
    }
    state.items = Array.from(items.values());
    await chrome.storage.session.set({ [keyFor(tabId)]: state });
    await setBadge(tabId, state.items.length);
  });
}

function rejectResponse(tabId, rawURL) {
  return serialize(tabId, async () => {
    try { await chrome.tabs.get(tabId); } catch { return; }
    const state = await readState(tabId);
    const url = AudioTools.normalizeURL(rawURL);
    state.items = state.items.filter(item => item.url !== url);
    state.rejected = [...new Set([...(state.rejected || []), url])].slice(-MAX_ITEMS);
    await chrome.storage.session.set({ [keyFor(tabId)]: state });
    await setBadge(tabId, state.items.length);
  });
}

function clearTab(tabId) {
  pendingNeteaseResponses.delete(tabId);
  return serialize(tabId, async () => {
    const stored = await chrome.storage.session.get(null);
    const keys = Object.keys(stored).filter(key => key === keyFor(tabId) || key.startsWith(`status:${tabId}:`) || (key.startsWith("download:") && stored[key].tabId === tabId));
    if (keys.length) await chrome.storage.session.remove(keys);
    await setBadge(tabId, 0);
  });
}

// Reset before the new document's requests start, rather than at load completion.
chrome.webRequest.onBeforeRequest.addListener(details => {
  if (details.tabId < 0 || navigationRequests.get(details.tabId) === details.requestId) return;
  navigationRequests.set(details.tabId, details.requestId);
  pendingNeteaseResponses.delete(details.tabId);
  void clearTab(details.tabId).catch(console.error);
}, { urls: ["http://*/*", "https://*/*"], types: ["main_frame"] });

chrome.webRequest.onHeadersReceived.addListener(details => {
  if (details.tabId < 0 || details.method !== "GET") return;
  // A later error or replacement response invalidates any earlier pending
  // success before asynchronous player reads can publish it.
  pendingNeteaseResponses.get(details.tabId)?.delete(AudioTools.normalizeURL(details.url));
  diagnoseNeteaseResponse(details);
  if (!((details.statusCode >= 200 && details.statusCode < 300) || details.statusCode === 304)) {
    if (details.statusCode >= 400 && (details.type === "media" || AudioTools.isAudioURL(details.url))) {
      void rejectResponse(details.tabId, details.url).catch(console.error);
    }
    return;
  }
  const headers = details.responseHeaders;
  const item = {
    url: details.url,
    mime: AudioTools.headerValue(headers, "content-type"),
    disposition: AudioTools.headerValue(headers, "content-disposition"),
    size: AudioTools.responseSize(headers),
    source: "network",
    verified: true
  };
  if (AudioTools.isAudioURL(item.url, item.mime, AudioTools.dispositionFilename(item.disposition))) {
    void recordItems(details.tabId, [item], undefined, true).then(() => enrichNeteaseNames(details.tabId, 'captured-response')).catch(console.error);
  } else if (needsNeteaseM4APlaybackProof(item.url, item.mime)) {
    awaitNeteaseM4AProof(details.tabId, item);
  } else if (item.mime && (details.type === "media" || AudioTools.isAudioURL(item.url))) {
    void rejectResponse(details.tabId, item.url).catch(console.error);
  }
}, { urls: ["http://*/*", "https://*/*"] }, ["responseHeaders"]);

chrome.tabs.onRemoved.addListener(tabId => {
  navigationRequests.delete(tabId);
  pendingNeteaseResponses.delete(tabId);
  void clearTab(tabId).catch(console.error);
});

async function scanTab(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "SCAN_AUDIO" });
  } catch {
    // Also covers pages that were already open when the extension was installed.
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["lib/audio.js", "content.js"] });
    await chrome.tabs.sendMessage(tabId, { type: "SCAN_AUDIO" });
  }
  if (queues.has(tabId)) await queues.get(tabId);
  await enrichNeteaseNames(tabId, 'scan');
  return readState(tabId);
}

async function downloadItems(tabId, urls, saveAs) {
  if (queues.has(tabId)) await queues.get(tabId);
  await enrichNeteaseNames(tabId, 'download');
  const state = await readState(tabId);
  const requested = new Set(urls);
  const items = state.items.filter(item => requested.has(item.url));
  if (!items.length) throw new Error("列表已更新，请重新扫描页面后再下载。");
  return workbench.downloadItems(tabId, items, saveAs);
}

chrome.downloads.onChanged.addListener(delta => {
  if (!delta.state && !delta.error) return;
  void workbench.downloadChanged(delta).catch(console.error);
});

async function handleMessage(message, sender) {
  if (message.type === "REPORT_AUDIO") {
    if (!sender.tab || !Array.isArray(message.items)) throw new Error("无效的页面报告。");
    await recordItems(sender.tab.id, message.items, sender.url);
    await enrichNeteaseNames(sender.tab.id, 'page-report');
    return { ok: true };
  }
  // Downloads and tab actions can only be requested from our own extension UI.
  if (!isTrustedUI(sender, chrome.runtime.getURL('/'))) throw new Error("不允许此操作。");
  if (message.type === 'CLOSE_PANEL') {
    if (!Number.isInteger(message.windowId)) throw new Error('无效的浏览器窗口。');
    if (chrome.sidePanel?.close) {await chrome.sidePanel.close({windowId:message.windowId}); return {closed:true};}
    return {closed:false,useBrowserClose:true};
  }
  if (['GET_WORKBENCH','NATIVE_CONNECT','SAVE_SETTINGS','CHOOSE_DIRECTORY','ADD_CONVERSION_FILES',
    'START_CONVERSION','CANCEL_CONVERSION','RETRY_CONVERSION','RETRY_DOWNLOAD','OPEN_TASK'].includes(message.type)) return workbench.handle(message);
  if (!Number.isInteger(message.tabId) || message.tabId < 0) throw new Error("请先打开一个网页。");
  switch (message.type) {
    case "GET_AUDIO":
      if (queues.has(message.tabId)) await queues.get(message.tabId);
      await enrichNeteaseNames(message.tabId);
      return readState(message.tabId);
    case "SCAN_TAB": return scanTab(message.tabId);
    case "CLEAR_TAB": await clearTab(message.tabId); return emptyState();
    case "DOWNLOAD_AUDIO":
      if (!Array.isArray(message.urls)) throw new Error("请选择音频。");
      return downloadItems(message.tabId, message.urls.slice(0, MAX_ITEMS), {saveAs:message.saveAs,convert:message.convert});
    default: throw new Error("未知操作。");
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!message || typeof message.type !== "string") return;
  handleMessage(message, sender).then(data => respond({ ok: true, data }))
    .catch(error => respond({ ok: false, error: error.message || "操作失败，请重试。" }));
  return true;
});

// Preferences stay on this device and are not sent through browser sync.
chrome.runtime.onInstalled.addListener(() => {
  void chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
});

// A global panel stays visible while switching tabs. Repeated action clicks keep it open.
if (chrome.sidePanel) {
  void chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:false}).catch(console.error);
  chrome.action.onClicked.addListener(tab => {
    void chrome.sidePanel.open({windowId:tab.windowId}).catch(console.error);
  });
}
