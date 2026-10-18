using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace TingjianConverter
{
    public sealed class MainForm : Form
    {
        private readonly Color ink = Color.FromArgb(28, 49, 44);
        private readonly Color accent = Color.FromArgb(17, 109, 96);
        private readonly Color muted = Color.FromArgb(105, 124, 115);
        private readonly List<AudioJob> jobs = new List<AudioJob>();
        private readonly Dictionary<AudioJob, ListViewItem> rows = new Dictionary<AudioJob, ListViewItem>();
        private readonly string ffmpeg;
        private readonly Button addFiles, addFolder, remove, clear, browse, openOutput, start, stop, report;
        private readonly CheckBox recursive;
        private readonly FlowLayoutPanel quality;
        private readonly RadioButton[] bitrateChoices;
        private readonly TextBox output;
        private readonly ListView queue;
        private readonly Label summary, status, empty, qualityNote;
        private readonly ProgressBar progress;
        private readonly ToolTip tips = new ToolTip();
        private CancellationTokenSource cancellation;
        private bool busy;
        private bool scanning;
        private bool closing;
        private int batchCompleted;
        private int batchTotal;
        private string lastOutput;
        private Task currentOperation;

        internal IList<AudioJob> Jobs { get { return jobs.AsReadOnly(); } }
        internal string OutputDirectory { get { return output.Text; } set { output.Text = value; } }
        internal int SelectedBitrate { get { return BatchConverter.Bitrates[Array.FindIndex(bitrateChoices, choice => choice.Checked)]; } }
        internal Button StartButton { get { return start; } }
        internal bool IsBusy { get { return busy; } }

        public MainForm(string ffmpegPath)
        {
            ffmpeg = ffmpegPath;
            Text = "听见 · M4A 批量转 MP3";
            Name = "TingjianConverter";
            Font = new Font("Microsoft YaHei UI", 9F);
            ForeColor = ink;
            BackColor = Color.FromArgb(247, 248, 243);
            AutoScaleMode = AutoScaleMode.Dpi;
            ClientSize = new Size(960, 740);
            MinimumSize = new Size(860, 700);
            StartPosition = FormStartPosition.CenterScreen;
            AllowDrop = true;
            DoubleBuffered = true;
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

            var layout = new TableLayoutPanel {
                Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 7, Padding = new Padding(28, 18, 28, 22),
                BackColor = BackColor
            };
            layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            foreach (int height in new[] { 94, 55, 119, 32 }) layout.RowStyles.Add(new RowStyle(SizeType.Absolute, height));
            layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 48));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 76));
            Controls.Add(layout);

            var header = new Panel { Dock = DockStyle.Fill, Margin = Padding.Empty };
            var title = MakeLabel("听见", 0, 3, 190, 40, 25, ink);
            title.Font = new Font(Font.FontFamily, 25, FontStyle.Bold);
            header.Controls.Add(title);
            header.Controls.Add(MakeLabel("M4A  批量转  MP3", 120, 12, 400, 32, 17, accent));
            header.Controls.Add(MakeLabel("把音乐整理成更通用的格式。所有转换都在你的电脑上完成。", 1, 55, 720, 27, 10, muted));
            var badge = MakeLabel("本地转换  ·  无需联网", 680, 15, 223, 27, 9, accent);
            header.Controls.Add(badge);
            header.Resize += delegate { badge.Left = Math.Max(520, header.ClientSize.Width - badge.Width); };
            layout.Controls.Add(header, 0, 0);

            var toolbar = new FlowLayoutPanel { Dock = DockStyle.Fill, Margin = Padding.Empty, WrapContents = false };
            addFiles = MakeButton("＋ 添加文件", 134, false);
            addFolder = MakeButton("添加文件夹", 127, false);
            recursive = new CheckBox { Text = "包含子文件夹", Checked = true, AutoSize = true, Margin = new Padding(10, 12, 24, 0) };
            remove = MakeButton("移除所选", 105, false);
            clear = MakeButton("清空列表", 105, false);
            toolbar.Controls.AddRange(new Control[] { addFiles, addFolder, recursive, remove, clear });
            layout.Controls.Add(toolbar, 0, 1);

            var settings = new TableLayoutPanel {
                Dock = DockStyle.Fill, ColumnCount = 3, RowCount = 3, BackColor = Color.White,
                Padding = new Padding(14, 10, 14, 8), Margin = new Padding(0, 0, 0, 8)
            };
            settings.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 82));
            settings.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            settings.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 104));
            settings.RowStyles.Add(new RowStyle(SizeType.Absolute, 38));
            settings.RowStyles.Add(new RowStyle(SizeType.Absolute, 38));
            settings.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            settings.Controls.Add(CellLabel("保存位置"), 0, 0);
            output = new TextBox {
                Dock = DockStyle.Fill, Margin = new Padding(2, 4, 12, 0),
                Text = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyMusic), "听见 MP3")
            };
            settings.Controls.Add(output, 1, 0);
            browse = MakeButton("选择位置", 100, false);
            browse.Dock = DockStyle.Fill;
            browse.Margin = new Padding(0, 0, 0, 5);
            settings.Controls.Add(browse, 2, 0);
            settings.Controls.Add(CellLabel("音质码率"), 0, 1);
            var qualityRow = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false, Margin = Padding.Empty };
            quality = new FlowLayoutPanel { Width = 404, Height = 32, WrapContents = false, Margin = new Padding(2, 3, 12, 0) };
            bitrateChoices = BatchConverter.Bitrates.Select(rate => new RadioButton {
                Text = rate + " kbps", AutoSize = true, Margin = new Padding(0, 3, 16, 0), Checked = rate == 320
            }).ToArray();
            quality.Controls.AddRange(bitrateChoices);
            qualityNote = new Label { Text = "44.1 kHz  /  立体声", AutoSize = true, ForeColor = muted, Margin = new Padding(0, 8, 0, 0) };
            qualityRow.Controls.AddRange(new Control[] { quality, qualityNote });
            settings.Controls.Add(qualityRow, 1, 1);
            settings.SetColumnSpan(qualityRow, 2);
            var policy = CellLabel("原文件会保留；重名时自动编号；标题、歌手等常见文字标签随音频保存。");
            policy.ForeColor = muted;
            policy.Font = new Font(Font.FontFamily, 8.5F);
            policy.Margin = Padding.Empty;
            settings.Controls.Add(policy, 0, 2);
            settings.SetColumnSpan(policy, 3);
            layout.Controls.Add(settings, 0, 2);

            summary = new Label { Text = "转换列表  ·  0 个文件", Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft, Margin = Padding.Empty };
            layout.Controls.Add(summary, 0, 3);
            var listPanel = new Panel { Dock = DockStyle.Fill, Margin = Padding.Empty, BackColor = Color.White };
            queue = new ListView {
                Dock = DockStyle.Fill, View = View.Details, FullRowSelect = true, MultiSelect = true,
                HideSelection = false, BorderStyle = BorderStyle.None, ShowItemToolTips = true,
                BackColor = Color.White, ForeColor = ink, AllowDrop = true
            };
            queue.Columns.Add("文件名", 330);
            queue.Columns.Add("大小", 95);
            queue.Columns.Add("状态", 125);
            queue.Columns.Add("输出文件 / 说明", 330);
            listPanel.Controls.Add(queue);
            empty = new Label {
                Text = "把 M4A 文件或整个文件夹拖到这里\r\n\r\n也可以点击上方「添加文件」或「添加文件夹」",
                Font = new Font(Font.FontFamily, 12), ForeColor = muted, BackColor = Color.White,
                TextAlign = ContentAlignment.MiddleCenter, AutoSize = false,
                Dock = DockStyle.Fill,
                AllowDrop = true
            };
            listPanel.Controls.Add(empty);
            empty.BringToFront();
            layout.Controls.Add(listPanel, 0, 4);

            var progressPanel = new TableLayoutPanel { Dock = DockStyle.Fill, RowCount = 2, ColumnCount = 1, Margin = new Padding(0, 6, 0, 0) };
            progressPanel.RowStyles.Add(new RowStyle(SizeType.Absolute, 24));
            progressPanel.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            status = new Label { Text = "准备就绪 · 添加文件后即可开始", Dock = DockStyle.Fill, ForeColor = muted, Margin = Padding.Empty };
            progress = new ProgressBar { Dock = DockStyle.Top, Height = 8, Maximum = 1000, Margin = Padding.Empty };
            progressPanel.Controls.Add(status, 0, 0);
            progressPanel.Controls.Add(progress, 0, 1);
            layout.Controls.Add(progressPanel, 0, 5);

            var footer = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 2, Margin = Padding.Empty };
            footer.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            footer.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 296));
            footer.RowStyles.Add(new RowStyle(SizeType.Absolute, 45));
            footer.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            var leftActions = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false, Margin = Padding.Empty };
            openOutput = MakeButton("打开输出文件夹", 145, false);
            report = MakeButton("导出结果", 108, false);
            leftActions.Controls.AddRange(new Control[] { openOutput, report });
            footer.Controls.Add(leftActions, 0, 0);
            var rightActions = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.RightToLeft, WrapContents = false, Margin = Padding.Empty };
            start = MakeButton("开始转换", 165, true);
            stop = MakeButton("停止", 96, false);
            stop.Enabled = false;
            rightActions.Controls.AddRange(new Control[] { start, stop });
            footer.Controls.Add(rightActions, 1, 0);
            var hint = CellLabel("提示：提高输出码率不会提升源文件音质。双击列表项可打开成品或查看失败原因。");
            hint.Font = new Font(Font.FontFamily, 8.5F);
            hint.ForeColor = muted;
            hint.Margin = Padding.Empty;
            footer.Controls.Add(hint, 0, 1);
            footer.SetColumnSpan(hint, 2);
            layout.Controls.Add(footer, 0, 6);

            addFiles.Click += async delegate {
                using (var dialog = new OpenFileDialog { Filter = "M4A 音频 (*.m4a)|*.m4a", Multiselect = true, Title = "选择要转换的 M4A 音频" })
                    if (dialog.ShowDialog(this) == DialogResult.OK) await ScanAndAddAsync(dialog.FileNames);
            };
            addFolder.Click += async delegate {
                using (var dialog = new FolderBrowserDialog { Description = "选择存放 M4A 文件的文件夹", ShowNewFolderButton = false })
                    if (dialog.ShowDialog(this) == DialogResult.OK) await ScanAndAddAsync(new[] { dialog.SelectedPath });
            };
            remove.Click += delegate {
                foreach (ListViewItem item in queue.SelectedItems.Cast<ListViewItem>().ToArray())
                {
                    var job = (AudioJob)item.Tag;
                    jobs.Remove(job);
                    rows.Remove(job);
                    queue.Items.Remove(item);
                }
                RefreshQueue();
            };
            clear.Click += delegate { jobs.Clear(); rows.Clear(); queue.Items.Clear(); progress.Value = 0; RefreshQueue(); };
            browse.Click += delegate {
                using (var dialog = new FolderBrowserDialog { Description = "选择 MP3 文件的保存位置", ShowNewFolderButton = true })
                {
                    if (Directory.Exists(output.Text)) dialog.SelectedPath = output.Text;
                    if (dialog.ShowDialog(this) == DialogResult.OK) output.Text = dialog.SelectedPath;
                }
            };
            openOutput.Click += delegate { OpenOutputDirectory(); };
            report.Click += delegate { ExportResults(); };
            start.Click += async delegate { await StartBatchAsync(); };
            stop.Click += delegate { CancelOperation(); };
            queue.SelectedIndexChanged += delegate { remove.Enabled = !busy && queue.SelectedItems.Count > 0; };
            queue.DoubleClick += delegate { OpenSelected(); };
            queue.KeyDown += delegate(object sender, KeyEventArgs e) {
                if (e.Control && e.KeyCode == Keys.A) foreach (ListViewItem item in queue.Items) item.Selected = true;
                if (e.KeyCode == Keys.Delete && remove.Enabled) remove.PerformClick();
                if (e.KeyCode == Keys.Enter) OpenSelected();
            };
            foreach (Control target in new Control[] { this, queue, empty })
            {
                target.DragEnter += delegate(object sender, DragEventArgs e) {
                    e.Effect = !busy && e.Data.GetDataPresent(DataFormats.FileDrop) ? DragDropEffects.Copy : DragDropEffects.None;
                };
                target.DragDrop += async delegate(object sender, DragEventArgs e) {
                    if (!busy && e.Data.GetDataPresent(DataFormats.FileDrop))
                        await ScanAndAddAsync((string[])e.Data.GetData(DataFormats.FileDrop));
                };
            }
            tips.SetToolTip(output, "可以输入路径。所有 MP3 集中保存到此文件夹。");
            tips.SetToolTip(recursive, "添加或拖入文件夹时，扫描其中的所有子文件夹；不跟随文件夹链接。");
            tips.SetToolTip(stop, "停止当前任务，保留已完成的 MP3；可再次开始继续转换。");
            FormClosing += HandleClosing;
            RefreshQueue();
        }

        private Label MakeLabel(string text, int x, int y, int width, int height, float size, Color color)
        {
            return new Label { Text = text, Location = new Point(x, y), Size = new Size(width, height),
                Font = new Font(Font.FontFamily, size), ForeColor = color, TextAlign = ContentAlignment.MiddleLeft };
        }

        private Label CellLabel(string text)
        {
            return new Label { Text = text, Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft, Margin = new Padding(0, 0, 0, 4) };
        }

        private Button MakeButton(string text, int width, bool primary)
        {
            var button = new Button {
                Text = text, Width = width, Height = 36, FlatStyle = FlatStyle.Flat,
                BackColor = primary ? accent : Color.White, ForeColor = primary ? Color.White : ink,
                Cursor = Cursors.Hand, Margin = new Padding(0, 0, 10, 0), UseVisualStyleBackColor = false
            };
            button.FlatAppearance.BorderColor = primary ? accent : Color.FromArgb(217, 227, 219);
            button.FlatAppearance.MouseOverBackColor = primary ? Color.FromArgb(25, 124, 108) : Color.FromArgb(236, 243, 236);
            return button;
        }

        internal void AddPaths(IEnumerable<string> paths, List<string> errors = null)
        {
            var existing = new HashSet<string>(jobs.Select(j => j.InputPath), StringComparer.OrdinalIgnoreCase);
            queue.BeginUpdate();
            try
            {
                foreach (string path in paths)
                {
                    try
                    {
                    string fullPath = Path.GetFullPath(path);
                    if (!existing.Add(fullPath)) continue;
                    if (!String.Equals(Path.GetExtension(fullPath), ".m4a", StringComparison.OrdinalIgnoreCase)) continue;
                    var job = new AudioJob(fullPath);
                    var item = new ListViewItem(Path.GetFileName(fullPath)) { Tag = job, ToolTipText = fullPath };
                    item.SubItems.Add(FormatSize(job.Size));
                    item.SubItems.Add("等待转换");
                    item.SubItems.Add("—");
                    jobs.Add(job);
                    rows.Add(job, item);
                    queue.Items.Add(item);
                    }
                    catch (Exception ex) {
                        if (errors == null) throw;
                        errors.Add(path + "：" + ex.Message);
                    }
                }
            }
            finally { queue.EndUpdate(); RefreshQueue(); }
        }

        internal async Task ScanAndAddAsync(IEnumerable<string> paths)
        {
            if (busy) return;
            SetBusy(true, true);
            cancellation = new CancellationTokenSource();
            bool includeChildren = recursive.Checked;
            status.Text = "正在扫描 M4A 文件…";
            progress.Style = ProgressBarStyle.Marquee;
            try
            {
                currentOperation = Task.Run(delegate { return FileScanner.Scan(paths, includeChildren, cancellation.Token); });
                var result = await (Task<ScanResult>)currentOperation;
                int before = jobs.Count;
                var errors = new List<string>(result.Errors);
                AddPaths(result.Files, errors);
                status.Text = String.Format("已添加 {0} 个文件 · 当前共 {1} 个", jobs.Count - before, jobs.Count);
                if (result.Files.Count == 0) status.Text = "没有找到 M4A 文件，请选择包含 .m4a 音频的文件或文件夹。";
                if (errors.Count > 0 && !closing)
                    MessageBox.Show(this, String.Join("\r\n", errors.Take(10)) + (errors.Count > 10 ? "\r\n…另有 " + (errors.Count - 10) + " 项" : ""), "部分路径无法读取", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            catch (OperationCanceledException) { status.Text = "已停止扫描。"; }
            catch (Exception ex) { ShowError(ex.Message); }
            finally { FinishOperation(); }
        }

        internal async Task StartBatchAsync()
        {
            if (busy) return;
            var pending = jobs.Where(j => j.State != ConversionState.Complete).ToList();
            if (pending.Count == 0) return;
            string destination;
            BatchConverter converter;
            try
            {
                if (String.IsNullOrWhiteSpace(output.Text)) throw new InvalidOperationException("请先选择保存位置。");
                destination = Path.GetFullPath(output.Text.Trim());
                converter = new BatchConverter(ffmpeg);
            }
            catch (Exception ex) { ShowError(ex.Message); return; }
            int bitrate = SelectedBitrate;
            output.Text = destination;
            cancellation = new CancellationTokenSource();
            batchCompleted = 0;
            batchTotal = pending.Count;
            progress.Value = 0;
            SetBusy(true, false);
            foreach (AudioJob job in pending)
            {
                job.State = ConversionState.Pending;
                job.Error = null;
                rows[job].SubItems[2].Text = "等待转换";
                rows[job].SubItems[3].Text = "—";
                rows[job].ForeColor = ink;
            }
            status.Text = "正在准备转换…";
            var uiProgress = new Progress<ConversionProgress>(UpdateProgress);
            try
            {
                currentOperation = Task.Run(delegate {
                    converter.Run(pending, destination, bitrate, cancellation.Token, p => ((IProgress<ConversionProgress>)uiProgress).Report(p));
                });
                await currentOperation;
                int complete = pending.Count(j => j.State == ConversionState.Complete);
                int failed = pending.Count(j => j.State == ConversionState.Failed);
                int remaining = pending.Count - complete - failed;
                foreach (AudioJob job in pending) UpdateRow(job, job.State, job.State == ConversionState.Complete ? 1 : 0);
                lastOutput = destination;
                if (remaining == 0) progress.Value = progress.Maximum;
                status.Text = String.Format("{0} · 成功 {1} 个 / 失败 {2} 个{3}", remaining > 0 ? "已停止" : "转换结束", complete, failed,
                    remaining > 0 ? " / 未完成 " + remaining + " 个，可再次开始" : "");
            }
            catch (Exception ex) { ShowError(ex.Message); }
            finally { FinishOperation(); }
        }

        private void UpdateProgress(ConversionProgress update)
        {
            if (IsDisposed || closing || !busy || scanning) return;
            UpdateRow(update.Job, update.State, update.Fraction);
            if (update.State == ConversionState.Running)
            {
                status.Text = String.Format("正在转换 {0} / {1} · {2}", batchCompleted + 1, batchTotal, Path.GetFileName(update.Job.InputPath));
                progress.Value = Math.Min(progress.Maximum, (int)(progress.Maximum * (batchCompleted + update.Fraction) / Math.Max(1, batchTotal)));
            }
            else if (update.State == ConversionState.Complete || update.State == ConversionState.Failed)
            {
                batchCompleted++;
                progress.Value = Math.Min(progress.Maximum, progress.Maximum * batchCompleted / Math.Max(1, batchTotal));
            }
        }

        private void UpdateRow(AudioJob job, ConversionState state, double fraction)
        {
            ListViewItem item;
            if (!rows.TryGetValue(job, out item)) return;
            switch (state)
            {
                case ConversionState.Running: item.SubItems[2].Text = "转换中 " + (fraction * 100).ToString("0") + "%"; item.ForeColor = accent; break;
                case ConversionState.Complete: item.SubItems[2].Text = "✓ 已完成"; item.ForeColor = accent; break;
                case ConversionState.Failed: item.SubItems[2].Text = "转换失败"; item.ForeColor = Color.FromArgb(159, 64, 45); break;
                case ConversionState.Cancelled: item.SubItems[2].Text = "已停止"; item.ForeColor = muted; break;
                default: item.SubItems[2].Text = "等待转换"; item.ForeColor = ink; break;
            }
            item.SubItems[3].Text = state == ConversionState.Complete ? Path.GetFileName(job.OutputPath)
                : !String.IsNullOrEmpty(job.Error) ? job.Error.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)[0] : "—";
            item.ToolTipText = job.InputPath + (job.OutputPath != null ? "\r\n输出：" + job.OutputPath : "")
                + (job.Error != null ? "\r\n" + job.Error : "");
        }

        private void SetBusy(bool value, bool isScan)
        {
            busy = value;
            scanning = isScan;
            addFiles.Enabled = addFolder.Enabled = recursive.Enabled = browse.Enabled = output.Enabled = quality.Enabled = !value;
            stop.Enabled = value;
            start.Text = value ? (isScan ? "扫描中…" : "转换中…") : "开始转换";
            RefreshQueue();
        }

        private void FinishOperation()
        {
            progress.Style = ProgressBarStyle.Continuous;
            if (cancellation != null) { cancellation.Dispose(); cancellation = null; }
            currentOperation = null;
            SetBusy(false, false);
            if (closing) Close();
        }

        private void RefreshQueue()
        {
            summary.Text = String.Format("转换列表  ·  {0} 个文件  ·  {1}", jobs.Count, FormatSize(jobs.Sum(j => j.Size)));
            empty.Visible = jobs.Count == 0;
            queue.Visible = jobs.Count > 0;
            start.Enabled = !busy && jobs.Any(j => j.State != ConversionState.Complete);
            start.BackColor = start.Enabled ? accent : Color.FromArgb(222, 232, 223);
            remove.Enabled = !busy && queue.SelectedItems.Count > 0;
            clear.Enabled = !busy && jobs.Count > 0;
            report.Enabled = !busy && jobs.Any(j => j.State != ConversionState.Pending);
            openOutput.Enabled = !busy;
        }

        internal void CancelOperation()
        {
            if (cancellation == null) return;
            cancellation.Cancel();
            stop.Enabled = false;
            status.Text = scanning ? "正在停止扫描…" : "正在停止，已完成的文件会保留…";
        }

        private void HandleClosing(object sender, FormClosingEventArgs e)
        {
            if (!busy) return;
            e.Cancel = true;
            closing = true;
            CancelOperation();
        }

        private void OpenSelected()
        {
            if (queue.SelectedItems.Count != 1) return;
            var job = (AudioJob)queue.SelectedItems[0].Tag;
            try
            {
                if (job.State == ConversionState.Complete && File.Exists(job.OutputPath))
                    Process.Start(new ProcessStartInfo(job.OutputPath) { UseShellExecute = true });
                else if (!String.IsNullOrEmpty(job.Error))
                    MessageBox.Show(this, job.Error, "转换详情 · " + Path.GetFileName(job.InputPath), MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            catch (Exception ex) { ShowError(ex.Message); }
        }

        private void OpenOutputDirectory()
        {
            try
            {
                string target = lastOutput ?? Path.GetFullPath(output.Text.Trim());
                if (!Directory.Exists(target)) { status.Text = "保存文件夹尚未创建，开始转换后会自动创建。"; return; }
                Process.Start(new ProcessStartInfo(target) { UseShellExecute = true });
            }
            catch (Exception ex) { ShowError(ex.Message); }
        }

        private void ExportResults()
        {
            using (var dialog = new SaveFileDialog { Filter = "CSV 表格 (*.csv)|*.csv", FileName = "听见转换结果.csv", Title = "保存转换结果" })
            {
                if (dialog.ShowDialog(this) != DialogResult.OK) return;
                try { File.WriteAllText(dialog.FileName, ResultsCsv(jobs), new UTF8Encoding(true)); status.Text = "转换结果已导出。"; }
                catch (Exception ex) { ShowError(ex.Message); }
            }
        }

        internal static string ResultsCsv(IEnumerable<AudioJob> items)
        {
            var csv = new StringBuilder("原文件,状态,输出文件,详情\r\n");
            foreach (AudioJob job in items)
                csv.AppendLine(String.Join(",", new[] { job.InputPath, StateText(job.State), job.OutputPath ?? "", job.Error ?? "" }.Select(CsvCell)));
            return csv.ToString();
        }

        private static string CsvCell(string value)
        {
            if (value.Length > 0 && "=+-@\t\r\n".IndexOf(value[0]) >= 0) value = "'" + value;
            return "\"" + value.Replace("\"", "\"\"") + "\"";
        }

        private static string StateText(ConversionState state)
        {
            switch (state) {
                case ConversionState.Complete: return "已完成";
                case ConversionState.Failed: return "失败";
                case ConversionState.Running: return "转换中";
                case ConversionState.Cancelled: return "已停止";
                default: return "等待转换";
            }
        }

        private static string FormatSize(long bytes)
        {
            if (bytes >= 1073741824) return (bytes / 1073741824.0).ToString("0.0") + " GB";
            if (bytes >= 1048576) return (bytes / 1048576.0).ToString("0.0") + " MB";
            return (bytes / 1024.0).ToString("0.0") + " KB";
        }

        private void ShowError(string message)
        {
            status.Text = "操作未完成 · " + message.Split(new[] { '\r', '\n' })[0];
            if (!closing) MessageBox.Show(this, message, "听见 · 提示", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing) tips.Dispose();
            base.Dispose(disposing);
        }
    }

    internal static class Program
    {
        [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();

        [STAThread]
        private static void Main(string[] args)
        {
            try { SetProcessDPIAware(); } catch { }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
            Application.ThreadException += delegate(object sender, ThreadExceptionEventArgs e) {
                MessageBox.Show("操作未完成：" + e.Exception.Message, "听见 · 提示", MessageBoxButtons.OK, MessageBoxIcon.Information);
            };
            string ffmpeg = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "ffmpeg.exe");
            var form = new MainForm(ffmpeg);
            if (args.Length > 0) form.Shown += async delegate { await form.ScanAndAddAsync(args); };
            Application.Run(form);
        }
    }
}
