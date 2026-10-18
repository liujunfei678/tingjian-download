import test from 'node:test';
import assert from 'node:assert/strict';
import { Workbench } from '../extension/lib/workbench.js';

function fixture(initial = {}) {
  const local = {workbench: initial}; const session = {}; const actual = new Map(); const calls = [];
  const storage = map => ({async get(key) {return typeof key === 'string' ? {[key]:map[key]} : {...key,...map};},async set(values) {Object.assign(map,structuredClone(values));}});
  let id = 0;
  const chrome = {storage:{local:storage(local),session:storage(session)},downloads:{
    async download(options) {calls.push(['download',options]); actual.set(++id,{id,state:'in_progress',filename:'C:\\Downloads\\'+options.filename.replaceAll('/','\\')}); return id;},
    async search({id}) {return actual.has(id) ? [actual.get(id)] : [];},
    async removeFile(id) {calls.push(['removeFile',id]);}, async erase({id}) {calls.push(['erase',id]);},
    show(id) {calls.push(['show',id]);}, async open(id) {calls.push(['open',id]);}
  }};
  const bridge = {connected:false,onEvent:null,onDisconnect:null,async request(command,body={}) {
    calls.push([command,body]); this.connected=true;
    if(command==='hello') return {version:'2.0.0',defaultDownloadDirectory:'C:\\Downloads'};
    if(command==='snapshot') return {jobs:[]};
    if(command==='publish') {if(bridge.publishError) throw Error(bridge.publishError); return {path:'D:\\Music\\'+body.filename};}
    if(command==='chooseDirectory') return {path:'D:\\Music'};
    if(command==='chooseFiles') return {files:[{path:'D:\\Input\\歌曲.m4a',size:100}],errors:[]};
    if(command==='convert') return {jobs:body.jobs.map(j=>({...j,state:'pending',progress:0}))};
    return {};
  }};
  const wb = new Workbench(chrome,bridge); return {wb,chrome,bridge,calls,actual,local};
}
const song = {url:'https://example.test/song.m4a',filename:'歌曲.m4a',format:'M4A'};

test('ordinary browser downloads remain available with no native installation',async()=>{
  const f=fixture(); await f.wb.ready;
  const result=await f.wb.downloadItems(5,[song],{});
  assert.equal(result[0].id,1); assert.equal(f.calls.some(c=>c[0]==='hello'),false);
  f.actual.get(1).state='complete'; await f.wb.downloadChanged({id:1,state:{current:'complete'}});
  assert.equal((await f.wb.snapshot()).downloads[0].state,'complete');
});

test('custom downloads publish then persist final path before cleaning owned staging only',async()=>{
  const f=fixture({prefs:{downloadMode:'custom',downloadDirectory:'D:\\Music'}}); await f.wb.ready;
  await f.wb.downloadItems(5,[song],{});
  const options=f.calls.find(c=>c[0]==='download')[1];
  assert.match(options.filename,/^Tingjian\/staging\/[a-f0-9-]+\/歌曲\.m4a$/); assert.equal(options.saveAs,false);
  f.actual.get(1).state='complete';
  const request=f.bridge.request.bind(f.bridge);
  f.bridge.request=async(command,body)=>{if(command==='cleanup') assert.equal(f.local.workbench.downloads[0].path,'D:\\Music\\歌曲.m4a'); return request(command,body);};
  await f.wb.downloadChanged({id:1,state:{current:'complete'}});
  const snapshot=await f.wb.snapshot(); assert.equal(snapshot.downloads[0].state,'complete');
  assert.equal(snapshot.downloads[0].path,'D:\\Music\\歌曲.m4a');
  assert.deepEqual(f.calls.filter(c=>['publish','cleanup','erase'].includes(c[0])).map(c=>c[0]),['publish','cleanup','erase']);
});

test('publish failure preserves staging and can be retried without another network download',async()=>{
  const f=fixture({prefs:{downloadMode:'custom',downloadDirectory:'D:\\Music'}}); await f.wb.ready;
  await f.wb.downloadItems(5,[song],{}); f.actual.get(1).state='complete'; f.bridge.publishError='目录不可写';
  await f.wb.downloadChanged({id:1,state:{current:'complete'}});
  let task=(await f.wb.snapshot()).downloads[0]; assert.equal(task.state,'failed'); assert.match(task.error,/目录不可写/);
  assert.equal(f.calls.some(c=>c[0]==='removeFile'),false);
  f.bridge.publishError=''; await f.wb.handle({type:'RETRY_DOWNLOAD',id:task.id});
  task=(await f.wb.snapshot()).downloads[0]; assert.equal(task.state,'complete');
  assert.equal(f.calls.filter(c=>c[0]==='download').length,1);
});

test('download-and-convert keeps original, queues M4A only after successful publication',async()=>{
  const f=fixture(); await f.wb.ready; await f.wb.downloadItems(7,[song],{convert:true});
  assert.equal(f.calls.some(c=>c[0]==='convert'),false); f.actual.get(1).state='complete';
  await f.wb.downloadChanged({id:1,state:{current:'complete'}});
  const conversion=f.calls.find(c=>c[0]==='convert'); assert.equal(conversion[1].jobs[0].inputPath,'D:\\Music\\歌曲.m4a');
  const snap=await f.wb.snapshot(); assert.equal(snap.downloads[0].state,'complete'); assert.equal(snap.conversions.length,1);
});

test('directory authority cannot be supplied via saved settings or arbitrary file paths',async()=>{
  const f=fixture(); await f.wb.ready;
  await f.wb.handle({type:'SAVE_SETTINGS',settings:{downloadDirectory:'C:\\Windows',conversionDirectory:'C:\\Windows',bitrate:192,downloadMode:'custom'}});
  assert.equal((await f.wb.snapshot()).prefs.downloadDirectory,''); assert.equal((await f.wb.snapshot()).prefs.bitrate,192);
  await assert.rejects(f.wb.handle({type:'OPEN_TASK',id:'unknown'}),/任务/);
  await f.wb.handle({type:'CHOOSE_DIRECTORY',purpose:'download'}); assert.equal((await f.wb.snapshot()).prefs.downloadDirectory,'D:\\Music');
});

test('conversion progress survives UI closure and disconnected host never reports success',async()=>{
  const f=fixture(); await f.wb.ready;
  await f.wb.handle({type:'ADD_CONVERSION_FILES',folder:false}); await f.wb.handle({type:'START_CONVERSION'});
  const task=(await f.wb.snapshot()).conversions[0];
  await f.wb.nativeEvent({event:'conversion',jobs:[{id:task.id,state:'running',progress:.45}]});
  assert.equal((await f.wb.snapshot()).conversions[0].progress,.45);
  await f.wb.disconnected('本地组件连接已断开');
  const snap=await f.wb.snapshot(); assert.equal(snap.conversions[0].state,'interrupted'); assert.equal(snap.host.connected,false);
});

test('an interrupted browser transfer retries from the recorded URL and new download identity',async()=>{
  const f=fixture(); await f.wb.ready; await f.wb.downloadItems(3,[song],{});
  f.actual.get(1).state='interrupted'; await f.wb.downloadChanged({id:1,state:{current:'interrupted'},error:{current:'NETWORK_FAILED'}});
  const task=(await f.wb.snapshot()).downloads[0];
  await f.wb.handle({type:'RETRY_DOWNLOAD',id:task.id});
  const next=(await f.wb.snapshot()).downloads[0]; assert.equal(next.browserDownloadId,2); assert.equal(next.state,'downloading');
  assert.equal(f.calls.filter(c=>c[0]==='download')[1][1].url,song.url);
});

test('worker recovery reconciles a completed transfer rather than leaving it downloading forever',async()=>{
  const f=fixture(); await f.wb.ready; await f.wb.downloadItems(3,[song],{});
  f.actual.get(1).state='complete';
  await f.wb.recover();
  assert.equal((await f.wb.snapshot()).downloads[0].state,'complete');
});

test('completed download conversion intent is recovered after interruption before queue submission',async()=>{
  const f=fixture({downloads:[{id:'saved-m4a',name:'歌曲.m4a',path:'D:\\Music\\歌曲.m4a',state:'complete',staged:true,convert:true,browserDownloadId:99,tabId:1,url:song.url}],conversions:[]});
  await f.wb.ready; await f.wb.recover();
  const snapshot=await f.wb.snapshot(); assert.equal(snapshot.conversions.length,1);
  assert.equal(f.calls.filter(c=>c[0]==='convert').length,1);
});

test('large folders are fed in bounded batches as native queue capacity becomes available',async()=>{
  const conversions=Array.from({length:205},(_,i)=>({id:'job-'+i,inputPath:`D:\\Input\\${i}.m4a`,name:`${i}.m4a`,state:'pending',progress:0}));
  const f=fixture({conversions}); await f.wb.ready; await f.wb.handle({type:'START_CONVERSION'});
  assert.equal(f.calls.filter(c=>c[0]==='convert')[0][1].jobs.length,200);
  await f.wb.nativeEvent({event:'conversion',jobs:conversions.slice(0,200).map(j=>({...j,state:'complete',progress:1}))});
  assert.equal(f.calls.filter(c=>c[0]==='convert')[1][1].jobs.length,5);
});

test('restoring follow-download output stays selected after reconnecting an older native preference',async()=>{
  const f=fixture({prefs:{conversionDirectory:'D:\\OldMP3'}}); await f.wb.ready;
  const request=f.bridge.request.bind(f.bridge);
  f.bridge.request=(command,body)=>command==='hello' ? Promise.resolve({version:'2.0.0',conversionDirectory:'D:\\OldMP3',defaultDownloadDirectory:'C:\\Downloads'}) : request(command,body);
  await f.wb.handle({type:'SAVE_SETTINGS',settings:{conversionDirectory:''}});
  await f.wb.handle({type:'NATIVE_CONNECT'});
  assert.equal((await f.wb.snapshot()).prefs.conversionDirectory,'');
});
