(() => {
  if (globalThis.__tingjianInstalled) return;
  globalThis.__tingjianInstalled = true;
  const { candidate } = globalThis.AudioTools;
  let stopped = false;
  let scheduled;
  let forceNext = false;
  const reported = new Map();
  const resourceURLs = new Set();

  function collect() {
    const found = new Map();
    const add = raw => {
      const item = candidate({ ...raw, pageTitle: document.title }, document.baseURI);
      if (item) found.set(item.url, found.has(item.url) ? AudioTools.merge(found.get(item.url), item) : item);
    };
    const elements = Array.from(document.querySelectorAll("audio, video"));
    // A blob/data/MediaStream player still owns metadata even though it cannot
    // supply a downloadable HTTP URL. Only genuinely empty players are ignored.
    const players = elements.filter(element => element.srcObject ||
      (element.currentSrc || element.getAttribute("src") || "").trim() ||
      Array.from(element.querySelectorAll("source[src]")).some(source => (source.getAttribute("src") || "").trim()));
    const playing = elements.filter(element => !element.paused && !element.ended && element.currentSrc);
    const metadata = navigator.mediaSession?.metadata;
    // Metadata describes the current player, not every link on the page.
    const mediaTitle = metadata && AudioTools.readableName(metadata.title) ?
      [metadata.title, AudioTools.readableName(metadata.artist) ? metadata.artist : ""].filter(Boolean).join(" - ") : "";
    const elementTitle = element => [element.getAttribute("title"), element.getAttribute("aria-label")]
      .find(value => AudioTools.readableName(value)) || "";
    elements.forEach(element => {
      const title = elementTitle(element);
      const matchedTitle = title && (title === metadata?.title || title === mediaTitle);
      const linkedMetadata = matchedTitle || (players.length === 1 && !title);
      const isCurrentPlayer = playing.length === 1 && playing[0] === element && mediaTitle && linkedMetadata;
      const currentURL = AudioTools.normalizeURL(element.currentSrc || element.src, document.baseURI);
      const playerTitle = isCurrentPlayer ? title || metadata.title : title;
      const artist = isCurrentPlayer ? metadata.artist : "";
      const titleSource = isCurrentPlayer && !title ? "media" : "element";
      add({ url: currentURL, title: playerTitle, artist,
        titleSource, fromAudioElement: element.tagName === "AUDIO", source: "page" });
      element.querySelectorAll("source[src]").forEach(source => {
        const isCurrentSource = isCurrentPlayer && AudioTools.normalizeURL(source.src) === currentURL;
        add({ url: source.src, mime: source.type, title: isCurrentSource ? playerTitle : title,
          artist: isCurrentSource ? artist : "", titleSource: isCurrentSource ? titleSource : "element", source: "page" });
      });
    });
    document.querySelectorAll("a[href]").forEach(link => add({ url: link.href, mime: link.type,
      filenameHint: link.getAttribute("download"), title: elementTitle(link) || link.textContent.trim(), titleSource: "link", source: "page" }));
    for (const url of resourceURLs) add({ url, source: "resource" });
    return Array.from(found.values());
  }

  async function scan(force = false) {
    if (stopped) return;
    const items = collect().filter(item => {
      const signature = JSON.stringify(item);
      if (!force && reported.get(item.url) === signature) return false;
      reported.set(item.url, signature);
      return true;
    });
    try {
      for (let start = 0; start < items.length; start += 100) {
        await chrome.runtime.sendMessage({ type: "REPORT_AUDIO", items: items.slice(start, start + 100) });
      }
    } catch (error) {
      // A reloaded extension invalidates old isolated worlds; they must go quiet.
      if (String(error).includes("context invalidated")) {
        stopped = true;
        observer.disconnect();
        resourceObserver?.disconnect();
      } else {
        for (const item of items) reported.delete(item.url);
      }
    }
  }

  function schedule(force = false) {
    forceNext ||= force;
    if (scheduled || stopped) return;
    scheduled = setTimeout(() => {
      scheduled = undefined;
      const forceScan = forceNext;
      forceNext = false;
      void scan(forceScan);
    }, 350);
  }

  function rememberResource(entry) {
    if (!AudioTools.isAudioURL(entry.name) || resourceURLs.has(entry.name)) return false;
    if (resourceURLs.size >= 500) resourceURLs.delete(resourceURLs.values().next().value);
    resourceURLs.add(entry.name);
    return true;
  }

  performance.getEntriesByType("resource").forEach(rememberResource);
  const observer = new MutationObserver(records => {
    if (records.some(record => ["childList", "attributes", "characterData"].includes(record.type))) schedule();
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ["src", "href", "type", "download", "title", "aria-label"] });
  let resourceObserver;
  try {
    resourceObserver = new PerformanceObserver(list => {
      let changed = false;
      for (const entry of list.getEntries()) changed = rememberResource(entry) || changed;
      if (changed) schedule();
    });
    resourceObserver.observe({ type: "resource", buffered: true });
  } catch { /* DOM and webRequest detection remain available. */ }
  document.addEventListener("loadedmetadata", () => schedule(), true);
  document.addEventListener("play", () => schedule(), true);
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message.type !== "SCAN_AUDIO") return;
    scan(true).then(() => respond({ ok: true }));
    return true;
  });
  void scan(true);
})();
