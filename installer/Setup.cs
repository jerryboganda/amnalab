// Amna Lab LMS one-click installer and uninstaller (same program; the installer build embeds payload.zip).
// Compiled with the C# 5 compiler that ships with Windows (no SDK needed): see installer/build.mjs.
//
// Switches:  /S silent   /dir=PATH install folder   /nodesktop /nostartup /nolaunch   /uninstall [/purge]
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace AmnaLab
{
    internal sealed class Options
    {
        public bool Silent;
        public bool Uninstall;
        public bool Purge;
        public bool NoDesktop;
        public bool NoStartup;
        public bool NoLaunch;
        public bool AutoClose;
        public string Dir;
        public string CleanupDir; // internal: this process is a temp copy removing that install
    }

    internal sealed class InstallOutcome
    {
        public bool Ok;
        public string Error;
        public string Dir;
        public string NewPassphrase;
        public bool Upgraded;
    }

    internal delegate void Progress(int percent, string text);

    internal static class SetupProgram
    {
        internal const string AppName = "Amna Lab LMS";
        private const string RegPath = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\AmnaLabLMS";
        private static readonly string[] AppDirs = new string[] { "runtime", "dist", "node_modules", "assets", "scripts" };
        private static readonly string[] AppFiles = new string[]
        {
            "AmnaLabLMS.exe", "Uninstall.exe", "VERSION", "package.json", "package-lock.json", "README.md", "install.log", "LICENSE-node.txt"
        };

        internal static string Version
        {
            get
            {
                Version v = Assembly.GetExecutingAssembly().GetName().Version;
                return v.Major + "." + v.Minor + "." + v.Build;
            }
        }

        [STAThread]
        private static int Main(string[] args)
        {
            Options o = ParseArgs(args);
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            if (Environment.OSVersion.Version.Major < 10 || !Environment.Is64BitOperatingSystem)
            {
                Tell(o, "Amna Lab LMS needs 64-bit Windows 10 or Windows 11.", true);
                return 2;
            }

            bool created;
            using (Mutex mutex = new Mutex(true, "AmnaLabLMS.Setup", out created))
            {
                if (!created && o.CleanupDir != null)
                {
                    // The uninstaller that started this temporary copy is still exiting; wait for it.
                    try { created = mutex.WaitOne(15000); }
                    catch (AbandonedMutexException) { created = true; }
                }
                if (!created)
                {
                    Tell(o, "The Amna Lab LMS setup is already running.", true);
                    return 3;
                }
                if (o.CleanupDir != null) return RunCleanup(o);
                if (o.Uninstall) return RunUninstall(o);
                return RunInstall(o);
            }
        }

        private static Options ParseArgs(string[] args)
        {
            Options o = new Options();
            for (int i = 0; i < args.Length; i++)
            {
                string a = args[i];
                string low = a.ToLowerInvariant();
                if (low == "/s" || low == "/silent" || low == "/verysilent" || low == "-s") o.Silent = true;
                else if (low == "/uninstall") o.Uninstall = true;
                else if (low == "/purge") o.Purge = true;
                else if (low == "/nodesktop") o.NoDesktop = true;
                else if (low == "/nostartup") o.NoStartup = true;
                else if (low == "/nolaunch") o.NoLaunch = true;
                else if (low == "/autoclose") o.AutoClose = true;
                else if (low.StartsWith("/dir=")) o.Dir = a.Substring(5).Trim('"');
                else if (low == "/_cleanup" && i + 1 < args.Length) o.CleanupDir = args[++i];
            }
            return o;
        }

        private static void Tell(Options o, string message, bool error)
        {
            if (o.Silent)
            {
                try
                {
                    File.AppendAllText(Path.Combine(Path.GetTempPath(), "AmnaLab-Setup.log"), DateTime.Now.ToString("s") + " " + message + "\r\n");
                }
                catch
                {
                    // Nowhere to write; the exit code still tells the caller.
                }
                return;
            }
            MessageBox.Show(message, AppName, MessageBoxButtons.OK, error ? MessageBoxIcon.Error : MessageBoxIcon.Information);
        }

        // ------------------------------------------------------------------ install

        private static int RunInstall(Options o)
        {
            if (o.Silent)
            {
                InstallOutcome r = DoInstall(o, null);
                if (!r.Ok) Tell(o, "Installation failed: " + r.Error, true);
                return r.Ok ? 0 : 1;
            }
            SetupForm form = new SetupForm(o);
            Application.Run(form);
            return form.ExitCode;
        }

        internal static InstallOutcome DoInstall(Options o, Progress report)
        {
            InstallOutcome res = new InstallOutcome();
            StringBuilder log = new StringBuilder();
            string dir = null;
            try
            {
                dir = ResolveDir(o);
                res.Dir = dir;
                log.AppendLine(DateTime.Now.ToString("s") + " installing " + AppName + " " + Version + " to " + dir);
                res.Upgraded = Directory.Exists(Path.Combine(dir, "data")) || File.Exists(Path.Combine(dir, "VERSION"));

                Step(report, 4, res.Upgraded ? "Updating the existing installation..." : "Preparing...");
                Directory.CreateDirectory(dir);

                Step(report, 8, "Closing the running program...");
                StopRunning(dir);

                Step(report, 12, "Protecting your data before the update...");
                SnapshotDatabase(dir, log);

                Step(report, 16, "Removing the previous program files...");
                foreach (string d in AppDirs) DeleteDirWithRetry(Path.Combine(dir, d));

                Extract(dir, report, log);

                Step(report, 88, "Setting up backups and shortcuts...");
                res.NewPassphrase = EnsureConfig(dir, log);
                MakeShortcuts(dir, o, log);
                WriteUninstallEntry(dir);

                File.WriteAllText(Path.Combine(dir, "install.log"), log.ToString(), new UTF8Encoding(false));

                if (!o.NoLaunch)
                {
                    Step(report, 96, "Starting Amna Lab LMS...");
                    string exe = Path.Combine(dir, "AmnaLabLMS.exe");
                    ProcessStartInfo psi = new ProcessStartInfo(exe);
                    psi.WorkingDirectory = dir;
                    psi.UseShellExecute = false;
                    Process.Start(psi);
                }
                Step(report, 100, "Done");
                res.Ok = true;
            }
            catch (Exception ex)
            {
                res.Error = ex.Message;
                log.AppendLine("ERROR " + ex);
                try
                {
                    if (dir != null && Directory.Exists(dir)) File.WriteAllText(Path.Combine(dir, "install.log"), log.ToString(), new UTF8Encoding(false));
                }
                catch
                {
                    // Cannot even write the log; the message below is all we have.
                }
            }
            return res;
        }

        private static void Step(Progress report, int percent, string text)
        {
            if (report != null) report(percent, text);
        }

        private static string ResolveDir(Options o)
        {
            if (!string.IsNullOrEmpty(o.Dir)) return Path.GetFullPath(o.Dir).TrimEnd('\\');
            string existing = ExistingInstallDir();
            if (existing != null) return existing;
            string preferred = @"C:\AmnaLabLMS";
            try
            {
                Directory.CreateDirectory(preferred);
                string probe = Path.Combine(preferred, ".write-test");
                File.WriteAllText(probe, "x");
                File.Delete(probe);
                return preferred;
            }
            catch
            {
                return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "AmnaLabLMS");
            }
        }

        private static string ExistingInstallDir()
        {
            try
            {
                using (RegistryKey k = Registry.CurrentUser.OpenSubKey(RegPath))
                {
                    if (k == null) return null;
                    string loc = k.GetValue("InstallLocation") as string;
                    if (!string.IsNullOrEmpty(loc) && Directory.Exists(loc)) return loc.TrimEnd('\\');
                }
            }
            catch
            {
                // Registry unreadable: treat as a new install.
            }
            return null;
        }

        private static void StopRunning(string dir)
        {
            string prefix = dir.TrimEnd('\\') + "\\";
            // Launcher first, so it does not restart the server we are about to stop.
            foreach (string name in new string[] { "AmnaLabLMS", "node" })
            {
                foreach (Process p in Process.GetProcessesByName(name))
                {
                    try
                    {
                        string path = p.MainModule.FileName;
                        if (path.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                        {
                            p.Kill();
                            p.WaitForExit(8000);
                        }
                    }
                    catch
                    {
                        // Not ours, or already gone.
                    }
                }
            }
            Thread.Sleep(300);
        }

        // A copy of the live database next to the backups, so a bad update can always be rolled back.
        private static void SnapshotDatabase(string dir, StringBuilder log)
        {
            string db = Path.Combine(dir, "data", "lms.db");
            if (!File.Exists(db)) return;
            string target = Path.Combine(dir, "backups", "pre-update-" + DateTime.Now.ToString("yyyyMMdd-HHmmss"));
            Directory.CreateDirectory(target);
            foreach (string suffix in new string[] { "", "-wal" })
            {
                string src = db + suffix;
                if (File.Exists(src)) File.Copy(src, Path.Combine(target, "lms.db" + suffix), true);
            }
            log.AppendLine("database copied to " + target);
            // Keep only the three most recent snapshots.
            string[] all = Directory.GetDirectories(Path.Combine(dir, "backups"), "pre-update-*");
            Array.Sort(all, StringComparer.OrdinalIgnoreCase);
            for (int i = 0; i < all.Length - 3; i++) DeleteDirWithRetry(all[i]);
        }

        private static void DeleteDirWithRetry(string path)
        {
            for (int attempt = 0; attempt < 5; attempt++)
            {
                try
                {
                    if (Directory.Exists(path)) Directory.Delete(path, true);
                    return;
                }
                catch
                {
                    Thread.Sleep(400);
                }
            }
            if (Directory.Exists(path)) throw new IOException("Could not remove " + path + ". Close any program using it and try again.");
        }

        private static void Extract(string dir, Progress report, StringBuilder log)
        {
            Assembly asm = Assembly.GetExecutingAssembly();
            using (Stream s = asm.GetManifestResourceStream("payload.zip"))
            {
                if (s == null) throw new InvalidOperationException("This file does not contain the program files.");
                using (ZipArchive zip = new ZipArchive(s, ZipArchiveMode.Read))
                {
                    long total = 0;
                    foreach (ZipArchiveEntry e in zip.Entries) total += e.Length;
                    if (total == 0) total = 1;
                    long done = 0;
                    int files = 0;
                    string rootFull = Path.GetFullPath(dir).TrimEnd('\\') + "\\";
                    byte[] buffer = new byte[256 * 1024];
                    int lastPercent = -1;
                    foreach (ZipArchiveEntry e in zip.Entries)
                    {
                        string rel = e.FullName.Replace('/', '\\');
                        while (rel.StartsWith(".\\")) rel = rel.Substring(2);
                        rel = rel.TrimStart('\\');
                        if (rel.Length == 0) continue;
                        string target = Path.GetFullPath(Path.Combine(dir, rel));
                        if (!target.StartsWith(rootFull, StringComparison.OrdinalIgnoreCase))
                        {
                            throw new InvalidOperationException("The installer contains an unsafe path: " + e.FullName);
                        }
                        if (rel.EndsWith("\\"))
                        {
                            Directory.CreateDirectory(target);
                            continue;
                        }
                        Directory.CreateDirectory(Path.GetDirectoryName(target));
                        using (Stream src = e.Open())
                        using (FileStream dst = new FileStream(target, FileMode.Create, FileAccess.Write))
                        {
                            int n;
                            while ((n = src.Read(buffer, 0, buffer.Length)) > 0)
                            {
                                dst.Write(buffer, 0, n);
                                done += n;
                            }
                        }
                        files++;
                        int pct = 18 + (int)(68 * done / total);
                        if (pct != lastPercent)
                        {
                            lastPercent = pct;
                            Step(report, pct, "Copying program files...");
                        }
                    }
                    log.AppendLine("extracted " + files + " files");
                }
            }
        }

        // First install only: a random backup password, so nightly backups work without any manual setup.
        private static string EnsureConfig(string dir, StringBuilder log)
        {
            string data = Path.Combine(dir, "data");
            Directory.CreateDirectory(data);
            string cfg = Path.Combine(data, "config.json");
            if (File.Exists(cfg)) return null;
            string pass = NewPassphrase();
            string json = "{\r\n  \"backup\": { \"passphrase\": \"" + pass + "\", \"hour\": 2 },\r\n  \"publicBaseUrl\": \"http://127.0.0.1:8080\"\r\n}\r\n";
            File.WriteAllText(cfg, json, new UTF8Encoding(false)); // no byte-order mark: Node's JSON parser rejects it
            log.AppendLine("created data\\config.json with a generated backup password");
            return pass;
        }

        private static string NewPassphrase()
        {
            const string alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32 symbols: no 0/O/1/I confusion
            byte[] bytes = new byte[24];
            using (RandomNumberGenerator rng = RandomNumberGenerator.Create())
            {
                rng.GetBytes(bytes);
            }
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < bytes.Length; i++)
            {
                if (i > 0 && i % 4 == 0) sb.Append('-');
                sb.Append(alphabet[bytes[i] % 32]);
            }
            return sb.ToString();
        }

        // ------------------------------------------------------------------ shortcuts and registry

        private static string DesktopLink() { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), AppName + ".lnk"); }
        private static string StartupLink() { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Startup), AppName + ".lnk"); }
        private static string MenuDir() { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), AppName); }

        private static void MakeShortcuts(string dir, Options o, StringBuilder log)
        {
            string exe = Path.Combine(dir, "AmnaLabLMS.exe");
            string uninstall = Path.Combine(dir, "Uninstall.exe");
            try
            {
                if (!o.NoDesktop) MakeShortcut(DesktopLink(), exe, "", dir, AppName, exe);
                Directory.CreateDirectory(MenuDir());
                MakeShortcut(Path.Combine(MenuDir(), AppName + ".lnk"), exe, "", dir, AppName, exe);
                MakeShortcut(Path.Combine(MenuDir(), "Uninstall " + AppName + ".lnk"), uninstall, "/uninstall", dir, "Remove " + AppName, exe);
                if (!o.NoStartup) MakeShortcut(StartupLink(), exe, "/background", dir, AppName, exe);
                log.AppendLine("shortcuts created");
            }
            catch (Exception ex)
            {
                // The program works without shortcuts; do not fail the whole install for them.
                log.AppendLine("shortcut error: " + ex.Message);
            }
        }

        private static void MakeShortcut(string path, string target, string arguments, string workDir, string description, string icon)
        {
            Type t = Type.GetTypeFromProgID("WScript.Shell");
            object shell = Activator.CreateInstance(t);
            object lnk = t.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { path });
            Type lt = lnk.GetType();
            lt.InvokeMember("TargetPath", BindingFlags.SetProperty, null, lnk, new object[] { target });
            lt.InvokeMember("Arguments", BindingFlags.SetProperty, null, lnk, new object[] { arguments });
            lt.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, lnk, new object[] { workDir });
            lt.InvokeMember("Description", BindingFlags.SetProperty, null, lnk, new object[] { description });
            lt.InvokeMember("IconLocation", BindingFlags.SetProperty, null, lnk, new object[] { icon + ",0" });
            lt.InvokeMember("Save", BindingFlags.InvokeMethod, null, lnk, null);
        }

        private static void WriteUninstallEntry(string dir)
        {
            using (RegistryKey k = Registry.CurrentUser.CreateSubKey(RegPath))
            {
                k.SetValue("DisplayName", AppName);
                k.SetValue("DisplayVersion", Version);
                k.SetValue("Publisher", "Pro Health Digital LLC");
                k.SetValue("InstallLocation", dir);
                k.SetValue("DisplayIcon", Path.Combine(dir, "AmnaLabLMS.exe"));
                k.SetValue("UninstallString", "\"" + Path.Combine(dir, "Uninstall.exe") + "\" /uninstall");
                k.SetValue("NoModify", 1, RegistryValueKind.DWord);
                k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
            }
        }

        // ------------------------------------------------------------------ uninstall

        private static string UninstallDir(Options o)
        {
            if (!string.IsNullOrEmpty(o.Dir)) return Path.GetFullPath(o.Dir).TrimEnd('\\');
            string here = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
            if (File.Exists(Path.Combine(here, "AmnaLabLMS.exe"))) return here;
            return ExistingInstallDir();
        }

        private static int RunUninstall(Options o)
        {
            string dir = UninstallDir(o);
            if (dir == null || !Directory.Exists(dir))
            {
                Tell(o, "Amna Lab LMS is not installed for this user.", false);
                return 0;
            }
            bool purge = o.Purge;
            if (!o.Silent)
            {
                ConfirmForm confirm = new ConfirmForm(dir);
                if (confirm.ShowDialog() != DialogResult.OK) return 0;
                purge = confirm.Purge;
            }
            // This exe lives inside the folder being removed, so hand over to a temporary copy.
            string temp = Path.Combine(Path.GetTempPath(), "AmnaLab-Remove-" + Guid.NewGuid().ToString("N").Substring(0, 8) + ".exe");
            File.Copy(Assembly.GetExecutingAssembly().Location, temp, true);
            string args = "/_cleanup \"" + dir + "\"" + (purge ? " /purge" : "") + (o.Silent ? " /S" : "");
            ProcessStartInfo psi = new ProcessStartInfo(temp, args);
            psi.UseShellExecute = false;
            Process.Start(psi);
            return 0;
        }

        private static int RunCleanup(Options o)
        {
            string dir = o.CleanupDir;
            string self = Assembly.GetExecutingAssembly().Location;
            try
            {
                // Setup mutex is held by this process, so a second setup cannot start meanwhile.
                StopRunning(dir);
                foreach (string link in new string[] { DesktopLink(), StartupLink() })
                {
                    try { if (File.Exists(link)) File.Delete(link); } catch { }
                }
                try { if (Directory.Exists(MenuDir())) Directory.Delete(MenuDir(), true); } catch { }
                try { Registry.CurrentUser.DeleteSubKeyTree(RegPath, false); } catch { }

                foreach (string d in AppDirs) DeleteDirWithRetry(Path.Combine(dir, d));
                foreach (string f in AppFiles)
                {
                    string p = Path.Combine(dir, f);
                    for (int attempt = 0; attempt < 5; attempt++)
                    {
                        try { if (File.Exists(p)) File.Delete(p); break; } catch { Thread.Sleep(400); }
                    }
                }
                if (o.Purge)
                {
                    DeleteDirWithRetry(Path.Combine(dir, "data"));
                    DeleteDirWithRetry(Path.Combine(dir, "backups"));
                }
                try { Directory.Delete(dir, false); } catch { /* still holds data or backups */ }

                bool kept = Directory.Exists(dir);
                Tell(o, kept
                    ? "Amna Lab LMS was removed.\n\nYour lab data and backups were kept in:\n" + dir
                    : "Amna Lab LMS was removed from this PC.", false);
            }
            catch (Exception ex)
            {
                Tell(o, "Removal did not finish: " + ex.Message, true);
            }
            // Delete this temporary copy once it has exited.
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo("cmd.exe", "/c ping -n 4 127.0.0.1 >nul & del /f /q \"" + self + "\"");
                psi.CreateNoWindow = true;
                psi.UseShellExecute = false;
                Process.Start(psi);
            }
            catch
            {
                // Leaves one small file in %TEMP%.
            }
            return 0;
        }
    }

    // ---------------------------------------------------------------------- windows

    internal sealed class SetupForm : Form
    {
        private readonly Options options;
        private readonly Label status;
        private readonly ProgressBar bar;
        private readonly Panel done;
        private readonly Label doneText;
        private readonly TextBox pass;
        private readonly Label passHint;
        private readonly Button copy;
        private readonly Button close;
        private InstallOutcome outcome;

        public int ExitCode;

        public SetupForm(Options o)
        {
            options = o;
            Text = SetupProgram.AppName + " Setup";
            ClientSize = new Size(560, 330);
            StartPosition = FormStartPosition.CenterScreen;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            BackColor = Color.White;
            Font = new Font("Segoe UI", 9.5f);

            Panel band = new Panel();
            band.Dock = DockStyle.Top;
            band.Height = 74;
            band.BackColor = Color.FromArgb(31, 95, 174);
            Label title = new Label();
            title.Text = SetupProgram.AppName;
            title.ForeColor = Color.White;
            title.Font = new Font("Segoe UI", 18f, FontStyle.Bold);
            title.AutoSize = true;
            title.Location = new Point(22, 12);
            Label sub = new Label();
            sub.Text = "Laboratory management system  |  version " + SetupProgram.Version;
            sub.ForeColor = Color.FromArgb(220, 232, 247);
            sub.AutoSize = true;
            sub.Location = new Point(25, 47);
            band.Controls.Add(title);
            band.Controls.Add(sub);
            Controls.Add(band);

            status = new Label();
            status.Text = "Installing...";
            status.Location = new Point(24, 100);
            status.Size = new Size(510, 24);
            Controls.Add(status);

            bar = new ProgressBar();
            bar.Location = new Point(24, 132);
            bar.Size = new Size(510, 22);
            bar.Minimum = 0;
            bar.Maximum = 100;
            Controls.Add(bar);

            Label note = new Label();
            note.Text = "This takes about a minute. Nothing else needs to be installed first, and no internet is needed.";
            note.ForeColor = Color.FromArgb(90, 100, 115);
            note.Location = new Point(24, 170);
            note.Size = new Size(510, 40);
            Controls.Add(note);

            done = new Panel();
            done.Location = new Point(0, 90);
            done.Size = new Size(560, 240);
            done.Visible = false;
            doneText = new Label();
            doneText.Location = new Point(24, 6);
            doneText.Size = new Size(510, 88);
            done.Controls.Add(doneText);
            passHint = new Label();
            passHint.Text = "Backup password (write it down and keep it safe; it is needed to restore a backup on another PC):";
            passHint.Location = new Point(24, 100);
            passHint.Size = new Size(510, 40);
            done.Controls.Add(passHint);
            pass = new TextBox();
            pass.ReadOnly = true;
            pass.Font = new Font("Consolas", 12f, FontStyle.Bold);
            pass.Location = new Point(24, 142);
            pass.Size = new Size(380, 28);
            done.Controls.Add(pass);
            copy = new Button();
            copy.Text = "Copy";
            copy.Location = new Point(414, 140);
            copy.Size = new Size(120, 30);
            copy.Click += delegate
            {
                try { Clipboard.SetText(pass.Text); } catch { }
            };
            done.Controls.Add(copy);
            close = new Button();
            close.Text = "Close";
            close.Location = new Point(414, 190);
            close.Size = new Size(120, 34);
            close.Click += delegate { Close(); };
            done.Controls.Add(close);
            Controls.Add(done);

            Shown += delegate
            {
                Thread worker = new Thread(Work);
                worker.IsBackground = true;
                worker.Start();
            };
            FormClosing += delegate(object s, FormClosingEventArgs e)
            {
                if (outcome == null) e.Cancel = true; // not while files are being copied
            };
        }

        private void Work()
        {
            InstallOutcome r = SetupProgram.DoInstall(options, delegate(int percent, string text)
            {
                BeginInvoke(new MethodInvoker(delegate
                {
                    bar.Value = Math.Max(0, Math.Min(100, percent));
                    status.Text = text;
                }));
            });
            BeginInvoke(new MethodInvoker(delegate { Finish(r); }));
        }

        private void Finish(InstallOutcome r)
        {
            outcome = r;
            foreach (Control c in new Control[] { status, bar })
            {
                c.Visible = false;
            }
            foreach (Control c in Controls)
            {
                Label l = c as Label;
                if (l != null) l.Visible = false;
            }
            done.Visible = true;
            if (!r.Ok)
            {
                ExitCode = 1;
                doneText.ForeColor = Color.FromArgb(180, 35, 24);
                doneText.Text = "The installation did not finish.\n\n" + r.Error;
                passHint.Visible = false;
                pass.Visible = false;
                copy.Visible = false;
                return;
            }
            doneText.ForeColor = Color.FromArgb(20, 110, 60);
            doneText.Text = (r.Upgraded ? "Amna Lab LMS was updated. Your lab data was kept." : "Amna Lab LMS is installed.") +
                "\n\nIt is starting now and will open in your browser. A shortcut is on the desktop.\nInstalled in: " + r.Dir;
            if (r.NewPassphrase != null)
            {
                pass.Text = r.NewPassphrase;
            }
            else
            {
                passHint.Visible = false;
                pass.Visible = false;
                copy.Visible = false;
            }
            if (options.AutoClose)
            {
                System.Windows.Forms.Timer t = new System.Windows.Forms.Timer();
                t.Interval = 4000;
                t.Tick += delegate { Close(); };
                t.Start();
            }
        }
    }

    internal sealed class ConfirmForm : Form
    {
        private readonly CheckBox purge;

        public bool Purge
        {
            get { return purge.Checked; }
        }

        public ConfirmForm(string dir)
        {
            Text = "Remove " + SetupProgram.AppName;
            ClientSize = new Size(520, 210);
            StartPosition = FormStartPosition.CenterScreen;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            Font = new Font("Segoe UI", 9.5f);

            Label text = new Label();
            text.Text = "Remove Amna Lab LMS from this PC?\n\nYour lab data (patients, results, reports) and backups stay in:\n" + dir;
            text.Location = new Point(20, 16);
            text.Size = new Size(480, 90);
            Controls.Add(text);

            purge = new CheckBox();
            purge.Text = "Also delete ALL lab data and backups (cannot be undone)";
            purge.ForeColor = Color.FromArgb(180, 35, 24);
            purge.Location = new Point(22, 112);
            purge.Size = new Size(470, 24);
            Controls.Add(purge);

            Button ok = new Button();
            ok.Text = "Remove";
            ok.DialogResult = DialogResult.OK;
            ok.Location = new Point(290, 160);
            ok.Size = new Size(100, 32);
            Controls.Add(ok);
            Button cancel = new Button();
            cancel.Text = "Cancel";
            cancel.DialogResult = DialogResult.Cancel;
            cancel.Location = new Point(400, 160);
            cancel.Size = new Size(100, 32);
            Controls.Add(cancel);
            AcceptButton = cancel; // Enter keeps the data safe
            CancelButton = cancel;
        }
    }
}
