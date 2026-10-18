using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

namespace TingjianNative
{
    internal static class Setup
    {
        const string Host="com.tingjian.audio";
        static readonly string Target=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Tingjian","NativeHost");
        static readonly string[] Keys={@"Software\Google\Chrome\NativeMessagingHosts\com.tingjian.audio",@"Software\Microsoft\Edge\NativeMessagingHosts\com.tingjian.audio"};
        const string Marker=".tingjian-nativehost";
        const string Inventory=".tingjian-assets.json";
        static readonly string[] Assets={"Tingjian.NativeHost.exe","Tingjian.NativeHost.exe.config","Tingjian.Setup.exe","Tingjian.Setup.exe.config","Tingjian.Uninstall.exe","Tingjian.Uninstall.exe.config","ffmpeg.exe","com.tingjian.audio.json","使用说明.md",@"third-party\LICENSE-FFmpeg.txt",@"third-party\FFmpeg-build-and-source.txt",@"third-party\源码与许可说明.txt",@"source\NativeHost.cs",@"source\HostCore.cs",@"source\Setup.cs",@"source\NativeHostOrigin.cs",@"source\ConverterCore.cs",@"source\build-native-host.mjs",@"source\build-converter.mjs",@"source\rebuild.cmd",@"source\README.txt"};
        static readonly JavaScriptSerializer Json=new JavaScriptSerializer();
        [STAThread]
        static int Main(string[] args)
        {
            Application.EnableVisualStyles();
            try {
#if UNINSTALL
                Uninstall();
#else
                if(args.Contains("/uninstall")) Uninstall(); else Install();
#endif
                return 0;
            } catch(Exception ex) { MessageBox.Show(ex.Message+"\r\n\r\n请关闭 Chrome / Edge 后重试。", "听见本地组件",MessageBoxButtons.OK,MessageBoxIcon.Error); return 1; }
        }
        static void SafeTree(string directory)
        {
            string current=Path.GetFullPath(directory);
            while(!String.IsNullOrEmpty(current)) { if((File.Exists(current)||Directory.Exists(current))&&(File.GetAttributes(current)&FileAttributes.ReparsePoint)!=0) throw new IOException("组件目录包含符号链接或目录联接，已停止配置。"); current=Path.GetDirectoryName(current); }
        }
        static void CopyTree(string source,string destination)
        {
            SafeTree(source); SafeTree(destination); Directory.CreateDirectory(destination);
            foreach(string file in Directory.EnumerateFiles(source)) { SafeTree(file); File.Copy(file,Path.Combine(destination,Path.GetFileName(file)),true); }
            foreach(string child in Directory.EnumerateDirectories(source)) CopyTree(child,Path.Combine(destination,Path.GetFileName(child)));
        }
        static Dictionary<string,object> ReadManifest(string file)
        {
            var manifest=Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(file,Encoding.UTF8));
            object name, rawOrigins;
            if(manifest==null || !manifest.TryGetValue("name",out name) || !manifest.TryGetValue("allowed_origins",out rawOrigins)) throw new IOException("组件清单与听见扩展不匹配，请重新解压完整交付包。");
            var origins=rawOrigins as System.Collections.IList;
            if((name as string)!=Host || origins==null || origins.Count!=1 || (origins[0] as string)!=TrustedOrigin.Value) throw new IOException("组件清单与听见扩展不匹配，请重新解压完整交付包。");
            return manifest;
        }
        static void Install()
        {
            string source=Path.GetFullPath(AppDomain.CurrentDomain.BaseDirectory).TrimEnd(Path.DirectorySeparatorChar);
            string sourceManifest=Path.Combine(source,Host+".json");
            var manifest=ReadManifest(sourceManifest);
            SafeTree(Target);
            if(Directory.Exists(Target)&&Directory.EnumerateFileSystemEntries(Target).Any()&&(!File.Exists(Path.Combine(Target,Marker))||File.ReadAllText(Path.Combine(Target,Marker))!=Host)) throw new IOException("安装目录已被其他文件使用，已停止配置。");
            if(!String.Equals(source,Target,StringComparison.OrdinalIgnoreCase)) CopyTree(source,Target);
            File.WriteAllText(Path.Combine(Target,Marker),Host,new UTF8Encoding(false));
            manifest["path"]=Path.Combine(Target,"Tingjian.NativeHost.exe");
            string installedManifest=Path.Combine(Target,Host+".json"); File.WriteAllText(installedManifest,Json.Serialize(manifest),new UTF8Encoding(false));
            RecordOwned(Target);
            foreach(string key in Keys) using(var registry=Registry.CurrentUser.CreateSubKey(key)) registry.SetValue("",installedManifest,RegistryValueKind.String);
            MessageBox.Show("听见本地组件已为当前用户配置到 Chrome 和 Edge。\r\n\r\n返回听见侧栏，在设置中点击连接本地组件。\r\n无需管理员权限，无需修改浏览器默认下载目录。", "听见本地组件", MessageBoxButtons.OK,MessageBoxIcon.Information);
        }
        static void DeleteOwned(string directory)
        {
            SafeTree(directory);
            string inventory=Path.Combine(directory,Inventory); if(!File.Exists(inventory)) return;
            SafeTree(inventory); if(new FileInfo(inventory).Length>64*1024) return;
            Dictionary<string,string> recorded;
            try { recorded=Json.Deserialize<Dictionary<string,string>>(File.ReadAllText(inventory,Encoding.UTF8)); } catch { return; }
            if(recorded==null) return;
            // An ownership marker does not make user-selected audio folders app-owned.
            // Only a fixed package file with an unchanged recorded hash may be removed.
            foreach(string relative in Assets) {
                string hash; if(!recorded.TryGetValue(relative,out hash)) continue;
                string file=Path.Combine(directory,relative); if(!File.Exists(file)) continue; SafeTree(file);
                try { if(Hash(file)==hash) File.Delete(file); } catch(IOException) { } catch(UnauthorizedAccessException) { }
            }
            foreach(string relative in new[]{"source","third-party"}) { string child=Path.Combine(directory,relative); if(Directory.Exists(child)) { SafeTree(child); if(!Directory.EnumerateFileSystemEntries(child).Any()) Directory.Delete(child); } }
            if(Directory.EnumerateFileSystemEntries(directory).All(p=>Path.GetFileName(p)==Inventory || Path.GetFileName(p)==Marker)) {
                File.Delete(inventory); string marker=Path.Combine(directory,Marker); if(File.Exists(marker) && File.ReadAllText(marker)==Host) File.Delete(marker);
                if(!Directory.EnumerateFileSystemEntries(directory).Any()) Directory.Delete(directory);
            }
        }
        static string Hash(string file) { using(var input=File.OpenRead(file)) using(var sha=SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(input)).Replace("-",""); }
        static void RecordOwned(string directory)
        {
            SafeTree(directory); var recorded=new Dictionary<string,string>();
            foreach(string relative in Assets) { string file=Path.Combine(directory,relative); if(!File.Exists(file)) continue; SafeTree(file); recorded[relative]=Hash(file); }
            File.WriteAllText(Path.Combine(directory,Inventory),Json.Serialize(recorded),new UTF8Encoding(false));
        }
        static void Uninstall()
        {
            string manifest=Path.Combine(Target,Host+".json");
            foreach(string key in Keys) using(var registry=Registry.CurrentUser.OpenSubKey(key)) { if(registry!=null && String.Equals(Convert.ToString(registry.GetValue("")),manifest,StringComparison.OrdinalIgnoreCase)) Registry.CurrentUser.DeleteSubKey(key,false); }
            SafeTree(Target);
            if(Directory.Exists(Target)) {
                string marker=Path.Combine(Target,Marker);
                if(!File.Exists(marker)||File.ReadAllText(marker)!=Host) throw new IOException("已取消浏览器配置，但目录缺少听见所有权标记，未删除目录。");
                DeleteOwned(Target);
            }
            MessageBox.Show("已取消 Chrome 和 Edge 的本地组件配置。\r\n本地任务记录、音频及其他用户文件已保留。\r\n正在使用或已修改的组件文件也会保留。", "听见本地组件",MessageBoxButtons.OK,MessageBoxIcon.Information);
        }
    }
}
