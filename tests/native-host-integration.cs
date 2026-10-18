// Test-only JSON-lines transport. This file is never compiled into the shipped host.
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;
using TingjianNative;

internal static class NativeHostIntegration
{
    static readonly object Gate=new object();
    static readonly JavaScriptSerializer Json=new JavaScriptSerializer { MaxJsonLength=1024*1024,RecursionLimit=32 };
    static void Send(object message) { lock(Gate) { Console.WriteLine(Json.Serialize(message)); Console.Out.Flush(); } }
    static int Main(string[] args)
    {
        if(args.Length!=2) { Console.Error.WriteLine("Expected fixtureRoot and ffmpegPath."); return 2; }
        Console.InputEncoding=new UTF8Encoding(false); Console.OutputEncoding=new UTF8Encoding(false);
        string root=Path.GetFullPath(args[0]);
        try {
            using(var service=new HostService(new HostOptions {
                StateDirectory=Path.Combine(root,"state"),DefaultDownloadDirectory=Path.Combine(root,"browser-downloads"),FFmpegPath=args[1],
                SelectDirectory=delegate(string purpose) { string path=Path.Combine(root,purpose=="download"?"output":"converted"); Directory.CreateDirectory(path); return path; },
                SelectFiles=delegate(bool folder) { string path=Path.Combine(root,"inputs"); return folder?new[]{path}:Directory.GetFiles(path,"*.m4a",SearchOption.TopDirectoryOnly); }
            })) {
                service.Changed+=Send;
                string line;
                while((line=Console.ReadLine())!=null) {
                    if(line.Length>256*1024) throw new InvalidDataException("Oversized test request.");
                    var request=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(line);
                    object id; if(!request.TryGetValue("id",out id)) id=null;
                    try { Send(new Dictionary<string,object>{{"id",id},{"ok",true},{"data",service.Execute(request)}}); }
                    catch(Exception ex) { Send(new Dictionary<string,object>{{"id",id},{"ok",false},{"error",ex.Message}}); }
                }
            }
            return 0;
        } catch(Exception ex) { Console.Error.WriteLine(ex); return 1; }
    }
}
