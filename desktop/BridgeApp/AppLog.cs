using System.IO;
using System.Text.Json;

namespace BridgeApp;

/// <summary>Best-effort persistent diagnostics for failures that happen before the web UI exists.</summary>
internal static class AppLog
{
    private static readonly object Gate = new();
    private static string? path;

    public static void Initialize(string projectRoot)
    {
        try
        {
            var directory = Path.Combine(projectRoot, "logs");
            Directory.CreateDirectory(directory);
            path = Path.Combine(directory, "desktop.log");
            if (File.Exists(path) && new FileInfo(path).Length >= 5 * 1024 * 1024)
            {
                File.Move(path, $"{path}.{DateTimeOffset.UtcNow:yyyyMMddHHmmss}");
            }
            Info("desktop launcher started", new { pid = Environment.ProcessId });
        }
        catch
        {
            path = null; // Logging must never prevent the launcher from opening.
        }
    }

    public static void Info(string message, object? data = null) => Write("info", message, data);
    public static void Error(string message, Exception error) =>
        Write("error", message, new { type = error.GetType().Name, error.Message, error.StackTrace });

    private static void Write(string level, string message, object? data)
    {
        if (path is null) return;
        try
        {
            var line = JsonSerializer.Serialize(new
            {
                at = DateTimeOffset.UtcNow,
                level,
                scope = "desktop",
                message,
                data,
            });
            lock (Gate) File.AppendAllText(path, line + Environment.NewLine);
        }
        catch
        {
            // Disk-full, permissions, and teardown races are deliberately non-fatal.
        }
    }
}
