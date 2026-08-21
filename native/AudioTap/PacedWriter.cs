using System.Diagnostics;
using System.Runtime.InteropServices;

namespace AudioTap;

/// <summary>
/// Turns the bursty, gap-prone delivery of WASAPI into a perfectly constant byte rate on stdout.
///
/// Two problems make this necessary:
///
///  1. Per-process loopback delivers *nothing at all* while the target app is idle - not even
///     silence. A Discord audio player that stops receiving data gives up after a handful of
///     missed frames, so the gaps have to be filled locally.
///  2. The audio device clock and the system clock are not the same clock. Over hours they drift
///     by tens of ppm, which is enough to slowly overflow or drain any fixed buffer.
///
/// So: the capture callback pushes into a ring buffer, and a dedicated pacing thread drains it
/// against a Stopwatch at exactly sampleRate * frameSize bytes per second, padding silence on
/// underrun and gently discarding a frame at a time when the ring runs persistently long.
/// </summary>
internal sealed class PacedWriter : IDisposable
{
    private const int TickMs = 10;

    /// <summary>How far past the target fill we tolerate before trimming.</summary>
    private const double DriftToleranceRatio = 0.5;

    /// <summary>Frames discarded per tick while trimming. 100/s is about 2ms/s of correction.</summary>
    private const int TrimFramesPerTick = 1;

    private readonly Stream output;
    private readonly int bytesPerFrame;
    private readonly int bytesPerSecond;
    private readonly int targetBytes;
    private readonly int highWaterBytes;

    private readonly byte[] ring;
    private readonly object gate = new();
    private int head;      // read cursor
    private int fill;      // valid bytes
    private bool primed;   // false while we wait for the jitter buffer to fill

    private readonly Thread thread;
    private readonly CancellationTokenSource cts = new();

    // Stats, in bytes; converted to milliseconds when reported.
    private long written;
    private long padded;
    private long dropped;
    private long trimmed;

    public PacedWriter(Stream output, int sampleRate, int channels, int bytesPerSample, int bufferMs)
    {
        this.output = output;
        bytesPerFrame = channels * bytesPerSample;
        bytesPerSecond = sampleRate * bytesPerFrame;

        targetBytes = Align(bytesPerSecond * bufferMs / 1000);
        highWaterBytes = Align(targetBytes + (int)(targetBytes * DriftToleranceRatio));

        // The ring holds the target plus a generous margin so a scheduling hiccup never costs samples.
        ring = new byte[Align(Math.Max(bytesPerSecond * 2, highWaterBytes * 4))];

        thread = new Thread(PaceLoop)
        {
            Name = "AudioTap pacer",
            IsBackground = true,
            Priority = ThreadPriority.Highest,
        };
    }

    public void Start() => thread.Start();

    private int Align(int bytes) => bytes - (bytes % bytesPerFrame);

    /// <summary>Called from the WASAPI capture callback. Must not block.</summary>
    public void Enqueue(ReadOnlySpan<byte> data)
    {
        if (data.IsEmpty) return;

        lock (gate)
        {
            // Overrun: the pacer is not keeping up. This should be impossible, but never wedge the
            // capture thread over it - drop the oldest audio and carry on.
            var overflow = fill + data.Length - ring.Length;
            if (overflow > 0)
            {
                var discard = Math.Min(fill, Align(overflow + bytesPerFrame));
                head = (head + discard) % ring.Length;
                fill -= discard;
                dropped += discard;
            }

            var writable = Math.Min(data.Length, ring.Length - fill);
            var tail = (head + fill) % ring.Length;
            var firstChunk = Math.Min(writable, ring.Length - tail);
            data[..firstChunk].CopyTo(ring.AsSpan(tail));
            if (firstChunk < writable)
                data.Slice(firstChunk, writable - firstChunk).CopyTo(ring.AsSpan(0));

            fill += writable;
        }
    }

    private void PaceLoop()
    {
        // Ask Windows for 1ms timer granularity so Thread.Sleep is not quantised to ~15ms.
        _ = TimeBeginPeriod(1);
        try
        {
            var clock = Stopwatch.StartNew();
            long emitted = 0;
            var scratch = new byte[Align(bytesPerSecond / 10)];

            while (!cts.IsCancellationRequested)
            {
                var due = (long)(clock.Elapsed.TotalSeconds * bytesPerSecond);
                var owed = Align((int)Math.Min(due - emitted, scratch.Length));

                if (owed <= 0)
                {
                    Thread.Sleep(1);
                    continue;
                }

                var taken = Drain(scratch.AsSpan(0, owed));

                try
                {
                    output.Write(scratch, 0, owed);
                    output.Flush();
                }
                catch (Exception ex) when (ex is IOException or ObjectDisposedException)
                {
                    return; // downstream (ffmpeg) closed the pipe
                }

                emitted += owed;
                written += owed;
                padded += owed - taken;

                // Sleep until the next tick is due. Because `due` is derived from an absolute
                // Stopwatch reading, an overslept tick costs burstiness but never drift.
                var aheadBytes = emitted - due;
                var sleepMs = (int)(aheadBytes * 1000.0 / bytesPerSecond);
                if (sleepMs > 0) Thread.Sleep(Math.Min(sleepMs, TickMs));
            }
        }
        finally
        {
            _ = TimeEndPeriod(1);
        }
    }

    /// <summary>Fills <paramref name="dest"/> from the ring, zero-padding any shortfall.</summary>
    private int Drain(Span<byte> dest)
    {
        lock (gate)
        {
            // Priming: hold the output at silence until the jitter buffer has enough to survive the
            // next hiccup. Entered at startup and re-entered after any full drain.
            if (!primed)
            {
                if (fill < targetBytes)
                {
                    dest.Clear();
                    return 0;
                }

                primed = true;
            }

            // Drift trim: we are running persistently long, so quietly shed a frame.
            if (fill > highWaterBytes)
            {
                var trim = Math.Min(fill, TrimFramesPerTick * bytesPerFrame);
                head = (head + trim) % ring.Length;
                fill -= trim;
                trimmed += trim;
            }

            var take = Math.Min(dest.Length, fill);
            if (take > 0)
            {
                var firstChunk = Math.Min(take, ring.Length - head);
                ring.AsSpan(head, firstChunk).CopyTo(dest);
                if (firstChunk < take)
                    ring.AsSpan(0, take - firstChunk).CopyTo(dest[firstChunk..]);

                head = (head + take) % ring.Length;
                fill -= take;
            }

            if (take < dest.Length)
            {
                dest[take..].Clear();
                // Fully drained: the source stopped (paused app, device change). Re-prime so we
                // rebuild the jitter buffer instead of stuttering through the next few seconds.
                if (fill == 0) primed = false;
            }

            return take;
        }
    }

    public Stats Snapshot()
    {
        lock (gate)
        {
            return new Stats(
                BufferMs: Math.Round(fill * 1000.0 / bytesPerSecond, 1),
                TargetMs: Math.Round(targetBytes * 1000.0 / bytesPerSecond, 1),
                StreamedMs: Math.Round(written * 1000.0 / bytesPerSecond, 1),
                PaddedMs: Math.Round(padded * 1000.0 / bytesPerSecond, 1),
                DroppedMs: Math.Round(dropped * 1000.0 / bytesPerSecond, 1),
                TrimmedMs: Math.Round(trimmed * 1000.0 / bytesPerSecond, 1),
                Primed: primed);
        }
    }

    public void Dispose()
    {
        cts.Cancel();
        if (thread.IsAlive) thread.Join(500);
        cts.Dispose();
    }

    internal readonly record struct Stats(
        double BufferMs,
        double TargetMs,
        double StreamedMs,
        double PaddedMs,
        double DroppedMs,
        double TrimmedMs,
        bool Primed);

    [DllImport("winmm.dll", EntryPoint = "timeBeginPeriod")]
    private static extern uint TimeBeginPeriod(uint ms);

    [DllImport("winmm.dll", EntryPoint = "timeEndPeriod")]
    private static extern uint TimeEndPeriod(uint ms);
}
