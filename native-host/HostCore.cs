using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using TingjianConverter;

namespace TingjianNative
{
    public sealed class HostOptions
    {
        public string StateDirectory;
        public string DefaultDownloadDirectory;
        public string FFmpegPath;
        public Func<string,string> SelectDirectory;
        public Func<bool,string[]> SelectFiles;
    }

    public sealed class HostService : IDisposable
    {
        readonly HostOptions options;
        readonly object gate = new object();
        readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 4 * 1024 * 1024 };
        readonly HashSet<string> directories = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        readonly HashSet<string> inputs = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        readonly HashSet<string> outputs = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        readonly List<Dictionary<string,object>> jobs = new List<Dictionary<string,object>>();
        readonly Dictionary<string,Dictionary<string,object>> receipts = new Dictionary<string,Dictionary<string,object>>();
        string downloadDirectory = "", conversionDirectory = "";
        CancellationTokenSource cancellation;
        Thread worker;
        bool stopping;
        public event Action<object> Changed;

        public HostService(HostOptions settings)
        {
            options = settings;
            options.StateDirectory = Full(options.StateDirectory);
            options.DefaultDownloadDirectory = Full(options.DefaultDownloadDirectory);
            options.FFmpegPath = Full(options.FFmpegPath);
            Directory.CreateDirectory(options.StateDirectory);
            SafePath(options.StateDirectory);
            Load();
        }
        static string Text(IDictionary<string,object> d,string key,string fallback = "") { object value; return d.TryGetValue(key,out value) && value != null ? Convert.ToString(value,CultureInfo.InvariantCulture) : fallback; }
        static bool Flag(IDictionary<string,object> d,string key) { object value; return d.TryGetValue(key,out value) && value is bool && (bool)value; }
        static Dictionary<string,object> D(params object[] values) { var d = new Dictionary<string,object>(); for (int i=0;i<values.Length;i+=2) d[(string)values[i]]=values[i+1]; return d; }
        static IEnumerable<object> Items(object value) { var list = value as IEnumerable; if (list == null || value is string) throw new ArgumentException("列表格式无效。"); return list.Cast<object>(); }
        static string Full(string value) { if (String.IsNullOrWhiteSpace(value) || !Path.IsPathRooted(value) || value.StartsWith(@"\\",StringComparison.Ordinal)) throw new ArgumentException("必须使用本机绝对路径。"); string full=Path.GetFullPath(value); return full.Length>Path.GetPathRoot(full).Length?full.TrimEnd(Path.DirectorySeparatorChar):full; }
        static void SafePath(string path)
        {
            string current = Full(path);
            while (!String.IsNullOrEmpty(current)) {
                if ((File.Exists(current) || Directory.Exists(current)) && (File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) throw new UnauthorizedAccessException("不能处理符号链接或目录联接。");
                current = Path.GetDirectoryName(current);
            }
        }
        static void Id(string id) { if (!Regex.IsMatch(id ?? "", @"\A[A-Za-z0-9][A-Za-z0-9_-]{0,95}\z")) throw new ArgumentException("任务标识无效。"); }
        static void Filename(string name)
        {
            if (String.IsNullOrWhiteSpace(name) || name.Length > 200 || name != Path.GetFileName(name) || name.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 || name.EndsWith(" ") || name.EndsWith(".") || Regex.IsMatch(name,@"\A(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)",RegexOptions.IgnoreCase)) throw new ArgumentException("文件名无效。");
            if (!new[]{".m4a",".mp3",".wav",".wave",".flac",".ogg",".oga",".opus",".aac",".webm",".weba",".mp4",".aif",".aiff",".wma",".amr",".ac3",".caf",".mka",".mid",".midi"}.Contains(Path.GetExtension(name).ToLowerInvariant())) throw new ArgumentException("只允许音频文件名。");
        }
        string Output(string path)
        {
            string full = Full(path);
            if (!full.Equals(options.DefaultDownloadDirectory,StringComparison.OrdinalIgnoreCase) && !directories.Contains(full)) throw new UnauthorizedAccessException("请先使用听见的系统对话框选择此保存目录。");
            SafePath(full); return full;
        }
        string Input(string path)
        {
            string full=Full(path);
            if (!inputs.Contains(full) && !outputs.Contains(full)) throw new UnauthorizedAccessException("请先使用听见的系统对话框选择输入文件。");
            if (!String.Equals(Path.GetExtension(full),".m4a",StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("只支持 M4A 输入。");
            SafePath(full); if (!File.Exists(full)) throw new FileNotFoundException("原文件已移动或删除。",full); return full;
        }
        string Staging(string id,string path)
        {
            Id(id); string full=Full(path); Filename(Path.GetFileName(full));
            string parent=Path.GetDirectoryName(full), staging=Path.GetDirectoryName(parent), tingjian=Path.GetDirectoryName(staging);
            if (!String.Equals(Path.GetFileName(parent),id,StringComparison.Ordinal) || !String.Equals(Path.GetFileName(staging),"staging",StringComparison.Ordinal) || !String.Equals(Path.GetFileName(tingjian),"Tingjian",StringComparison.Ordinal)) throw new UnauthorizedAccessException("来源不是听见任务暂存文件。");
            SafePath(full); return full;
        }
        public Dictionary<string,object> Execute(Dictionary<string,object> request)
        {
            string command=Text(request,"command");
            lock (gate) {
                if (stopping) throw new InvalidOperationException("本地组件正在退出。");
                if (command=="hello") return Hello();
                if (command=="snapshot") { var result=Hello(); result["jobs"]=Snapshot(); return result; }
                if (command=="chooseDirectory") {
                    string purpose=Text(request,"purpose"); if (purpose!="download" && purpose!="conversion") throw new ArgumentException("目录用途无效。");
                    string chosen=options.SelectDirectory(purpose); if (String.IsNullOrEmpty(chosen)) return D("path","");
                    chosen=Full(chosen); SafePath(chosen); Directory.CreateDirectory(chosen); directories.Add(chosen);
                    if (purpose=="download") downloadDirectory=chosen; else conversionDirectory=chosen; Save(); return D("path",chosen);
                }
                if (command=="chooseFiles") {
                    string[] chosen=options.SelectFiles(Flag(request,"folder"));
                    if (chosen==null || chosen.Length==0) return D("files",new object[0],"errors",new string[0]);
                    foreach (string path in chosen) SafePath(Full(path));
                    var scan=FileScanner.Scan(chosen,Flag(request,"recursive"),CancellationToken.None);
                    var selected=new List<object>();
                    foreach (string path in scan.Files.Take(2000)) { try { SafePath(path); inputs.Add(Full(path)); selected.Add(D("path",path,"size",new FileInfo(path).Length)); } catch(Exception ex) { scan.Errors.Add(path+"："+ex.Message); } }
                    if (scan.Files.Count>2000) scan.Errors.Add("一次最多添加 2000 个文件，请分批添加。");
                    Save(); return D("files",selected.ToArray(),"errors",scan.Errors.Take(100).ToArray());
                }
                if (command=="publish") return Publish(request);
                if (command=="cleanup") return Cleanup(request);
                if (command=="convert") return ConvertJobs(request);
                if (command=="cancel") { if(cancellation!=null) cancellation.Cancel(); foreach(var job in jobs.Where(j=>Text(j,"state")=="pending")) { job["state"]="cancelled"; job["error"]="已停止，可以重试。"; } Save(); Emit(); return D("jobs",Snapshot()); }
                if (command=="open") {
                    string path=Full(Text(request,"path"));
                    if (!inputs.Contains(path) && !outputs.Contains(path)) throw new UnauthorizedAccessException("只能打开听见已选择或已生成的文件。");
                    SafePath(path); if(!File.Exists(path)) throw new FileNotFoundException("文件已移动或删除。",path);
                    if(Flag(request,"reveal")) Process.Start(new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows),"explorer.exe"),"/select,"+BatchConverter.QuoteArgument(path)) { UseShellExecute=false });
                    else Process.Start(new ProcessStartInfo(path) { UseShellExecute=true });
                    return D("path",path);
                }
                throw new ArgumentException("不支持的本地命令。");
            }
        }
        Dictionary<string,object> Hello() { return D("version","2.0.0","downloadDirectory",downloadDirectory,"conversionDirectory",conversionDirectory,"defaultDownloadDirectory",options.DefaultDownloadDirectory); }
        Dictionary<string,object>[] Snapshot() { return jobs.Select(j=>D("id",j["id"],"inputPath",j["inputPath"],"outputPath",j["outputPath"],"state",j["state"],"progress",j["progress"],"error",j["error"])).ToArray(); }
        static string Hash(string path) { using(var stream=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read)) using(var sha=SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-",""); }
        Dictionary<string,object> Publish(Dictionary<string,object> request)
        {
            string id=Text(request,"taskId"),source=Staging(id,Text(request,"sourcePath")),name=Text(request,"filename"); Filename(name);
            string directory=Text(request,"directory"); bool browserDirectory=directory=="@browser";
            if(browserDirectory) {
                // The caller supplies no destination authority: derive it only from the validated app staging path.
                directory=Path.GetDirectoryName(Path.GetDirectoryName(Path.GetDirectoryName(Path.GetDirectoryName(source))));
                directory=Full(directory); SafePath(directory);
            }
            else directory=Output(String.IsNullOrEmpty(directory)?options.DefaultDownloadDirectory:directory);
            Dictionary<string,object> receipt;
            if(receipts.TryGetValue(id,out receipt)) {
                if(!String.Equals(Text(receipt,"sourcePath"),source,StringComparison.OrdinalIgnoreCase) || !String.Equals(Text(receipt,"directory"),directory,StringComparison.OrdinalIgnoreCase) || Text(receipt,"filename")!=name) throw new UnauthorizedAccessException("任务标识已用于其他文件。");
                string previous=Text(receipt,"path"); SafePath(previous);
                if(File.Exists(previous) && Hash(previous)==Text(receipt,"hash")) return D("path",previous);
                throw new IOException("已发布文件已移动或修改，请创建新下载任务。");
            }
            if(!File.Exists(source)) throw new FileNotFoundException("找不到已完成的暂存文件。",source);
            Directory.CreateDirectory(directory); string temporary=Path.Combine(directory,".tingjian-"+Guid.NewGuid().ToString("N")+".partial"),destination=null;
            try {
                using(var input=new FileStream(source,FileMode.Open,FileAccess.Read,FileShare.Read)) using(var output=new FileStream(temporary,FileMode.CreateNew,FileAccess.Write,FileShare.None)) { input.CopyTo(output); output.Flush(true); }
                string hash=Hash(temporary);
                for(int n=0;n<Int32.MaxValue;n++) {
                    destination=Path.Combine(directory,Path.GetFileNameWithoutExtension(name)+(n==0?"":" ("+n.ToString(CultureInfo.InvariantCulture)+")")+Path.GetExtension(name));
                    try { File.Move(temporary,destination); break; } catch(IOException) { if(File.Exists(destination)||Directory.Exists(destination)) continue; throw; }
                }
                if(File.Exists(temporary)) throw new IOException("同名文件过多。");
                if(browserDirectory) directories.Add(directory);
                outputs.Add(destination); receipts[id]=D("sourcePath",source,"directory",directory,"filename",name,"path",destination,"hash",hash); Save(); return D("path",destination);
            } finally { if(File.Exists(temporary)) File.Delete(temporary); }
        }
        Dictionary<string,object> Cleanup(Dictionary<string,object> request)
        {
            string id=Text(request,"taskId"),source=Staging(id,Text(request,"sourcePath")); Dictionary<string,object> receipt;
            if(!receipts.TryGetValue(id,out receipt)||!String.Equals(Text(receipt,"sourcePath"),source,StringComparison.OrdinalIgnoreCase)) throw new UnauthorizedAccessException("没有此任务的成功发布记录，保留原文件。");
            string destination=Text(receipt,"path"); SafePath(destination);
            if(!File.Exists(destination)||Hash(destination)!=Text(receipt,"hash")) throw new IOException("目标文件无法验证，保留暂存文件。");
            if(File.Exists(source)) { if(Hash(source)!=Text(receipt,"hash")) throw new IOException("暂存文件已变化，保留文件。"); File.Delete(source); }
            string parent=Path.GetDirectoryName(source); if(Directory.Exists(parent)&&!Directory.EnumerateFileSystemEntries(parent).Any()) Directory.Delete(parent);
            return D("cleaned",true);
        }
        Dictionary<string,object> ConvertJobs(Dictionary<string,object> request)
        {
            object raw; if(!request.TryGetValue("jobs",out raw)) throw new ArgumentException("缺少转换任务。");
            var requested=Items(raw).ToArray(); if(requested.Length==0||requested.Length>200) throw new ArgumentException("一次支持 1 至 200 个转换任务。");
            int bitrate=320; object value; if(request.TryGetValue("bitrate",out value) && !Int32.TryParse(Convert.ToString(value,CultureInfo.InvariantCulture),out bitrate)) throw new ArgumentException("码率无效。");
            if(!BatchConverter.Bitrates.Contains(bitrate)) throw new ArgumentException("码率无效。");
            string directory=Text(request,"outputDirectory"); if(String.IsNullOrEmpty(directory)) directory=!String.IsNullOrEmpty(conversionDirectory)?conversionDirectory:!String.IsNullOrEmpty(downloadDirectory)?downloadDirectory:options.DefaultDownloadDirectory;
            directory=Output(directory);
            var accepted=new List<Dictionary<string,object>>(); var ids=new HashSet<string>();
            foreach(var item in requested) {
                var job=item as Dictionary<string,object>; if(job==null) throw new ArgumentException("任务格式无效。");
                string id=Text(job,"id"),input=Input(Text(job,"inputPath")); Id(id); if(!ids.Add(id)) throw new ArgumentException("重复的任务标识。");
                var previous=jobs.SingleOrDefault(j=>Text(j,"id")==id);
                if(previous!=null && (Text(previous,"state")=="running" || Text(previous,"state")=="pending" || Text(previous,"state")=="complete")) throw new InvalidOperationException("任务已在执行或已完成。");
                accepted.Add(D("id",id,"inputPath",input,"outputPath",null,"outputDirectory",directory,"bitrate",bitrate,"state","pending","progress",0.0,"error",null));
            }
            if(jobs.Count(j=>Text(j,"state")=="pending"||Text(j,"state")=="running")+accepted.Count>300) throw new InvalidOperationException("等待中的任务过多，请等待当前转换完成。");
            foreach(var job in accepted) { jobs.RemoveAll(j=>Text(j,"id")==Text(job,"id")); jobs.Add(job); }
            while(jobs.Count>300) { int index=jobs.FindIndex(j=>new[]{"complete","failed","cancelled","interrupted"}.Contains(Text(j,"state"))); if(index<0) throw new InvalidOperationException("等待中的任务过多，请等待当前转换完成。"); jobs.RemoveAt(index); }
            Save();
            if(worker==null) StartWorker();
            Emit(); return D("jobs",Snapshot());
        }
        void Work()
        {
            try {
            while(true) {
                Dictionary<string,object> record; CancellationToken token;
                lock(gate) { if(stopping || cancellation.IsCancellationRequested) return; record=jobs.FirstOrDefault(j=>Text(j,"state")=="pending"); if(record==null) return; record["state"]="running"; token=cancellation.Token; Save(); Emit(); }
                try {
                    string input,output; int bitrate;
                    lock(gate) { input=Input(Text(record,"inputPath")); output=Output(Text(record,"outputDirectory")); bitrate=Convert.ToInt32(record["bitrate"],CultureInfo.InvariantCulture); }
                    var job=new AudioJob(input);
                    new BatchConverter(options.FFmpegPath).Run(new[]{job},output,bitrate,token,delegate(ConversionProgress p) {
                        lock(gate) { if(stopping) return; record["state"]=p.State.ToString().ToLowerInvariant(); record["progress"]=p.Fraction; record["outputPath"]=p.Job.OutputPath; record["error"]=ShortError(p.Job.Error);
                            if(p.State==ConversionState.Complete && p.Job.OutputPath!=null) outputs.Add(p.Job.OutputPath);
                            Save(); Emit(); }
                    });
                    lock(gate) {
                        if(!stopping && job.State==ConversionState.Pending && token.IsCancellationRequested) { record["state"]="cancelled"; record["progress"]=0.0; record["error"]="已停止，可以重试。"; Save(); Emit(); }
                        if(stopping && job.State==ConversionState.Complete) { record["state"]="complete"; record["progress"]=1.0; record["outputPath"]=job.OutputPath; record["error"]=job.Error; outputs.Add(job.OutputPath); Save(); }
                    }
                } catch(Exception ex) { lock(gate) { if(!stopping) { record["state"]="failed"; record["progress"]=0.0; record["error"]=ShortError(ex.Message); Save(); Emit(); } } }
            }
            } finally { lock(gate) { worker=null; if(!stopping && jobs.Any(j=>Text(j,"state")=="pending")) StartWorker(); } }
        }
        static string ShortError(string value) { return value==null?null:value.Length>300?value.Substring(0,300):value; }
        void StartWorker() { cancellation=new CancellationTokenSource(); worker=new Thread(Work) { IsBackground=true,Name="Tingjian conversion" }; worker.Start(); }
        void Emit() { var callback=Changed; if(callback!=null) { try { callback(D("event","conversion","jobs",Snapshot())); } catch(IOException) { /* Pipe shutdown must not turn a completed file into a failure. */ } catch(ObjectDisposedException) { } } }
        void Save()
        {
            string file=Path.Combine(options.StateDirectory,"state.json"),temporary=file+"."+Guid.NewGuid().ToString("N")+".tmp";
            var state=D("downloadDirectory",downloadDirectory,"conversionDirectory",conversionDirectory,"directories",directories.ToArray(),"inputs",inputs.ToArray(),"outputs",outputs.ToArray(),"jobs",jobs.ToArray(),"receipts",receipts);
            try { using(var stream=new FileStream(temporary,FileMode.CreateNew,FileAccess.Write,FileShare.None)) { var bytes=new UTF8Encoding(false).GetBytes(json.Serialize(state)); stream.Write(bytes,0,bytes.Length); stream.Flush(true); }
                if(File.Exists(file)) File.Replace(temporary,file,null); else File.Move(temporary,file);
            } finally { if(File.Exists(temporary)) File.Delete(temporary); }
        }
        void Load()
        {
            string file=Path.Combine(options.StateDirectory,"state.json"); if(!File.Exists(file)) return; SafePath(file);
            if(new FileInfo(file).Length>4*1024*1024) throw new IOException("本地状态文件过大。");
            var state=json.Deserialize<Dictionary<string,object>>(File.ReadAllText(file,Encoding.UTF8));
            downloadDirectory=Text(state,"downloadDirectory"); conversionDirectory=Text(state,"conversionDirectory");
            foreach(var name in new[]{"directories","inputs","outputs"}) { object raw; if(!state.TryGetValue(name,out raw)) continue; var target=name=="directories"?directories:name=="inputs"?inputs:outputs; foreach(var p in Items(raw)) target.Add(Full(Convert.ToString(p,CultureInfo.InvariantCulture))); }
            object list; if(state.TryGetValue("jobs",out list)) foreach(var item in Items(list)) { var job=(Dictionary<string,object>)item; if(Text(job,"state")=="pending" || Text(job,"state")=="running") { job["state"]="interrupted"; job["error"]="浏览器或本地组件已退出，请重试。"; } jobs.Add(job); }
            object recorded; if(state.TryGetValue("receipts",out recorded)) foreach(var pair in (Dictionary<string,object>)recorded) receipts[pair.Key]=(Dictionary<string,object>)pair.Value;
            Save();
        }
        public void Dispose()
        {
            Thread running;
            lock(gate) { if(stopping) return; stopping=true; if(cancellation!=null) cancellation.Cancel(); foreach(var job in jobs.Where(j=>Text(j,"state")=="pending"||Text(j,"state")=="running")) { job["state"]="interrupted"; job["error"]="浏览器或本地组件已退出，请重试。"; } Save(); running=worker; }
            if(running!=null) running.Join(5000);
        }
    }
}
