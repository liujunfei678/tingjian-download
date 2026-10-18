import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {mkdir, readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {makeWav} from '../scripts/demo-server.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const results=path.join(os.tmpdir(),'tingjian-netease-'+Date.now());
await mkdir(results,{recursive:true});
const origin='https://music.163.com';
const urls=[
  'https://m704.music.126.net/20261018/obj_w5rDlsOJwrLDjj7Cm.m4a?token=a%2Bb&quality=320',
  'https://m10.music.126.net/20261018/obj_wonDkMOGw6XDiT.m4a?token=c%2Bd&quality=192',
  'https://m804.music.126.net/20261018/obj_w5rDlsOJwrLDjj7Cm_unknown.m4a?token=e%2Bf',
  'https://m804.music.126.net/20261018/obj_w5rDlsOJwrLDjj7Cm_late.m4a?token=g%2Bh'
];
const body=makeWav();
const downloadServer=createServer((_request,response)=>{response.writeHead(200,{'Content-Type':'audio/wav'});response.end(body);});
await new Promise(resolve=>downloadServer.listen(0,'127.0.0.1',resolve));
const downloadURL='http://m704.music.126.net:'+downloadServer.address().port+'/obj_w5rDlsOJwrLDjj7Cm_download.m4a?token=local%2Btest';
const context=await chromium.launchPersistentContext(path.join(root,'.test-profile','netease-'+Date.now()),{
  channel:process.env.TINGJIAN_TEST_BROWSER || 'msedge',headless:true,acceptDownloads:true,viewport:{width:420,height:900},
  args:['--disable-extensions-except='+path.join(root,'extension'),'--load-extension='+path.join(root,'extension'),
    '--host-resolver-rules=MAP m704.music.126.net 127.0.0.1','--no-proxy-server']
});
const passed=[],errors=[];
async function poll(fn,label){const end=Date.now()+15000;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw Error('Timeout: '+label);}
try{
  await context.route('https://*.music.126.net/**',route=>route.fulfill({status:200,contentType:'audio/wav',body}));
  await context.route('https://music.163.com/**',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:'<!doctype html><title>网易云音乐</title><h1>网易云播放器场景</h1><a href="/song?id=276035">歌曲页面，不是音频</a><script>window.nm={w:{}};window.currentTrack=null;window.player={getPlaying:()=>({track:window.currentTrack,playing:true})};function MediaController(){};MediaController.singleton={state:{}};window.nm.w.MediaController=MediaController;window.bindTrack=(id,name,artist,url,stateId=id)=>{window.currentTrack={id,name,artists:[{name:artist}]};MediaController.singleton.state={id:stateId,playUrl:url,mediaType:"audio"};};window.loadAudio=async url=>{window.detachedAudio?.pause();window.detachedAudio=new Audio();window.detachedAudio.src=url;await new Promise(resolve=>{window.detachedAudio.onloadedmetadata=resolve;window.detachedAudio.onerror=resolve;window.detachedAudio.load();});};</script>'}));
  let worker=context.serviceWorkers().find(w=>w.url().includes('lncnlaidcmglpbnfmikaocnhocjifghn'));
  if(!worker)worker=await context.waitForEvent('serviceworker',{predicate:w=>w.url().includes('lncnlaidcmglpbnfmikaocnhocjifghn')});
  worker.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  const id=worker.url().split('/')[2];
  const webpage=await context.newPage();await webpage.goto(origin+'/playlist?id=7106006414');
  const ui=await context.newPage();await ui.goto('chrome-extension://'+id+'/popup/popup.html');
  const tabId=await ui.evaluate(async()=>{const tabs=await chrome.tabs.query({url:'https://music.163.com/*'});return tabs[0].id;});
  const state=async(scan=false)=>{const reply=await ui.evaluate(async({tabId,scan})=>chrome.runtime.sendMessage({type:scan?'SCAN_TAB':'GET_AUDIO',tabId}),{tabId,scan});assert.equal(reply.ok,true,JSON.stringify(reply));return reply.data;};

  await webpage.evaluate(({url})=>{bindTrack(276035,'爱一点','莫艳琳',url);return loadAudio(url);},{url:urls[0]});
  await poll(async()=>(await state()).items.some(x=>x.url===urls[0]),'detached media captured');
  assert.equal(await webpage.locator('audio').count(),0,'fixture must reproduce detached NetEase audio');
  assert.equal((await state(true)).items.find(x=>x.url===urls[0]).filename,'爱一点 - 莫艳琳.m4a');
  const readDiagnostics=()=>ui.evaluate(async()=>(await chrome.storage.local.get('neteaseDiagnostics')).neteaseDiagnostics);
  let diagnostic=await readDiagnostics();
  assert.ok(diagnostic.events.some(event=>event.event==='playback'&&event.outcome==='matched'&&event.frames[0].trackId==='276035'));
  assert.ok(diagnostic.events.some(event=>event.event==='response'&&event.decision==='capture'&&event.status===200));
  assert.doesNotMatch(JSON.stringify(diagnostic), /a%2Bb|token=/, 'local diagnostics must not retain signed query values');
  passed.push('Edge MAIN 世界读取脱离 DOM 的网易云播放器，为精确 URL 补歌名和歌手');

  await webpage.evaluate(({url})=>{bindTrack(167827,'就是爱你','陶喆',url,276035);return loadAudio(url);},{url:urls[1]});
  await poll(async()=>(await state()).items.length===2,'second resource');
  let items=(await state(true)).items;
  assert.equal(items.find(x=>x.url===urls[0]).filename,'爱一点 - 莫艳琳.m4a');
  assert.equal(items.find(x=>x.url===urls[1]).nameRecognized,false,'mismatched track IDs must not supply a title');
  await webpage.evaluate(url=>bindTrack(167827,'就是爱你','陶喆',url),urls[1]);
  items=(await state(true)).items;
  assert.equal(items.find(x=>x.url===urls[1]).filename,'就是爱你 - 陶喆.m4a');
  assert.equal(items.find(x=>x.url===urls[0]).filename,'爱一点 - 莫艳琳.m4a');
  passed.push('快速切歌时 ID 不一致不补名；一致后只补对应音频，保留上一首名称');

  await webpage.evaluate(url=>bindTrack(167827,'就是爱你','陶喆',url),urls[0]);
  items=(await state(true)).items;
  assert.equal(items.find(x=>x.url===urls[0]).filename,'爱一点 - 莫艳琳.m4a','a late website response must not rebind a known URL to another track');
  await webpage.evaluate(url=>bindTrack(167827,'就是爱你','陶喆',url),urls[1]);
  passed.push('已记录的 URL 与歌曲 ID 绑定不会被切歌后的迟到响应覆盖');

  await webpage.evaluate(url=>loadAudio(url),urls[2]);
  await poll(async()=>(await state()).items.length===3,'unrelated resource');
  items=(await state(true)).items;
  assert.equal(items.find(x=>x.url===urls[2]).nameRecognized,false);
  assert.equal(items.find(x=>x.url===urls[2]).filename,'obj_w5rDlsOJwrLDjj7Cm_unknown.m4a');
  assert.equal(items.length,3,'song pages and metadata must never create extra resource candidates');
  passed.push('未知 obj 文件保留原名并归入未识别；歌曲链接与播放器信息不增加资源');

  await webpage.evaluate(()=>{nm.w.MediaController.singleton.state={id:999,playUrl:'https://m704.music.126.net/not-captured.m4a'};currentTrack={id:999,name:'不能增加的新资源',artists:[]};});
  assert.equal((await state(true)).items.length,3);
  diagnostic=await readDiagnostics();
  assert.equal(diagnostic.events.at(-1).outcome,'no-exact-captured-url');
  await webpage.evaluate(()=>{currentTrack=null;nm.w.MediaController.singleton.state={};});
  await webpage.evaluate(url=>loadAudio(url),urls[3]);
  await poll(async()=>(await state()).items.length===4,'late metadata resource');
  assert.equal((await state()).items.find(x=>x.url===urls[3]).nameRecognized,false);
  await webpage.evaluate(url=>bindTrack(123456,'后来才有的名字','示例歌手',url),urls[3]);
  items=(await state(true)).items;
  assert.equal(items.find(x=>x.url===urls[3]).filename,'后来才有的名字 - 示例歌手.m4a');
  assert.deepEqual(items.map(x=>x.url).sort(),urls.slice().sort());
  passed.push('名称晚于网络响应到达也能补全；签名参数与资源总数保持不变');

  const panel=await context.newPage();await panel.goto('chrome-extension://'+id+'/panel/panel.html');
  panel.on('pageerror',e=>errors.push(e.message));
  await webpage.bringToFront();
  await poll(async()=>await panel.locator('#count').textContent()==='4','real panel resource count');
  assert.equal(await panel.locator('[data-group="recognized"] .audio-card').count(),3);
  assert.equal(await panel.locator('[data-group="unrecognized"] .audio-card').count(),1);
  assert.ok((await panel.locator('[data-group="recognized"] .file-name').allTextContents()).includes('爱一点 - 莫艳琳.m4a'));
  await panel.screenshot({path:path.join(results,'netease-names-edge.png')});
  passed.push('真实扩展界面显示中文名称、歌手，以及正确的已识别/未识别分组');

  // Browser-managed chrome.downloads requests bypass Playwright page routes.
  // Use an actual local HTTP response with a NetEase hostname for this boundary.
  await webpage.evaluate(url=>{bindTrack(276035,'爱一点','莫艳琳',url);const link=document.createElement('a');link.href=url;link.textContent='下载';document.body.append(link);},downloadURL);
  await poll(async()=>(await state()).items.some(item=>item.url===downloadURL&&item.filename==='爱一点 - 莫艳琳.m4a'),'local named download source');
  const cdp=await context.browser().newBrowserCDPSession();await cdp.send('Browser.setDownloadBehavior',{behavior:'allowAndName',downloadPath:results});
  const reply=await ui.evaluate(async({tabId,url})=>chrome.runtime.sendMessage({type:'DOWNLOAD_AUDIO',tabId,urls:[url]}),{tabId,url:downloadURL});
  assert.equal(reply.ok,true,JSON.stringify(reply));
  await poll(()=>ui.evaluate(async()=>{const all=await chrome.downloads.search({});return all.length===1&&all[0].state==='complete';}),'named download');
  const downloads=await ui.evaluate(()=>chrome.downloads.search({}));
  const workbench=await ui.evaluate(()=>chrome.runtime.sendMessage({type:'GET_WORKBENCH'}));
  assert.equal(workbench.data.downloads[0].name,'爱一点 - 莫艳琳.m4a');
  assert.deepEqual(await readFile(downloads[0].filename),body);
  passed.push('下载任务采用已补全的真实名称，音频内容保持完整');

  // Reproduce the actual Edge response for 爱一点: a successful M4A byte
  // range is mislabeled video/quicktime by the NetEase CDN.
  const mislabeledURL='https://m804.music.126.net/20261018/jdyyaac/obj/9557680230/track.m4a?token=private%2Bsignature';
  await context.route(mislabeledURL,route=>route.fulfill({status:206,contentType:'video/quicktime;charset=UTF-8',
    headers:{'Content-Range':`bytes 0-${body.length-1}/${body.length}`},body}));
  await webpage.evaluate(url=>{bindTrack(276035,'爱一点','莫艳琳',url);return loadAudio(url);},mislabeledURL);
  await poll(async()=>{const item=(await state(true)).items.find(item=>item.url===mislabeledURL);return item?.verified&&item.filename==='爱一点 - 莫艳琳.m4a';},'successful mislabeled NetEase M4A captured and named');
  const corrected=(await state()).items.find(item=>item.url===mislabeledURL);
  assert.equal(corrected.mime,'audio/mp4');
  assert.equal(corrected.size,body.length);
  assert.equal(corrected.neteaseTrackId,'276035');
  passed.push('真实故障回归：网易云误标 video/quicktime 的206 M4A响应仍被识别并正确命名');

  const stableCount=(await state()).items.length;
  await webpage.evaluate(url=>loadAudio(url),mislabeledURL);
  assert.equal((await state(true)).items.length,stableCount);
  const lateM4A=mislabeledURL.replace('track.m4a','late.m4a');
  await context.route(lateM4A,route=>route.fulfill({status:206,contentType:'video/quicktime;charset=UTF-8',
    headers:{'Content-Range':`bytes 0-${body.length-1}/${body.length}`},body}));
  await webpage.evaluate(url=>{currentTrack=null;return loadAudio(url);},lateM4A);
  await poll(async()=>(await state(true)).rejected.includes(lateM4A),'unbound QuickTime source hidden');
  assert.equal((await state()).items.some(item=>item.url===lateM4A),false);
  await webpage.evaluate(url=>bindTrack(1007635,'Only One','Alex Band',url),lateM4A);
  await poll(async()=>(await state(true)).items.some(item=>item.url===lateM4A&&item.filename==='Only One - Alex Band.m4a'&&item.verified),'late metadata proves observed response');
  passed.push('重复Range响应不增加条目；元数据晚到时可补回已收到的误标M4A响应');

  const negatives=[
    {url:mislabeledURL.replace('track.m4a','forbidden.m4a'),status:403,mime:'video/quicktime'},
    {url:mislabeledURL.replace('track.m4a','video.m4a'),status:200,mime:'video/mp4'},
    {url:mislabeledURL.replace('track.m4a','movie.mov'),status:200,mime:'video/quicktime'},
    {url:mislabeledURL.replace('track.m4a','movie.mp4'),status:200,mime:'video/quicktime'},
    {url:mislabeledURL.replace('track.m4a','wrong-signature.m4a'),status:206,mime:'video/quicktime',differentSignature:true}
  ];
  for(const negative of negatives){
    await context.route(negative.url,route=>route.fulfill({status:negative.status,contentType:negative.mime,
      headers:negative.status===206?{'Content-Range':`bytes 0-${body.length-1}/${body.length}`}:{},body}));
    await webpage.evaluate(({url,differentSignature})=>{bindTrack(276035,'爱一点','莫艳琳',differentSignature?url+'&other=1':url);return loadAudio(url);},negative);
    await poll(async()=>(await state(true)).rejected.includes(negative.url),'excluded '+negative.url);
    assert.equal((await state()).items.some(item=>item.url===negative.url),false);
  }
  passed.push('403、真正的视频MIME、MOV/MP4和签名不匹配的地址继续排除');

  const offsiteURL=mislabeledURL.replace('track.m4a','offsite.m4a');
  await context.route(offsiteURL,route=>route.fulfill({contentType:'video/quicktime',body}));
  await context.route('https://other.test/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>其他网页</title>'}));
  const offsite=await context.newPage();await offsite.goto('https://other.test/');
  const offsiteTabId=await ui.evaluate(async()=>(await chrome.tabs.query({url:'https://other.test/*'}))[0].id);
  await offsite.evaluate(url=>{window.media=new Audio(url);media.load();},offsiteURL);
  const offsiteState=async()=>{const reply=await ui.evaluate(tabId=>chrome.runtime.sendMessage({type:'GET_AUDIO',tabId}),offsiteTabId);assert.equal(reply.ok,true);return reply.data;};
  await poll(async()=>(await offsiteState()).rejected.includes(offsiteURL),'other page keeps general video filter');
  assert.equal((await offsiteState()).items.length,0);
  passed.push('其他网页不会继承网易云的M4A误标兼容规则');

  await webpage.evaluate(url=>{bindTrack(1007635,'Only One','Alex Band',url);return loadAudio(url);},mislabeledURL);
  assert.equal((await state(true)).items.find(item=>item.url===mislabeledURL).filename,'爱一点 - 莫艳琳.m4a');
  passed.push('误标响应也遵守已有歌曲绑定，不会把旧链接改成新歌名');

  // Hold the result of a real MAIN-world read in this isolated test profile,
  // so an HTTP failure or Clear can happen before the result is committed.
  await worker.evaluate(()=>{
    globalThis.heldPlaybackReads=[];globalThis.holdPlaybackReads=false;
    const execute=chrome.scripting.executeScript.bind(chrome.scripting);
    chrome.scripting.executeScript=async options=>{
      const value=await execute(options);
      if(globalThis.holdPlaybackReads&&options.func?.name==='readNeteasePlayback') await new Promise(resolve=>heldPlaybackReads.push(resolve));
      return value;
    };
  });
  const hold=()=>worker.evaluate(()=>{holdPlaybackReads=true;});
  const release=()=>worker.evaluate(()=>{holdPlaybackReads=false;for(const resolve of heldPlaybackReads.splice(0))resolve();});
  const held=()=>worker.evaluate(()=>heldPlaybackReads.length>0);
  const cached=()=>ui.evaluate(async tabId=>(await chrome.storage.session.get('audio:'+tabId))['audio:'+tabId],tabId);

  const failureRace=mislabeledURL.replace('track.m4a','late-failure.m4a');let failureRequests=0;
  await context.route(failureRace,route=>route.fulfill({status:++failureRequests===1?206:403,contentType:'video/quicktime',
    headers:failureRequests===1?{'Content-Range':`bytes 0-${body.length-1}/${body.length}`}:{},body}));
  await hold();
  await webpage.evaluate(url=>{bindTrack(276035,'爱一点','莫艳琳',url);return loadAudio(url);},failureRace);
  await poll(held,'held player snapshot before failure');
  await webpage.evaluate(async url=>{try{await fetch(url,{cache:'reload'});}catch{}},failureRace);
  await poll(async()=>(await cached())?.rejected?.includes(failureRace),'new HTTP403 supersedes success');
  await release();
  assert.equal((await state(true)).items.some(item=>item.url===failureRace),false);
  passed.push('迟到的播放器读取不会在后续403之后恢复失效资源');

  const clearRace=mislabeledURL.replace('track.m4a','late-clear.m4a');
  await context.route(clearRace,route=>route.fulfill({status:206,contentType:'video/quicktime',
    headers:{'Content-Range':`bytes 0-${body.length-1}/${body.length}`},body}));
  await hold();
  await webpage.evaluate(url=>{bindTrack(276035,'爱一点','莫艳琳',url);return loadAudio(url);},clearRace);
  await poll(held,'held player snapshot before clear');
  const cleared=await ui.evaluate(tabId=>chrome.runtime.sendMessage({type:'CLEAR_TAB',tabId}),tabId);
  assert.equal(cleared.ok,true);
  await release();
  assert.equal((await state()).items.length,0);
  passed.push('清空列表同时作废待验证响应，迟到的读取不会恢复旧歌曲');
  assert.deepEqual(errors,[]);
  passed.forEach(x=>console.log('PASS '+x));
  console.log('Screenshot: '+path.join(results,'netease-names-edge.png'));
}finally{await context.close();await new Promise(resolve=>downloadServer.close(resolve));}
