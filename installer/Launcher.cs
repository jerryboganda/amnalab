// Amna Lab LMS launcher: starts the bundled server hidden, keeps a tray icon, restarts the server if it stops.
// Compiled with the C# 5 compiler that ships with Windows (no SDK needed): see installer/build.mjs.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace AmnaLab
{
    internal static class LauncherProgram
    {
        [STAThread]
        private static int Main(string[] args)
        {
            string root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
            bool background = false;
            foreach (string a in args)
            {
                if (string.Equals(a, "/background", StringComparison.OrdinalIgnoreCase)) background = true;
            }
            string mutexName = "AmnaLabLMS.Launcher." + root.ToLowerInvariant().Replace('\\', '_').Replace(':', '_');
            bool created;
            using (Mutex mutex = new Mutex(true, mutexName, out created))
            {
                if (!created)
                {
                    // Already running: just bring the program up in the browser.
                    if (!background) LauncherContext.OpenBrowser();
                    return 0;
                }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new LauncherContext(root, background));
            }
            return 0;
        }
    }

    internal sealed class LauncherContext : ApplicationContext
    {
        private const string Title = "Amna Lab LMS";
        private readonly string root;
        private readonly string dataDir;
        private readonly string node;
        private readonly string script;
        private readonly NotifyIcon tray;
        private readonly System.Windows.Forms.Timer watch;
        private readonly Control ui;
        private readonly Queue<DateTime> crashes = new Queue<DateTime>();
        private readonly object logLock = new object();
        private static readonly int Port = ReadPort();
        private Process proc;
        private StreamWriter log;
        private bool stopping;
        private bool gaveUp;

        private static int ReadPort()
        {
            int p;
            return int.TryParse(Environment.GetEnvironmentVariable("LMS_PORT"), out p) && p > 0 && p < 65536 ? p : 8080;
        }

        private static string Url
        {
            get { return "http://127.0.0.1:" + Port; }
        }

        public static void OpenBrowser()
        {
            try
            {
                Process.Start(new ProcessStartInfo(Url) { UseShellExecute = true });
            }
            catch
            {
                // No default browser registered: nothing more we can do silently.
            }
        }

        public LauncherContext(string rootDir, bool background)
        {
            root = rootDir;
            dataDir = Path.Combine(root, "data");
            node = Path.Combine(root, "runtime", "node.exe");
            script = Path.Combine(root, "dist", "server", "index.js");
            ui = new Control();
            IntPtr handle = ui.Handle; // creates the window handle so BeginInvoke works from worker threads
            Directory.CreateDirectory(dataDir);

            tray = new NotifyIcon();
            tray.Icon = MakeIcon();
            tray.Text = Title;
            tray.Visible = true;
            ContextMenuStrip menu = new ContextMenuStrip();
            menu.Items.Add("Open Amna Lab LMS", null, delegate { OpenBrowser(); });
            menu.Items.Add("Open backups folder", null, delegate { OpenFolder(Path.Combine(root, "backups")); });
            menu.Items.Add("Open data folder", null, delegate { OpenFolder(dataDir); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Restart server", null, delegate { RestartServer(); });
            menu.Items.Add("Stop LMS and exit", null, delegate { AskStop(); });
            tray.ContextMenuStrip = menu;
            tray.DoubleClick += delegate { OpenBrowser(); };

            if (!File.Exists(node) || !File.Exists(script))
            {
                MessageBox.Show("The program files are incomplete. Run the Amna Lab LMS setup again.\n\n" + root, Title, MessageBoxButtons.OK, MessageBoxIcon.Error);
                ShutDown();
                return;
            }

            if (!ServerUp()) StartServer();

            watch = new System.Windows.Forms.Timer();
            watch.Interval = 5000;
            watch.Tick += delegate { Watchdog(); };
            watch.Start();

            ThreadPool.QueueUserWorkItem(delegate { WaitUntilReady(background); });
        }

        private void WaitUntilReady(bool background)
        {
            bool up = false;
            for (int i = 0; i < 120 && !up && !stopping; i++)
            {
                up = ServerUp();
                if (up) break;
                Process p = proc;
                if (p != null && p.HasExited) break;
                Thread.Sleep(250);
            }
            ui.BeginInvoke(new MethodInvoker(delegate
            {
                if (up)
                {
                    tray.Text = Title + " - running";
                    if (!background) OpenBrowser();
                }
                else if (!stopping)
                {
                    ReportFailure();
                }
            }));
        }

        private static bool ServerUp()
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(Url + "/api/health");
                req.Timeout = 1500;
                req.Proxy = null;
                using (WebResponse resp = req.GetResponse())
                using (StreamReader sr = new StreamReader(resp.GetResponseStream()))
                {
                    return sr.ReadToEnd().Contains("\"status\":\"ok\"");
                }
            }
            catch
            {
                return false;
            }
        }

        private void StartServer()
        {
            try
            {
                string logFile = Path.Combine(dataDir, "server.log");
                lock (logLock)
                {
                    // Release the current log first: an open file cannot be renamed.
                    if (log != null)
                    {
                        log.Dispose();
                        log = null;
                    }
                }
                if (File.Exists(logFile))
                {
                    string prev = Path.Combine(dataDir, "server.prev.log");
                    try
                    {
                        if (File.Exists(prev)) File.Delete(prev);
                        File.Move(logFile, prev);
                    }
                    catch
                    {
                        // Keep going with the old log if it is locked.
                    }
                }
                lock (logLock)
                {
                    log = new StreamWriter(logFile, false, new UTF8Encoding(false));
                    log.AutoFlush = true;
                    log.WriteLine("[" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "] starting server");
                }

                ProcessStartInfo psi = new ProcessStartInfo(node, "\"" + script + "\"");
                psi.WorkingDirectory = root;
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                Process p = new Process();
                p.StartInfo = psi;
                p.OutputDataReceived += delegate(object s, DataReceivedEventArgs e) { Append(e.Data); };
                p.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e) { Append(e.Data); };
                p.Start();
                p.BeginOutputReadLine();
                p.BeginErrorReadLine();
                proc = p;
            }
            catch (Exception ex)
            {
                Append("could not start the server: " + ex.Message);
            }
        }

        private void Append(string line)
        {
            if (line == null) return;
            lock (logLock)
            {
                if (log != null)
                {
                    try { log.WriteLine(line); } catch { }
                }
            }
        }

        private void KillServer()
        {
            Process p = proc;
            proc = null;
            try
            {
                if (p != null && !p.HasExited)
                {
                    p.Kill();
                    p.WaitForExit(5000);
                }
            }
            catch
            {
                // Already gone.
            }
        }

        private void RestartServer()
        {
            gaveUp = false;
            crashes.Clear();
            KillServer();
            StartServer();
            ThreadPool.QueueUserWorkItem(delegate { WaitUntilReady(true); });
        }

        private void Watchdog()
        {
            if (stopping || gaveUp) return;
            Process p = proc;
            if (p != null && !p.HasExited) return;
            if (ServerUp()) return; // someone else's copy is serving; leave it alone
            DateTime now = DateTime.UtcNow;
            crashes.Enqueue(now);
            while (crashes.Count > 0 && (now - crashes.Peek()).TotalMinutes > 2) crashes.Dequeue();
            if (crashes.Count >= 5)
            {
                gaveUp = true;
                tray.Text = Title + " - stopped";
                ReportFailure();
                return;
            }
            tray.ShowBalloonTip(4000, Title, "The server stopped and is being restarted.", ToolTipIcon.Warning);
            StartServer();
        }

        private void ReportFailure()
        {
            string tail = LastLogLines(12);
            string portHint = tail.IndexOf("already in use", StringComparison.OrdinalIgnoreCase) >= 0
                ? "\n\nAnother program is using port " + Port + ". Close it, or close the other copy of Amna Lab LMS, then choose Restart server from the tray icon."
                : "\n\nChoose Restart server from the tray icon to try again.";
            MessageBox.Show("Amna Lab LMS could not start.\n\n" + tail + portHint, Title, MessageBoxButtons.OK, MessageBoxIcon.Error);
        }

        private string LastLogLines(int count)
        {
            try
            {
                string file = Path.Combine(dataDir, "server.log");
                lock (logLock)
                {
                    if (log != null) log.Flush();
                }
                using (FileStream fs = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                using (StreamReader sr = new StreamReader(fs))
                {
                    List<string> lines = new List<string>();
                    string l;
                    while ((l = sr.ReadLine()) != null) lines.Add(l);
                    int from = Math.Max(0, lines.Count - count);
                    return string.Join("\n", lines.GetRange(from, lines.Count - from).ToArray());
                }
            }
            catch
            {
                return "(no log available)";
            }
        }

        private void AskStop()
        {
            DialogResult r = MessageBox.Show(
                "Stop Amna Lab LMS?\n\nStaff cannot use the system until it is started again from the desktop shortcut.",
                Title, MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2);
            if (r == DialogResult.Yes) ShutDown();
        }

        private void ShutDown()
        {
            stopping = true;
            if (watch != null) watch.Stop();
            KillServer();
            tray.Visible = false;
            ExitThread();
        }

        private static void OpenFolder(string path)
        {
            try
            {
                Directory.CreateDirectory(path);
                Process.Start("explorer.exe", "\"" + path + "\"");
            }
            catch
            {
                // Explorer not available.
            }
        }

        private static Icon MakeIcon()
        {
            using (Bitmap bmp = new Bitmap(32, 32))
            using (Graphics g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
                g.Clear(Color.Transparent);
                using (Brush blue = new SolidBrush(Color.FromArgb(31, 95, 174)))
                {
                    g.FillEllipse(blue, 1, 1, 30, 30);
                }
                using (Font f = new Font("Segoe UI", 17, FontStyle.Bold, GraphicsUnit.Pixel))
                using (StringFormat sf = new StringFormat())
                {
                    sf.Alignment = StringAlignment.Center;
                    sf.LineAlignment = StringAlignment.Center;
                    g.DrawString("A", f, Brushes.White, new RectangleF(0, 1, 32, 32), sf);
                }
                return Icon.FromHandle(bmp.GetHicon());
            }
        }
    }
}
