using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Text.Json;

namespace BridgeApp;

internal sealed record ControlEndpoint(int Port, string Token)
{
    public string Url => $"http://127.0.0.1:{Port}/#token={Token}";
    public string StateUrl => $"http://127.0.0.1:{Port}/api/state";
}

/// <summary>
/// Owns the Node bot process.
///
/// Attaching to an already-running bot is tried first, so launching the desktop app while
/// `npm start` is open in a terminal gives you the same session rather than a port clash.
/// Only when nothing answers do we start our own child, and only then do we stop it on exit.
/// </summary>
internal sealed class BotProcess : IDisposable
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(2) };

    private readonly string projectRoot;
    private Process? child;

    public event Action<string>? Output;

    public bool OwnsProcess => child is { HasExited: false };

    public BotProcess(string projectRoot) => this.projectRoot = projectRoot;

    /// <summary>
    /// Locates the repo root, identified by its package.json.
    ///
    /// Normally the executable sits in desktop/BridgeApp/bin, so walking up finds it. An explicit
    /// override comes first so a shortcut pinned anywhere - or a copy of the exe moved out of the
    /// tree - still works.
    /// </summary>
    public static string? FindProjectRoot(string? overridePath = null)
    {
        var explicitRoot = overridePath ?? Environment.GetEnvironmentVariable("BRIDGE_PROJECT_ROOT");
        if (!string.IsNullOrWhiteSpace(explicitRoot))
        {
            return IsProjectRoot(explicitRoot)
                ? Path.GetFullPath(explicitRoot)
                : throw new DirectoryNotFoundException(
                    $"'{explicitRoot}' does not look like the discord-audio-bridge project " +
                    "(no matching package.json there).");
        }

        var candidates = new List<string?>
        {
            AppContext.BaseDirectory,
            Directory.GetCurrentDirectory(),
        };

        foreach (var start in candidates)
        {
            var dir = start is null ? null : new DirectoryInfo(start);
            while (dir is not null)
            {
                if (IsProjectRoot(dir.FullName)) return dir.FullName;
                dir = dir.Parent;
            }
        }

        return null;
    }

    private static bool IsProjectRoot(string directory)
    {
        try
        {
            var manifest = Path.Combine(directory, "package.json");
            return File.Exists(manifest)
                && File.ReadAllText(manifest).Contains("discord-audio-bridge", StringComparison.Ordinal);
        }
        catch (Exception)
        {
            return false; // unreadable path; treat as "not it" rather than crashing the walk
        }
    }

    public async Task<ControlEndpoint> EnsureRunningAsync(IProgress<string> status, CancellationToken cancel)
    {
        var existing = await ProbeAsync(cancel);
        if (existing is not null)
        {
            AppLog.Info("attached to existing bot", new { existing.Port });
            status.Report("Attached to a bot that was already running.");
            return existing;
        }

        status.Report("Starting the bot...");
        AppLog.Info("starting bot process");
        Start();

        // The bot writes .control-token once its HTTP server is listening. Poll for that file and
        // then confirm the port genuinely answers, so we never navigate to a half-open server.
        var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(60);
        while (DateTime.UtcNow < deadline)
        {
            cancel.ThrowIfCancellationRequested();

            if (child is { HasExited: true })
            {
                var code = child.ExitCode;
                throw new InvalidOperationException(
                    $"The bot stopped before opening its control panel (exit code {code}). " +
                    "The output below says why; a missing or invalid DISCORD_TOKEN is the usual cause.");
            }

            var endpoint = await ProbeAsync(cancel);
            if (endpoint is not null) return endpoint;

            await Task.Delay(300, cancel);
        }

        var timeout = new TimeoutException("The bot did not open its control panel within 60 seconds.");
        AppLog.Error("bot startup timed out", timeout);
        throw timeout;
    }

    /// <summary>Reads .control-token and checks whether anything is actually listening on it.</summary>
    private async Task<ControlEndpoint?> ProbeAsync(CancellationToken cancel)
    {
        var tokenFile = Path.Combine(projectRoot, ".control-token");
        if (!File.Exists(tokenFile)) return null;

        ControlEndpoint endpoint;
        try
        {
            using var json = JsonDocument.Parse(await File.ReadAllTextAsync(tokenFile, cancel));
            endpoint = new ControlEndpoint(
                json.RootElement.GetProperty("port").GetInt32(),
                json.RootElement.GetProperty("token").GetString() ?? string.Empty);
        }
        catch (Exception)
        {
            return null; // truncated or mid-write; try again next tick
        }

        if (string.IsNullOrEmpty(endpoint.Token)) return null;

        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, endpoint.StateUrl);
            request.Headers.Add("Authorization", $"Bearer {endpoint.Token}");
            using var response = await Http.SendAsync(request, cancel);
            return response.IsSuccessStatusCode ? endpoint : null;
        }
        catch (Exception)
        {
            return null; // stale file from a previous run
        }
    }

    private void Start()
    {
        var info = new ProcessStartInfo
        {
            // CreateProcess searches PATH for a bare executable name, so this finds Node wherever
            // it was installed without us hard-coding a location.
            FileName = "node.exe",
            WorkingDirectory = projectRoot,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };

        info.ArgumentList.Add(Path.Combine("src", "index.ts"));
        // The panel shows the log itself, so the console copy would only be noise.
        info.Environment["FORCE_COLOR"] = "0";

        var process = new Process { StartInfo = info, EnableRaisingEvents = true };
        process.Exited += (_, _) => AppLog.Info("bot process exited", new { process.ExitCode });
        process.OutputDataReceived += (_, e) => Report(e.Data);
        process.ErrorDataReceived += (_, e) => Report(e.Data);
        child = process;

        try
        {
            process.Start();
            AppLog.Info("bot process spawned", new { process.Id });
        }
        catch (Exception ex)
        {
            child = null;
            AppLog.Error("could not spawn bot process", ex);
            throw new InvalidOperationException(
                "Could not start Node. Install Node.js 22.18 or newer and make sure `node` is on PATH.", ex);
        }

        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
    }

    private void Report(string? line)
    {
        if (!string.IsNullOrWhiteSpace(line)) Output?.Invoke(line);
    }

    /// <summary>
    /// Stops the bot, but only if we were the one who started it. A bot the user launched from a
    /// terminal keeps running when the window closes.
    /// </summary>
    public void Dispose()
    {
        if (child is null) return;

        try
        {
            if (!child.HasExited)
            {
                AppLog.Info("stopping owned bot process", new { child.Id });
                // Kill the whole tree: the bot has AudioTap and ffmpeg children of its own.
                child.Kill(entireProcessTree: true);
                child.WaitForExit(4000);
            }
        }
        catch (Exception)
        {
            /* already gone */
        }
        finally
        {
            child.Dispose();
            child = null;
        }
    }
}
