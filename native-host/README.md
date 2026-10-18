# 听见 2.0 Windows 本地组件

适用 Windows 10/11 x64、Chrome 和 Edge。先把浏览器扩展 ZIP 解压并在扩展管理页以开发者模式加载整个 `extension` 目录；扩展 ID 应为 `lncnlaidcmglpbnfmikaocnhocjifghn`。

1. 将本地组件 ZIP 完整解压到普通文件夹，运行 `Tingjian.Setup.exe`。它只配置当前 Windows 用户，无需管理员权限。
2. 返回听见侧栏的设置，连接本地组件。按系统对话框选择下载目录或 M4A 输入文件。
3. 取消配置时，先退出 Chrome 和 Edge，再运行解压包里的 `Tingjian.Uninstall.exe`。程序仅删除安装清单中哈希未变化的组件文件；正在使用、已修改的文件，以及目录内所有用户文件都会保留。任务记录与已下载/转换的音频始终保留。

程序安装到 `%LOCALAPPDATA%\Tingjian\NativeHost`；偏好、输入授权、发布收据和任务状态保存在 `%LOCALAPPDATA%\Tingjian\State`。仅登记 HKCU 下 Chrome / Edge 的 `NativeMessagingHosts\com.tingjian.audio`，不改动下载目录、执行策略、系统服务或开机启动项。

组件只接受随包清单中的固定听见扩展来源。输入必须来自系统文件选择器，输出必须为系统下载目录或已选择目录；拒绝路径穿越、符号链接、目录联接和非音频文件名。浏览器暂存文件必须位于 `Tingjian\staging\<任务标识>\<文件名>`，发布采用同目录临时文件加原子移动，不覆盖同名文件。仅在调用方记录成功后，凭成功发布收据和 SHA-256 校验清理对应暂存文件。

“浏览器默认目录”的下载后转换从已验证暂存路径推导浏览器实际下载目录；浏览器将默认目录设到其他磁盘时，原 M4A 仍保存在该目录。调用方不能通过这个模式指定其他任意目录。

关闭侧栏不停止转换。浏览器退出或通信关闭会停止活动任务并记录为中断，下次连接后可重试。为防止两个浏览器同时修改同一本地队列，一个 Windows 用户同时只允许一个浏览器连接；需要切换时先退出另一浏览器。

支持 M4A（含 AAC、ALAC）转 MP3，128/192/256/320 kbps、44.1 kHz 双声道。保留原始文件并尽量保留文字标签。FFmpeg 的许可、供应方构建说明和源码获取信息见 `third-party`；听见组件源码与构建脚本见 `source`。

开发者构建：项目根目录运行 `node scripts/build-native-host.mjs`。构建不会执行配置程序，也不会修改注册表。验证：`node --test tests/native-host.test.mjs`。
