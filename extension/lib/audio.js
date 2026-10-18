/* Shared by isolated content scripts, extension pages and the service worker. */
(() => {
  const extensions = new Set(["mp3", "m4a", "aac", "wav", "wave", "flac", "ogg", "oga", "opus", "weba", "aif", "aiff", "wma", "amr", "ac3", "caf", "mka", "mid", "midi"]);
  const mimeExtensions = {
    "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/mp4": "m4a", "audio/x-m4a": "m4a",
    "audio/aac": "aac", "audio/aacp": "aac", "audio/wav": "wav", "audio/wave": "wav",
    "audio/x-wav": "wav", "audio/vnd.wave": "wav", "audio/flac": "flac", "audio/x-flac": "flac",
    "audio/ogg": "ogg", "application/ogg": "ogg", "audio/opus": "opus", "audio/webm": "weba",
    "audio/aiff": "aiff", "audio/x-aiff": "aiff", "audio/x-ms-wma": "wma", "audio/amr": "amr",
    "audio/ac3": "ac3", "audio/x-caf": "caf", "audio/x-matroska": "mka", "audio/midi": "mid"
  };

  function decode(value) {
    try { return decodeURIComponent(value); } catch { return value; }
  }

  function normalizeURL(value, base) {
    if (typeof value !== "string" || !value.trim() || value.length > 16384) return null;
    try {
      const url = new URL(value, base);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
      url.hash = "";
      return url.href;
    } catch { return null; }
  }

  function extensionOf(name) {
    const match = String(name || "").toLowerCase().match(/\.([a-z0-9]+)$/);
    return match && extensions.has(match[1]) ? match[1] : "";
  }

  function extensionFromURL(value) {
    try {
      const url = new URL(value);
      const pathExtension = extensionOf(decode(url.pathname.split("/").pop()));
      if (pathExtension) return pathExtension;
      for (const key of ["filename", "file", "name", "download"]) {
        const ext = extensionOf(url.searchParams.get(key));
        if (ext) return ext;
      }
      const format = (url.searchParams.get("format") || "").toLowerCase();
      return extensions.has(format) ? format : "";
    } catch { return ""; }
  }

  function cleanMime(value) { return String(value || "").split(";")[0].trim().toLowerCase(); }

  function isAudioURL(value, mime = "", filenameHint = "") {
    const normalized = normalizeURL(value);
    if (!normalized) return false;
    const url = new URL(normalized);
    const type = cleanMime(mime);
    // Playlists and media fragments are not standalone audio files.
    if (/\.(?:m3u8?|mpd|m4s|cmfa|cmfv|ts|pls)$/i.test(url.pathname) || /mpegurl|dash\+xml|scpls/.test(type)) return false;
    const audioMime = type.startsWith("audio/") || type === "application/ogg";
    if (type && !audioMime && !["application/octet-stream", "binary/octet-stream", "application/download", "application/x-download", "application/force-download"].includes(type)) return false;
    return Boolean(extensionFromURL(normalized) || extensionOf(filenameHint) || audioMime);
  }

  function dispositionFilename(value) {
    const extended = String(value || "").match(/filename\*\s*=\s*(?:"?)(?:UTF-8|utf-8)'[^']*'([^;"\r\n]+)/);
    if (extended) return decode(extended[1].trim());
    const normal = String(value || "").match(/filename\s*=\s*(?:"([^"\r\n]+)"|([^;\r\n]+))/i);
    return normal ? (normal[1] || normal[2]).trim() : "";
  }

  function sanitizeFilename(value) {
    let name = String(value || "").normalize("NFC").replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "_")
      .replace(/^[.\s]+|[.\s]+$/g, "").replace(/\s+/g, " ");
    if (!name) name = "音频";
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
    return Array.from(name).slice(0, 120).join("");
  }

  // Element labels are directly associated; Media Session metadata is global.
  const titleRanks = { element: 3, media: 2, link: 1 };

  function cleanTitle(value) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, 200);
  }

  function readableName(value) {
    const name = cleanTitle(value);
    const ext = extensionOf(name);
    const stem = (ext ? name.slice(0, -ext.length - 1) : name).trim();
    if (!stem || /\uFFFD/.test(stem)) return false;
    const compact = stem.replace(/[-_]/g, "");
    if (/^[a-f0-9]{16,}$/i.test(compact) || /^\d{8,}$/.test(stem)) return false;
    if (/^[a-z0-9_-]{24,}$/i.test(stem) && (stem.match(/\d/g) || []).length >= 4) return false;
    return !/^(?:(?:点击此处|点击|点此|立即|马上|开始|在线|免费|一键)?(?:播放|试听|收听|下载)(?:这首|该|本)?(?:音频|音乐|歌曲|文件|mp3|wav|flac)?(?:文件)?|音频|音乐|歌曲|未知(?:歌曲|音频)?|未命名(?:音频|歌曲)?|(?:play|listen|download)(?:\s+(?:now|audio|music|song|file))?|audio(?:[-_ ]?endpoint)?|music|song|track|file|stream|media|attachment|endpoint|get|unknown|untitled|null|undefined)$/i.test(stem);
  }

  function namingFor(item) {
    const url = new URL(item.url);
    const mimeExt = mimeExtensions[cleanMime(item.mime)] || "";
    const urlExt = extensionFromURL(item.url);
    const file = (value, source) => ({ value: decode(String(value || "")), kind: "file", source });
    const hint = file(item.filenameHint, "download");
    const title = { value: item.title && item.artist && !item.title.includes(item.artist) ? `${item.title} - ${item.artist}` : item.title,
      kind: "title", source: Object.hasOwn(titleRanks, item.titleSource) ? item.titleSource : "element" };
    const files = [file(dispositionFilename(item.disposition), "disposition"), file(url.searchParams.get("filename"), "query"),
      file(url.searchParams.get("file"), "query"), file(url.searchParams.get("name"), "query"),
      file(url.searchParams.get("download"), "query"), file(url.pathname.split("/").pop(), "path")];
    const isReadable = option => readableName(option.kind === "file" ? option.value.replace(/\.[a-z0-9]{1,8}$/i, "") : option.value);
    // An explicit download attribute is more precise than a link's caption.
    const specific = item.titleSource === "link" ? [hint, title] : [title, hint];
    const choice = [...specific, ...files, { value: item.pageTitle, kind: "title", source: "page" }]
      .find(isReadable) || [hint, ...files].find(option => option.value) || { value: "音频", kind: "title", source: "fallback" };
    let name = sanitizeFilename(choice.value);
    const ext = urlExt || mimeExt || extensionOf(decode(dispositionFilename(item.disposition))) || extensionOf(hint.value);
    if (ext) {
      const existing = extensionOf(name);
      if (existing) name = name.slice(0, -existing.length - 1);
      else if (choice.kind === "file") name = name.replace(/\.[a-z0-9]{1,8}$/i, "");
      name = `${sanitizeFilename(name)}.${ext}`;
    }
    // NetEase's obj_ filenames are storage keys, even when they happen to pass
    // the generic readability heuristic. Preserve the 1.1 filename choice until
    // actual song metadata arrives, but keep these file keys in the unnamed group.
    const objectFilename = choice.kind === "file" && /^obj_[a-z0-9_-]{12,}(?:\.[a-z0-9]{1,8})?$/i.test(choice.value);
    return { filename: name, nameSource: choice.source,
      nameRecognized: !["page", "fallback"].includes(choice.source) && isReadable(choice) && !objectFilename };
  }

  function filenameFor(item) { return namingFor(item).filename; }

  function headerValue(headers, name) {
    return (headers || []).find(header => header.name.toLowerCase() === name.toLowerCase())?.value || "";
  }

  function responseSize(headers) {
    const range = headerValue(headers, "content-range").match(/\/(\d+)$/);
    const value = Number(range?.[1] || headerValue(headers, "content-length"));
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }

  function candidate(raw, base) {
    const url = normalizeURL(raw?.url, base);
    if (!url) return null;
    const fromAudioElement = raw.fromAudioElement === true && raw.source === "page" && !raw.mime &&
      !new URL(url).pathname.split("/").pop().includes(".");
    if (!fromAudioElement && !isAudioURL(url, raw.mime, dispositionFilename(raw.disposition) || raw.filenameHint)) return null;
    const item = {
      url,
      mime: cleanMime(raw.mime).slice(0, 100),
      disposition: String(raw.disposition || "").slice(0, 1000),
      filenameHint: String(raw.filenameHint || "").slice(0, 200),
      title: readableName(raw.title) ? cleanTitle(raw.title) : "",
      artist: readableName(raw.artist) ? cleanTitle(raw.artist) : "",
      titleSource: Object.hasOwn(titleRanks, raw.titleSource) ? raw.titleSource : "element",
      pageTitle: cleanTitle(raw.pageTitle),
      fromAudioElement,
      size: Number.isSafeInteger(raw.size) && raw.size > 0 ? raw.size : null,
      source: ["network", "page", "resource"].includes(raw.source) ? raw.source : "page",
      verified: raw.verified === true
    };
    Object.assign(item, namingFor(item));
    item.format = (extensionFromURL(url) || extensionOf(item.filename) || mimeExtensions[item.mime] || item.mime.replace(/^audio\//, "") || "音频").toUpperCase();
    return item;
  }

  function merge(oldItem, newItem) {
    const result = { ...oldItem };
    for (const key of ["mime", "disposition", "filenameHint", "pageTitle", "size"]) {
      if (newItem[key] && (!oldItem[key] || newItem.source === "network" || key === "pageTitle")) result[key] = newItem[key];
    }
    if (newItem.title && (!oldItem.title || (titleRanks[newItem.titleSource] || 0) >= (titleRanks[oldItem.titleSource] || 0))) {
      if (newItem.artist || newItem.title !== oldItem.title) result.artist = newItem.artist || "";
      result.title = newItem.title;
      result.titleSource = newItem.titleSource;
    }
    result.verified = oldItem.verified || newItem.verified;
    result.source = result.verified ? "network" : (oldItem.source === "page" || newItem.source === "page" ? "page" : "resource");
    Object.assign(result, namingFor(result));
    result.format = (extensionFromURL(result.url) || extensionOf(result.filename) || mimeExtensions[result.mime] || result.mime.replace(/^audio\//, "") || "音频").toUpperCase();
    return result;
  }

  function formatBytes(bytes) {
    if (!bytes || bytes < 0) return "大小未知";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  }

  globalThis.AudioTools = Object.freeze({ normalizeURL, extensionOf, extensionFromURL, isAudioURL, cleanMime,
    dispositionFilename, sanitizeFilename, filenameFor, namingFor, readableName, headerValue, responseSize, candidate, merge, formatBytes });
})();
