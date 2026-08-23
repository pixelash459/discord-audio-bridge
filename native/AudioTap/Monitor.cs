using System.Text.Json;
using Windows.Media.Control;

namespace AudioTap;

/// <summary>
/// Resident enumeration: one helper process that pushes changes instead of being spawned to answer
/// the same question on a timer.
///
/// The control panel used to re-run <c>--list-processes</c> every ten seconds, which meant a helper
/// process appearing and disappearing in Task Manager forever and a source list that was up to ten
/// seconds stale. This mode replaces that with a single long-lived child: it re-reads the audio
/// session list on a short interval, compares a cheap signature, and only writes when something
/// actually changed. Track metadata rides along on the same channel, driven by real SMTC events
/// rather than polling.
///
/// Unlike capture mode, stdout carries no audio here, so events go to stdout as line-delimited
/// JSON and stderr is left for diagnostics.
/// </summary>
internal static class Monitor
{
    private static readonly object Gate = new();

    public static int Run(Options options)
    {
        var stop = new ManualResetEventSlim(false);
        var sourceGate = new object();
        var trackGate = new SemaphoreSlim(1, 1);
        string? lastProcesses = null;
        string? lastDevices = null;
        string? lastTrack = null;

        void PublishSources(bool force)
        {
            // Timer ticks and an explicit stdin refresh can coincide. The Core Audio enumerator is
            // not re-entrant, and the comparison state must move atomically with its publication.
            lock (sourceGate)
            {
                try
                {
                    var processes = JsonSerializer.Serialize(Enumerate.Processes(options.WithIcons), Enumerate.Json);
                    if (force || processes != lastProcesses)
                    {
                        lastProcesses = processes;
                        WriteRaw("processes", processes);
                    }
                }
                catch (Exception ex)
                {
                    Write("warning", new { scope = "processes", message = ex.Message });
                }

                try
                {
                    var devices = JsonSerializer.Serialize(Enumerate.Devices(), Enumerate.Json);
                    if (force || devices != lastDevices)
                    {
                        lastDevices = devices;
                        WriteRaw("devices", devices);
                    }
                }
                catch (Exception ex)
                {
                    Write("warning", new { scope = "devices", message = ex.Message });
                }
            }
        }

        async Task PublishTrackAsync(bool force)
        {
            await trackGate.WaitAsync();
            try
            {
                var track = await NowPlaying.ReadAsync();
                // Artwork is large and changes with the track, so the signature deliberately
                // ignores it: comparing base64 blobs twice a second is not worth the CPU.
                var signature = track is null
                    ? "none"
                    : $"{track.Title}\u001f{track.Artist}\u001f{track.Album}\u001f{track.Status}";

                if (!force && signature == lastTrack) return;
                lastTrack = signature;
                Write("nowPlaying", track is null ? null : new
                {
                    title = track.Title,
                    artist = track.Artist,
                    album = track.Album,
                    appId = track.AppId,
                    status = track.Status,
                    artwork = track.Artwork,
                });
            }
            catch (Exception ex)
            {
                Write("warning", new { scope = "nowPlaying", message = ex.Message });
            }
            finally
            {
                trackGate.Release();
            }
        }

        Write("ready", new { pollMs = options.PollMs, icons = options.WithIcons });
        PublishSources(force: true);
        _ = PublishTrackAsync(force: true);

        // Track changes are event-driven where the OS offers events; the poll below is only a
        // backstop for sessions that update their metadata without raising one.
        var subscription = SubscribeToMedia(() => _ = PublishTrackAsync(force: false));

        using var poll = new Timer(
            _ =>
            {
                PublishSources(force: false);
                if (!subscription) _ = PublishTrackAsync(force: false);
            },
            null,
            options.PollMs,
            options.PollMs);

        var commands = new Thread(() =>
        {
            string? line;
            while ((line = Console.In.ReadLine()) is not null)
            {
                switch (line.Trim().ToLowerInvariant())
                {
                    case "refresh":
                        PublishSources(force: true);
                        _ = PublishTrackAsync(force: true);
                        break;
                    case "quit":
                        stop.Set();
                        return;
                    case "":
                        break;
                    default:
                        Write("warning", new { message = "Unknown monitor command", command = line.Trim() });
                        break;
                }
            }

            stop.Set(); // parent closed stdin
        })
        { IsBackground = true, Name = "AudioTap monitor stdin" };
        commands.Start();

        Console.CancelKeyPress += (_, e) =>
        {
            e.Cancel = true;
            stop.Set();
        };

        stop.Wait();
        return 0;
    }

    /// <summary>
    /// Hooks the system media session events. Returns false when the projection is unavailable -
    /// notably in non-interactive sessions - so the caller knows to fall back to polling.
    /// </summary>
    private static bool SubscribeToMedia(Action onChange)
    {
        try
        {
            if (!OperatingSystem.IsWindowsVersionAtLeast(10, 0, 17763)) return false;

            var sessions = NowPlaying.ManagerAsync().GetAwaiter().GetResult();
            if (sessions is null) return false;

            void Attach(GlobalSystemMediaTransportControlsSession? session)
            {
                if (session is null) return;
                session.MediaPropertiesChanged += (_, _) => onChange();
                session.PlaybackInfoChanged += (_, _) => onChange();
            }

            sessions.CurrentSessionChanged += (manager, _) =>
            {
                Attach(manager.GetCurrentSession());
                onChange();
            };
            Attach(sessions.GetCurrentSession());
            return true;
        }
        catch (Exception)
        {
            return false;
        }
    }

    private static void Write(string name, object? payload)
    {
        WriteRaw(name, JsonSerializer.Serialize(payload, Enumerate.Json));
    }

    /// <summary>Writes an event whose payload is already serialised, avoiding a second pass.</summary>
    private static void WriteRaw(string name, string json)
    {
        lock (Gate)
        {
            Console.Out.WriteLine($"{{\"event\":\"{name}\",\"data\":{json}}}");
            Console.Out.Flush();
        }
    }
}
