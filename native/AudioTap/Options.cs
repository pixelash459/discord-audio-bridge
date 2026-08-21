namespace AudioTap;

internal enum Mode
{
    ListDevices,
    ListProcesses,
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
                case "--capture":
                    o.Mode = Mode.Capture;
                    break;
                case "--pid":
                    o.Source = SourceKind.Process;
                    o.Pid = uint.Parse(Next(arg));
                    break;
                case "--exclude":
                    o.Exclude = true;
                    break;
                case "--device":
                    o.Source = SourceKind.Device;
                    o.DeviceId = Next(arg);
                    break;
                case "--rate":
                    o.SampleRate = int.Parse(Next(arg));
                    break;
                case "--channels":
                    o.Channels = int.Parse(Next(arg));
                    break;
                case "--buffer-ms":
                    o.BufferMs = int.Parse(Next(arg));
                    break;
                case "--gain-db":
                    o.GainDb = double.Parse(Next(arg));
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

        o.BufferMs = Math.Clamp(o.BufferMs, 20, 2000);
        o.GainDb = Math.Clamp(o.GainDb, -60, 20);

        return o;
    }

    public const string Usage = """
        AudioTap - WASAPI capture helper for discord-audio-bridge

          AudioTap --list-devices
              Print active render endpoints as JSON.

          AudioTap --list-processes
              Print processes currently holding an audio render session, as JSON.

          AudioTap --capture --pid <n> [--exclude] [options]
              Per-process loopback capture (Windows 10 build 19041+).
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
