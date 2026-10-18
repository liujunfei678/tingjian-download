using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Web.Script.Serialization;
using TingjianNative;

public static class NativeHostTests
{
    static int checks;
    static void Assert(bool value, string name) { if (!value) throw new Exception(name); checks++; Console.WriteLine("PASS " + name); }
    static Dictionary<string, object> D(params object[] pairs) { var d = new Dictionary<string,object>(); for (int i=0;i<pairs.Length;i+=2) d[(string)pairs[i]]=pairs[i+1]; return d; }
    static Dictionary<string, object> Call(HostService service, string command, params object[] pairs) { var d=D(pairs); d["command"]=command; return service.Execute(d); }
    static void Denied(Action action,string name) { try { action(); } catch (Exception) { Assert(true,name); return; } throw new Exception("Not denied: " + name); }
    static HostOptions Options(string root,string ffmpeg) { return new HostOptions { StateDirectory=Path.Combine(root,"state"), DefaultDownloadDirectory=Path.Combine(root,"Downloads"), FFmpegPath=ffmpeg, SelectDirectory=delegate(string purpose) { return Path.Combine(root,purpose); }, SelectFiles=delegate(bool folder) { return new [] { Path.Combine(root,"inputs") }; } }; }
    static Dictionary<string,object>[] Jobs(HostService service) { return ((IEnumerable)Call(service,"snapshot")["jobs"]).Cast<Dictionary<string,object>>().ToArray(); }
    static void Wait(HostService service) { var end=DateTime.UtcNow.AddSeconds(30); while (DateTime.UtcNow < end) { if (!Jobs(service).Any(j=>new[]{"pending","running"}.Contains((string)j["state"]))) return; Thread.Sleep(40); } throw new Exception("conversion timeout"); }
    public static int Main(string[] args)
    {
        string ffmpeg=args[0], root=args[1];
        try {
            var options=Options(root,ffmpeg);
            using (var service=new HostService(options)) {
                Directory.CreateDirectory(options.DefaultDownloadDirectory);
                string selected=(string)Call(service,"chooseDirectory","purpose","download")["path"];
                Assert(selected==Path.Combine(root,"download"),"user-selected output retained");
                var files=(IEnumerable)Call(service,"chooseFiles","folder",true,"recursive",true)["files"];
                Assert(files.Cast<object>().Count()==4,"FileScanner selects M4A files");
                string source=Path.Combine(options.DefaultDownloadDirectory,"Tingjian","staging","task-1","原始.m4a"); Directory.CreateDirectory(Path.GetDirectoryName(source)); File.WriteAllText(source,"original");
                Directory.CreateDirectory(selected); File.WriteAllText(Path.Combine(selected,"歌曲.m4a"),"existing");
                string target=(string)Call(service,"publish","taskId","task-1","sourcePath",source,"directory",selected,"filename","歌曲.m4a")["path"];
                Assert(Path.GetFileName(target)=="歌曲 (1).m4a" && File.ReadAllText(target)=="original","atomic collision publishing");
                Assert(File.Exists(source) && File.ReadAllText(Path.Combine(selected,"歌曲.m4a"))=="existing","publish preserves staging until explicit cleanup");
                Assert((string)Call(service,"publish","taskId","task-1","sourcePath",source,"directory",selected,"filename","歌曲.m4a")["path"]==target,"publish retry is idempotent");
                string unrelated=Path.Combine(root,"unrelated.txt"); File.WriteAllText(unrelated,"keep");
                Denied(()=>Call(service,"cleanup","taskId","task-1","sourcePath",unrelated),"cleanup refuses unrelated file");
                Denied(()=>Call(service,"publish","taskId","../task-1","sourcePath",source,"directory",selected,"filename","x.m4a"),"reject traversal task id");
                Denied(()=>Call(service,"publish","taskId","task-1","sourcePath",source,"directory",selected,"filename","../x.m4a"),"reject traversal filename");
                Denied(()=>Call(service,"publish","taskId","task-1","sourcePath",source,"directory",Path.Combine(root,"unapproved"),"filename","x.m4a"),"reject unapproved output directory");
                Denied(()=>Call(service,"open","path",unrelated,"reveal",true),"reject arbitrary open path");
                File.WriteAllText(source,"changed"); Denied(()=>Call(service,"cleanup","taskId","task-1","sourcePath",source),"cleanup rejects modified staging"); File.WriteAllText(source,"original");
                Call(service,"cleanup","taskId","task-1","sourcePath",source); Assert(!File.Exists(source) && File.Exists(target),"cleanup deletes only published receipt source");
                string failedSource=Path.Combine(options.DefaultDownloadDirectory,"Tingjian","staging","failed-publish","保留.m4a"); Directory.CreateDirectory(Path.GetDirectoryName(failedSource)); File.WriteAllText(failedSource,"preserve");
                Directory.Move(selected,selected+"-backup"); File.WriteAllText(selected,"directory unavailable");
                Denied(()=>Call(service,"publish","taskId","failed-publish","sourcePath",failedSource,"directory",selected,"filename","保留.m4a"),"unavailable output directory fails publication");
                Assert(File.ReadAllText(failedSource)=="preserve","failed publication preserves original staging"); File.Delete(selected); Directory.Move(selected+"-backup",selected);
                string browserRoot=Path.Combine(root,"Browser Custom Default"),browserSource=Path.Combine(browserRoot,"Tingjian","staging","browser-mode","浏览器目录.m4a");
                Directory.CreateDirectory(Path.GetDirectoryName(browserSource)); File.Copy(Path.Combine(root,"inputs","ALAC.m4a"),browserSource);
                string browserPublished=(string)Call(service,"publish","taskId","browser-mode","sourcePath",browserSource,"directory","@browser","filename","浏览器目录.m4a")["path"];
                Assert(Path.GetDirectoryName(browserPublished)==browserRoot,"browser default mode preserves actual browser download directory");
                string fakeRoot=Path.Combine(root,"not-approved"),fakeSource=Path.Combine(fakeRoot,"Tingjian","staging","fake-source","fake.m4a");
                Denied(()=>Call(service,"publish","taskId","fake-source","sourcePath",fakeSource,"directory","@browser","filename","fake.m4a"),"missing staging cannot publish");
                Denied(()=>Call(service,"convert","jobs",new object[]{D("id","fake-output","inputPath",Path.Combine(root,"inputs","ALAC.m4a"))},"outputDirectory",fakeRoot,"bitrate",320),"failed browser publication cannot authorize output directory");
                string outside=Path.Combine(root,"outside.m4a"); File.Copy(Path.Combine(root,"inputs","ALAC.m4a"),outside);
                Denied(()=>Call(service,"convert","jobs",new object[]{D("id","outside","inputPath",outside)},"bitrate",320),"reject unselected input");
                Call(service,"chooseDirectory","purpose","conversion");
                Denied(()=>Call(service,"convert","jobs",new object[]{D("id","rate","inputPath",outside)},"bitrate",999),"reject unsupported bitrate");
                Call(service,"convert","jobs",new object[]{D("id","aac","inputPath",Path.Combine(root,"inputs","中文 & AAC.m4a")),D("id","alac","inputPath",Path.Combine(root,"inputs","ALAC.m4a")),D("id","bad","inputPath",Path.Combine(root,"inputs","bad.m4a"))},"bitrate",320);
                Wait(service);
                var jobs=Jobs(service); Assert(jobs.Single(j=>(string)j["id"]=="aac")["state"].Equals("complete") && jobs.Single(j=>(string)j["id"]=="alac")["state"].Equals("complete"),"real AAC and ALAC complete");
                Assert(jobs.Single(j=>(string)j["id"]=="bad")["state"].Equals("failed"),"invalid M4A fails");
                File.WriteAllText(Path.Combine(root,"outputs.json"),new JavaScriptSerializer().Serialize(jobs.Where(j=>(string)j["state"]=="complete").Select(j=>j["outputPath"]).ToArray()));
                Call(service,"convert","jobs",new object[]{D("id","long","inputPath",Path.Combine(root,"inputs","long.m4a"))},"bitrate",320);
                var activeEnd=DateTime.UtcNow.AddSeconds(5); while(DateTime.UtcNow<activeEnd && !Jobs(service).Any(j=>(string)j["id"]=="long" && Convert.ToDouble(j["progress"])>0)) Thread.Sleep(30);
                Assert(Jobs(service).Any(j=>(string)j["id"]=="long" && (string)j["state"]=="running" && Convert.ToDouble(j["progress"])>0),"cancel test reaches real FFmpeg progress");
                Call(service,"cancel"); Wait(service);
                Assert(Jobs(service).Single(j=>(string)j["id"]=="long")["state"].Equals("cancelled"),"cancel marks active or pending conversion cancelled");
                Call(service,"convert","jobs",new object[]{D("id","long","inputPath",Path.Combine(root,"inputs","long.m4a"))},"bitrate",320);
            }
            using (var resumed=new HostService(options)) {
                Assert(Jobs(resumed).Single(j=>(string)j["id"]=="long")["state"].Equals("interrupted"),"connection EOF persists interruption");
                Assert((string)Call(resumed,"hello")["downloadDirectory"]==Path.Combine(root,"download"),"directory approval survives reconnect");
                string retrySource=Path.Combine(options.DefaultDownloadDirectory,"Tingjian","staging","task-1","原始.m4a");
                Assert(Path.GetFileName((string)Call(resumed,"publish","taskId","task-1","sourcePath",retrySource,"directory",Path.Combine(root,"download"),"filename","歌曲.m4a")["path"])=="歌曲 (1).m4a","publish receipt survives reconnect and cleanup");
                Call(resumed,"convert","jobs",new object[]{D("id","bad","inputPath",Path.Combine(root,"inputs","bad.m4a"))},"bitrate",128); Wait(resumed);
                Assert(Jobs(resumed).Single(j=>(string)j["id"]=="bad")["state"].Equals("failed"),"failed job can retry without false success");
            }
            Assert(File.ReadAllText(Path.Combine(root,"unrelated.txt"))=="keep","unrelated files preserved");
            Console.WriteLine(checks+" native host assertions passed"); return 0;
        } catch (Exception ex) { Console.Error.WriteLine(ex); return 1; }
    }
}
