using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace TingjianNative
{
    internal static class NativeHost
    {
        const int MaximumMessage = 256 * 1024;
        static readonly object WriteGate = new object();
        static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = MaximumMessage, RecursionLimit=32 };
        static readonly JavaScriptSerializer OutputJson = new JavaScriptSerializer { MaxJsonLength = 1024 * 1024, RecursionLimit=32 };
        static Stream output;
        [DllImport("shell32.dll")] static extern int SHGetKnownFolderPath([MarshalAs(UnmanagedType.LPStruct)] Guid id, uint flags, IntPtr token, out IntPtr path);
        static string Downloads() { IntPtr result; int code=SHGetKnownFolderPath(new Guid("374DE290-123F-4565-9164-39C4925E467B"),0,IntPtr.Zero,out result); if(code!=0) Marshal.ThrowExceptionForHR(code); try { return Marshal.PtrToStringUni(result); } finally { Marshal.FreeCoTaskMem(result); } }
        [STAThread]
        static int Main(string[] args)
        {
            if(args.Length<1 || !String.Equals(args[0],TrustedOrigin.Value,StringComparison.Ordinal)) { Console.Error.WriteLine("Tingjian: untrusted extension origin."); return 2; }
            try {
                bool created;
                using(var mutex=new Mutex(true,@"Local\Tingjian.NativeHost."+WindowsIdentity.GetCurrent().User.Value,out created)) {
                    if(!created) { Console.Error.WriteLine("Tingjian: another browser connection owns the local queue. Close that browser before reconnecting."); return 1; }
                    try {
                        output=Console.OpenStandardOutput();
                        var options=new HostOptions {
                            StateDirectory=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Tingjian","State"),
                            DefaultDownloadDirectory=Downloads(), FFmpegPath=Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"ffmpeg.exe"),
                            SelectDirectory=SelectDirectory, SelectFiles=SelectFiles
                        };
                        using(var host=new HostService(options)) {
                            host.Changed+=Send;
                            var input=Console.OpenStandardInput();
                            while(true) {
                                byte[] header=Read(input,4,true); if(header==null) break;
                                uint size=(uint)(header[0]|header[1]<<8|header[2]<<16|header[3]<<24);
                                if(size==0 || size>MaximumMessage) throw new InvalidDataException("Native message length is out of bounds.");
                                byte[] bytes=Read(input,(int)size,false);
                                string text=new UTF8Encoding(false,true).GetString(bytes);
                                Dictionary<string,object> request=Json.Deserialize<Dictionary<string,object>>(text);
                                object id; if(request==null || !request.TryGetValue("id",out id) || !(id is string) || ((string)id).Length>96) throw new InvalidDataException("Invalid native message id.");
                                try { Send(new Dictionary<string,object>{{"id",id},{"ok",true},{"data",host.Execute(request)}}); }
                                catch(Exception ex) { Send(new Dictionary<string,object>{{"id",id},{"ok",false},{"error",ex.Message}}); }
                            }
                        }
                        return 0;
                    } finally { mutex.ReleaseMutex(); }
                }
            } catch(Exception ex) { Console.Error.WriteLine("Tingjian: "+ex.Message); return 1; }
        }
        static byte[] Read(Stream input,int size,bool eof)
        {
            byte[] bytes=new byte[size]; int offset=0;
            while(offset<size) { int count=input.Read(bytes,offset,size-offset); if(count==0) { if(offset==0&&eof) return null; throw new EndOfStreamException("Truncated native message."); } offset+=count; }
            return bytes;
        }
        static void Send(object message)
        {
            lock(WriteGate) {
                byte[] bytes=new UTF8Encoding(false).GetBytes(OutputJson.Serialize(message));
                if(bytes.Length>1024*1024) throw new InvalidDataException("Native response exceeds browser limit.");
                byte[] header=BitConverter.GetBytes(bytes.Length); output.Write(header,0,4); output.Write(bytes,0,bytes.Length); output.Flush();
            }
        }
        static string SelectDirectory(string purpose)
        {
            using(var dialog=new FolderBrowserDialog { Description=purpose=="download"?"选择听见下载保存目录":"选择 MP3 转换输出目录", ShowNewFolderButton=true }) return dialog.ShowDialog()==DialogResult.OK?dialog.SelectedPath:null;
        }
        static string[] SelectFiles(bool folder)
        {
            if(folder) { string path=SelectDirectory("input"); return path==null?new string[0]:new[]{path}; }
            using(var dialog=new OpenFileDialog { Title="添加 M4A 文件", Filter="M4A 音频 (*.m4a)|*.m4a", Multiselect=true, CheckFileExists=true }) return dialog.ShowDialog()==DialogResult.OK?dialog.FileNames:new string[0];
        }
    }
}
