import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawn,spawnSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {createServer} from 'node:http';
import {mkdir,readFile,writeFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildNativeHostIntegration} from './native-host-integration.mjs';
import {makeWav} from '../scripts/demo-server.mjs';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root=fileURLToPath(new URL('../',import.meta.url));
const fixture=path.join(root,'test-results','integration-'+Date.now());
for(const dir of ['inputs','browser-downloads','browser-choice','output','converted'])await mkdir(path.join(fixture,dir),{recursive:true});
const built=await buildNativeHostIntegration({fixtureRoot:fixture});
function run(exe,args){const result=spawnSync(exe,args,{encoding:'utf8',windowsHide:true,timeout:120000});if(result.error)throw result.error;assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;}
for(const [name,codec] of [['本地 AAC.m4a','aac'],['本地 ALAC.m4a','alac']])run(built.ffmpeg,['-v','error','-nostdin','-f','lavfi','-i','sine=frequency=330:duration=3','-c:a',codec,'-metadata','title=联调练习',path.join(fixture,'inputs',name)]);
const music=await readFile(path.join(fixture,'inputs','本地 AAC.m4a'));
const native=spawn(built.exe,built.args,{windowsHide:true});
const pending=new Map(),events=[];let nativeError='';native.stderr.on('data',b=>{nativeError+=b;});
createInterface({input:native.stdout}).on('line',line=>{const message=JSON.parse(line.replace(/^\uFEFF/,''));if(message.event)events.push(message);else {const response=pending.get(message.id);if(response){pending.delete(message.id);response(message);}}});
const server=createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://localhost');
  res.setHeader('Access-Control-Allow-Origin','*');
  if(url.pathname==='/native'){
   let body='';for await(const chunk of req)body+=chunk;
   const message=JSON.parse(body);const response=await new Promise(resolve=>{pending.set(message.id,resolve);native.stdin.write(JSON.stringify(message)+'\n');});
   res.setHeader('Content-Type','application/json');res.end(JSON.stringify(response));
  }else if(url.pathname==='/events'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({cursor:events.length,events:events.slice(Number(url.searchParams.get('cursor'))||0)}));}
  else if(url.pathname==='/song.m4a'){res.setHeader('Content-Type','audio/mp4');res.end(music);}
  else if(url.pathname.endsWith('.wav')){res.setHeader('Content-Type','audio/wav');res.end(makeWav());}
  else {res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><title>本地联调页面</title><a href="/song.m4a" download="联调歌曲.m4a">联调歌曲</a><a href="/tone.wav" title="提示声音">提示声音</a><a href="/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.wav">播放</a>');}
 }catch(error){res.statusCode=500;res.end(error.message);}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
const profile=path.join(root,'.test-profile','integration-'+Date.now());await mkdir(path.join(profile,'Default'),{recursive:true});
await writeFile(path.join(profile,'Default','Preferences'),JSON.stringify({download:{default_directory:path.join(fixture,'browser-choice'),prompt_for_download:false,directory_upgrade:true}}));
const context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,acceptDownloads:true,args:[`--disable-extensions-except=${path.join(root,'extension')}`,`--load-extension=${path.join(root,'extension')}`],viewport:{width:440,height:820}});
const errors=[],passed=[];let panel;
async function poll(operation,label){const end=Date.now()+30000;while(Date.now()<end){if(await operation())return;await new Promise(r=>setTimeout(r,100));}throw Error('Timeout '+label+' '+nativeError);}
try{
 let [worker]=context.serviceWorkers();if(!worker)worker=await context.waitForEvent('serviceworker');
 worker.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
 const browserCDP=await context.browser().newBrowserCDPSession();
 await browserCDP.send('Browser.setDownloadBehavior',{behavior:'default'});
 const id=worker.url().split('/')[2];
 // Test-only transport replaces the browser-native boundary in this isolated profile.
 // HostService, ConverterCore, actual browser downloads and every UI action remain real.
 await worker.evaluate(base=>{
  chrome.runtime.connectNative=()=>{
   const listeners=[],disconnected=[];let cursor=0,busy=false;
   const port={onMessage:{addListener:fn=>listeners.push(fn)},onDisconnect:{addListener:fn=>disconnected.push(fn)},postMessage(message){fetch(base+'/native',{method:'POST',body:JSON.stringify(message)}).then(r=>r.json()).then(data=>listeners.forEach(fn=>fn(data)));}};
   setInterval(async()=>{if(busy)return;busy=true;try{const data=await(await fetch(base+'/events?cursor='+cursor)).json();cursor=data.cursor;for(const event of data.events)listeners.forEach(fn=>fn(event));}finally{busy=false;}},100);
   return port;
  };
 },base);
 const page=await context.newPage();await page.goto(base);
 const open=async()=>{panel=await context.newPage();panel.on('pageerror',e=>errors.push(e.message));await page.bringToFront();await panel.goto(`chrome-extension://${id}/panel/panel.html`);await panel.waitForFunction(()=>document.querySelector('#count').textContent==='3');};
 await open();
 const snapshot=()=>panel.evaluate(()=>chrome.runtime.sendMessage({type:'GET_WORKBENCH'}).then(r=>r.data));
 await panel.locator('#nav-settings').click();await panel.locator('#native-connect').click();
 await poll(async()=>(await snapshot()).host.connected,'native connection');
 await panel.locator('#choose-download-directory').click();
 await poll(async()=>(await snapshot()).prefs.downloadDirectory===path.join(fixture,'output'),'chosen output directory');
 passed.push('侧栏选择目录经真实 HostService 授权，并保存在设置');
 await panel.locator('#nav-resources').click();await panel.locator('#select-all').check();await panel.locator('#download-selected').click();
 await poll(async()=>{const s=await snapshot();return s.downloads.length===3 && s.downloads.every(t=>t.state==='complete' && t.cleaned);},'custom bulk download publish and cleanup');
 let state=await snapshot();
 for(const task of state.downloads){assert.equal(path.dirname(task.path),path.join(fixture,'output'));assert.deepEqual(await readFile(task.path),task.name.endsWith('.m4a')?music:makeWav());}
 assert.deepEqual(await readdir(path.join(fixture,'browser-choice','Tingjian','staging')),[]);
 assert.equal((await panel.evaluate(()=>chrome.downloads.search({}))).length,0);
 passed.push('真实批量浏览器下载、原子保存、中文文件名、内容与暂存清理');
 await panel.locator('.audio-card[data-url$="/song.m4a"] .convert-button').click();
 await poll(async()=>{const s=await snapshot();return s.downloads.length===4 && s.conversions.length===1 && s.conversions[0].state==='complete';},'web M4A download then actual MP3 conversion');
 state=await snapshot();
 assert.equal(path.basename(state.downloads[0].path),'联调歌曲 (1).m4a');
 assert.deepEqual(await readFile(state.downloads[0].path),music);assert.ok((await readFile(state.conversions[0].outputPath)).length>0);
 passed.push('网页 M4A 下载并转 MP3、同名编号、原始 M4A 保留');
 await panel.locator('#nav-conversion').click();await panel.locator('#add-files').click();
 await poll(async()=>(await snapshot()).conversions.length===3,'local AAC and ALAC selected');
 await panel.locator('#bitrate').selectOption('192');await panel.locator('#choose-conversion-directory').click();
 await panel.locator('#start-conversion').click();await panel.close();
 await new Promise(r=>setTimeout(r,100));await open();
 await poll(async()=>{const s=await snapshot();return s.conversions.length===3 && s.conversions.every(j=>j.state==='complete');},'tasks finish while panel closed');
 state=await snapshot();
 const ffprobe=built.ffmpeg.replace(/ffmpeg\.exe$/i,'ffprobe.exe');
 for(const job of state.conversions){const result=JSON.parse(run(ffprobe,['-v','error','-show_entries','stream=codec_name,sample_rate,channels,bit_rate:format_tags=title','-of','json',job.outputPath]));assert.equal(result.streams[0].codec_name,'mp3');assert.equal(result.streams[0].sample_rate,'44100');assert.equal(result.streams[0].channels,2);if(!job.downloadTaskId){assert.equal(result.streams[0].bit_rate,'192000');assert.equal(path.dirname(job.outputPath),path.join(fixture,'converted'));}assert.equal(result.format.tags.title,'联调练习');run(built.ffmpeg,['-v','error','-nostdin','-i',job.outputPath,'-f','null','-']);}
 passed.push('本地 AAC/ALAC 实际转码、192kbps、44.1kHz、双声道、标签与完整解码');
 passed.push('关闭侧栏期间任务继续，重新打开恢复真实完成状态');
 await panel.locator('#nav-settings').click();await panel.locator('#follow-download-directory').click();await panel.locator('#mode-browser').check();
 await panel.locator('#nav-resources').click();await panel.locator('.audio-card[data-url$="/song.m4a"] .convert-button').click();
 await poll(async()=>{const s=await snapshot();return s.conversions.length===4 && s.conversions.every(j=>j.state==='complete');},'browser default download-and-convert preserves actual chosen browser directory');
 state=await snapshot();assert.equal(path.dirname(state.downloads[0].path),path.join(fixture,'browser-choice'));
 assert.equal(path.dirname(state.conversions.at(-1).outputPath),path.join(fixture,'browser-choice'));
 assert.deepEqual(await readFile(state.downloads[0].path),music);
 passed.push('恢复跟随目录后，网页 M4A 与 MP3 保存在浏览器实际默认文件夹');
 await panel.locator('#nav-conversion').click();await panel.screenshot({path:path.join(fixture,'conversion.png')});
 assert.deepEqual(errors,[]);passed.forEach(p=>console.log('PASS '+p));
 await writeFile(path.join(fixture,'report.json'),JSON.stringify({passed,errors,transport:'Isolated Chrome API shim -> local test transport -> production HostService; deterministic picker dependencies; no registry configuration',state},null,2));
 await writeFile(path.join(root,'test-results','integration-latest.txt'),fixture);
}catch(error){if(panel && !panel.isClosed()) {console.log('FAIL_STATE',JSON.stringify(await panel.evaluate(()=>chrome.storage.local.get(null))));console.log('FAIL_DOM',await panel.locator('#notice-text').textContent());}throw error;}finally{await context.close();native.stdin.end();await new Promise(r=>native.once('exit',r));await new Promise(r=>server.close(r));}
