using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

namespace TingjianConverter
{
    public enum ConversionState { Pending, Running, Complete, Failed, Cancelled }

    public sealed class AudioJob
    {
        public string InputPath { get; private set; }
        public string OutputPath { get; internal set; }
        public string Error { get; internal set; }
        public long Size { get; private set; }
        public ConversionState State { get; internal set; }
        public AudioJob(string path)
        {
            InputPath = Path.GetFullPath(path);
            Size = new FileInfo(InputPath).Length;
            State = ConversionState.Pending;
        }
    }

    public sealed class ConversionProgress
    {
        public AudioJob Job { get; private set; }
        public double Fraction { get; private set; }
        public ConversionState State { get; private set; }
        public ConversionProgress(AudioJob job, double fraction)
        {
            Job = job;
            Fraction = Math.Max(0, Math.Min(1, fraction));
            State = job.State;
        }
    }

    public sealed class ScanResult
    {
        public readonly List<string> Files = new List<string>();
        public readonly List<string> Errors = new List<string>();
        public int Ignored;
    }

    public static class FileScanner
    {
        public static ScanResult Scan(IEnumerable<string> paths, bool recursive, CancellationToken token)
        {
            var result = new ScanResult();
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var visited = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var raw in paths)
            {
                token.ThrowIfCancellationRequested();
                try
                {
                    string path = Path.GetFullPath(raw);
                    if (Directory.Exists(path)) ScanDirectory(path, recursive, result, seen, visited, token);
                    else if (File.Exists(path)) AddFile(path, result, seen);
                    else result.Errors.Add(path + "：路径不存在或无法访问。");
                }
                catch (OperationCanceledException) { throw; }
                catch (Exception ex) { result.Errors.Add(raw + "：" + ex.Message); }
            }
            result.Files.Sort(StringComparer.OrdinalIgnoreCase);
            return result;
        }

        private static void AddFile(string path, ScanResult result, HashSet<string> seen)
        {
            if (!String.Equals(Path.GetExtension(path), ".m4a", StringComparison.OrdinalIgnoreCase))
            {
                result.Ignored++;
                return;
            }
            if (seen.Add(path)) result.Files.Add(path);
        }

        private static void ScanDirectory(string root, bool recursive, ScanResult result,
            HashSet<string> seen, HashSet<string> visited, CancellationToken token)
        {
            var pending = new Stack<string>();
            pending.Push(root);
            while (pending.Count > 0)
            {
                token.ThrowIfCancellationRequested();
                string directory = pending.Pop();
                if (!visited.Add(directory)) continue;
                try
                {
                    foreach (string file in Directory.EnumerateFiles(directory))
                    {
                        token.ThrowIfCancellationRequested();
                        AddFile(file, result, seen);
                    }
                    if (!recursive) continue;
                    foreach (string child in Directory.EnumerateDirectories(directory))
                    {
                        token.ThrowIfCancellationRequested();
                        // Do not follow junctions/symlinks into another tree or into a cycle.
                        if ((File.GetAttributes(child) & FileAttributes.ReparsePoint) == 0) pending.Push(child);
                    }
                }
                catch (OperationCanceledException) { throw; }
                catch (Exception ex) { result.Errors.Add(directory + "：" + ex.Message); }
            }
        }
    }

    public sealed class BatchConverter
    {
        public static readonly int[] Bitrates = { 128, 192, 256, 320 };
        private readonly string ffmpeg;
        private static readonly Regex Duration = new Regex(@"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", RegexOptions.Compiled);

        public BatchConverter(string ffmpegPath)
        {
            ffmpeg = Path.GetFullPath(ffmpegPath);
            if (!File.Exists(ffmpeg)) throw new FileNotFoundException("找不到 ffmpeg.exe，请完整解压工具文件夹。", ffmpeg);
        }

        public void Run(IList<AudioJob> jobs, string outputDirectory, int bitrate,
            CancellationToken token, Action<ConversionProgress> onProgress)
        {
            if (!Bitrates.Contains(bitrate)) throw new ArgumentOutOfRangeException("bitrate", "支持 128、192、256、320 kbps。");
            string output = Path.GetFullPath(outputDirectory);
            Directory.CreateDirectory(output);
            // Fail before starting the batch if the selected destination is not writable.
            string probe = Path.Combine(output, ".tingjian-write-" + Guid.NewGuid().ToString("N"));
            using (new FileStream(probe, FileMode.CreateNew, FileAccess.Write, FileShare.None)) { }
            File.Delete(probe);
            foreach (AudioJob job in jobs)
            {
                if (token.IsCancellationRequested) break;
                if (job.State == ConversionState.Complete) continue;
                ConvertOne(job, output, bitrate, token, onProgress);
            }
        }

        private void ConvertOne(AudioJob job, string output, int bitrate,
            CancellationToken token, Action<ConversionProgress> onProgress)
        {
            string temporary = Path.Combine(output, ".tingjian-" + Guid.NewGuid().ToString("N") + ".partial");
            job.State = ConversionState.Running;
            job.Error = null;
            job.OutputPath = null;
            Report(onProgress, job, 0);
            var stderr = new StringBuilder();
            object logLock = new object();
            double totalSeconds = 0;
            double currentSeconds = 0;
            var args = new List<string> {
                "-hide_banner", "-nostdin", "-nostats", "-loglevel", "info", "-n",
                "-stats_period", "0.25", "-progress", "pipe:1",
                "-protocol_whitelist", "file,pipe", "-i", job.InputPath,
                "-map", "0:a:0", "-vn", "-sn", "-dn", "-map_metadata", "0",
                "-c:a", "libmp3lame", "-b:a", bitrate.ToString(CultureInfo.InvariantCulture) + "k",
                "-ar", "44100", "-ac", "2", "-id3v2_version", "3", "-f", "mp3", temporary
            };
            try
            {
                token.ThrowIfCancellationRequested();
                using (var process = new Process())
                {
                    process.StartInfo = new ProcessStartInfo(ffmpeg, JoinArguments(args)) {
                        UseShellExecute = false, CreateNoWindow = true,
                        RedirectStandardOutput = true, RedirectStandardError = true,
                        StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
                    };
                    process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) {
                        if (e.Data == null) return;
                        lock (logLock)
                        {
                            stderr.AppendLine(e.Data);
                            if (stderr.Length > 16000) stderr.Remove(0, stderr.Length - 12000);
                            Match match = Duration.Match(e.Data);
                            if (match.Success)
                                totalSeconds = Int32.Parse(match.Groups[1].Value, CultureInfo.InvariantCulture) * 3600
                                    + Int32.Parse(match.Groups[2].Value, CultureInfo.InvariantCulture) * 60
                                    + Double.Parse(match.Groups[3].Value, CultureInfo.InvariantCulture);
                        }
                    };
                    process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) {
                        if (e.Data == null) return;
                        if (e.Data.StartsWith("out_time_us=", StringComparison.Ordinal))
                        {
                            long micros;
                            if (Int64.TryParse(e.Data.Substring(12), NumberStyles.Integer, CultureInfo.InvariantCulture, out micros))
                                currentSeconds = Math.Max(0, micros / 1000000.0);
                        }
                        else if (e.Data.StartsWith("progress=", StringComparison.Ordinal))
                        {
                            double duration;
                            lock (logLock) duration = totalSeconds;
                            double fraction = duration > 0 ? Math.Min(0.99, currentSeconds / duration) : 0;
                            Report(onProgress, job, fraction);
                        }
                    };
                    process.Start();
                    using (token.Register(delegate {
                        try { if (!process.HasExited) process.Kill(); }
                        catch (InvalidOperationException) { }
                        catch (System.ComponentModel.Win32Exception) { }
                    }))
                    {
                        process.BeginErrorReadLine();
                        process.BeginOutputReadLine();
                        // Parameterless WaitForExit also waits for redirected stream callbacks.
                        process.WaitForExit();
                        token.ThrowIfCancellationRequested();
                        if (process.ExitCode != 0)
                        {
                            lock (logLock) throw new InvalidOperationException(ReadableError(stderr.ToString()));
                        }
                    }
                }
                if (!File.Exists(temporary) || new FileInfo(temporary).Length == 0)
                    throw new InvalidOperationException("文件中没有可转换的音频。");
                token.ThrowIfCancellationRequested();
                // File.Move is atomic and will never replace an existing destination.
                job.OutputPath = Publish(temporary, output, Path.GetFileNameWithoutExtension(job.InputPath));
                job.State = ConversionState.Complete;
                Report(onProgress, job, 1);
            }
            catch (OperationCanceledException)
            {
                job.State = ConversionState.Cancelled;
                job.Error = "已停止，可以再次点击开始转换。";
                Report(onProgress, job, 0);
            }
            catch (Exception ex)
            {
                job.State = ConversionState.Failed;
                job.Error = ex.Message;
                Report(onProgress, job, 0);
            }
            finally
            {
                try { if (File.Exists(temporary)) File.Delete(temporary); }
                catch (Exception ex) {
                    job.Error = (job.Error ?? "") + "\r\n临时文件清理失败：" + temporary + "\r\n" + ex.Message;
                }
            }
        }

        private static void Report(Action<ConversionProgress> callback, AudioJob job, double fraction)
        {
            if (callback != null) callback(new ConversionProgress(job, fraction));
        }

        public static string Publish(string temporary, string output, string stem)
        {
            for (int index = 0; index < Int32.MaxValue; index++)
            {
                string name = stem + (index == 0 ? "" : " (" + index.ToString(CultureInfo.InvariantCulture) + ")") + ".mp3";
                string destination = Path.Combine(output, name);
                if (File.Exists(destination) || Directory.Exists(destination)) continue;
                try { File.Move(temporary, destination); return destination; }
                catch (IOException) {
                    if (File.Exists(destination) || Directory.Exists(destination)) continue;
                    throw;
                }
            }
            throw new IOException("同名文件过多，请选择其他保存文件夹。");
        }

        private static string ReadableError(string log)
        {
            if (log.IndexOf("moov atom not found", StringComparison.OrdinalIgnoreCase) >= 0
                || log.IndexOf("Invalid data found", StringComparison.OrdinalIgnoreCase) >= 0)
                return "文件损坏，或不是有效的 M4A 音频。\r\n\r\n" + log.Trim();
            if (log.IndexOf("matches no streams", StringComparison.OrdinalIgnoreCase) >= 0)
                return "文件中没有可转换的音轨。\r\n\r\n" + log.Trim();
            if (log.IndexOf("No such file", StringComparison.OrdinalIgnoreCase) >= 0)
                return "原文件已移动或删除。\r\n\r\n" + log.Trim();
            return "转换失败，请检查文件是否完整、可读取。\r\n\r\n" + log.Trim();
        }

        public static string JoinArguments(IEnumerable<string> arguments)
        {
            // Windows argv quoting. No shell is involved, including for &, %, and Chinese names.
            return String.Join(" ", arguments.Select(QuoteArgument));
        }

        public static string QuoteArgument(string argument)
        {
            var quoted = new StringBuilder("\"");
            int slashes = 0;
            foreach (char character in argument)
            {
                if (character == '\\') { slashes++; continue; }
                if (character == '"') quoted.Append('\\', slashes * 2 + 1);
                else quoted.Append('\\', slashes);
                slashes = 0;
                quoted.Append(character);
            }
            quoted.Append('\\', slashes * 2);
            return quoted.Append('"').ToString();
        }
    }
}
