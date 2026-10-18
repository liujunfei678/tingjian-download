import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {makeWav} from '../scripts/demo-server.mjs';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root=fileURLToPath(new URL('../',import.meta.url));
const result=path.join(root,'test-results','legacy-v1.1-'+Date.now());await mkdir(result,{recursive:true});
const rawName='obj_w5rDlsOJwrLDjj7Cm.wav';const rawURL='/'+rawName+'?token=raw%2Bsignature';
const playerURL='/playback/song?token=legacy%2Bsignature';
const server=createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/playback/song' || url.pathname.endsWith('.wav')){res.writeHead(200,{'Content-Type':'audio/wav'});res.end(makeWav());return;}
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(`<!doctype html><title>音乐合集</title><audio id="player" preload="none" title="恢复的中文歌曲" src="${playerURL}"></audio><a href="${rawURL}">播放</a>`);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
const context=await chromium.launchPersistentContext(path.join(root,'.test-profile','legacy-'+Date.now()),{headless:true,channel:'chromium',acceptDownloads:true,args:[`--disable-extensions-except=${path.join(root,'extension')}`,`--load-extension=${path.join(root,'extension')}`]});
const passed=[];let ui;
async function poll(fn,label){const end=Date.now()+12000;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw Error('Timeout '+label);}
try{
 let [worker]=context.serviceWorkers();if(!worker)worker=await context.waitForEvent('serviceworker');
 const id=worker.url().split('/')[2];const page=await context.newPage();await page.goto(base);
 ui=await context.newPage();await page.bringToFront();await ui.goto(`chrome-extension://${id}/popup/popup.html`);
 await poll(()=>ui.evaluate(()=>document.querySelector('#count').textContent!=='0'),'capture initial');
 await new Promise(r=>setTimeout(r,400));
 const state=()=>ui.evaluate(async()=>{const [tab]=await chrome.tabs.query({active:true,currentWindow:true});return (await chrome.runtime.sendMessage({type:'GET_AUDIO',tabId:tab.id})).data;});
 let resources=await state();assert.equal(resources.items.length,2,'1.1 player descriptor must remain visible');
 assert.equal(resources.items.find(item=>item.url===base+playerURL).filename,'恢复的中文歌曲');
 assert.equal(resources.items.find(item=>item.url===base+rawURL).filename,rawName);
 assert.equal(resources.pending?.length || 0,0);
 passed.push('1.1规则：中文播放器资源和原始文件名资源同时显示');
 await page.evaluate(()=>document.querySelector('#player').play());
 await poll(async()=>(await state()).items.some(item=>item.url===base+playerURL && item.verified && item.filename==='恢复的中文歌曲.wav'),'real response adds format without losing Chinese name');
 resources=await state();
 const cdp=await context.browser().newBrowserCDPSession();await cdp.send('Browser.setDownloadBehavior',{behavior:'allowAndName',downloadPath:result});
 await ui.evaluate(async urls=>{const [tab]=await chrome.tabs.query({active:true,currentWindow:true});await chrome.runtime.sendMessage({type:'DOWNLOAD_AUDIO',tabId:tab.id,urls});},resources.items.map(item=>item.url));
 await poll(()=>ui.evaluate(async()=>{const all=await chrome.downloads.search({});return all.length===2 && all.every(item=>item.state==='complete');}),'both resources download');
 const downloads=await ui.evaluate(()=>chrome.downloads.search({}));for(const item of downloads)assert.deepEqual(await readFile(item.filename),makeWav());
 passed.push('中文名称和无名称来源都保持完整URL且可真实下载');
 passed.forEach(p=>console.log('PASS '+p));await writeFile(path.join(result,'report.json'),JSON.stringify({passed},null,2));
}finally{await context.close();await new Promise(r=>server.close(r));}
