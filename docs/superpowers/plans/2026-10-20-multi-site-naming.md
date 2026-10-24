# 多站点歌曲名称适配 Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 按用户批准的方案增加酷我、QQ 音乐、酷狗的歌曲名称关联。

**Architecture:** 各站独立只读读取当前播放器，将歌名、歌手、歌曲 ID 与完整播放 URL 绑定。后台只为已经捕获的资源补名；保留网易云原有实现和 1.1 资源筛选规则。

**Tech Stack:** Manifest V3、原生 JavaScript、Node test、Edge / Playwright。

**Spec:** 用户已批准“先做酷我、QQ 音乐、酷狗”，并要求使用免费歌曲验证。

## Global Constraints

- 不修改播放、不生成链接、不读取整张歌单作为音频资源。
- 签名参数、主机和协议必须完整匹配；同一资源已绑定的歌曲 ID 不可被切歌覆盖。
- 不增加权限或外部服务；稳定扩展 ID 不变。

## Review Focus

- 切歌期间新标题与旧 currentSrc 同时存在时不误配。
- QQ 播放器中 currentMid / playSong / URL 映射必须同一 ID。
- 酷狗 song_info / audio data-hash / 当前 src 必须一致。
- 导航、清空、403 响应后不能被迟到元数据恢复。
- 无播放器、未知 getter、循环 React return 指针均安全退出。

### Task 1: 独立站点读取器

Files: `extension/lib/music-sites.js`, `tests/music-sites.test.mjs`。
Interface: `musicSiteForURL(value)` 返回站点代号；`readMusicSitePlayback()` 可独立序列化，返回 `{site,trackId,url,title,artist}[]`。

- [x] 写入各站有效关联、ID 冲突、切歌、getter、边界和来源校验测试。
- [x] 运行 `node --test tests/music-sites.test.mjs`，确认因尚无读取器失败。
- [x] 根据官网当前播放器代码实现只读读取器，运行相同测试确认通过。

### Task 2: 后台关联与 Edge 验证

Files: `extension/background.js`, `tests/music-sites.browser.mjs`。
Consumes Task 1 exports; existing NetEase reader remains separate.

- [x] 写 Edge 夹具覆盖三站、精确签名、重复请求、迟到名称、歌曲切换、失败响应、真实下载名称。
- [x] 确认接入前测试失败；加入通用分派入口，只改已有资源的名称。
- [x] 运行新浏览器测试和 `tests/netease.browser.mjs`、1.1 回归、单元测试。

### Task 3: 文档与交付

Files: `README.md`, `package.json`, `extension/manifest.json`。

- [x] 记录支持范围和真实网站验证限制，版本更新为 2.1.0。
- [x] 打包并校验包内文件，更新用户实际加载的固定扩展目录。
- [x] 审查最终 diff，保留本地提交与检查证据；不自动发布远程。
