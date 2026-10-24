# 多站点歌曲名称关联

版本：2.1.0；检查日期：2026-10-20。

## 范围与数据流

新增酷我、QQ 音乐、酷狗的当前播放器读取器，网易云逻辑保留在独立模块。网络响应与 1.1 页面扫描仍负责决定哪些链接是音频；站点读取器只返回 `{site, trackId, url, title, artist}`，后台对已经存在的完整 URL 补名。不会更换签名地址、提高验证状态或凭元数据创建资源。

后台通过 `chrome.scripting.executeScript` 在顶层页面 MAIN 世界只读读取。函数所有依赖均放在函数体内，可独立序列化。对网站对象只读取自有数据字段，跳过未知 getter；不调用播放、初始化、队列或请求 API。DOM 媒体属性使用浏览器原生只读接口。

## 官方页面与实现证据

- [酷我官网](https://www.kuwo.cn/) 当前 Nuxt 播放器将 Vuex `song.currentSong` 的详情 ID、歌名、歌手和 URL 同时渲染到底部 `.playControl`。当前主资源为 `https://h5s.kuwo.cn/www/kw-www/dcc6cd7.js`。读取器使用底部 `.con_l` 和对应 audio，不依赖 Vue 响应式 getter。
- [QQ 音乐播放页](https://y.qq.com/n/ryqq_v2/player) 当前 React 类播放器拥有 `state.playSong`、`player.currentMid` 与 `player.playUrlMap[mid]`。当前页面资源为 `https://y.qq.com/ryqq/js/player.chunk.e7f390ec6e66adf171bb.js?max_age=2592000`。读取器只从 `.mod_player` 的 React 自有 fiber 指针沿父链查找现有实例，最多 40 层；不遍历子树、歌单或任意全局对象。当前状态的 mid 非空时也必须一致。
- [酷狗网页播放器](https://www.kugou.com/song/) 当前资源 `https://www.kugou.com/yy/static/js/play/playbyAudio.js` 的 `play.globalParam.song_info` 保存当前响应中的 hash、歌名、歌手和播放地址；更新 UI 时同时给 `#myAudio` 设置 src 与 `data-hash`。读取器要求媒体 hash 与响应 hash 相同，已加载的 URL 必须等于主地址或备用地址。

以上是此次检查到的官网结构，未来网站可能更换字段或资源文件名。扩展不下载或远程执行这些脚本；发布包只包含本项目的适配代码。

## 防止错配

- 仅处理指定网站的完整 http(s) 主机；媒体地址限制为该站对应的 CDN 域名与独立音频后缀。
- URL 只去除 fragment；协议、主机、路径与查询参数完整比较。
- 酷我、酷狗要求媒体已加载、没有媒体错误，且 currentSrc 等于 DOM src，避免新 src 与旧 currentSrc 混用。
- QQ 要求当前歌曲 mid 与播放器 mid 相同，再读取该 mid 的地址，适用于 DOM audio 或播放器内部音频实现。
- 已有 URL 的站点 / 歌曲 ID 关联不可被另一首覆盖；较强的元素名称依然按原有命名优先级保留。
- 每标签页串行写入；导航与清空使旧的多站点名称读取作废。补名不会恢复已被 403 移除的条目。

## 实际官网检查

使用官方网页入口与正常搜索，未复用用户 Edge 登录资料。

| 网站 | 曲目 / 入口 | 本次结果 |
| --- | --- | --- |
| 酷我 | 搜索“两只老虎”，选择标注“免费DJ版儿歌串烧”的儿歌多多曲目（详情 ID 397242799） | 播放进度正常递增；readyState=4；底部歌名、歌手、详情 ID 与 `kw-er.kuwo.cn` MP3 来源均已核对；通过浏览器媒体下载保存了 9,078,383 字节的 MP3 |
| QQ 音乐 | 贝乐虎儿歌200首 →《两只老虎》 | 独立播放页显示曲目，弹出 QQ 登录；未取得实际媒体，未声称登录后播放验证通过 |
| 酷狗 | 搜索“两只老虎”→儿歌多多版本 | 正常加入播放页队列，弹出登录；audio 为空，未取得实际媒体 |

“免费歌曲”与“未登录即可播放”是不同条件。不能播放的页面没有有效媒体时，适配器不会制造下载链接。酷我官网检查确认了实际 DOM 与来源关系；插件端完整链路另用以下可重复夹具验证。

## 可重复验证

`node --test tests/music-sites.test.mjs` 在独立 VM 中序列化读取器，检查三站字段、来源、切歌冲突、主备地址、未知 getter、父链循环与无播放器情况。

`node tests/music-sites.browser.mjs` 用独立 Edge 配置加载真实扩展，按当前官网结构构造播放器，音频内容全部为本机生成 WAV。检查三站名称 / 歌手、精确签名、切歌、重复请求、迟到名称、403、清空、导航、延迟 MAIN 读取竞争、实际 chrome.downloads 输出名称与文件字节、侧栏分组。截图与 JSON 结果放在系统临时目录，脚本结束时输出路径。

原有 `tests/netease.browser.mjs` 保留《爱一点》QuickTime MIME 回归和其他网易云场景，`tests/legacy-v1.1.browser.mjs` 检查捕获兼容性。

本次结果：75 项单元测试、17 项多站点 Edge 检查、14 项网易云 Edge 回归、19 项通用浏览器检查，以及 1.1、panel、sidepanel、workbench 集成检查均通过。多站点测试最后连续运行三次，覆盖清空后同 URL 再次捕获的旧快照竞争；独立只读审查未发现重要问题。包与实际扩展目录另按文件 SHA-256 校验。
