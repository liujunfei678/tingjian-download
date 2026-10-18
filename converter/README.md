# 听见 · M4A 批量转 MP3

Windows 10 / 11 的本地桌面工具。双击 `dist/M4A转MP3工具/听见批量转换.exe` 即可运行；便携 ZIP 中的文件需要完整解压。使用时不需要 Python、Node.js 或网络。

支持多选和拖入文件、文件夹及子目录扫描、128 / 192 / 256 / 320 kbps、指定输出位置、逐项与总进度、停止后继续、中文文件名、同名自动编号、失败详情和 CSV 结果导出。保留原文件与常见文字标签，输出为 44.1 kHz 立体声 MP3。成品集中存放在输出目录；封面和文件夹结构不保留，DRM 文件不支持。

## 构建

构建需要 Windows、Node.js、.NET Framework 自带的 C# 编译器、已安装的 FFmpeg（含 `libmp3lame`）。项目运行不依赖 npm 包。

```powershell
npm run build:converter
npm run test:converter
```

FFmpeg 默认从 PATH 查找，也可以通过 `FFMPEG_PATH` 指定。使用 Gyan essentials 构建，FFmpeg 上一级目录需要包含厂商提供的 `LICENSE` 与 `README.txt`。编译器默认使用 Windows 的 Framework64/v4.0.30319/csc.exe；可设置 `CSC_PATH`。

构建生成已包含 FFmpeg 的工具文件夹与 `dist/M4A转MP3工具.zip`。界面使用 .NET Framework 4.5 API、C# 5，无需额外安装现代 .NET SDK。

## 处理方式

每次调用独立 FFmpeg 进程，按队列逐个转换。只选取第一个音轨，用 `libmp3lame` 重编码，保留文字元数据。通过 `-progress pipe:1` 获取进度，输入协议限定为本地文件与管道。文件路径通过 Windows argv 编码传给进程，不经过 shell。

每个任务先写入随机临时文件，成功后通过不覆盖目标的原子移动发布 MP3；同名递增编号。失败或取消会终止子进程并清理该任务临时文件，已完成的文件保留。再次开始会跳过已成功项；队列不跨会话保存。目录扫描跳过子目录中的重解析点，避免链接循环。

测试生成真实 AAC、ALAC、大小写后缀和损坏样本，验证输出可解码、码率、采样率、文字标签、原文件保留、重名处理、取消与重试、真实窗口中的操作和渲染截图。

转换参数依据 [FFmpeg 官方文档](https://ffmpeg.org/ffmpeg.html) 与 [libmp3lame 文档](https://ffmpeg.org/ffmpeg-codecs.html#libmp3lame)。厂商版本、许可与源码信息随二进制放在 `third-party` 中。
