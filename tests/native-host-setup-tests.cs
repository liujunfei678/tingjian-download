using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;

internal static class NativeSetupTests
{
    static void Check(bool value,string name) { if(!value) throw new Exception(name); Console.WriteLine("PASS "+name); }
    static void Invoke(string name,string directory) { typeof(TingjianNative.Setup).GetMethod(name,BindingFlags.Static|BindingFlags.NonPublic).Invoke(null,new object[]{directory}); }
    static void CheckInstallManifest(string root)
    {
        string blocked=Path.Combine(root,"unowned-install"); Directory.CreateDirectory(blocked); File.WriteAllText(Path.Combine(blocked,"user.txt"),"preserve me");
        string manifest=Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"com.tingjian.audio.json");
        File.WriteAllText(manifest,"{\"name\":\"com.tingjian.audio\",\"allowed_origins\":[\"chrome-extension://lncnlaidcmglpbnfmikaocnhocjifghn/\"]}");
        var target=typeof(TingjianNative.Setup).GetField("Target",BindingFlags.Static|BindingFlags.NonPublic); object original=target.GetValue(null); target.SetValue(null,blocked);
        try {
            try { typeof(TingjianNative.Setup).GetMethod("Install",BindingFlags.Static|BindingFlags.NonPublic).Invoke(null,null); throw new Exception("installation must stop before copying or registry changes"); }
            catch(TargetInvocationException ex) {
                if(!(ex.InnerException is IOException) || !ex.InnerException.Message.Contains("安装目录已被其他文件使用")) throw new Exception("valid JSON manifest must reach the unowned directory guard",ex.InnerException);
                Check(true,"valid JSON manifest passes parsing before unowned installation directory is rejected");
            }
            Check(File.ReadAllText(Path.Combine(blocked,"user.txt"))=="preserve me","manifest test never modifies the blocked installation directory");
        } finally { target.SetValue(null,original); }
    }
    static void CheckManifestValidation(string root)
    {
        string file=Path.Combine(root,"manifest-validation.json");
        string valid="{\"name\":\"com.tingjian.audio\",\"path\":\"Tingjian.NativeHost.exe\",\"type\":\"stdio\",\"allowed_origins\":[\"chrome-extension://lncnlaidcmglpbnfmikaocnhocjifghn/\"]}";
        File.WriteAllText(file,valid);
        var method=typeof(TingjianNative.Setup).GetMethod("ReadManifest",BindingFlags.Static|BindingFlags.NonPublic);
        var manifest=(Dictionary<string,object>)method.Invoke(null,new object[]{file});
        Check((string)manifest["path"]=="Tingjian.NativeHost.exe" && (string)manifest["type"]=="stdio","valid packaged JSON manifest is accepted and preserves host fields");
        var invalid=new Dictionary<string,string> {
            {"wrong host name",valid.Replace("com.tingjian.audio","com.other.audio")},
            {"wrong extension origin",valid.Replace("lncnlaidcmglpbnfmikaocnhocjifghn","aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")},
            {"multiple extension origins","{\"name\":\"com.tingjian.audio\",\"allowed_origins\":[\"chrome-extension://lncnlaidcmglpbnfmikaocnhocjifghn/\",\"chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/\"]}"},
            {"empty origin list","{\"name\":\"com.tingjian.audio\",\"allowed_origins\":[]}"},
            {"scalar instead of origin list","{\"name\":\"com.tingjian.audio\",\"allowed_origins\":\"chrome-extension://lncnlaidcmglpbnfmikaocnhocjifghn/\"}"},
            {"missing origin list","{\"name\":\"com.tingjian.audio\"}"},
            {"non-string origin","{\"name\":\"com.tingjian.audio\",\"allowed_origins\":[123]}"}
        };
        foreach(var item in invalid) {
            File.WriteAllText(file,item.Value);
            try { method.Invoke(null,new object[]{file}); throw new Exception("invalid manifest was accepted: "+item.Key); }
            catch(TargetInvocationException ex) { Check(ex.InnerException is IOException,"manifest rejects "+item.Key); }
        }
    }
    static int Main(string[] args)
    {
        try {
            CheckInstallManifest(args[0]);
            CheckManifestValidation(args[0]);
            string old=Path.Combine(args[0],"legacy-install"), current=Path.Combine(args[0],"current-install");
            Directory.CreateDirectory(Path.Combine(old,"Music")); File.WriteAllText(Path.Combine(old,"Music","用户歌曲.mp3"),"audio"); File.WriteAllText(Path.Combine(old,"ffmpeg.exe"),"old component");
            Invoke("DeleteOwned",old);
            Check(File.Exists(Path.Combine(old,"Music","用户歌曲.mp3")),"legacy uninstall preserves user audio when no inventory exists");
            Check(File.Exists(Path.Combine(old,"ffmpeg.exe")),"legacy uninstall fails safe without ownership inventory");
            Directory.CreateDirectory(Path.Combine(current,"Music")); File.WriteAllText(Path.Combine(current,"Music","原声.m4a"),"original audio");
            File.WriteAllText(Path.Combine(current,"ffmpeg.exe"),"owned component"); File.WriteAllText(Path.Combine(current,"使用说明.md"),"original instructions");
            Invoke("RecordOwned",current);
            File.WriteAllText(Path.Combine(current,"使用说明.md"),"user changed this file"); File.WriteAllText(Path.Combine(current,"notes.txt"),"unknown user file");
            Invoke("DeleteOwned",current);
            Check(!File.Exists(Path.Combine(current,"ffmpeg.exe")),"uninstall removes unchanged inventoried component");
            Check(File.ReadAllText(Path.Combine(current,"Music","原声.m4a"))=="original audio","uninstall preserves nested user audio");
            Check(File.ReadAllText(Path.Combine(current,"使用说明.md"))=="user changed this file","uninstall preserves modified inventoried component");
            Check(File.ReadAllText(Path.Combine(current,"notes.txt"))=="unknown user file","uninstall preserves unknown root file");
            return 0;
        } catch(Exception ex) { Console.Error.WriteLine(ex); return 1; }
    }
}
