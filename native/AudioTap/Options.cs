using System.Globalization;

namespace AudioTap;

internal enum Mode
{
    ListDevices,
    ListProcesses,
    NowPlaying,

    /// <summary>
    /// Long-lived enumeration. One process stays resident and pushes changes, instead of the bot
    /// spawning a fresh helper every few seconds just to ask the same question again.
    /// </summary>
    Monitor,
    Capture,
}

internal enum SourceKind
{
    /// <summary>Per-process WASAPI loopback (ActivateAudioInterfaceAsync + PROCESS_LOOPBACK).</summary>
    Process,

    /// <summary>Everything rendered by one endpoint device.</summary>
    Device,
}

internal sealed class Options
{
    public Mode Mode = Mode.Capture;
    public SourceKind Source = SourceKind.Process;

    /// <summary>Target PID for <see cref="SourceKind.Process"/>.</summary>
    public uint Pid;

    /// <summary>Capture everything EXCEPT the target process tree.</summary>
    public bool Exclude;

    /// <summary>Endpoint id for <see cref="SourceKind.Device"/>; null or "default" = default render device.</summary>
    public string? DeviceId;

    /// <summary>Requested sample rate for process loopback. Ignored for device loopback (mix format wins).</summary>
    public int SampleRate = 48_000;

    public int Channels = 2;

    /// <summary>Jitter buffer target, in milliseconds.</summary>
    public int BufferMs = 120;

    public double GainDb;

    /// <summary>How often <see cref="Mode.Monitor"/> re-reads the audio session list, in ms.</summary>
    public int PollMs = 1_500;

    /// <summary>Extract executable icons during process enumeration. Costs a few ms per process.</summary>
    public bool WithIcons;

    public static Options Parse(string[] args)
    {
        var o = new Options();

        for (var i = 0; i < args.Length; i++)
        {
            var arg = args[i];
            string Next(string name) => i + 1 < args.Length
                ? args[++i]
                : throw new ArgumentException($"{name} requires a value");

            switch (arg)
            {
                case "--list-devices":
                    o.Mode = Mode.ListDevices;
                    break;
                case "--list-processes":
                    o.Mode = Mode.ListProcesses;
                    break;
                case "--now-playing":
                    o.Mode = Mode.NowPlaying;
                    break;
                case "--monitor":
                    o.Mode = Mode.Monitor;
                    break;
                case "--with-icons":
                    o.WithIcons = true;
                    break;
                case "--poll-ms":
                    o.PollMs = int.Parse(Next(arg), NumberStyles.None, CultureInfo.InvariantCulture);
                    break;
                case "--capture":
                    o.Mode = Mode.Capture;
                    break;
                case "--pid":
                    o.Source = SourceKind.Process;
                    o.Pid = uint.Parse(Next(arg), NumberStyles.None, CultureInfo.InvariantCulture);
                    break;
                case "--exclude":
                    o.Exclude = true;
                    break;
                case "--device":
                    o.Source = SourceKind.Device;
                    o.DeviceId = Next(arg);
                    break;
                case "--rate":
                    o.SampleRate = int.Parse(Next(arg), NumberStyles.None, CultureInfo.InvariantCulture);
                    break;
                case "--channels":
                    o.Channels = int.Parse(Next(arg), NumberStyles.None, CultureInfo.InvariantCulture);
                    break;
                case "--buffer-ms":
                    o.BufferMs = int.Parse(Next(arg), NumberStyles.None, CultureInfo.InvariantCulture);
                    break;
                case "--gain-db":
                    o.GainDb = double.Parse(Next(arg), NumberStyles.Float, CultureInfo.InvariantCulture);
                    break;
                case "--help":
                case "-h":
                    throw new HelpRequested();
                default:
                    throw new ArgumentException($"Unknown argument: {arg}");
            }
        }

        if (o.Mode == Mode.Capture && o.Source == SourceKind.Process && o.Pid == 0)
            throw new ArgumentException("--capture with a process source requires --pid <n>");

        if (o.SampleRate is < 8_000 or > 384_000)
            throw new ArgumentOutOfRangeException("--rate", "Sample rate must be between 8000 and 384000 Hz");
        if (o.Channels is < 1 or > 8)
            throw new ArgumentOutOfRangeException("--channels", "Channel count must be between 1 and 8");
        if (!double.IsFinite(o.GainDb))
            throw new ArgumentOutOfRangeException("--gain-db", "Gain must be a finite number");

        o.BufferMs = Math.Clamp(o.BufferMs, 20, 2000);
        o.GainDb = Math.Clamp(o.GainDb, -60, 20);
        o.PollMs = Math.Clamp(o.PollMs, 250, 60_000);

        return o;
    }

    public const string Usage = """
        AudioTap - WASAPI capture helper for discord-audio-bridge

          AudioTap --list-devices
              Print active render endpoints as JSON.

          AudioTap --list-processes [--with-icons]
              Print processes currently holding an audio render session, as JSON.
              --with-icons embeds each executable's icon as a base64 PNG.

          AudioTap --now-playing
              Print the system media session's current track as JSON, if any.

          AudioTap --monitor [--poll-ms <n>] [--with-icons]
              Stay resident and print line-delimited JSON events on stdout whenever the
              process list, device list, or now-playing track changes. stdin accepts
              "refresh" and "quit". This exists so the control panel can show a live
              source list without spawning a helper on a timer.

          AudioTap --capture --pid <n> [--exclude] [options]
              Per-process loopback capture (Windows 10 version 2004 / build 19041+).
              --exclude captures everything EXCEPT that process tree.

          AudioTap --capture --device <id|default> [options]
              Whole-endpoint loopback capture.

        Options:
          --rate <hz>        Requested sample rate for process loopback (default 48000)
          --channels <n>     Requested channel count for process loopback (default 2)
          --buffer-ms <n>    Jitter buffer target (default 120, clamped 20-2000)
          --gain-db <n>      Gain applied to float samples (default 0)

        Capture mode writes raw interleaved PCM to stdout and line-delimited JSON
        events to stderr. The first stderr line is always the negotiated format.
        stdin accepts commands, one per line: "gain <db>", "stats", "quit".
        """;
}

internal sealed class HelpRequested : Exception;
