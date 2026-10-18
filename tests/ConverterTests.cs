using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using TingjianConverter;

internal static class ConverterTests
{
    private static int passed;
    private static string root;
    private static string ffmpeg;

    private static void Check(bool condition, string message)
    {
        if (!condition) throw new Exception(message);
    }

    private static void Pass(string name)
    {
        passed++;
        Console.WriteLine("PASS " + name);
    }

    [STAThread]
    private static int Main(string[] args)
    {
        Console.OutputEncoding = Encoding.UTF8;
        ffmpeg = args[0];
        root = args[1];
        try
        {
            ScanTests();
            ConversionTests();
            CancellationTests();
            BoundaryTests();
            UiTests();
            Console.WriteLine("Passed " + passed + " checks.");
            return 0;
        }
        catch (Exception ex) { Console.Error.WriteLine(ex); return 1; }
    }

    private static void ScanTests()
    {
        string inputs = Path.Combine(root, "inputs");
        var recursive = FileScanner.Scan(new[] { inputs, Path.Combine(inputs, "one"), inputs }, true, CancellationToken.None);
        Check(recursive.Files.Count == 6, "Recursive scan or overlapping directory deduplication failed: " + recursive.Files.Count);
        Check(recursive.Files.Any(p => p.EndsWith(".M4A")), "Upper-case extension was not scanned.");
        var flat = FileScanner.Scan(new[] { inputs }, false, CancellationToken.None);
        Check(flat.Files.Count == 3, "Nonrecursive folder scan should include only root files.");
        var missing = FileScanner.Scan(new[] { Path.Combine(root, "not-present") }, true, CancellationToken.None);
        Check(missing.Errors.Count == 1, "Missing input path did not produce a clear scan error.");
        using (var cancellation = new CancellationTokenSource())
        {
            cancellation.Cancel();
            bool cancelled = false;
            try { FileScanner.Scan(new[] { inputs }, true, cancellation.Token); }
            catch (OperationCanceledException) { cancelled = true; }
            Check(cancelled, "Folder scanning did not honour cancellation.");
        }
        Pass("Folder scanning, child folders, uppercase extensions, deduplication and cancellation");
    }

    private static void ConversionTests()
    {
        string inputs = Path.Combine(root, "inputs");
        string destination = Path.Combine(root, "outputs");
        Directory.CreateDirectory(destination);
        string preserved = Path.Combine(destination, "同名.mp3");
        File.WriteAllText(preserved, "existing file -- keep untouched", Encoding.UTF8);
        var files = FileScanner.Scan(new[] { inputs }, true, CancellationToken.None).Files;
        var jobs = files.Select(p => new AudioJob(p)).ToList();
        var converter = new BatchConverter(ffmpeg);
        var progressStates = new List<ConversionState>();
        var fractions = new List<double>();
        object progressLock = new object();
        converter.Run(jobs, destination, 320, CancellationToken.None, p => {
            lock (progressLock) { progressStates.Add(p.State); fractions.Add(p.Fraction); }
        });
        Check(jobs.Count(j => j.State == ConversionState.Complete) == 4, "Expected four valid AAC/ALAC files to complete.");
        Check(jobs.Count(j => j.State == ConversionState.Failed) == 2, "Corrupt and video-only files should fail independently.");
        Check(File.ReadAllText(preserved, Encoding.UTF8) == "existing file -- keep untouched", "Existing MP3 was overwritten.");
        Check(File.Exists(Path.Combine(destination, "同名 (1).mp3")) && File.Exists(Path.Combine(destination, "同名 (2).mp3")), "Duplicate source basenames were not numbered.");
        Check(jobs.All(j => File.Exists(j.InputPath)), "Original file was removed.");
        Check(jobs.Where(j => j.State == ConversionState.Failed).All(j => !String.IsNullOrWhiteSpace(j.Error) && j.OutputPath == null), "Failure details missing.");
        Check(Directory.GetFiles(destination, "*.partial").Length == 0, "Failed conversions left partial files.");
        Check(progressStates.Contains(ConversionState.Running) && progressStates.Count(s => s == ConversionState.Complete) == 4, "Progress callbacks missing.");
        Check(fractions.All(f => f >= 0 && f <= 1), "Invalid progress fraction.");
        var csv = MainForm.ResultsCsv(jobs);
        Check(csv.Contains("已完成") && csv.Contains("失败") && csv.Contains("现场 & 笔记"), "CSV report is incomplete.");
        File.WriteAllText(Path.Combine(root, "report.csv"), csv, new UTF8Encoding(true));
        File.WriteAllLines(Path.Combine(root, "verified-outputs.txt"), jobs.Where(j => j.State == ConversionState.Complete).Select(j => j.OutputPath), new UTF8Encoding(false));
        var savedOutputs = jobs.Where(j => j.State == ConversionState.Complete).Select(j => j.OutputPath).ToArray();
        converter.Run(jobs, destination, 320, CancellationToken.None, null);
        Check(savedOutputs.All(File.Exists) && Directory.GetFiles(destination, "*.mp3").Length == 5, "Repeat batch re-encoded successful items.");
        Pass("Real AAC/ALAC batch, Chinese names, source preservation, existing/duplicate MP3 protection and progress");
        Pass("Corrupt and no-audio input isolation, cleanup, readable errors, CSV results and successful-item skip");

        string bitrateDir = Path.Combine(root, "bitrates");
        string source = jobs.First(j => j.State == ConversionState.Complete).InputPath;
        foreach (int bitrate in BatchConverter.Bitrates)
        {
            var job = new AudioJob(source);
            converter.Run(new[] { job }, Path.Combine(bitrateDir, bitrate.ToString()), bitrate, CancellationToken.None, null);
            Check(job.State == ConversionState.Complete, "Bitrate failed: " + bitrate);
            File.WriteAllText(Path.Combine(root, "bitrate-" + bitrate + ".txt"), job.OutputPath, new UTF8Encoding(false));
        }
        Pass("All four selectable bitrates produce MP3 files");
    }

    private static void CancellationTests()
    {
        var converter = new BatchConverter(ffmpeg);
        var longJob = new AudioJob(Path.Combine(root, "long.m4a"));
        var tailJob = new AudioJob(Path.Combine(root, "inputs", "正常尾项.m4a"));
        string destination = Path.Combine(root, "cancel-output");
        bool positiveProgress = false;
        using (var cancellation = new CancellationTokenSource())
        {
            converter.Run(new[] { longJob, tailJob }, destination, 320, cancellation.Token, p => {
                if (p.State == ConversionState.Running && p.Fraction > 0)
                {
                    positiveProgress = true;
                    cancellation.Cancel();
                }
            });
        }
        Check(positiveProgress, "No real per-file progress was observed before cancellation.");
        Check(longJob.State == ConversionState.Cancelled, "Active encoder was not cancelled.");
        Check(tailJob.State == ConversionState.Pending, "Pending item started after cancellation.");
        Check(Directory.GetFiles(destination).Length == 0, "Cancellation left incomplete output.");
        converter.Run(new[] { tailJob }, destination, 192, CancellationToken.None, null);
        Check(tailJob.State == ConversionState.Complete && File.Exists(tailJob.OutputPath), "Continuation after cancellation failed.");
        // Retry the cancelled row against a short file using the same job state transition.
        var retry = new AudioJob(tailJob.InputPath) { State = ConversionState.Cancelled };
        converter.Run(new[] { retry }, destination, 192, CancellationToken.None, null);
        Check(retry.State == ConversionState.Complete, "Cancelled rows were not retried.");
        Pass("Cancel active FFmpeg with real progress, clean partial files, keep pending work and resume");
    }

    private static void BoundaryTests()
    {
        var converter = new BatchConverter(ffmpeg);
        var deleted = new AudioJob(Path.Combine(root, "deleted.m4a"));
        File.Delete(deleted.InputPath);
        converter.Run(new[] { deleted }, Path.Combine(root, "deleted-output"), 320, CancellationToken.None, null);
        Check(deleted.State == ConversionState.Failed && deleted.Error.Contains("移动或删除"), "Deleted input wasn't reported.");
        bool invalidRate = false;
        try { converter.Run(new AudioJob[0], root, 333, CancellationToken.None, null); }
        catch (ArgumentOutOfRangeException) { invalidRate = true; }
        Check(invalidRate, "Unsupported bitrate was accepted.");
        string blocked = Path.Combine(root, "not-a-directory");
        File.WriteAllText(blocked, "occupied");
        bool blockedDestination = false;
        try { converter.Run(new AudioJob[0], blocked, 320, CancellationToken.None, null); }
        catch (IOException) { blockedDestination = true; }
        Check(blockedDestination, "Invalid destination wasn't rejected before conversion.");
        Check(BatchConverter.QuoteArgument("C:\\音乐\\") == "\"C:\\音乐\\\\\"", "Trailing slash argv quoting failed.");
        Check(BatchConverter.QuoteArgument("a\"b") == "\"a\\\"b\"", "Embedded quote argv quoting failed.");
        Pass("Missing input, invalid bitrate/destination and Windows path argument boundaries");
    }

    private static void Capture(Form form, string name)
    {
        using (var bitmap = new Bitmap(form.Width, form.Height))
        {
            // Render only the form's own controls, without reading the desktop.
            form.Refresh();
            form.DrawToBitmap(bitmap, new Rectangle(Point.Empty, form.Size));
            bitmap.Save(Path.Combine(root, name), System.Drawing.Imaging.ImageFormat.Png);
        }
    }

    private static void UiTests()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Exception failure = null;
        using (var form = new MainForm(ffmpeg))
        {
            form.OutputDirectory = Path.Combine(root, "ui-output");
            form.Shown += async delegate {
                try
                {
                    Check(!form.StartButton.Enabled, "Empty queue allowed starting.");
                    Check(form.SelectedBitrate == 320, "Default bitrate is not 320.");
                    await Task.Delay(200);
                    Capture(form, "converter-empty.png");
                    string source = Path.Combine(root, "inputs", "中文 & 空格", "现场 & 笔记 (一).m4a");
                    string invalid = Path.Combine(root, "inputs", "坏文件.m4a");
                    form.AddPaths(new[] { source, source, invalid });
                    Check(form.Jobs.Count == 2 && form.StartButton.Enabled, "UI add/dedupe failed.");
                    Capture(form, "converter-ready.png");
                    await form.StartBatchAsync();
                    await Task.Delay(150);
                    Check(!form.IsBusy, "UI did not release controls after conversion.");
                    Check(form.Jobs.Count(j => j.State == ConversionState.Complete) == 1, "UI conversion did not produce MP3.");
                    Check(form.Jobs.Count(j => j.State == ConversionState.Failed) == 1, "UI did not report per-file failure.");
                    Check(form.StartButton.Enabled, "Failed item cannot be retried.");
                    Capture(form, "converter-complete.png");
                    Pass("Real Windows UI: empty state, queue, defaults, complete/failed states and control recovery");
                    using (var closeForm = new MainForm(ffmpeg))
                    {
                        closeForm.OutputDirectory = Path.Combine(root, "ui-close-output");
                        closeForm.Show();
                        closeForm.AddPaths(new[] { Path.Combine(root, "long.m4a") });
                        var operation = closeForm.StartBatchAsync();
                        await Task.Delay(100);
                        closeForm.Close();
                        await operation;
                        Check(closeForm.IsDisposed, "Closing during a batch did not finish closing.");
                        Check(Directory.GetFiles(Path.Combine(root, "ui-close-output")).Length == 0, "Close left a partial file.");
                        Pass("Closing the window cancels FFmpeg and removes partial output");
                    }
                }
                catch (Exception ex) { failure = ex; }
                finally { form.Close(); }
            };
            Application.Run(form);
        }
        if (failure != null) throw failure;
    }
}
