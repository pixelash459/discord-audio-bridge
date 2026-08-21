using System.Drawing.Drawing2D;
using System.Text;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace BridgeApp;

/// <summary>
/// The desktop window: a WebView2 showing the same control panel the bot serves over loopback,
/// plus a tray icon so it can live in the background while music plays.
/// </summary>
internal sealed class MainForm : Form
{
    private readonly WebView2 view = new() { Dock = DockStyle.Fill };
    private readonly NotifyIcon tray = new();
    private readonly BotProcess bot;
    private readonly CancellationTokenSource cancel = new();
    private readonly StringBuilder startupLog = new();

    private bool reallyExiting;
    private Icon? trayIcon;

    public MainForm(BotProcess bot)
    {
        this.bot = bot;

        Text = "Discord Audio Bridge";
        MinimumSize = new Size(720, 560);
        ClientSize = new Size(1080, 780);
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(15, 17, 21);

        trayIcon = BuildIcon();
        Icon = trayIcon;

        Controls.Add(view);
        SetUpTray();

        bot.Output += line =>
        {
            lock (startupLog)
            {
                startupLog.AppendLine(line);
                if (startupLog.Length > 8000) startupLog.Remove(0, startupLog.Length - 8000);
            }
        };

        Load += async (_, _) => await StartAsync();
        FormClosing += OnFormClosing;
    }

    private async Task StartAsync()
    {
        try
        {
            await view.EnsureCoreWebView2Async();
        }
        catch (Exception ex)
        {
            ShowFatal(
                "WebView2 is not available",
                "This window needs the Microsoft Edge WebView2 Runtime, which ships with Windows 11 " +
                "and current Windows 10.<br><br>Install it from " +
                "<a href=\"https://developer.microsoft.com/microsoft-edge/webview2/\">" +
                "developer.microsoft.com/microsoft-edge/webview2</a>, or just run <code>npm start</code> " +
                "and open the printed URL in any browser.",
                ex.Message);
            return;
        }

        var settings = view.CoreWebView2.Settings;
        settings.AreDefaultContextMenusEnabled = false;
        settings.IsStatusBarEnabled = false;
        settings.AreBrowserAcceleratorKeysEnabled = false;

        // Links to Discord's site and similar should open in the real browser, not replace the panel.
        view.CoreWebView2.NewWindowRequested += (_, e) =>
        {
            e.Handled = true;
            OpenExternally(e.Uri);
        };

        ShowSplash("Starting the bot…");

        try
        {
            var progress = new Progress<string>(message => ShowSplash(message));
            var endpoint = await bot.EnsureRunningAsync(progress, cancel.Token);
            view.CoreWebView2.Navigate(endpoint.Url);
        }
        catch (OperationCanceledException)
        {
            // Window closed while starting; nothing to report.
        }
        catch (Exception ex)
        {
            string tail;
            lock (startupLog) tail = startupLog.ToString();
            ShowFatal("The bot did not start", WebUtilityEncode(ex.Message), tail);
        }
    }

    private void SetUpTray()
    {
        var menu = new ContextMenuStrip();
        menu.Items.Add("Open control panel", null, (_, _) => RestoreWindow());
        menu.Items.Add("Open in browser", null, (_, _) => OpenInBrowser());
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Quit", null, (_, _) => ExitApplication());

        tray.Icon = trayIcon;
        tray.Text = "Discord Audio Bridge";
        tray.Visible = true;
        tray.ContextMenuStrip = menu;
        tray.DoubleClick += (_, _) => RestoreWindow();
    }

    private void RestoreWindow()
    {
        Show();
        WindowState = FormWindowState.Normal;
        Activate();
    }

    private void OpenInBrowser()
    {
        var uri = view.CoreWebView2?.Source;
        if (!string.IsNullOrEmpty(uri) && uri.StartsWith("http", StringComparison.OrdinalIgnoreCase))
        {
            OpenExternally(uri);
        }
    }

    private static void OpenExternally(string uri)
    {
        try
        {
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(uri)
            {
                UseShellExecute = true,
            });
        }
        catch (Exception)
        {
            /* no browser association; nothing useful to do */
        }
    }

    private void OnFormClosing(object? sender, FormClosingEventArgs e)
    {
        // Closing the window hides to the tray rather than stopping the music. Quitting is an
        // explicit choice from the tray menu or a real shutdown.
        if (!reallyExiting && e.CloseReason == CloseReason.UserClosing)
        {
            e.Cancel = true;
            Hide();
            tray.ShowBalloonTip(
                2000,
                "Still running",
                "The bridge is in the notification area. Quit from there to stop it.",
                ToolTipIcon.Info);
            return;
        }

        cancel.Cancel();
        tray.Visible = false;
    }

    private void ExitApplication()
    {
        reallyExiting = true;
        Close();
        Application.Exit();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            cancel.Dispose();
            tray.Dispose();
            trayIcon?.Dispose();
            view.Dispose();
        }

        base.Dispose(disposing);
    }

    /* ── in-window pages, used before the real panel is reachable ─────────── */

    private void ShowSplash(string message) => view.CoreWebView2?.NavigateToString(Page($"""
        <div class="spinner"></div>
        <h1>Discord Audio Bridge</h1>
        <p>{WebUtilityEncode(message)}</p>
        """));

    private void ShowFatal(string title, string htmlBody, string? detail) =>
        view.CoreWebView2?.NavigateToString(Page($"""
        <h1>{WebUtilityEncode(title)}</h1>
        <p>{htmlBody}</p>
        {(string.IsNullOrWhiteSpace(detail) ? "" : $"<pre>{WebUtilityEncode(detail)}</pre>")}
        """));

    private static string WebUtilityEncode(string value) =>
        System.Net.WebUtility.HtmlEncode(value);

    private static string Page(string body) => $$"""
        <!doctype html><meta charset="utf-8">
        <style>
          :root { color-scheme: dark; }
          body {
            margin: 0; min-height: 100vh; display: grid; place-content: center; justify-items: center;
            gap: 10px; padding: 40px; text-align: center;
            background: #0f1115; color: #e6e8ee;
            font: 14px/1.6 system-ui, "Segoe UI", sans-serif;
          }
          h1 { font-size: 17px; font-weight: 600; margin: 6px 0 0; }
          p { margin: 0; color: #9aa2b1; max-width: 46ch; }
          a { color: #5865f2; }
          code { background: #0b0d11; padding: 1px 5px; border-radius: 4px; font-size: .92em; }
          pre {
            background: #0b0d11; border: 1px solid #262b36; border-radius: 8px; padding: 12px;
            font-size: 11px; line-height: 1.5; text-align: left; max-width: 78ch; max-height: 320px;
            overflow: auto; white-space: pre-wrap; color: #9aa2b1; margin-top: 8px;
          }
          .spinner {
            width: 26px; height: 26px; border: 2.5px solid #333a48; border-top-color: #5865f2;
            border-radius: 50%; animation: spin .8s linear infinite;
          }
          @keyframes spin { to { transform: rotate(360deg); } }
        </style>
        {{body}}
        """;

    /// <summary>Draws the tray/window icon at runtime so the repo carries no binary assets.</summary>
    private static Icon BuildIcon()
    {
        using var bitmap = new Bitmap(32, 32);
        using (var g = Graphics.FromImage(bitmap))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            using var background = new SolidBrush(Color.FromArgb(88, 101, 242));
            g.FillEllipse(background, 1, 1, 30, 30);

            // A simple headphone glyph: a band across the top and two ear cups.
            using var stroke = new Pen(Color.White, 3f) { StartCap = LineCap.Round, EndCap = LineCap.Round };
            g.DrawArc(stroke, 8, 9, 16, 16, 180, 180);
            using var cups = new SolidBrush(Color.White);
            g.FillRectangle(cups, 7, 16, 4, 8);
            g.FillRectangle(cups, 21, 16, 4, 8);
        }

        var handle = bitmap.GetHicon();
        try
        {
            // Clone so the icon survives DestroyIcon, which must run to avoid leaking the handle.
            using var temporary = Icon.FromHandle(handle);
            return (Icon)temporary.Clone();
        }
        finally
        {
            _ = NativeMethods.DestroyIcon(handle);
        }
    }
}

internal static class NativeMethods
{
    [System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
    [System.Runtime.InteropServices.DefaultDllImportSearchPaths(
        System.Runtime.InteropServices.DllImportSearchPath.System32)]
    internal static extern bool DestroyIcon(IntPtr handle);
}
