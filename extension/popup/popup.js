import "../lib/audio.js";

const $ = id => document.getElementById(id);
const selected = new Set();
const busyURLs = new Set();
const statuses = new Map();
let tabId;
let state = { items: [], capped: false };
let visibleItems = [];
let downloadBusy = false;
let readVersion = 0;

async function request(type, extra = {}) {
  const response = await chrome.runtime.sendMessage({ type, tabId, ...extra });
  if (!response?.ok) throw new Error(response?.error || "扩展暂时没有响应，请重试。");
  return response.data;
}

function notify(message, error = false) {
  $("notice").textContent = message;
  $("notice").classList.toggle("error", error);
  $("notice").hidden = false;
}

function updateSelection() {
  $("selected-count").textContent = `已选 ${selected.size} 个`;
  const all = visibleItems.length > 0 && visibleItems.every(item => selected.has(item.url));
  $("select-all").checked = all;
  $("select-all").indeterminate = !all && visibleItems.some(item => selected.has(item.url));
  $("download-selected").disabled = !selected.size || downloadBusy;
  $("download-selected").textContent = downloadBusy ? "正在提交下载…" : selected.size ? `下载所选音频（${selected.size}）` : "下载所选音频";
}

function render() {
  const validURLs = new Set(state.items.map(item => item.url));
  for (const url of selected) if (!validURLs.has(url)) selected.delete(url);
  const term = $("search").value.trim().toLowerCase();
  visibleItems = state.items.filter(item => [item.filename, item.title, item.format, item.url].join(" ").toLowerCase().includes(term));
  $("count").textContent = state.items.length;
  $("clear").disabled = !state.items.length;
  $("limit").hidden = !state.capped;
  $("selectbar").hidden = !visibleItems.length;
  $("empty").hidden = visibleItems.length > 0;
  if (state.items.length && !visibleItems.length) {
    $("empty-title").textContent = "没有匹配的音频";
    $("empty-description").textContent = "换个关键词，或清除搜索条件。";
  } else {
    $("empty-title").textContent = "还没有发现音频";
    $("empty-description").textContent = "试着播放页面里的音频。新的音频链接会自动出现在这里。";
  }
  const fragment = document.createDocumentFragment();
  for (const item of visibleItems) {
    const card = $("audio-template").content.firstElementChild.cloneNode(true);
    card.dataset.url = item.url;
    card.querySelector(".format").textContent = item.format;
    card.querySelector(".file-size").textContent = AudioTools.formatBytes(item.size);
    card.querySelector(".source").textContent = item.verified ? "网络已识别" : item.source === "page" ? "页面链接" : "已加载资源";
    card.querySelector(".file-name").textContent = item.filename;
    card.querySelector(".file-name").title = item.title || item.filename;
    card.querySelector(".file-host").textContent = new URL(item.url).hostname;
    card.querySelector(".file-host").title = item.url;
    const status = statuses.get(item.url);
    if (status) {
      const text = card.querySelector(".download-state");
      text.hidden = false;
      text.classList.toggle("failed", status.state === "interrupted");
      text.textContent = status.state === "complete" ? "已下载" : status.state === "interrupted" ? `下载未完成：${status.error || "请在浏览器下载记录中查看"}` : "下载中，可在浏览器下载记录查看进度";
    }
    const checkbox = card.querySelector(".item-select");
    checkbox.checked = selected.has(item.url);
    checkbox.setAttribute("aria-label", `选择 ${item.filename}`);
    checkbox.addEventListener("change", () => {
      checkbox.checked ? selected.add(item.url) : selected.delete(item.url);
      updateSelection();
    });
    card.querySelector(".copy-button").addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(item.url); notify("音频链接已复制。"); }
      catch { notify("复制失败，请保持扩展窗口打开后重试。", true); }
    });
    const downloadButton = card.querySelector(".download-button");
    downloadButton.disabled = busyURLs.has(item.url) || downloadBusy;
    downloadButton.textContent = busyURLs.has(item.url) ? "提交中…" : "下载";
    downloadButton.addEventListener("click", () => void download([item.url]));
    fragment.append(card);
  }
  const list = $("audio-list");
  list.hidden = !visibleItems.length;
  const scroll = list.scrollTop;
  list.replaceChildren(fragment);
  list.scrollTop = scroll;
  updateSelection();
}

async function download(urls) {
  if (downloadBusy) return;
  downloadBusy = true;
  urls.forEach(url => busyURLs.add(url));
  render();
  try {
    const results = await request("DOWNLOAD_AUDIO", { urls, saveAs: $("save-as").checked });
    const failures = results.filter(result => result.error);
    for (const result of results) {
      if (!result.error) {
        const [actual] = await chrome.downloads.search({ id: result.id });
        statuses.set(result.url, { state: actual?.state || "in_progress", error: actual?.error || "" });
        selected.delete(result.url);
      }
    }
    const succeeded = results.length - failures.length;
    notify(failures.length ? `${succeeded} 个下载已提交，${failures.length} 个未开始：${failures[0].error}` : `已提交 ${succeeded} 个下载，可在浏览器下载记录中查看。`, failures.length > 0);
  } catch (error) { notify(error.message, true); }
  finally { downloadBusy = false; urls.forEach(url => busyURLs.delete(url)); render(); }
}

async function refresh(type = "GET_AUDIO") {
  const version = ++readVersion;
  const next = await request(type);
  if (version !== readVersion) return;
  state = next;
  render();
}

$("search").addEventListener("input", render);
$("select-all").addEventListener("change", () => {
  visibleItems.forEach(item => $("select-all").checked ? selected.add(item.url) : selected.delete(item.url));
  render();
});
$("download-selected").addEventListener("click", () => void download(Array.from(selected)));
$("save-as").addEventListener("change", () => void chrome.storage.local.set({ saveAs: $("save-as").checked }));
$("scan").addEventListener("click", async () => {
  $("scan").disabled = true;
  $("scan").textContent = "扫描中…";
  try { await refresh("SCAN_TAB"); notify("已重新扫描。播放音频后还能发现新的链接。"); }
  catch { notify("当前页面无法扫描。请打开普通网页，安装后刷新页面再播放音频。", true); }
  finally { $("scan").disabled = false; $("scan").textContent = "重新扫描"; }
});
$("clear").addEventListener("click", async () => {
  try { ++readVersion; state = await request("CLEAR_TAB"); selected.clear(); statuses.clear(); render(); notify("列表已清空。点击重新扫描可找回页面链接。"); }
  catch (error) { notify(error.message, true); }
});
$("open-downloads").addEventListener("click", () => {
  const url = navigator.userAgent.includes("Edg/") ? "edge://downloads/" : "chrome://downloads/";
  void chrome.tabs.create({ url });
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "session" || tabId === undefined) return;
  if (changes[`audio:${tabId}`]) void refresh().catch(error => notify(error.message, true));
  const prefix = `status:${tabId}:`;
  for (const [key, change] of Object.entries(changes)) {
    if (key.startsWith(prefix)) {
      const url = key.slice(prefix.length);
      change.newValue ? statuses.set(url, change.newValue) : statuses.delete(url);
    }
  }
  render();
});

async function initialize() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error("请先打开一个网页。");
  tabId = tab.id;
  $("page-title").textContent = tab.title || "当前网页";
  $("page-title").title = tab.title || "";
  let accessible = false;
  try {
    const url = new URL(tab.url);
    accessible = ["http:", "https:"].includes(url.protocol);
    $("page-host").textContent = accessible ? url.hostname : "浏览器内部页面";
  } catch { $("page-host").textContent = "请打开普通网页"; }
  $("save-as").checked = (await chrome.storage.local.get({ saveAs: false })).saveAs;
  const cached = await chrome.storage.session.get(null);
  for (const [key, value] of Object.entries(cached)) {
    if (key.startsWith(`status:${tabId}:`)) statuses.set(key.slice(`status:${tabId}:`.length), value);
  }
  await refresh();
  $("scan").disabled = !accessible;
  if (accessible) {
    try { await refresh("SCAN_TAB"); }
    catch { notify("本页暂时无法扫描。安装后刷新页面，再播放音频即可继续识别。", true); }
  } else {
    $("empty-title").textContent = "请打开一个普通网页";
    $("empty-description").textContent = "扩展可在 HTTP / HTTPS 网页中识别音频。";
    document.querySelector(".live").textContent = "等待打开网页";
  }
}

initialize().catch(error => notify(error.message, true));
