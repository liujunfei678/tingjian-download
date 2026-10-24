import '../lib/audio.js';

const $ = id => document.getElementById(id);
const initialPrefs = { downloadMode: 'browser', downloadDirectory: '', conversionDirectory: '', bitrate: 320, saveAs: false, recursive: false };
const perTab = new Map();
const statuses = new Map();
const activeStates = new Set(['running', 'downloading', 'publishing', 'in_progress']);
const retryStates = new Set(['failed', 'cancelled', 'interrupted']);
let workbench = { prefs: { ...initialPrefs }, host: { connected: false }, downloads: [], conversions: [] };
let windowId, tabId, currentTab;
let resources = { items: [], capped: false };
let visibleItems = [];
let readVersion = 0, followVersion = 0, workbenchVersion = 0;
let downloading = false, scanning = false, loadingResources = true;
let noticeTimer;

function tabState(id = tabId) {
  if (!perTab.has(id)) perTab.set(id, { selected: new Set(), search: '' });
  return perTab.get(id);
}
function selected() { return tabState().selected; }
async function request(type, data = {}) {
  const result = await chrome.runtime.sendMessage({ type, tabId, ...data });
  if (!result?.ok) throw new Error(result?.error || '工作台暂时没有响应，请重试。');
  return result.data;
}
function notify(message, error = false) {
  clearTimeout(noticeTimer);
  $('notice-text').textContent = message;
  $('notice').classList.toggle('error', error);
  $('notice').hidden = false;
  noticeTimer = setTimeout(() => { $('notice').hidden = true; }, error ? 16000 : 7000);
}
async function perform(button, operation) {
  if (button?.disabled) return;
  if (button) button.disabled = true;
  try { return await operation(); }
  catch (error) { notify(error.message, true); }
  finally { if (button) button.disabled = false; renderWorkbench(); }
}
function setView(view) {
  for (const button of document.querySelectorAll('.tab')) {
    const active = button.dataset.view === view;
    button.classList.toggle('active', active);
    active ? button.setAttribute('aria-current', 'page') : button.removeAttribute('aria-current');
    $('view-' + button.dataset.view).hidden = !active;
  }
}
async function hostRequired() {
  if (workbench.host.connected) return true;
  try {
    await updateFromResponse(await request('NATIVE_CONNECT'));
    if (workbench.host.connected) return true;
  } catch { /* Missing hosts are explained with the actionable setup view below. */ }
  setView('settings');
  $('setup-help').hidden = false;
  $('setup-help-toggle').setAttribute('aria-expanded', 'true');
  notify('请先配置并连接本地组件，即可选择文件夹和转换 M4A。浏览器默认目录仍可直接下载。', true);
  return false;
}
function setText(id, value) { const node = $(id); node.textContent = value; }
function hostOf(url) { try { return new URL(url).hostname; } catch { return '音频资源'; } }
function recognized(item) { return item.nameRecognized === true; }
function formatOf(item) { return String(item.format || item.filename?.split('.').pop() || 'audio').toLowerCase(); }
function isM4A(item) { return formatOf(item) === 'm4a'; }
function renderSelection() {
  const selection = selected();
  setText('selected-count', `已选 ${selection.size} 个`);
  const all = visibleItems.length > 0 && visibleItems.every(item => selection.has(item.url));
  $('select-all').checked = all;
  $('select-all').indeterminate = !all && visibleItems.some(item => selection.has(item.url));
  $('select-all').disabled = !visibleItems.length;
  $('download-selected').disabled = !selection.size || downloading;
  setText('download-selected', downloading ? '正在提交下载…' : selection.size ? `下载所选 ${selection.size} 个` : '下载所选音频');
  for (const group of document.querySelectorAll('.resource-group')) {
    const items = visibleItems.filter(item => recognized(item) === (group.dataset.group === 'recognized'));
    const allInGroup = items.length > 0 && items.every(item => selection.has(item.url));
    const checkbox = group.querySelector('.group-select');
    checkbox.checked = allInGroup;
    checkbox.indeterminate = !allInGroup && items.some(item => selection.has(item.url));
    checkbox.disabled = !items.length;
  }
}
function statusFor(item) {
  const matching = workbench.downloads.filter(task => task.tabId === tabId && task.url === item.url);
  return matching[0] || statuses.get(`${tabId}:${item.url}`);
}
function renderResources() {
  const valid = new Set(resources.items.map(item => item.url));
  if (!loadingResources) for (const url of selected()) if (!valid.has(url)) selected().delete(url);
  const term = $('search').value.trim().toLowerCase();
  visibleItems = resources.items.filter(item => [item.filename, item.title, item.format, item.url].join(' ').toLowerCase().includes(term));
  setText('count', resources.items.length);
  $('clear').disabled = !resources.items.length;
  $('limit').hidden = !resources.capped;
  $('audio-list').hidden = !resources.items.length;
  $('empty').hidden = visibleItems.length > 0;
  $('resource-scroll').setAttribute('aria-busy', String(loadingResources));
  if (loadingResources) {
    setText('empty-title', '正在读取网页音频…'); setText('empty-description', '侧栏会自动跟随这个窗口的活动网页。');
  } else if (resources.items.length && !visibleItems.length) {
    setText('empty-title', '没有匹配的音频'); setText('empty-description', '换个关键词，或清除搜索条件。');
  } else if (currentTab && !isWebTab(currentTab)) {
    setText('empty-title', '请打开一个普通网页'); setText('empty-description', '听见可在 HTTP / HTTPS 网页中收集音频。');
  } else {
    setText('empty-title', '还没有发现音频'); setText('empty-description', '试着播放页面里的音频。新的链接会自动出现在这里。');
  }
  for (const group of document.querySelectorAll('.resource-group')) {
    const groupRecognized = group.dataset.group === 'recognized';
    const items = visibleItems.filter(item => recognized(item) === groupRecognized);
    const total = resources.items.filter(item => recognized(item) === groupRecognized).length;
    group.querySelector('.group-count').textContent = term ? `${items.length} / ${total}` : String(total);
    const fragment = document.createDocumentFragment();
    for (const item of items) {
      const card = $('audio-template').content.firstElementChild.cloneNode(true);
      card.dataset.url = item.url;
      card.classList.toggle('selected', selected().has(item.url));
      const checkbox = card.querySelector('.item-select');
      checkbox.checked = selected().has(item.url);
      checkbox.setAttribute('aria-label', '选择 ' + item.filename);
      checkbox.addEventListener('change', () => {
        checkbox.checked ? selected().add(item.url) : selected().delete(item.url);
        card.classList.toggle('selected', checkbox.checked); renderSelection();
      });
      card.querySelector('.file-name').textContent = item.filename;
      card.querySelector('.file-name').title = item.filename;
      card.querySelector('.format').textContent = formatOf(item);
      card.querySelector('.file-size').textContent = AudioTools.formatBytes(item.size);
      card.querySelector('.file-host').textContent = hostOf(item.url);
      card.querySelector('.file-host').title = item.url;
      card.querySelector('.source').textContent = item.verified ? '网络音频' : item.source === 'page' ? '网页元素' : '已加载资源';
      card.querySelector('.file-host').title = item.url + '\n' + card.querySelector('.source').textContent;
      card.querySelector('.provenance').hidden = recognized(item);
      card.querySelector('.name-pending').hidden = recognized(item);
      const status = statusFor(item);
      if (status) {
        const label = card.querySelector('.download-state');
        label.hidden = false;
        label.textContent = status.state === 'complete' ? '已下载' : retryStates.has(status.state) ? `下载未完成：${status.error || stateLabel(status.state)}` : stateLabel(status.state);
        label.classList.toggle('failed', retryStates.has(status.state));
      }
      const downloadButton = card.querySelector('.download-button');
      downloadButton.disabled = downloading;
      downloadButton.setAttribute('aria-label', '下载 ' + item.filename);
      downloadButton.addEventListener('click', () => void download([item.url]));
      card.querySelector('.copy-button').addEventListener('click', () => void perform(null, async () => {
        await navigator.clipboard.writeText(item.url); notify('音频链接已复制。');
      }));
      const convert = card.querySelector('.convert-button');
      convert.hidden = !isM4A(item);
      convert.disabled = downloading;
      convert.addEventListener('click', () => void download([item.url], true));
      fragment.append(card);
    }
    group.querySelector('.group-items').replaceChildren(fragment);
  }
  renderSelection();
}
function stateLabel(state) {
  return ({ complete: '已完成', failed: '失败', cancelled: '已停止', interrupted: '已中断', pending: '等待中', running: '转换中', downloading: '下载中', publishing: '保存到文件夹…', in_progress: '下载中' })[state] || '等待中';
}
function textElement(tag, className, text) { const node = document.createElement(tag); node.className = className; node.textContent = text; return node; }
function taskButton(label, className, action) {
  const button = textElement('button', 'text-button ' + className, label);
  button.addEventListener('click', () => void perform(button, action));
  return button;
}
function taskNode(task) {
  const node = document.createElement('article');
  node.className = `task conversion-task ${task.state}`;
  node.dataset.id = task.id;
  const top = textElement('div', 'task-top', '');
  top.append(textElement('h4', 'task-name', task.name || task.filename || task.inputPath?.split(/[\\/]/).pop() || '音频任务'));
  top.append(textElement('span', 'task-state', stateLabel(task.state) + (activeStates.has(task.state) && Number.isFinite(task.progress) ? ` ${Math.round(task.progress * 100)}%` : '')));
  node.append(top);
  if (activeStates.has(task.state)) {
    const bar = document.createElement('progress'); bar.max = 1; bar.value = task.progress || 0; bar.setAttribute('aria-label', '任务进度'); node.append(bar);
  }
  const destination = task.outputPath || task.path || task.inputPath;
  if (destination) node.append(textElement('p', 'task-meta', destination));
  if (task.error) node.append(textElement('p', 'task-error', task.error));
  const actions = textElement('div', 'task-actions', '');
  if (retryStates.has(task.state)) actions.append(taskButton('重试', 'retry-conversion', async () => {
    if (!await hostRequired()) return;
    await updateFromResponse(await request('RETRY_CONVERSION', { id: task.id }));
  }));
  if (task.state === 'complete') {
    actions.append(taskButton('打开', 'open-task', () => request('OPEN_TASK', { id: task.id, reveal: false })));
    actions.append(taskButton('定位', 'reveal-task', () => request('OPEN_TASK', { id: task.id, reveal: true })));
  }
  if (actions.childNodes.length) node.append(actions);
  return node;
}
function renderWorkbench() {
  const prefs = workbench.prefs;
  const connected = Boolean(workbench.host.connected);
  $('mode-browser').checked = prefs.downloadMode !== 'custom';
  $('mode-custom').checked = prefs.downloadMode === 'custom';
  $('save-as').checked = prefs.saveAs;
  $('recursive').checked = prefs.recursive;
  $('bitrate').value = String(prefs.bitrate);
  $('settings-bitrate').value = String(prefs.bitrate);
  const target = prefs.downloadMode === 'custom' ? prefs.downloadDirectory || '请选择文件夹' : '浏览器默认目录';
  setText('save-target', target); $('save-target').title = target;
  setText('download-directory', prefs.downloadDirectory || '尚未选择'); $('download-directory').title = prefs.downloadDirectory || '尚未选择';
  const output = prefs.conversionDirectory || '跟随下载目录';
  setText('conversion-directory', output); $('conversion-directory').title = output;
  setText('settings-conversion-directory', output); $('settings-conversion-directory').title = output;
  $('follow-download-directory').hidden = !prefs.conversionDirectory;
  $('host-status').replaceChildren();
  const dot = document.createElement('span'); dot.className = 'status-dot'; $('host-status').append(dot, document.createTextNode(connected ? '已连接' + (workbench.host.version ? ' · ' + workbench.host.version : '') : '尚未配置'));
  $('host-status').classList.toggle('connected', connected);
  $('conversion-host').classList.toggle('connected', connected);
  setText('conversion-host-text', connected ? '本地组件已连接' : '本地组件尚未配置 · 点此查看配置说明');
  setText('native-connect', connected ? '重新连接' : '连接本地组件');
  $('host-error').hidden = !workbench.host.error;
  setText('host-error', workbench.host.error || '');
  const jobs = workbench.conversions;
  const running = jobs.some(task => task.state === 'running' || (task.state === 'pending' && task.submitted));
  const pending = jobs.some(task => task.state === 'pending' && !task.submitted);
  const complete = jobs.filter(task => task.state === 'complete').length;
  const queueProgress = jobs.length ? jobs.reduce((sum, task) => sum + (task.state === 'complete' ? 1 : task.progress || 0), 0) / jobs.length : 0;
  setText('queue-count', jobs.length);
  setText('queue-summary', `已完成 ${complete} / ${jobs.length}`);
  setText('queue-progress-text', running ? `${Math.round(queueProgress * 100)}%` : '');
  $('queue-progress').value = queueProgress;
  $('start-conversion').disabled = !pending || running || !connected;
  $('cancel-conversion').disabled = !running;
  $('conversion-empty').hidden = jobs.length > 0;
  $('conversion-list').replaceChildren(...jobs.map(task => taskNode(task)));
  const waitingCount = jobs.filter(task => ['pending', 'running'].includes(task.state)).length;
  $('conversion-badge').hidden = !waitingCount; setText('conversion-badge', waitingCount);
  renderResources();
}
function acceptWorkbench(snapshot) {
  if (!snapshot || !snapshot.prefs) return false;
  workbench = { prefs: { ...initialPrefs, ...snapshot.prefs }, host: snapshot.host || { connected: false }, downloads: snapshot.downloads || [], conversions: snapshot.conversions || [] };
  renderWorkbench(); return true;
}
async function refreshWorkbench() {
  const version = ++workbenchVersion;
  const snapshot = await request('GET_WORKBENCH');
  if (version === workbenchVersion) acceptWorkbench(snapshot);
}
async function updateFromResponse(data) {
  ++workbenchVersion;
  if (!acceptWorkbench(data?.workbench || data)) await refreshWorkbench();
}
async function saveSettings(settings) { await updateFromResponse(await request('SAVE_SETTINGS', { settings })); }
async function chooseDirectory(purpose) {
  if (!await hostRequired()) return;
  await updateFromResponse(await request('CHOOSE_DIRECTORY', { purpose }));
}
async function download(urls, convert = false) {
  if (downloading || !urls.length) return;
  const downloadTab = tabId;
  downloading = true; renderResources();
  try {
    if ((convert || workbench.prefs.downloadMode === 'custom') && !await hostRequired()) return;
    const results = await request('DOWNLOAD_AUDIO', { tabId: downloadTab, urls, saveAs: workbench.prefs.saveAs, convert });
    if (Array.isArray(results)) {
      const failures = results.filter(result => result.error);
      for (const result of results) if (!result.error) {
        tabState(downloadTab).selected.delete(result.url);
        statuses.set(`${downloadTab}:${result.url}`, { state: 'downloading' });
      }
      notify(failures.length ? `${results.length - failures.length} 个下载已提交，${failures.length} 个未开始：${failures[0].error}` : `已提交 ${results.length} 个${convert ? '下载与转换任务' : '下载'}。`, failures.length > 0);
    } else { await updateFromResponse(results); notify(convert ? '下载与转换任务已加入队列。' : '下载已提交。'); }
    await refreshWorkbench();
  } catch (error) { notify(error.message, true); }
  finally { downloading = false; renderResources(); }
}
async function refreshResources(type = 'GET_AUDIO') {
  if (tabId === undefined) return;
  const version = ++readVersion, readTab = tabId;
  let next;
  try { next = await request(type, { tabId: readTab }); }
  catch (error) {
    if (version === readVersion && readTab === tabId) { loadingResources = false; renderResources(); }
    throw error;
  }
  if (version !== readVersion || readTab !== tabId) return;
  resources = { items: next?.items || [], capped: Boolean(next?.capped) }; loadingResources = false; renderResources();
}
function isWebTab(tab) { return /^https?:\/\//i.test(tab?.url || ''); }
function renderPage(tab) {
  currentTab = tab;
  setText('page-title', tab.title || '当前网页'); $('page-title').title = tab.title || '';
  setText('page-host', isWebTab(tab) ? hostOf(tab.url) : '浏览器内部页面');
  $('scan').disabled = !isWebTab(tab) || scanning;
}
async function bindTab(tab) {
  if (!tab || (windowId !== undefined && tab.windowId !== undefined && tab.windowId !== windowId)) return;
  if (tabId !== undefined) tabState().search = $('search').value;
  ++readVersion; tabId = tab.id; loadingResources = true; resources = { items: [], capped: false };
  $('search').value = tabState().search;
  renderPage(tab); renderResources();
  const expectedTab = tabId;
  await refreshResources();
  if (expectedTab === tabId && isWebTab(tab)) {
    try { await refreshResources('SCAN_TAB'); }
    catch { if (expectedTab === tabId) notify('本页暂时无法扫描。安装后刷新网页，再播放音频即可继续收集。', true); }
  }
}
async function followTab(id) {
  const version = ++followVersion; ++readVersion;
  const tab = await chrome.tabs.get(id);
  if (version === followVersion) await bindTab(tab);
}

for (const button of document.querySelectorAll('.tab')) button.addEventListener('click', () => setView(button.dataset.view));
$('dismiss-notice').addEventListener('click', () => { $('notice').hidden = true; });
$('search').addEventListener('input', () => { tabState().search = $('search').value; renderResources(); });
$('select-all').addEventListener('change', () => { visibleItems.forEach(item => $('select-all').checked ? selected().add(item.url) : selected().delete(item.url)); renderResources(); });
for (const group of document.querySelectorAll('.resource-group')) {
  group.querySelector('.group-toggle').addEventListener('click', event => {
    const button = event.currentTarget, open = button.getAttribute('aria-expanded') === 'true';
    button.setAttribute('aria-expanded', String(!open)); group.querySelector('.group-items').hidden = open;
  });
  group.querySelector('.group-select').addEventListener('change', event => {
    const checked = event.currentTarget.checked;
    visibleItems.filter(item => recognized(item) === (group.dataset.group === 'recognized')).forEach(item => checked ? selected().add(item.url) : selected().delete(item.url)); renderResources();
  });
}
$('download-selected').addEventListener('click', () => void download([...selected()]));
$('scan').addEventListener('click', () => void perform($('scan'), async () => {
  scanning = true; $('scan').querySelector('span').textContent = '扫描中…';
  try { await refreshResources('SCAN_TAB'); notify('已重新扫描。播放音频后还能发现新的链接。'); }
  finally { scanning = false; $('scan').querySelector('span').textContent = '重新扫描'; }
}));
$('clear').addEventListener('click', () => void perform($('clear'), async () => { const clearedTab = tabId; await refreshResources('CLEAR_TAB'); tabState(clearedTab).selected.clear(); renderResources(); notify('列表已清空。重新扫描可找回网页链接。'); }));
$('save-target').addEventListener('click', () => setView('settings'));
$('change-save-target').addEventListener('click', () => setView('settings'));
$('conversion-host').addEventListener('click', () => { setView('settings'); if (!workbench.host.connected) { $('setup-help').hidden = false; $('setup-help-toggle').setAttribute('aria-expanded', 'true'); } });
$('choose-download-directory').addEventListener('click', event => void perform(event.currentTarget, () => chooseDirectory('download')));
$('choose-conversion-directory').addEventListener('click', event => void perform(event.currentTarget, () => chooseDirectory('conversion')));
$('settings-conversion-directory').addEventListener('click', event => void perform(event.currentTarget, () => chooseDirectory('conversion')));
$('follow-download-directory').addEventListener('click', event => void perform(event.currentTarget, () => saveSettings({ conversionDirectory: '' })));
for (const mode of ['browser', 'custom']) $('mode-' + mode).addEventListener('change', () => void perform(null, async () => {
  if (mode === 'custom' && !workbench.prefs.downloadDirectory) { if (!await hostRequired()) { renderWorkbench(); return; } await chooseDirectory('download'); return; }
  await saveSettings({ downloadMode: mode });
}));
$('save-as').addEventListener('change', () => void perform(null, () => saveSettings({ saveAs: $('save-as').checked })));
$('recursive').addEventListener('change', () => void perform(null, () => saveSettings({ recursive: $('recursive').checked })));
for (const id of ['bitrate', 'settings-bitrate']) $(id).addEventListener('change', () => void perform(null, () => saveSettings({ bitrate: Number($(id).value) })));
$('native-connect').addEventListener('click', event => void perform(event.currentTarget, async () => { await updateFromResponse(await request('NATIVE_CONNECT')); notify(workbench.host.connected ? '本地组件已连接，可以选择目录和转换文件。' : '尚未连接，请按配置说明完成一次性配置。', !workbench.host.connected); }));
$('setup-help-toggle').addEventListener('click', () => { $('setup-help').hidden = !$('setup-help').hidden; $('setup-help-toggle').setAttribute('aria-expanded', String(!$('setup-help').hidden)); });
for (const [id, folder] of [['add-files', false], ['add-folder', true]]) $(id).addEventListener('click', event => void perform(event.currentTarget, async () => {
  if (!await hostRequired()) return;
  const result = await request('ADD_CONVERSION_FILES', { folder, recursive: $('recursive').checked });
  await updateFromResponse(result);
  const scanErrors = (result?.workbench || result)?.scanErrors;
  if (scanErrors?.length) notify(`已添加可用文件；另有 ${scanErrors.length} 个文件或目录无法读取：${typeof scanErrors[0] === 'string' ? scanErrors[0] : scanErrors[0].message || scanErrors[0].error || scanErrors[0].path || '请检查访问权限。'}`, true);
}));
$('start-conversion').addEventListener('click', event => void perform(event.currentTarget, async () => { if (await hostRequired()) await updateFromResponse(await request('START_CONVERSION')); }));
$('cancel-conversion').addEventListener('click', event => void perform(event.currentTarget, async () => { await updateFromResponse(await request('CANCEL_CONVERSION')); notify('已请求停止转换。已完成的文件会保留。'); }));
for (const button of document.querySelectorAll('.open-downloads')) button.addEventListener('click', () => void chrome.tabs.create({ url: navigator.userAgent.includes('Edg/') ? 'edge://downloads/' : 'chrome://downloads/' }));
$('close-panel').addEventListener('click', event => void perform(event.currentTarget, async () => {
  const result = await request('CLOSE_PANEL', { windowId });
  if (!result?.closed) notify('请点击浏览器侧栏右上角的关闭按钮。后台任务会继续执行。');
}));
chrome.tabs.onActivated.addListener(info => { if (info.windowId === windowId) void followTab(info.tabId).catch(error => notify(error.message, true)); });
chrome.tabs.onUpdated.addListener((id, change, tab) => {
  if (id !== tabId || (tab.windowId !== undefined && tab.windowId !== windowId)) return;
  renderPage(tab);
  if (change.url) { ++readVersion; resources = { items: [], capped: false }; selected().clear(); renderResources(); }
  if (change.url || change.status === 'complete') void refreshResources().catch(error => notify(error.message, true));
});
chrome.tabs.onRemoved.addListener(id => { perTab.delete(id); if (id === tabId) { ++readVersion; resources = { items: [], capped: false }; renderResources(); } });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.workbench) { ++workbenchVersion; acceptWorkbench(changes.workbench.newValue); }
  if (area !== 'session' || tabId === undefined) return;
  if (changes[`audio:${tabId}`]) void refreshResources().catch(error => notify(error.message, true));
  for (const [key, change] of Object.entries(changes)) if (key.startsWith('status:')) {
    const statusKey = key.slice(7); change.newValue ? statuses.set(statusKey, change.newValue) : statuses.delete(statusKey);
  }
  renderResources();
});
async function initialize() {
  windowId = (await chrome.windows.getCurrent()).id;
  const initialFollow = followVersion;
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  const cached = await chrome.storage.session.get(null);
  for (const [key, value] of Object.entries(cached)) if (key.startsWith('status:')) statuses.set(key.slice(7), value);
  await Promise.all([refreshWorkbench(), initialFollow === followVersion ? bindTab(tab) : Promise.resolve()]);
  if (!tab && initialFollow === followVersion) notify('请在这个窗口打开一个网页。');
}
initialize().catch(error => notify(error.message, true));
