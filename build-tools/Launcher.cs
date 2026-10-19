using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Windows.Forms;

// 原生桌面启动器：不依赖 VBS，检查服务就绪，记录错误并支持重复打开。
class Launcher {
    static readonly object LogLock = new object();
    static string logPath;
    static bool quiet;
    static string baseUrl;

    static void Log(string text) {
        try { lock (LogLock) File.AppendAllText(logPath, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss ") + text + Environment.NewLine, Encoding.UTF8); } catch { }
    }
    static string Health() {
        try {
            var request = (HttpWebRequest)WebRequest.Create(baseUrl + "/health");
            request.Proxy = null;
            request.Timeout = 800;
            request.ReadWriteTimeout = 800;
            using (var response = request.GetResponse())
            using (var reader = new StreamReader(response.GetResponseStream())) {
                return reader.ReadToEnd().Contains("\"app\":\"dy-lead-app\"") ? "ready" : "other";
            }
        } catch (WebException ex) {
            if (ex.Response != null) {
                ex.Response.Close();
                // 旧版没有 /health，但可通过页面识别，避免重复启动造成无响应。
                try {
                    var legacy = (HttpWebRequest)WebRequest.Create(baseUrl + "/");
                    legacy.Proxy = null; legacy.Timeout = 800; legacy.ReadWriteTimeout = 800;
                    using (var response = legacy.GetResponse())
                    using (var reader = new StreamReader(response.GetResponseStream())) {
                        var html = reader.ReadToEnd();
                        if (html.Contains("<title>抖音获客软件</title>") && html.Contains("id=\"login-layer\"")) return "ready";
                    }
                } catch { }
                return "other";
            }
            return "offline";
        }
        catch { return "offline"; }
    }
    static void Open() {
        if (quiet) return;
        try { Process.Start(new ProcessStartInfo(baseUrl) { UseShellExecute = true }); }
        catch (Exception ex) {
            Log("默认浏览器打开失败：" + ex.Message);
            foreach (var candidate in new [] {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"Google\Chrome\Application\chrome.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), @"Microsoft\Edge\Application\msedge.exe")
            }) {
                if (File.Exists(candidate)) { Process.Start(candidate, baseUrl); return; }
            }
            MessageBox.Show("服务已经启动，请在浏览器打开：" + baseUrl, "抖音获客软件");
        }
    }
    static int Fail(string message) {
        Log(message);
        if (!quiet) MessageBox.Show(message + "\n\n启动日志：" + logPath, "抖音获客软件启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
        return 1;
    }
    [STAThread]
    static int Main() {
        quiet = Environment.GetEnvironmentVariable("DY_LEAD_NO_OPEN") == "1";
        var dir = AppDomain.CurrentDomain.BaseDirectory;
        var logDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Huamao", "DouyinLead", "logs");
        Directory.CreateDirectory(logDir);
        logPath = Path.Combine(logDir, "startup.log");
        int port;
        if (!Int32.TryParse(Environment.GetEnvironmentVariable("DY_LEAD_PORT") ?? "17888", out port) || port < 1 || port > 65535) return Fail("端口配置无效");
        baseUrl = "http://127.0.0.1:" + port;
        using (var mutex = new Mutex(false, @"Local\HuamaoDouyinLeadStartup-" + port)) {
            bool acquired = false;
            try {
                try { acquired = mutex.WaitOne(25000); } catch (AbandonedMutexException) { acquired = true; }
                if (!acquired) return Fail("另一个启动进程仍在初始化，请稍后再打开");
                var health = Health();
                if (health == "ready") { Open(); return 0; }
                if (health == "other") return Fail("端口 " + port + " 已被其他程序或旧版本占用，请退出旧版后重试");
                var node = Path.Combine(dir, "node.exe");
                var server = Path.Combine(dir, "server.js");
                if (!File.Exists(node) || !File.Exists(server)) return Fail("程序文件不完整，请重新安装完整安装包");
                var info = new ProcessStartInfo(node, "\"" + server + "\"") {
                    WorkingDirectory = dir, UseShellExecute = false, CreateNoWindow = true,
                    RedirectStandardOutput = true, RedirectStandardError = true,
                    StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
                };
                info.EnvironmentVariables["DY_LEAD_NO_OPEN"] = "1";
                var process = new Process { StartInfo = info };
                process.OutputDataReceived += (sender, e) => { if (e.Data != null) Log(e.Data); };
                process.ErrorDataReceived += (sender, e) => { if (e.Data != null) Log(e.Data); };
                Log("启动程序：" + dir);
                process.Start();
                process.BeginOutputReadLine(); process.BeginErrorReadLine();
                var until = DateTime.UtcNow.AddSeconds(20);
                while (DateTime.UtcNow < until && !process.HasExited) {
                    if (Health() == "ready") {
                        mutex.ReleaseMutex(); acquired = false;
                        Open();
                        process.WaitForExit();
                        return process.ExitCode;
                    }
                    Thread.Sleep(250);
                }
                if (!process.HasExited) process.Kill();
                process.WaitForExit();
                return Fail("服务启动失败，请查看启动日志中的具体原因");
            } catch (Exception ex) { return Fail(ex.Message); }
            finally { if (acquired) mutex.ReleaseMutex(); }
        }
    }
}
