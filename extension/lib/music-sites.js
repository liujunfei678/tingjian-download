// Only the desktop origins whose current players have an adapter below.
export function musicSiteForURL(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    const sites = {'kuwo.cn':'kuwo','www.kuwo.cn':'kuwo','y.qq.com':'qq',
      'kugou.com':'kugou','www.kugou.com':'kugou'};
    return Object.hasOwn(sites,url.hostname) ? sites[url.hostname] : '';
  } catch { return ''; }
}

// Serialized into MAIN world. Keep helpers inside this function. Read the
// existing current player only; do not call site APIs, initialize playback,
// inspect queues, or construct media addresses from a song ID.
export function readMusicSitePlayback() {
  try {
    const pageURL = new URL(location.href);
    if (!['http:', 'https:'].includes(pageURL.protocol) || pageURL.username || pageURL.password) return [];
    const sites = {'kuwo.cn':'kuwo','www.kuwo.cn':'kuwo','y.qq.com':'qq',
      'kugou.com':'kugou','www.kugou.com':'kugou'};
    if (!Object.hasOwn(sites,pageURL.hostname)) return [];
    const site = sites[pageURL.hostname];
    let budget = 1024;
    const own = (object, key) => {
      if (!object || !['object','function'].includes(typeof object) || budget-- <= 0) return undefined;
      try {
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
      } catch { return undefined; }
    };
    const text = value => typeof value === 'string' ? value.replace(/\s+/g,' ').trim().slice(0,200) : '';
    const audioURL = value => {
      if (typeof value !== 'string' || value.length > 16384) return '';
      try {
        const url = new URL(value);
        if (!['http:','https:'].includes(url.protocol) || url.username || url.password) return '';
        const hosts = {kuwo:['kuwo.cn'],qq:['qqmusic.qq.com','qqmusic.tc.qq.com'],kugou:['kugou.com','kugou.net','kg.qq.com']}[site];
        if (!hosts.some(host => url.hostname === host || url.hostname.endsWith('.'+host))) return '';
        if (!/\.(?:mp3|m4a|aac|wav|flac|ogg|oga|opus|weba|aiff?|wma|amr|ac3|caf|mka)$/i.test(url.pathname)) return '';
        url.hash = '';
        return url.href;
      } catch { return ''; }
    };
    const loadedSource = audio => {
      if (!audio || audio.error || audio.readyState < 1) return '';
      const current = audioURL(audio.currentSrc);
      // During a song switch the DOM src can already be new while currentSrc
      // still names the old song. Wait for the new source to load.
      return current && current === audioURL(audio.getAttribute('src')) ? current : '';
    };
    const result = (trackId,title,artist,url) => trackId && title && url ? [{site,trackId,title,artist,url}] : [];

    if (site === 'kuwo') {
      // Kuwo renders the footer title, detail link and audio src from the same
      // currentSong. A detail-page heading may instead describe another song.
      const footer = document.querySelector('.playControl .con_l');
      const url = loadedSource(document.querySelector('.playControl audio'));
      if (!footer || !url) return [];
      const href = footer.querySelector('a[href*="/play_detail/"]')?.getAttribute('href');
      const link = href ? new URL(href, location.href) : null;
      const trackId = link?.origin === location.origin ? /^\/play_detail\/([1-9]\d{0,19})\/?$/.exec(link.pathname)?.[1] || '' : '';
      const title = text(footer.querySelector('.song_name')?.textContent);
      const artist = text(footer.querySelector('.artist')?.textContent).replace(/^[-–—]\s*/, '');
      return result(trackId,title,artist,url);
    }

    if (site === 'qq') {
      // Current ryqq_v2 React class owns state.playSong and player.playUrlMap.
      // Follow only the mounted player's DOM fiber ancestry, never children,
      // arbitrary window objects, React queues or component methods.
      const root = document.querySelector('.mod_player');
      if (!root) return [];
      const key = Object.getOwnPropertyNames(root).slice(0,128).find(value => /^__react(?:Fiber|InternalInstance)\$/.test(value));
      let fiber = key ? own(root,key) : null;
      const visited = new Set();
      for (let depth = 0; fiber && depth < 40 && !visited.has(fiber); depth++, fiber = own(fiber,'return')) {
        visited.add(fiber);
        const instance = own(fiber,'stateNode');
        const state = own(instance,'state');
        const player = own(instance,'player');
        const song = own(state,'playSong');
        const trackId = own(song,'mid');
        if (typeof trackId !== 'string' || !/^[a-zA-Z0-9]{8,32}$/.test(trackId) || own(player,'currentMid') !== trackId) continue;
        const stateMid = own(state,'currentMid');
        if (stateMid != null && stateMid !== trackId) continue;
        const url = audioURL(own(own(player,'playUrlMap'),trackId));
        if (!url) continue;
        const singers = own(song,'singer');
        const artists = [];
        if (Array.isArray(singers)) for (let index=0; index<Math.min(own(singers,'length') || 0,16); index++) {
          const name = text(own(own(singers,String(index)),'name'));
          if (name) artists.push(name);
        }
        return result(trackId,text(own(song,'name')) || text(own(song,'title')),artists.join(' / ').slice(0,200),url);
      }
      return [];
    }

    if (site === 'kugou') {
      const audio = document.querySelector('#myAudio');
      const url = loadedSource(audio);
      if (!url) return [];
      const song = own(own(own(window,'play'),'globalParam'),'song_info');
      const hash = own(song,'hash');
      const trackId = typeof hash === 'string' && /^[a-f0-9]{32}$/i.test(hash) ? hash.toLowerCase() : '';
      if (!trackId || audio.getAttribute('data-hash')?.toLowerCase() !== trackId) return [];
      if (url !== audioURL(own(song,'play_url')) && url !== audioURL(own(song,'play_backup_url'))) return [];
      return result(trackId,text(own(song,'song_name')),text(own(song,'author_name')),url);
    }
    return [];
  } catch { return []; }
}
