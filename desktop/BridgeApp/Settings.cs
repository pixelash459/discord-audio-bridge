using System.IO;
using System.Text.Json;
using Microsoft.Win32;

namespace BridgeApp;

/// <summary>
/// The handful of things the shell should remember between launches.
///
/// Where the window was, and whether it should start with Windows. Neither is interesting on its
/// own; together they are the difference between an app you launch and an app that is simply there.
/// Everything is best-effort: a corrupt file or a locked registry key must never stop the window
/// from opening, so every path falls back to the default and carries on.
/// </summary>
internal sealed class Settings
{
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string RunValue = "DiscordAudioBridge";

    public int? X { get; set; }
    public int? Y { get; set; }
    public int? Width { get; set; }
    public int? Height { get; set; }
    public bool Maximized { get; set; }

    private static string Path =>
        System.IO.Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "discord-audio-bridge",
            "desktop.json");

    public static Settings Load()
    {
        try
        {
            if (!File.Exists(Path)) return new Settings();
            return JsonSerializer.Deserialize<Settings>(File.ReadAllText(Path)) ?? new Settings();
        }
        catch (Exception)
        {
            return new Settings();
        }
    }

    public void Save()
    {
        try
        {
            var directory = System.IO.Path.GetDirectoryName(Path);
            if (directory is not null) Directory.CreateDirectory(directory);
            File.WriteAllText(Path, JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true }));
        }
        catch (Exception ex)
        {
            AppLog.Error("could not save desktop settings", ex);
        }
    }

    /// <summary>
    /// Restores the saved bounds, but only if they still land on a screen.
    ///
    /// Monitors get unplugged. Without this check a window last used on a second display reopens at
    /// coordinates that no longer exist, which looks exactly like the app failing to start.
    /// </summary>
    public void Apply(Form form)
    {
        if (Width is not > 0 || Height is not > 0 || X is null || Y is null) return;

        var bounds = new Rectangle(X.Value, Y.Value, Width.Value, Height.Value);
        if (!Screen.AllScreens.Any(screen => screen.WorkingArea.IntersectsWith(bounds))) return;

        form.StartPosition = FormStartPosition.Manual;
        form.Bounds = bounds;
        if (Maximized) form.WindowState = FormWindowState.Maximized;
    }

    public void Capture(Form form)
    {
        Maximized = form.WindowState == FormWindowState.Maximized;
        // RestoreBounds is the only honest answer while maximized or minimized; Bounds would
        // record the maximized rectangle and the window would never come back to its real size.
        var bounds = form.WindowState == FormWindowState.Normal ? form.Bounds : form.RestoreBounds;
        if (bounds.Width <= 0 || bounds.Height <= 0) return;
        X = bounds.X;
        Y = bounds.Y;
        Width = bounds.Width;
        Height = bounds.Height;
    }

    /* ── start with Windows ───────────────────────────────────────────────── */

    public static bool StartsWithWindows()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(RunKey);
            return key?.GetValue(RunValue) is not null;
        }
        catch (Exception)
        {
            return false;
        }
    }

    /// <summary>Per-user only: HKCU, never HKLM, so this needs no elevation and affects nobody else.</summary>
    public static bool SetStartWithWindows(bool enabled)
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(RunKey, writable: true);
            if (key is null) return false;

            if (!enabled)
            {
                key.DeleteValue(RunValue, throwOnMissingValue: false);
                AppLog.Info("removed start-with-Windows entry");
                return true;
            }

            var executable = Environment.ProcessPath;
            if (string.IsNullOrEmpty(executable)) return false;
            key.SetValue(RunValue, $"\"{executable}\" --minimized");
            AppLog.Info("registered start-with-Windows entry", new { executable });
            return true;
        }
        catch (Exception ex)
        {
            AppLog.Error("could not change the start-with-Windows setting", ex);
            return false;
        }
    }
}
