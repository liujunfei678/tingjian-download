import http from "node:http";
import { pathToFileURL } from "node:url";

// A generated one-second tone: no external files or copyrighted test media.
export function makeWav() {
  const sampleRate = 22050;
  const samples = sampleRate;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVE", 8);
  bytes.write("fmt ", 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(sampleRate, 24); bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write("data", 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    const envelope = Math.min(i / 1000, (samples - i) / 1000, 1);
    bytes.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / sampleRate) * 4000 * envelope), 44 + i * 2);
  }
  return bytes;
}

const demoHTML = `<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><title>听见 · 音频识别测试页</title>
<style>body{font:16px/1.7 system-ui;max-width:760px;margin:60px auto;background:#f7f8f3;color:#172c28;padding:24px}h1{font-size:32px}section{background:white;border:1px solid #e1e8e3;border-radius:12px;padding:24px;margin:16px 0}a{color:#116d60}button{background:#116d60;color:white;border:0;padding:12px 18px;border-radius:6px;cursor:pointer}audio{width:100%}small{color:#6a7d76}</style>
<h1>听见 · 音频识别测试页</h1><p>安装扩展后，点击工具栏里的「听见」查看识别结果。</p>
<section><h2>页面音频与重复链接</h2><audio controls preload="metadata" src="/tone.wav"></audio><p><a href="/tone.wav">测试提示音 WAV</a> · <a href="/tone.wav#duplicate">同一个音频（应合并）</a></p></section>
<section><h2>无文件后缀的网络请求</h2><button id="load-network">加载网络音频</button><p id="network-result"></p><small>通过 audio/wav 响应类型识别；首次点击后才出现在列表里。</small></section>
<section><h2>动态插入与下载文件名</h2><button id="add-dynamic">插入音频链接</button><div id="dynamic-links"></div><p><a href="/download-hint" download="提示音.wav">带 download 文件名的链接</a></p><p><a href="/stream.m3u8">播放列表（不作为完整音频）</a> · <a href="/video.mp4">视频（不收录）</a></p></section>
<section><h2>子框架</h2><iframe src="/frame" title="子框架音频测试" style="border:0;width:100%;height:60px"></iframe></section>
<p><a href="/empty">跳转到无音频页，验证列表重置</a></p>
<script>document.querySelector('#load-network').onclick=async()=>{const response=await fetch('/audio-endpoint?token=test%2Bsigned');await response.arrayBuffer();document.querySelector('#network-result').textContent='音频已加载，查看扩展列表。'};document.querySelector('#add-dynamic').onclick=()=>{const link=document.createElement('a');link.href='/dynamic.wav';link.textContent='动态提示音';document.querySelector('#dynamic-links').replaceChildren(link)};</script></html>`;

const namingHTML = `<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><title>声音课堂 · 音频合集</title>
<h1>真实名称识别测试</h1>
<p><a href="/11111111111111111111111111111111.wav">晨光 - 示例歌手</a></p>
<p><a href="/22222222222222222222222222222222.wav" title="雨声 - 环境录音">下载</a></p>
<p><a href="/33333333333333333333333333333333.wav" download="44444444444444444444444444444444.wav">播放</a></p>
<p><a href="/readable-track.wav">下载</a></p>
<p><a href="/55555555555555555555555555555555.wav">星河</a> · <a href="/55555555555555555555555555555555.wav#duplicate">播放</a></p>
<audio id="named-player" preload="none" src="/66666666666666666666666666666666.wav" title="晚风 - 示例歌手"></audio>
<audio id="empty-player" preload="none"></audio>
<audio id="media-player" preload="none" title="远方"><source src="/77777777777777777777777777777777.wav" type="audio/wav"></audio>
<audio id="notification-player" preload="none" src="/99999999999999999999999999999999.wav" title="通知提示音"></audio>
<button id="play-media">播放播放器元数据测试</button>
<button id="load-server-name">加载服务器文件名</button>
<button id="load-unnamed">加载无名称网络音频</button>
<script>
document.querySelector('#play-media').onclick=()=>{navigator.mediaSession.metadata=new MediaMetadata({title:'远方',artist:'示例歌手'});document.querySelector('#media-player').play()};
document.querySelector('#load-server-name').onclick=async()=>{await(await fetch('/server-name')).arrayBuffer()};
document.querySelector('#load-unnamed').onclick=async()=>{await(await fetch('/88888888888888888888888888888888.wav')).arrayBuffer()};
</script></html>`;

export function createDemoServer() {
  const wav = makeWav();
  return http.createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); response.end(demoHTML);
    } else if (url.pathname === "/naming") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); response.end(namingHTML);
    } else if (url.pathname === "/frame") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end('<!doctype html><meta charset="UTF-8"><a href="/iframe.wav">子框架音频</a>');
    } else if (url.pathname === "/empty") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); response.end('<!doctype html><meta charset="UTF-8"><title>无音频页面</title><h1>这里没有音频</h1>');
    } else if (["/not-audio.mp3", "/not-audio-endpoint"].includes(url.pathname)) {
      response.writeHead(200, { "Content-Type": "text/html" }); response.end("<h1>Login required</h1>");
    } else if (["/stream.m3u8", "/playlist-endpoint"].includes(url.pathname)) {
      response.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" }); response.end("#EXTM3U\n");
    } else if (url.pathname.endsWith(".wav") || ["/audio-endpoint", "/download-hint", "/attachment", "/server-name"].includes(url.pathname)) {
      const headers = { "Content-Type": url.pathname === "/attachment" ? "application/octet-stream" : "audio/wav", "Content-Length": wav.length, "Cache-Control": "no-store" };
      if (url.pathname === "/audio-endpoint") headers["Content-Disposition"] = "inline; filename*=UTF-8''%E7%BD%91%E7%BB%9C%E6%8F%90%E7%A4%BA%E9%9F%B3.wav";
      if (url.pathname === "/attachment") headers["Content-Disposition"] = 'attachment; filename="attachment-tone.wav"';
      if (url.pathname === "/server-name") headers["Content-Disposition"] = "inline; filename*=UTF-8''%E5%8F%AF%E8%AF%BB%E6%9C%8D%E5%8A%A1%E5%99%A8%E5%90%8D.wav";
      response.writeHead(200, headers); response.end(wav);
    } else { response.writeHead(404); response.end("Not found"); }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createDemoServer();
  server.listen(8765, "127.0.0.1", () => process.stdout.write("测试页面：http://127.0.0.1:8765\n按 Ctrl+C 停止。\n"));
}
