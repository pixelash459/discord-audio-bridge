using System.Collections.Concurrent;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.Versioning;

namespace AudioTap;

/// <summary>
/// Executable icons as base64 PNGs, for the source picker.
///
/// A list of grey process names is a lookup exercise; the same list with each app's own icon is
/// recognised at a glance. That is the entire justification, and it is enough - people pick the
/// wrong source more often than any other mistake this tool allows.
///
/// Everything here is best-effort by design. Reading another process's image path fails for
/// elevated and protected processes, icon extraction fails for store apps whose launcher is a stub,
/// and none of that is worth failing an enumeration over: a missing icon simply renders as the
/// existing text row. Results are cached by executable path because the same handful of apps are
/// re-enumerated every time the panel refreshes.
/// </summary>
[SupportedOSPlatform("windows6.1")]
internal static class AppIcons
{
    private const int MaxCacheEntries = 256;

    private static readonly ConcurrentDictionary<string, string?> ByPath = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>
    /// Icons already resolved for a process name, used when the executable path is unreadable.
    ///
    /// Browsers are the reason this exists. Firefox and Chrome render audio from sandboxed content
    /// processes whose image path cannot be read at all, so the picker would show one "firefox" row
    /// with an icon beside two identical rows without - which reads as a rendering bug rather than
    /// as a permission boundary. The parent process of the same name has already been resolved by
    /// then, and its icon is the correct one to show.
    /// </summary>
    private static readonly ConcurrentDictionary<string, string?> ByName = new(StringComparer.OrdinalIgnoreCase);

    public static string? For(uint pid)
    {
        var (path, name) = Identify(pid);

        if (path is null)
        {
            return name is not null && ByName.TryGetValue(name, out var known) ? known : null;
        }

        if (ByPath.TryGetValue(path, out var cached))
        {
            if (name is not null && cached is not null) ByName.TryAdd(name, cached);
            return cached;
        }

        // Unbounded growth is not a risk worth managing cleverly: audio sessions come from a small
        // set of applications. If something pathological happens, stop caching rather than grow.
        var encoded = Encode(path);
        if (ByPath.Count < MaxCacheEntries) ByPath[path] = encoded;
        if (name is not null && encoded is not null && ByName.Count < MaxCacheEntries) ByName[name] = encoded;
        return encoded;
    }

    /// <summary>
    /// The executable path and process name, either of which may be unavailable.
    ///
    /// ProcessName is readable for almost anything; MainModule is not, because reading another
    /// process's module list needs rights a sandboxed or elevated target will refuse.
    /// </summary>
    private static (string? Path, string? Name) Identify(uint pid)
    {
        try
        {
            using var process = Process.GetProcessById((int)pid);
            string? name = null;
            try
            {
                name = process.ProcessName;
            }
            catch (Exception)
            {
                // Exited between enumeration and here.
            }

            try
            {
                return (process.MainModule?.FileName, name);
            }
            catch (Exception)
            {
                return (null, name); // access denied, or a protected process
            }
        }
        catch (Exception)
        {
            return (null, null);
        }
    }

    private static string? Encode(string path)
    {
        try
        {
            if (!File.Exists(path)) return null;

            using var icon = Icon.ExtractAssociatedIcon(path);
            if (icon is null) return null;

            using var bitmap = icon.ToBitmap();
            using var buffer = new MemoryStream();
            bitmap.Save(buffer, ImageFormat.Png);
            return Convert.ToBase64String(buffer.ToArray());
        }
        catch (Exception)
        {
            return null; // no icon resource, GDI+ failure, or an unreadable file
        }
    }
}
