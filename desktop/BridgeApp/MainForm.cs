using System.Drawing.Drawing2D;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace BridgeApp;

/// <summary>
/// The desktop window: a WebView2 showing the same control panel the bot serves over loopback,
/// plus a tray icon so it can live in the background while music plays.
///
/// The tray half is not decoration. This application spends most of its life hidden, so the icon
/// has to say what the bridge is doing, the menu has to offer the two actions people actually take,
/// and the same two actions need global hotkeys - otherwise muting means finding a hidden window.
/// </summary>
internal sealed class MainForm : Form
{
    private readonly WebView2 view = new() { Dock = DockStyle.Fill };
    private readonly NotifyIcon tray = new();
    private readonly BotProcess bot;
    private readonly CancellationTokenSource cancel = new();
    private readonly StringBuilder startupLog = new();
    private readonly Settings settings = Settings.Load();

    private ToolStripMenuItem muteItem = null!;
    private ToolStripMenuItem stopItem = null!;
    private ToolStripMenuItem autostartItem = null!;

    private BridgeClient? client;
    private ControlEndpoint? endpoint;
    private System.Windows.Forms.Timer? poll;
    private BridgeState state = BridgeState.Offline;

    private bool reallyExiting;
    private bool hotkeysRegistered;
    private bool webViewInitialized;
    private bool connecting;
    private bool polling;
    private Icon? trayIcon;
    private string iconKey = string.Empty;

    public MainForm(BotProcess bot, bool startMinimized = false)
    {
        this.bot = bot;

        Text = "Discord Audio Bridge";
        MinimumSize = new Size(720, 560);
        ClientSize = new Size(1080, 780);
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(15, 17, 21);

        settings.Apply(this);
        if (startMinimized)
        {
            WindowState = FormWindowState.Minimized;
            ShowInTaskbar = false;
            Shown += (_, _) => Hide();
        }

        trayIcon = BuildIcon(StatusColour.Idle);
        Icon = trayIcon;

        Controls.Add(view);
        SetUpTray();

        bot.Output += line =>
        {
            lock (startupLog)
            {
                startupLog.AppendLine(RedactStartupLine(line));
                if (startupLog.Length > 8000) startupLog.Remove(0, startupLog.Length - 8000);
            }
        };

        Load += async (_, _) => await StartAsync();
        FormClosing += OnFormClosing;
        Resize += (_, _) =>
        {
            if (WindowState != FormWindowState.Minimized) settings.Capture(this);
        };
    }

    /// <summary>
    /// Dark chrome and hotkeys both need a real window handle, so they are applied here rather
    /// than in the constructor. OnHandleCreated also runs again if the handle is ever recreated.
    /// </summary>
    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        Native.ApplyModernChrome(Handle);
        RegisterHotkeys();
    }

    private void RegisterHotkeys()
    {
        if (hotkeysRegistered) return;
        const uint modifiers = (uint)(Native.HotkeyModifiers.Control | Native.HotkeyModifiers.Alt | Native.HotkeyModifiers.NoRepeat);

        // Ctrl+Alt+M / S / B. A failure here is almost always another application owning the
        // combination, which is a reason to carry on quietly rather than to complain.
        var mute = Native.RegisterHotKey(Handle, (int)Native.Hotkey.ToggleMute, modifiers, (uint)Keys.M);
        var stop = Native.RegisterHotKey(Handle, (int)Native.Hotkey.Stop, modifiers, (uint)Keys.S);
        var show = Native.RegisterHotKey(Handle, (int)Native.Hotkey.ShowWindow, modifiers, (uint)Keys.B);
        hotkeysRegistered = true;

        AppLog.Info("registered global hotkeys", new { mute, stop, show });
        if (!mute || !stop) AppLog.Info("some hotkeys were already taken by another application");
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == Native.WmHotkey)
        {
            switch ((Native.Hotkey)m.WParam.ToInt32())
            {
                case Native.Hotkey.ToggleMute:
                    _ = ToggleMuteAsync();
                    break;
                case Native.Hotkey.Stop:
                    _ = StopStreamAsync();
                    break;
                case Native.Hotkey.ShowWindow:
                    RestoreWindow();
                    break;
            }
        }

        base.WndProc(ref m);
    }

    private async Task StartAsync()
    {
        if (!webViewInitialized)
        {
            AppLog.Info("initializing desktop web view");
            try
            {
                await view.EnsureCoreWebView2Async();
            }
            catch (Exception ex)
            {
                AppLog.Error("WebView2 initialization failed", ex);
                ShowFatal(
                    "WebView2 is not available",
                    "This window needs the Microsoft Edge WebView2 Runtime, which ships with Windows 11 " +
                    "and current Windows 10.<br><br>Install it from " +
                    "<a href=\"https://developer.microsoft.com/microsoft-edge/webview2/\">" +
                    "developer.microsoft.com/microsoft-edge/webview2</a>, or just run <code>npm start</code> " +
                    "and open the printed URL in any browser.",
                    ex.Message,
                    retry: false);
                return;
            }

            var settings2 = view.CoreWebView2.Settings;
            settings2.AreDefaultContextMenusEnabled = false;
            settings2.IsStatusBarEnabled = false;
            settings2.AreBrowserAcceleratorKeysEnabled = false;

        // Links to Discord's site and similar should open in the real browser, not replace the panel.
            view.CoreWebView2.NewWindowRequested += (_, e) =>
            {
                e.Handled = true;
                OpenExternally(e.Uri);
            };

        // The only message the built-in pages send is a retry request from the failure screen.
            view.CoreWebView2.WebMessageReceived += (_, e) =>
            {
                if (e.TryGetWebMessageAsString() == "retry") _ = ConnectAsync();
            };
            webViewInitialized = true;
        }

        ShowSplash("Starting the bot…");
        await ConnectAsync();
    }

    private async Task ConnectAsync()
    {
        if (connecting) return;
        connecting = true;
        poll?.Stop();
        client = null;
        try
        {
            var progress = new Progress<string>(ShowSplash);
            endpoint = await bot.EnsureRunningAsync(progress, cancel.Token);
            client = new BridgeClient(endpoint);
            AppLog.Info("navigating to control panel", new { endpoint.Port });
            view.CoreWebView2.Navigate(endpoint.Url);
            StartPolling();
        }
        catch (OperationCanceledException)
        {
            // Window closed while starting; nothing to report.
        }
        catch (Exception ex)
        {
            AppLog.Error("desktop startup failed", ex);
            string tail;
            lock (startupLog) tail = startupLog.ToString();
            ShowFatal("The bot did not start", WebUtilityEncode(ex.Message), tail, retry: true);
            UpdateTray(BridgeState.Offline);
        }
        finally
        {
            connecting = false;
        }
    }

    /// <summary>
    /// Polls the control API so the tray can reflect reality.
    ///
    /// Two seconds is deliberately slower than the panel's own half-second feed: nothing here needs
    /// to animate, and this keeps running while the window is hidden.
    /// </summary>
    private void StartPolling()
    {
        poll?.Dispose();
        poll = new System.Windows.Forms.Timer { Interval = 2000 };
        poll.Tick += async (_, _) =>
        {
            if (client is null || polling) return;
            polling = true;
            try
            {
                UpdateTray(await client.ReadAsync(cancel.Token));
            }
            finally
            {
                polling = false;
            }
        };
        poll.Start();
    }

    private void UpdateTray(BridgeState next)
    {
        state = next;
        tray.Text = next.Tooltip;

        var status = !next.Ready
            ? StatusColour.Offline
            : next.Streaming
                ? next.Muted ? StatusColour.Muted : StatusColour.Streaming
                : StatusColour.Idle;

        // Rebuilding the icon every two seconds would leak GDI handles for no visible change.
        var key = status.ToString();
        if (key != iconKey)
        {
            iconKey = key;
            var updated = BuildIcon(status);
            var previous = trayIcon;
            trayIcon = updated;
            Icon = updated;
            tray.Icon = updated;
            previous?.Dispose();
        }

        muteItem.Enabled = next.Streaming;
        muteItem.Text = next.Muted ? "Unmute bot" : "Mute bot";
        stopItem.Enabled = next.Streaming;
    }

    private void SetUpTray()
    {
        var menu = new ContextMenuStrip();
        menu.Items.Add("Open control panel", null, (_, _) => RestoreWindow());
        menu.Items.Add("Open in browser", null, (_, _) => OpenInBrowser());
        menu.Items.Add(new ToolStripSeparator());

        muteItem = new ToolStripMenuItem("Mute bot", null, (_, _) => _ = ToggleMuteAsync()) { Enabled = false };
        stopItem = new ToolStripMenuItem("Stop streaming", null, (_, _) => _ = StopStreamAsync()) { Enabled = false };
        menu.Items.Add(muteItem);
        menu.Items.Add(stopItem);
        menu.Items.Add(new ToolStripSeparator());

        autostartItem = new ToolStripMenuItem("Start with Windows", null, (_, _) => ToggleAutostart())
        {
            CheckOnClick = false,
            Checked = Settings.StartsWithWindows(),
        };
        menu.Items.Add(autostartItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Quit", null, (_, _) => ExitApplication());

        tray.Icon = trayIcon;
        tray.Text = "Discord Audio Bridge";
        tray.Visible = true;
        tray.ContextMenuStrip = menu;
        tray.DoubleClick += (_, _) => RestoreWindow();
    }

    private void ToggleAutostart()
    {
        var wanted = !autostartItem.Checked;
        if (Settings.SetStartWithWindows(wanted))
        {
            autostartItem.Checked = wanted;
            tray.ShowBalloonTip(
                1500,
                "Discord Audio Bridge",
                wanted ? "Will start with Windows." : "No longer starts with Windows.",
                ToolTipIcon.Info);
        }
    }

    private async Task ToggleMuteAsync()
    {
        if (client is null || !state.Streaming) return;
        if (await client.ToggleMuteAsync(!state.Muted, cancel.Token))
        {
            UpdateTray(await client.ReadAsync(cancel.Token));
        }
    }

    private async Task StopStreamAsync()
    {
        if (client is null || !state.Streaming) return;
        if (await client.StopAsync(cancel.Token))
        {
            UpdateTray(await client.ReadAsync(cancel.Token));
        }
    }

    private void RestoreWindow()
    {
        Show();
        ShowInTaskbar = true;
        WindowState = FormWindowState.Normal;
        Activate();
    }

    /// <summary>
    /// Opens the panel in the default browser.
    ///
    /// Deliberately uses the authenticated endpoint URL rather than the WebView's current address:
    /// the page strips its own token out of the address bar on load, so handing over what the
    /// WebView is showing would open a panel that cannot talk to the bot.
    /// </summary>
    private void OpenInBrowser()
    {
        if (endpoint is not null)
        {
            OpenExternally(endpoint.Url);
            return;
        }

        var uri = view.CoreWebView2?.Source;
        if (!string.IsNullOrEmpty(uri)) OpenExternally(uri);
    }

    /// <summary>
    /// Hands a URI to the shell, but only http(s).
    ///
    /// Everything reaching this point comes from a page we serve on loopback, so this is defence in
    /// depth rather than a live concern - but ShellExecute will happily launch a registered
    /// protocol handler, and there is no reason a control panel should ever be able to ask for one.
    /// </summary>
    private static void OpenExternally(string uri)
    {
        if (!Uri.TryCreate(uri, UriKind.Absolute, out var parsed)) return;
        if (parsed.Scheme != Uri.UriSchemeHttp && parsed.Scheme != Uri.UriSchemeHttps) return;

        try
        {
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(parsed.AbsoluteUri)
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
            settings.Capture(this);
            settings.Save();
            e.Cancel = true;
            ShowInTaskbar = false;
            Hide();
            tray.ShowBalloonTip(
                2000,
                "Still running",
                "The bridge is in the notification area. Quit from there to stop it. " +
                "Ctrl+Alt+B brings this window back.",
                ToolTipIcon.Info);
            return;
        }

        settings.Capture(this);
        settings.Save();
        cancel.Cancel();
        poll?.Stop();
        tray.Visible = false;

        if (hotkeysRegistered)
        {
            foreach (var id in Enum.GetValues<Native.Hotkey>()) Native.UnregisterHotKey(Handle, (int)id);
            hotkeysRegistered = false;
        }
    }

    private void ExitApplication()
    {
        AppLog.Info("quit requested from tray");
        reallyExiting = true;
        Close();
        Application.Exit();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            poll?.Dispose();
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

    /// <summary>
    /// The failure screen, with a way out of it.
    ///
    /// Without a retry button a failed start is a dead end that can only be escaped by closing and
    /// relaunching the application - which is a poor answer when the usual cause is something the
    /// user has just fixed in another window.
    /// </summary>
    private void ShowFatal(string title, string htmlBody, string? detail, bool retry) =>
        view.CoreWebView2?.NavigateToString(Page($"""
        <h1>{WebUtilityEncode(title)}</h1>
        <p>{htmlBody}</p>
        {(retry ? """<button type="button" onclick="window.chrome.webview.postMessage('retry')">Try again</button>""" : "")}
        {(string.IsNullOrWhiteSpace(detail) ? "" : $"<pre>{WebUtilityEncode(detail)}</pre>")}
        """));

    private static string WebUtilityEncode(string value) =>
        System.Net.WebUtility.HtmlEncode(value);

    private static string RedactStartupLine(string value) =>
        Regex.Replace(value, @"(?i)([?#&]token=)[^&#\s\""']+", "$1[REDACTED]");

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
          button {
            margin-top: 6px; padding: 8px 18px; border: 0; border-radius: 8px;
            background: #5865f2; color: #fff; font: inherit; font-weight: 600; cursor: pointer;
          }
          button:hover { background: #6b76ff; }
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
          @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
        </style>
        {{body}}
        """;

    /* ── tray icon ────────────────────────────────────────────────────────── */

    private enum StatusColour
    {
        Offline,
        Idle,
        Streaming,
        Muted,
    }

    /// <summary>
    /// Draws the tray/window icon at runtime so the repo carries no binary assets.
    ///
    /// The colour carries the state, which is the whole point: a glance at the notification area
    /// should answer "is it streaming?" without opening anything. Sized from the system metric so
    /// it stays sharp on a high-DPI display instead of being scaled up from 32px.
    /// </summary>
    private static Icon BuildIcon(StatusColour status)
    {
        var size = Math.Max(16, SystemInformation.SmallIconSize.Width * 2);
        var background = status switch
        {
            StatusColour.Streaming => Color.FromArgb(59, 165, 93),
            StatusColour.Muted => Color.FromArgb(250, 166, 26),
            StatusColour.Offline => Color.FromArgb(110, 118, 132),
            _ => Color.FromArgb(88, 101, 242),
        };

        using var bitmap = new Bitmap(size, size);
        using (var g = Graphics.FromImage(bitmap))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            var scale = size / 32f;
            using var fill = new SolidBrush(background);
            g.FillEllipse(fill, scale, scale, size - 2 * scale, size - 2 * scale);

            // A simple headphone glyph: a band across the top and two ear cups.
            using var stroke = new Pen(Color.White, 3f * scale) { StartCap = LineCap.Round, EndCap = LineCap.Round };
            g.DrawArc(stroke, 8 * scale, 9 * scale, 16 * scale, 16 * scale, 180, 180);
            using var cups = new SolidBrush(Color.White);
            g.FillRectangle(cups, 7 * scale, 16 * scale, 4 * scale, 8 * scale);
            g.FillRectangle(cups, 21 * scale, 16 * scale, 4 * scale, 8 * scale);
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
            _ = Native.DestroyIcon(handle);
        }
    }
}
