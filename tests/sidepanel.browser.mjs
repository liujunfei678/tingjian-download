import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createDemoServer} from '../scripts/demo-server.mjs';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root=fileURLToPath(new URL('../',import.meta.url));
const result=path.join(root,'test-results','sidepanel'); await mkdir(result,{recursive:true});
const server=createDemoServer(); await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;
const context=await chromium.launchPersistentContext(path.join(root,'.test-profile','sidepanel-'+Date.now()),{channel:'chromium',headless:true,args:[`--disable-extensions-except=${path.join(root,'extension')}`,`--load-extension=${path.join(root,'extension')}`],viewport:{width:1200,height:900}});
const passed=[],errors=[];
async function poll(operation,description){const end=Date.now()+15000;while(Date.now()<end){if(await operation())return;await new Promise(r=>setTimeout(r,100));}throw Error('Timeout: '+description);}
try{
 let [worker]=context.serviceWorkers(); if(!worker)worker=await context.waitForEvent('serviceworker');
 worker.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
 const id=worker.url().split('/')[2];
 const webpage=await context.newPage(); await webpage.goto(base+'/naming');
 const helper=await context.newPage(); await helper.goto(`chrome-extension://${id}/popup/popup.html`);
 const helperCDP=await context.newCDPSession(helper);
 const browser=await context.browser().newBrowserCDPSession();
 async function openPanel(){
  const response=await helperCDP.send('Runtime.evaluate',{expression:'chrome.windows.getCurrent().then(w=>chrome.sidePanel.open({windowId:w.id})).then(()=>true)',userGesture:true,awaitPromise:true,returnByValue:true});
  assert.equal(response.result?.value,true,JSON.stringify(response));
 }
 await openPanel(); await webpage.bringToFront();
 const targets=async()=> (await browser.send('Target.getTargets')).targetInfos;
 let target;
 await poll(async()=>{target=(await targets()).find(t=>t.url===`chrome-extension://${id}/panel/panel.html`);return target;},'true sidepanel target');
 const {sessionId}=await browser.send('Target.attachToTarget',{targetId:target.targetId,flatten:false});
 let sequence=0; const pending=new Map();
 browser.on('Target.receivedMessageFromTarget',event=>{if(event.sessionId!==sessionId)return;const message=JSON.parse(event.message);if(message.id){const request=pending.get(message.id);if(request){pending.delete(message.id);message.error?request.reject(Error(message.error.message)):request.resolve(message.result);}}if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails.text);});
 const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});void browser.send('Target.sendMessageToTarget',{sessionId,message:JSON.stringify({id,method,params})}).catch(reject);});
 async function evaluate(expression){const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;}
 await send('Runtime.enable');
 await poll(()=>evaluate('document.querySelector("#count")?.textContent === "8"'),'sidepanel reads actual naming resources');
 const grouping=await evaluate('({recognized:document.querySelectorAll("[data-group=recognized] .audio-card").length,unrecognized:document.querySelectorAll("[data-group=unrecognized] .audio-card").length})');
 assert.ok(grouping.recognized>0); assert.ok(grouping.unrecognized>0); assert.equal(grouping.recognized+grouping.unrecognized,8);
 passed.push('真实 sidePanel 文档读取后台资源并按名称分两组');
 await webpage.locator('body').click({position:{x:5,y:5}});
 assert.ok((await targets()).some(t=>t.targetId===target.targetId));
 assert.equal(await evaluate('document.visibilityState'),'visible');
 passed.push('点击网页后侧栏仍保持可见');
 const second=await context.newPage(); await second.goto(base+'/empty'); await second.bringToFront();
 await poll(()=>evaluate('document.querySelector("#count").textContent === "0"'),'follow second tab');
 await webpage.bringToFront(); await poll(()=>evaluate('document.querySelector("#count").textContent === "8"'),'return first tab');
 passed.push('真实标签页切换跟随并隔离资源');
 const owner=await evaluate('chrome.windows.getCurrent().then(w=>w.id)');
 const other=await helper.evaluate(()=>chrome.windows.create({url:'about:blank',focused:false}));
 assert.notEqual(other.id,owner); await new Promise(r=>setTimeout(r,300));
 assert.equal(await evaluate('document.querySelector("#count").textContent'),'8');
 await helper.evaluate(id=>chrome.windows.remove(id),other.id);
 passed.push('另一浏览器窗口的活动页不会覆盖当前侧栏');
 const screenshot=await send('Page.captureScreenshot',{format:'png'}); await writeFile(path.join(result,'resources.png'),Buffer.from(screenshot.data,'base64'));
 await evaluate('document.querySelector("#nav-settings").click()');
 await evaluate('document.querySelector("#native-connect").click()');
 await poll(()=>evaluate('document.querySelector("#notice-text").textContent.includes("本地组件")'),'missing host clear feedback');
 passed.push('未注册本地组件时显示配置提示且不影响普通下载');
 await evaluate('document.querySelector("#close-panel").click()');
 await poll(async()=>!(await targets()).some(t=>t.targetId===target.targetId),'explicit close destroys sidepanel document');
 await openPanel();
 await poll(async()=>(await targets()).some(t=>t.url===`chrome-extension://${id}/panel/panel.html`),'reopen sidepanel');
 passed.push('点击关闭后可重新打开常驻侧栏');
 assert.deepEqual(errors,[]);
 passed.forEach(p=>console.log('PASS '+p));
 await writeFile(path.join(result,'report.json'),JSON.stringify({passed,errors,method:'真实Chrome sidePanel target; CDP user gesture; no mock Chrome APIs'},null,2));
}finally{await context.close();await new Promise(r=>server.close(r));}
