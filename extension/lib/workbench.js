const defaults = {downloadMode:'browser',downloadDirectory:'',conversionDirectory:'',bitrate:320,saveAs:false,recursive:false};
const activeDownload = state => ['downloading','publishing'].includes(state);
const activeConversion = state => ['running','pending'].includes(state);
const errorText = error => error?.message || String(error || '操作失败');

export class Workbench {
  constructor(chromeAPI, bridge) {
    this.chrome = chromeAPI;
    this.bridge = bridge;
    this.tail = Promise.resolve();
    this.finishing = new Set();
    bridge.onEvent = event => { void this.nativeEvent(event).catch(console.error); };
    bridge.onDisconnect = reason => { void this.disconnected(reason).catch(console.error); };
    this.ready = this.initialize();
  }

  async initialize() {
    const {workbench, saveAs} = await this.chrome.storage.local.get({workbench:null,saveAs:false});
    const sameSession = (await this.chrome.storage.session.get('workbenchSession')).workbenchSession;
    this.state = {
      prefs:{...defaults,saveAs,...workbench?.prefs},
      host:{connected:false,version:'',error:''},
      downloads:Array.isArray(workbench?.downloads) ? workbench.downloads : [],
      conversions:Array.isArray(workbench?.conversions) ? workbench.conversions : []
    };
    if (!sameSession) {
      for (const task of this.state.conversions) if (activeConversion(task.state) && (task.submitted || task.scheduled || task.state==='running')) Object.assign(task,{state:'interrupted',error:'浏览器上次退出，任务已中断，可重试。'});
      for (const task of this.state.downloads) if (activeDownload(task.state)) Object.assign(task,{state:'interrupted',error:'浏览器上次退出，请重试或查看浏览器下载记录。'});
    }
    await this.chrome.storage.session.set({workbenchSession:true});
    await this.save();
  }

  async save() {
    await this.chrome.storage.local.set({workbench:structuredClone(this.state)});
  }

  run(operation) {
    const next = this.tail.catch(()=>{}).then(async()=>{await this.ready; return operation();});
    this.tail = next;
    return next;
  }

  async snapshot() {await this.ready; return structuredClone(this.state);}

  recover() {
    return this.run(async()=>{
      for (const task of this.state.downloads.filter(task=>activeDownload(task.state))) {
        try {
          const [actual]=await this.chrome.downloads.search({id:task.browserDownloadId});
          if (actual?.state==='complete') await this.finishDownload(task,actual);
          else if (!actual || actual.state==='interrupted') await this.failDownload(task,actual?.error || '下载已中断，请重试。');
        } catch (error) {await this.failDownload(task,errorText(error));}
      }
      for (const task of this.state.downloads.filter(task=>task.state==='complete')) {
        if (task.staged && !task.cleaned) await this.cleanupTask(task);
        if (task.convert && task.path && !this.state.conversions.some(job=>job.downloadTaskId===task.id)) this.addConversion(task.path,0,task.id);
      }
      const automatic=this.state.conversions.filter(task=>task.downloadTaskId && task.state==='pending' && !task.submitted);
      if (automatic.length) {
        automatic.forEach(task=>{task.scheduled=true;});
        try {await this.pumpConversions();} catch (error) {
          automatic.forEach(task=>Object.assign(task,{state:'failed',error:errorText(error)})); await this.save();
        }
      }
      if (this.state.conversions.some(task=>task.submitted && activeConversion(task.state))) {
        try {await this.connect();} catch (error) {
          for (const task of this.state.conversions) if (task.submitted && activeConversion(task.state)) Object.assign(task,{state:'interrupted',error:errorText(error)});
          await this.save();
        }
      }
      await this.pumpConversions();
      await this.save();
    });
  }

  async connect() {
    if (this.state.host.connected && this.bridge.connected) return;
    try {
      const hello = await this.bridge.request('hello');
      this.bridge.connected = true;
      this.state.host = {connected:true,version:hello.version || '',error:''};
      for (const key of ['downloadDirectory','conversionDirectory']) if (hello[key] !== undefined && !(key==='conversionDirectory' && this.state.prefs.followDownloadDirectory)) this.state.prefs[key] = hello[key];
      this.defaultDirectory = hello.defaultDownloadDirectory || '';
      const snapshot = await this.bridge.request('snapshot');
      this.mergeJobs(snapshot.jobs || []);
      await this.save();
    } catch (error) {
      this.state.host = {connected:false,version:'',error:errorText(error)};
      await this.save();
      throw new Error('请先配置听见 Windows 本地组件，再连接重试。' + errorText(error));
    }
  }

  mergeJobs(jobs) {
    for (const incoming of jobs) {
      const task = this.state.conversions.find(item=>item.id===incoming.id);
      if (!task) continue;
      Object.assign(task, incoming, {progress:Math.min(1,Math.max(0,Number(incoming.progress)||0))});
      if (task.state === 'complete') task.progress = 1;
      if (task.outputPath) task.path = task.outputPath;
    }
  }

  nativeEvent(event) {
    return this.run(async()=>{
      if (event.event === 'conversion') {this.mergeJobs(event.jobs || []); await this.save(); await this.pumpConversions();}
    });
  }

  disconnected(reason) {
    return this.run(async()=>{
      this.state.host.connected = false;
      this.state.host.error = reason;
      for (const task of this.state.conversions) if (task.state === 'running' || task.state === 'pending' && task.submitted) Object.assign(task,{state:'interrupted',error:reason});
      await this.save();
    });
  }

  downloadItems(tabId, items, options) {
    return this.run(async()=>{
      const results = [];
      for (const item of items) {
        const convert = options.convert === true && String(item.format).toUpperCase() === 'M4A';
        const staged = this.state.prefs.downloadMode === 'custom' || convert;
        try {
          if (options.convert && !convert) throw new Error('只有 M4A 资源支持此转换操作。');
          if (staged) await this.connect();
          if (this.state.prefs.downloadMode === 'custom' && !this.state.prefs.downloadDirectory) throw new Error('请先在设置中选择下载文件夹。');
          const task = {id:crypto.randomUUID(),tabId,url:item.url,name:item.filename,state:'downloading',progress:0,error:'',path:'',staged,convert,format:item.format,
            directory:this.state.prefs.downloadMode === 'custom' ? this.state.prefs.downloadDirectory : '@browser',createdAt:Date.now()};
          const id = await this.chrome.downloads.download({url:item.url,
            filename:staged ? `Tingjian/staging/${task.id}/${item.filename}` : item.filename,
            conflictAction:'uniquify',saveAs:staged ? false : Boolean(options.saveAs ?? this.state.prefs.saveAs)});
          task.browserDownloadId = id;
          this.state.downloads.unshift(task);
          await this.save();
          await this.status(task,'in_progress');
          results.push({url:item.url,id,taskId:task.id});
          const [actual] = await this.chrome.downloads.search({id});
          if (actual?.state === 'complete') await this.finishDownload(task,actual);
          else if (actual?.state === 'interrupted') await this.failDownload(task,actual.error || '下载已中断');
        } catch (error) {results.push({url:item.url,error:errorText(error)});}
      }
      return results;
    });
  }

  async status(task,state,error='') {
    await this.chrome.storage.session.set({[`status:${task.tabId}:${task.url}`]:{state,error,updatedAt:Date.now()}});
  }

  async failDownload(task,reason) {
    Object.assign(task,{state:'failed',error:reason}); await this.save(); await this.status(task,'interrupted',reason);
  }

  async finishDownload(task, actual) {
    if (task.state === 'complete' || this.finishing.has(task.id)) return;
    this.finishing.add(task.id);
    try {
      task.sourcePath = actual.filename;
      if (task.staged) {
        task.state = 'publishing'; await this.save();
        await this.connect();
        const published = await this.bridge.request('publish',{taskId:task.id,sourcePath:actual.filename,directory:task.directory,filename:task.name});
        task.path = published.path;
      } else task.path = actual.filename;
      const job=task.convert && !this.state.conversions.some(job=>job.downloadTaskId===task.id) ? this.addConversion(task.path,0,task.id) : null;
      Object.assign(task,{state:'complete',progress:1,error:''});
      await this.save();
      await this.status(task,'complete');
      if (task.staged) await this.cleanupTask(task);
      if (job) {
        job.scheduled=true;
        try {await this.pumpConversions();}
        catch (error) {Object.assign(job,{state:'failed',error:errorText(error)}); await this.save();}
      }
    } catch (error) {await this.failDownload(task,errorText(error));}
    finally {this.finishing.delete(task.id);}
  }

  async cleanupTask(task) {
    // Success and conversion intent have already been durably recorded.
    try {
      await this.connect();
      await this.bridge.request('cleanup',{taskId:task.id,sourcePath:task.sourcePath});
      await this.chrome.downloads.erase({id:task.browserDownloadId});
      task.cleaned=true;
    } catch (error) {task.cleanupError=errorText(error);}
    await this.save();
  }

  downloadChanged(delta) {
    return this.run(async()=>{
      const task = this.state.downloads.find(item=>item.browserDownloadId===delta.id);
      if (!task || task.state === 'complete') return;
      if (delta.state?.current === 'interrupted' || delta.error?.current) return this.failDownload(task,delta.error?.current || '下载已取消或中断。');
      if (delta.state?.current === 'complete') {
        const [actual] = await this.chrome.downloads.search({id:delta.id});
        if (actual) await this.finishDownload(task,actual);
      }
    });
  }

  addConversion(inputPath,size=0,downloadTaskId='') {
    const task = {id:crypto.randomUUID(),inputPath,name:inputPath.split(/[\\/]/).pop(),size,downloadTaskId,state:'pending',progress:0,error:'',createdAt:Date.now()};
    if (downloadTaskId) task.outputDirectory=this.state.prefs.conversionDirectory || inputPath.replace(/[\\/][^\\/]+$/,'');
    this.state.conversions.push(task); return task;
  }

  async submitConversions(jobs) {
    if (!jobs.length) throw new Error('没有待转换的 M4A 文件。');
    await this.connect();
    const result = await this.bridge.request('convert',{
      jobs:jobs.map(({id,inputPath})=>({id,inputPath})),
      outputDirectory:jobs[0].outputDirectory || this.state.prefs.conversionDirectory || (this.state.prefs.downloadMode === 'custom' ? this.state.prefs.downloadDirectory : this.defaultDirectory),
      bitrate:this.state.prefs.bitrate});
    jobs.forEach(task=>{Object.assign(task,{state:'pending',submitted:true,error:'',progress:0});});
    this.mergeJobs(result.jobs || []); await this.save();
  }

  async pumpConversions() {
    const active=this.state.conversions.filter(task=>task.submitted && activeConversion(task.state)).length;
    const waiting=this.state.conversions.filter(task=>task.scheduled && !task.submitted && task.state==='pending');
    const jobs=waiting.filter(task=>task.outputDirectory===waiting[0]?.outputDirectory).slice(0,Math.max(0,200-active));
    if (!jobs.length) return;
    try {await this.submitConversions(jobs);} catch(error) {
      jobs.forEach(task=>Object.assign(task,{state:'failed',error:errorText(error)})); await this.save();
      throw error;
    }
  }

  handle(message) {
    return this.run(async()=>{
      switch(message.type) {
        case 'GET_WORKBENCH': break;
        case 'NATIVE_CONNECT': await this.connect(); break;
        case 'SAVE_SETTINGS': {
          const value = message.settings || {};
          if (['browser','custom'].includes(value.downloadMode)) this.state.prefs.downloadMode = value.downloadMode;
          if ([128,192,256,320].includes(Number(value.bitrate))) this.state.prefs.bitrate=Number(value.bitrate);
          for (const key of ['saveAs','recursive']) if (typeof value[key] === 'boolean') this.state.prefs[key]=value[key];
          if (value.conversionDirectory === '') {this.state.prefs.conversionDirectory='';this.state.prefs.followDownloadDirectory=true;}
          // Directories are authorized only by native system pickers.
          await this.save(); break;
        }
        case 'CHOOSE_DIRECTORY': {
          if (!['download','conversion'].includes(message.purpose)) throw new Error('无效的文件夹类型。');
          await this.connect(); const result = await this.bridge.request('chooseDirectory',{purpose:message.purpose});
          if (result.path) {
            this.state.prefs[message.purpose === 'download' ? 'downloadDirectory' : 'conversionDirectory'] = result.path;
            if (message.purpose === 'download') this.state.prefs.downloadMode='custom';
            else this.state.prefs.followDownloadDirectory=false;
          }
          await this.save(); break;
        }
        case 'ADD_CONVERSION_FILES': {
          await this.connect();
          const result = await this.bridge.request('chooseFiles',{folder:message.folder===true,recursive:message.recursive===true});
          for (const file of result.files || []) if (!this.state.conversions.some(task=>task.inputPath.toLowerCase()===file.path.toLowerCase() && activeConversion(task.state))) this.addConversion(file.path,file.size);
          this.state.scanErrors = result.errors || []; await this.save(); break;
        }
        case 'START_CONVERSION': {
          const ids=Array.isArray(message.ids) ? new Set(message.ids) : null;
          const jobs = this.state.conversions.filter(task=>(!ids || ids.has(task.id)) && !task.submitted && task.state==='pending');
          if (!jobs.length) throw new Error('没有待转换的 M4A 文件。');
          jobs.forEach(task=>{task.scheduled=true;}); await this.save(); await this.pumpConversions(); break;
        }
        case 'RETRY_CONVERSION': {
          const task=this.state.conversions.find(task=>task.id===message.id && ['failed','cancelled','interrupted'].includes(task.state));
          if (!task) throw new Error('找不到可重试的转换任务。');
          await this.submitConversions([task]); break;
        }
        case 'CANCEL_CONVERSION': {
          await this.connect(); await this.bridge.request('cancel');
          for (const task of this.state.conversions) if (activeConversion(task.state)) Object.assign(task,{state:'cancelled',error:'已停止转换',submitted:false});
          await this.save(); break;
        }
        case 'RETRY_DOWNLOAD': {
          const task=this.state.downloads.find(task=>task.id===message.id && ['failed','interrupted'].includes(task.state));
          if (!task) throw new Error('找不到可重试的下载任务。');
          const [actual] = await this.chrome.downloads.search({id:task.browserDownloadId});
          if (actual?.state==='complete' && task.staged) {await this.finishDownload(task,actual); break;}
          if (task.staged) await this.connect();
          const id=await this.chrome.downloads.download({url:task.url,
            filename:task.staged ? `Tingjian/staging/${task.id}/${task.name}` : task.name,
            conflictAction:'uniquify',saveAs:task.staged ? false : this.state.prefs.saveAs});
          Object.assign(task,{browserDownloadId:id,state:'downloading',progress:0,error:'',sourcePath:''});
          await this.save(); await this.status(task,'in_progress');
          const [started]=await this.chrome.downloads.search({id});
          if (started?.state==='complete') await this.finishDownload(task,started);
          else if (started?.state==='interrupted') await this.failDownload(task,started.error || '下载已中断');
          break;
        }
        case 'OPEN_TASK': {
          const task=[...this.state.downloads,...this.state.conversions].find(task=>task.id===message.id && task.state==='complete');
          if (!task) throw new Error('任务尚未完成或不存在。');
          if (!task.staged && task.browserDownloadId !== undefined) {
            message.reveal ? this.chrome.downloads.show(task.browserDownloadId) : await this.chrome.downloads.open(task.browserDownloadId);
          } else {await this.connect(); await this.bridge.request('open',{path:task.path || task.outputPath,reveal:message.reveal===true});}
          break;
        }
        default: throw new Error('未知工作台操作。');
      }
      return structuredClone(this.state);
    });
  }
}
