using System.Buffers;
using System.Text.Json;
using NAudio.CoreAudioApi;
using NAudio.Wave;

namespace AudioTap;

/// <summary>
/// A thin, single-purpose WASAPI tap.
///
/// stdout carries nothing but raw interleaved PCM at a constant rate, so it can be piped straight
/// into ffmpeg. Everything else - the negotiated format, readiness, statistics, errors - goes to
/// stderr as line-delimited JSON, which is what the Node side parses.
/// </summary>
internal static class Program
{
    // No [STAThread]: console apps default to MTA, which is what WASAPI COM activation wants.
    private static int Main(string[] args)
    {
        Options options;
        try
        {
            options = Options.Parse(args);
        }
        catch (HelpRequested)
        {
            Console.Error.WriteLine(Options.Usage);
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(Options.Usage);
            Console.Error.WriteLine();
            Console.Error.WriteLine($"error: {ex.Message}");
            return 2;
        }

        try
        {
            return options.Mode switch
            {
                Mode.ListDevices => Print(Enumerate.Devices()),
                Mode.ListProcesses => Print(Enumerate.Processes()),
                _ => Capture(options),
            };
        }
        catch (Exception ex)
        {
            Emit("error", new { message = ex.Message, type = ex.GetType().Name, hresult = $"0x{ex.HResult:X8}" });
            return 1;
        }
    }

    private static int Print<T>(List<T> items)
    {
        Console.Out.WriteLine(JsonSerializer.Serialize(items, Enumerate.Json));
        return 0;
    }

    private static int Capture(Options options)
    {
        using var recorder = Build(options);

        var format = Formats.Normalise(recorder.WaveFormat);
        var ffmpegName = Formats.ToFfmpegName(format);
        if (ffmpegName == "unsupported")
            throw new NotSupportedException(
                $"Capture format {format} cannot be expressed as raw PCM for ffmpeg. " +
                "Set the endpoint to 16-bit or 32-bit float in Windows sound settings.");

        var bytesPerSample = Formats.BytesPerSample(format);
        var isFloat = format.Encoding == WaveFormatEncoding.IeeeFloat && format.BitsPerSample == 32;

        Emit("format", new
        {
            sampleRate = format.SampleRate,
            channels = format.Channels,
            sampleFormat = ffmpegName,
            bitsPerSample = format.BitsPerSample,
            encoding = format.Encoding.ToString(),
            latencyMs = recorder.LatencyMilliseconds,
            source = options.Source == SourceKind.Process
                ? $"pid {options.Pid}{(options.Exclude ? " (excluded)" : string.Empty)}"
                : options.DeviceId ?? "default",
            gainAppliedInTap = isFloat,
        });

        var stdout = Console.OpenStandardOutput();
        using var pacer = new PacedWriter(stdout, format.SampleRate, format.Channels, bytesPerSample, options.BufferMs);
        var meter = new LevelMeter(format.Channels);

        // Gain lives here rather than in an ffmpeg filter so it can be changed live over stdin
        // without restarting the encoder, and so it happens before any format conversion.
        var gain = (float)Math.Pow(10, options.GainDb / 20.0);

        recorder.DataAvailable += (buffer, flags, _, _) =>
        {
            if (buffer.IsEmpty) return;

            // Per the WASAPI contract, the contents of a Silent buffer are undefined.
            if ((flags & AudioClientBufferFlags.Silent) != 0)
            {
                var zeros = ArrayPool<byte>.Shared.Rent(buffer.Length);
                try
                {
                    Array.Clear(zeros, 0, buffer.Length);
                    meter.Add(zeros.AsSpan(0, buffer.Length), isFloat);
                    pacer.Enqueue(zeros.AsSpan(0, buffer.Length));
                }
                finally
                {
                    ArrayPool<byte>.Shared.Return(zeros);
                }

                return;
            }

            if (!isFloat || Math.Abs(gain - 1f) < 1e-6f)
            {
                meter.Add(buffer, isFloat);
                pacer.Enqueue(buffer);
                return;
            }

            var scratch = ArrayPool<byte>.Shared.Rent(buffer.Length);
            try
            {
                buffer.CopyTo(scratch);
                var samples = System.Runtime.InteropServices.MemoryMarshal
                    .Cast<byte, float>(scratch.AsSpan(0, buffer.Length));
                for (var i = 0; i < samples.Length; i++) samples[i] *= gain;
                meter.Add(scratch.AsSpan(0, buffer.Length), isFloat);
                pacer.Enqueue(scratch.AsSpan(0, buffer.Length));
            }
            finally
            {
                ArrayPool<byte>.Shared.Return(scratch);
            }
        };

        using var finished = new ManualResetEventSlim(false);
        Exception? failure = null;

        recorder.RecordingStopped += (_, e) =>
        {
            failure = e.Exception;
            finished.Set();
        };

        recorder.StartRecording();
        pacer.Start();
        Emit("ready", new { bufferMs = options.BufferMs, gainDb = options.GainDb });

        // 200ms is fast enough for a level meter to look alive without flooding the pipe.
        using var stats = new Timer(_ =>
        {
            var s = pacer.Snapshot();
            var level = meter.Read();
            Emit("stats", new
            {
                bufferMs = s.BufferMs,
                targetMs = s.TargetMs,
                streamedMs = s.StreamedMs,
                paddedMs = s.PaddedMs,
                droppedMs = s.DroppedMs,
                trimmedMs = s.TrimmedMs,
                primed = s.Primed,
                peakDb = level.Peak,
                rmsDb = level.Rms,
                clipping = level.PeakLinear.Any(v => v >= 0.999f),
                silent = level.Frames > 0 && level.PeakLinear.All(v => v < 1e-5f),
            });
        }, null, TimeSpan.FromMilliseconds(200), TimeSpan.FromMilliseconds(200));

        Console.CancelKeyPress += (_, e) =>
        {
            e.Cancel = true;
            finished.Set();
        };

        // Commands arrive on stdin, one per line. EOF means the parent went away.
        var commands = new Thread(() =>
        {
            string? line;
            while ((line = Console.In.ReadLine()) is not null)
            {
                var parts = line.Trim().Split(' ', 2, StringSplitOptions.RemoveEmptyEntries);
                if (parts.Length == 0) continue;

                switch (parts[0].ToLowerInvariant())
                {
                    case "gain" when parts.Length == 2 && double.TryParse(parts[1], out var db):
                        gain = (float)Math.Pow(10, Math.Clamp(db, -60, 20) / 20.0);
                        Emit("gain", new { gainDb = db });
                        break;
                    case "stats":
                        var s = pacer.Snapshot();
                        Emit("stats", new { bufferMs = s.BufferMs, targetMs = s.TargetMs, primed = s.Primed });
                        break;
                    case "quit":
                        finished.Set();
                        return;
                }
            }

            finished.Set();
        })
        { IsBackground = true, Name = "AudioTap stdin" };
        commands.Start();

        finished.Wait();

        try { recorder.StopRecording(); }
        catch (Exception) { /* already stopped */ }

        if (failure is not null)
        {
            Emit("error", new { message = failure.Message, type = failure.GetType().Name });
            return 1;
        }

        return 0;
    }

    private static WasapiRecorder Build(Options options)
    {
        if (options.Source == SourceKind.Process)
        {
            var mode = options.Exclude
                ? ProcessLoopbackMode.ExcludeTargetProcessTree
                : ProcessLoopbackMode.IncludeTargetProcessTree;

            // The process-loopback virtual device exposes no mix format, so NAudio would otherwise
            // default to 44.1kHz. Asking for 48kHz float up front means the audio engine performs
            // exactly one resample (from whatever the app renders) and we never touch the samples.
            var format = WaveFormat.CreateIeeeFloatWaveFormat(options.SampleRate, options.Channels);

            // Activation is async and the completion handler is agile, so it is run on the thread
            // pool rather than the entry thread. The OS check lives inside the lambda because that
            // is the scope the platform-compatibility analyzer reasons about.
            return Task.Run(() =>
                {
                    // AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS arrived in Windows 10 version 2004.
                    // Checking turns an opaque COM failure into an actionable sentence.
                    if (!OperatingSystem.IsWindowsVersionAtLeast(10, 0, 19041))
                    {
                        throw new PlatformNotSupportedException(
                            "Per-process capture requires Windows 10 build 19041 (version 2004) or " +
                            "newer. Use --device for endpoint loopback instead.");
                    }

                    return new WasapiRecorderBuilder()
                        .WithProcessLoopback(options.Pid, mode)
                        .WithFormat(format)
                        .BuildAsync();
                })
                .GetAwaiter().GetResult();
        }

        using var enumerator = new MMDeviceEnumerator();
        var device = string.IsNullOrWhiteSpace(options.DeviceId) || options.DeviceId == "default"
            ? enumerator.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia)
            : enumerator.GetDevice(options.DeviceId);

        // Shared-mode endpoint loopback must run at the device mix format; anything else is
        // rejected. We report that format upstream and let ffmpeg convert if it is not 48kHz.
        return new WasapiRecorderBuilder()
            .WithDevice(device)
            .WithLoopbackCapture()
            .WithEventSync()
            .WithMmcssThreadPriority("Pro Audio")
            .Build();
    }

    private static void Emit(string name, object payload)
    {
        var json = JsonSerializer.Serialize(payload, Enumerate.Json);
        Console.Error.WriteLine($"{{\"event\":\"{name}\",\"data\":{json}}}");
        Console.Error.Flush();
    }
}
