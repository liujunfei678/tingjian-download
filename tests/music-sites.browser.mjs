import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {makeWav} from '../scripts/demo-server.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const results=path.join(os.tmpdir(),'tingjian-music-sites-'+Date.now());
await mkdir(results,{recursive:true});
const body=makeWav();
const server=createServer((req,res)=>{res.writeHead(req.url.includes('forbidden')?403:200,{'Content-Type':'audio/wav'});res.end(body);});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const sites=[
  {site:'kuwo',origin:'https://www.kuwo.cn',media:'https://kw-er.kuwo.cn/obj_test.mp3?sign=a%2Bb'},
  {site:'qq',origin:'https://y.qq.com',media:'https://ws6.stream.qqmusic.qq.com/obj_test.m4a?vkey=a%2Bb'},
  {site:'kugou',origin:'https://www.kugou.com',media:'https://webfs.ali.kugou.com/obj_test.mp3?token=a%2Bb'}
];
// Match the current official structures: Kuwo footer co-renders currentSong;
// QQ class instance owns playSong/currentMid/playUrlMap; Kugou binds song_info
// to #myAudio data-hash. Fixtures serve generated WAV bytes, never real music.
const html=site=>`<!doctype html><meta charset="utf-8"><title>多站点播放器夹具</title>
<div class="playControl"><div class="con_l"><a href="/play_detail/123456">歌曲</a><span class="song_name"></span><span class="artist"></span></div><audio></audio></div>
<div class="mod_player"></div><audio id="myAudio"></audio><script>
window.adapterSite=${JSON.stringify(site)};window.play={globalParam:{song_info:{}}};
window.qqInstance={state:{playSong:null,currentMid:null},player:{currentMid:null,playUrlMap:{}}};
document.querySelector('.mod_player').__reactFiber$fixture={return:{stateNode:window.qqInstance}};
window.bind=(url,title='免费测试曲',id=1)=>{
 if(adapterSite==='kuwo'){document.querySelector('.song_name').textContent=title;document.querySelector('.artist').textContent=' - 示例歌手';document.querySelector('.con_l a').href='/play_detail/'+(123455+id);}
 if(adapterSite==='qq'){let mid='00songmid00000'+id;qqInstance.state.playSong={mid,name:title,singer:[{name:'示例歌手'}]};qqInstance.state.currentMid=mid;qqInstance.player.currentMid=mid;qqInstance.player.playUrlMap[mid]=url;}
 if(adapterSite==='kugou'){let hash=String(id).repeat(32);play.globalParam.song_info={hash,song_name:title,author_name:'示例歌手',play_url:url};document.querySelector('#myAudio').setAttribute('data-hash',hash);}
};
window.loadAudio=async url=>{let audio=adapterSite==='kuwo'?document.querySelector('.playControl audio'):adapterSite==='kugou'?document.querySelector('#myAudio'):(window.detachedAudio||=new Audio());audio.src=url;await new Promise(resolve=>{audio.onloadedmetadata=resolve;audio.onerror=resolve;audio.load();});};
window.clearMetadata=()=>{document.querySelector('.song_name').textContent='';qqInstance.state.playSong=null;play.globalParam.song_info={};};
</script>`;
const context=await chromium.launchPersistentContext(path.join(root,'.test-profile','music-sites-'+Date.now()),{
 channel:process.env.TINGJIAN_TEST_BROWSER||'msedge',headless:true,acceptDownloads:true,viewport:{width:420,height:900},
 args:['--disable-extensions-except='+path.join(root,'extension'),'--load-extension='+path.join(root,'extension'),
 '--host-resolver-rules=MAP ws6.stream.qqmusic.qq.com 127.0.0.1','--no-proxy-server']
});
const passed=[],errors=[];
async function poll(fn,label){const end=Date.now()+15000;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw Error('Timeout: '+label);}
try {
 for(const site of sites){
  await context.route(site.origin+'/**',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:html(site.site)}));
  await context.route(site.media.split('/').slice(0,3).join('/')+'/**',route=>route.fulfill({status:route.request().url().includes('forbidden')?403:200,contentType:'audio/wav',body}));
 }
 let worker=context.serviceWorkers().find(w=>w.url().includes('lncnlaidcmglpbnfmikaocnhocjifghn'));
 if(!worker)worker=await context.waitForEvent('serviceworker');
 worker.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 const ui=await context.newPage();await ui.goto('chrome-extension://'+worker.url().split('/')[2]+'/popup/popup.html');
 const page=await context.newPage();
 let tabId;
 const message=(type,extra={})=>ui.evaluate(async args=>chrome.runtime.sendMessage(args),{type,tabId,...extra});
 const state=async(scan=false)=>{const reply=await message(scan?'SCAN_TAB':'GET_AUDIO');assert.equal(reply.ok,true,JSON.stringify(reply));return reply.data;};
 for(const {site,origin,media} of sites){
  await page.goto(origin+'/player-fixture');
  tabId=await ui.evaluate(async origin=>(await chrome.tabs.query({url:origin+'/*'}))[0].id,origin);
  await page.evaluate(async url=>{bind(url);await loadAudio(url);},media);
  await poll(async()=>(await state()).items.some(x=>x.url===media),'capture '+site);
  let item=(await state(true)).items.find(x=>x.url===media);
  assert.equal(item.filename,'免费测试曲 - 示例歌手.'+(site==='qq'?'m4a':'mp3'),site+' title');
  assert.equal(item.musicSite,site);assert.ok(item.musicTrackId);assert.equal(item.verified,true);
  await page.evaluate(url=>loadAudio(url),media);
  assert.equal((await state(true)).items.length,1,'repeated requests do not duplicate '+site);
  passed.push(site+'：实际 MAIN 世界读取当前歌名、歌手和 ID，重复请求保持一条');

  await page.evaluate(url=>bind(url,'切歌后迟到的错误标题',2),media);
  assert.equal((await state(true)).items.find(x=>x.url===media).title,'免费测试曲');
  const second=media.replace('obj_test','obj_second');
  await page.evaluate(async url=>{bind(url,'第二首',2);await loadAudio(url);},second);
  await poll(async()=>(await state()).items.some(x=>x.url===second),'second '+site);
  assert.equal((await state(true)).items.find(x=>x.url===second).title,'第二首');
  assert.equal((await state()).items.find(x=>x.url===media).title,'免费测试曲');
  passed.push(site+'：切歌精确补名，已绑定 URL 不被其他歌曲 ID 改名');

  const wrong=second.replace('a%2Bb','different');
  await page.evaluate(url=>bind(url,'签名不对应',3),wrong);
  assert.equal((await state(true)).items.find(x=>x.url===second).title,'第二首');
  assert.equal((await state()).items.some(x=>x.url===wrong),false,'metadata alone adds nothing');
  const late=media.replace('obj_test','obj_late');
  await page.evaluate(url=>{clearMetadata();return loadAudio(url);},late);
  await poll(async()=>(await state()).items.some(x=>x.url===late),'late '+site);
  assert.equal((await state(true)).items.find(x=>x.url===late).title,'');
  await page.evaluate(url=>bind(url,'迟到的名称',3),late);
  assert.equal((await state(true)).items.find(x=>x.url===late).title,'迟到的名称');
  passed.push(site+'：完整签名必须匹配、名称可晚到、元数据不会制造资源');

  const forbidden=media.replace('obj_test','obj_forbidden');
  await page.evaluate(async url=>{bind(url,'不能下载的歌',4);await loadAudio(url);},forbidden);
  assert.equal((await state(true)).items.some(x=>x.url===forbidden),false);
  await message('CLEAR_TAB');assert.equal((await state()).items.length,0,'metadata cannot restore a cleared resource');
  passed.push(site+'：403 和清空后的失败链接不会成为下载项');
 }
 // Browser-managed downloads use the real local HTTP server (not page routes).
 const downloadURL='http://ws6.stream.qqmusic.qq.com:'+server.address().port+'/obj_download.m4a?vkey=local%2Btest';
 await page.goto('https://y.qq.com/player-fixture');
 tabId=await ui.evaluate(async()=>(await chrome.tabs.query({url:'https://y.qq.com/*'}))[0].id);
 await page.evaluate(url=>{bind(url,'下载用的歌曲');let a=document.createElement('a');a.href=url;a.textContent='下载';document.body.append(a);},downloadURL);
 await poll(async()=>(await state(true)).items.some(x=>x.url===downloadURL&&x.nameRecognized),'named download source');
 const cdp=await context.browser().newBrowserCDPSession();await cdp.send('Browser.setDownloadBehavior',{behavior:'allowAndName',downloadPath:results});
 const reply=await message('DOWNLOAD_AUDIO',{urls:[downloadURL]});assert.equal(reply.ok,true,JSON.stringify(reply));
 await poll(()=>ui.evaluate(async()=>(await chrome.downloads.search({})).some(d=>d.state==='complete')),'completed download');
 const download=(await ui.evaluate(()=>chrome.downloads.search({})))[0];assert.deepEqual(await readFile(download.filename),body);
 const wb=await message('GET_WORKBENCH');assert.equal(wb.data.downloads[0].name,'下载用的歌曲 - 示例歌手.m4a');
 passed.push('真实 chrome.downloads 下载：使用补全名称，文件内容完整');
 const panel=await context.newPage();await panel.goto('chrome-extension://'+worker.url().split('/')[2]+'/panel/panel.html');
 await page.bringToFront();await poll(async()=>await panel.locator('#count').textContent()==='1','panel count');
 assert.equal(await panel.locator('[data-group="recognized"] .audio-card').count(),1);
 await panel.screenshot({path:path.join(results,'multi-site-names-edge.png')});
 passed.push('实际侧栏将补全名称的歌曲展示在已识别组');
 await panel.close();
 // Hold an actual MAIN-world snapshot after it has executed to reproduce
 // asynchronous metadata returning after Clear or a document navigation.
 await worker.evaluate(()=>{
   const execute=chrome.scripting.executeScript.bind(chrome.scripting);
   globalThis.holdSiteReads=false;globalThis.heldSiteReads=[];
   chrome.scripting.executeScript=async options=>{
     const value=await execute(options);
     if(holdSiteReads&&options.func?.name==='readMusicSitePlayback')await new Promise(resolve=>heldSiteReads.push(resolve));
     return value;
   };
 });
 const hold=()=>worker.evaluate(()=>{holdSiteReads=true;});
 const release=()=>worker.evaluate(()=>{holdSiteReads=false;for(const resolve of heldSiteReads.splice(0))resolve();});
 const cached=()=>ui.evaluate(async tabId=>(await chrome.storage.session.get('audio:'+tabId))['audio:'+tabId],tabId);
 const reused='https://ws6.stream.qqmusic.qq.com/obj_reused.m4a?vkey=reused';
 await page.evaluate(async url=>{bind(url,'清空前的名称');try{await fetch(url);}catch{}},reused);
 await poll(async()=>(await state()).items.some(x=>x.url===reused&&x.title==='清空前的名称'),'reused source first capture');
 await hold();const oldSnapshot=state();
 await poll(()=>worker.evaluate(()=>heldSiteReads.length>0),'snapshot before recapture');
 await message('CLEAR_TAB');
 await page.evaluate(async url=>{bind(url,'清空后的正确名称',2);try{await fetch(url,{cache:'reload'});}catch{}},reused);
 await poll(async()=>(await cached())?.items.some(x=>x.url===reused),'same URL recaptured after clear');
 await release();await oldSnapshot;
 assert.equal((await state()).items.find(x=>x.url===reused).title,'清空后的正确名称','old snapshot must not lock a recaptured URL to the previous ID');
 await state(true); // Finish explicit content reports before isolating stale naming reads.
 passed.push('清空后同一URL重新捕获：旧快照不能锁定旧歌曲ID，采用当前名称');
 for(const action of ['clear','navigate']){
   await hold();
   const pending=state();
   await poll(()=>worker.evaluate(()=>heldSiteReads.length>0),'held metadata '+action);
   if(action==='clear')await message('CLEAR_TAB');
   else await page.goto('https://y.qq.com/next-document');
   await release();await pending;
   assert.equal((await state()).items.length,0,action+' cannot restore old resources');
 }
 passed.push('真实异步读取竞争：清空或导航后，迟到的名称不恢复旧资源');
 // Failure supersedes a captured success while the naming read is in flight.
 const race='https://ws6.stream.qqmusic.qq.com/obj_race.m4a?vkey=race';let requests=0;
 await context.route(race,route=>route.fulfill({status:++requests===1?200:403,contentType:'audio/wav',body}));
 await hold();
 await page.evaluate(async url=>{bind(url,'旧响应名称');try{await fetch(url);}catch{}},race);
 await poll(()=>worker.evaluate(()=>heldSiteReads.length>0),'held before 403');
 await page.evaluate(async url=>{try{await fetch(url,{cache:'reload'});}catch{}},race);
 await poll(async()=>(await cached())?.rejected?.includes(race),'403 supersedes success');
 await release();assert.equal((await state(true)).items.some(x=>x.url===race),false);
 passed.push('真实异步读取竞争：后续403作废成功资源，旧播放器快照不恢复它');
 assert.deepEqual(errors,[]);
 await writeFile(path.join(results,'report.json'),JSON.stringify({passed,errors},null,2));
 console.log(JSON.stringify({passed,errors,results},null,2));
} finally {await context.close();await new Promise(resolve=>server.close(resolve));}
