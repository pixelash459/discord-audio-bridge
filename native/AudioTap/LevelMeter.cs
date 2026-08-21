using System.Runtime.InteropServices;

namespace AudioTap;

/// <summary>
/// Per-channel peak and RMS over the interval between two reads.
///
/// Measured after gain, so the numbers describe what actually leaves the tap rather than what
/// arrived at it. Cheap enough to run on the capture callback: one pass, no allocation.
/// </summary>
internal sealed class LevelMeter(int channels)
{
    private readonly object gate = new();
    private readonly double[] sumSquares = new double[channels];
    private readonly float[] peaks = new float[channels];
    private long frames;

    public void Add(ReadOnlySpan<byte> buffer, bool isFloat)
    {
        if (!isFloat || buffer.IsEmpty) return;

        var samples = MemoryMarshal.Cast<byte, float>(buffer);
        if (samples.Length < channels) return;

        lock (gate)
        {
            for (var i = 0; i + channels <= samples.Length; i += channels)
            {
                for (var c = 0; c < channels; c++)
                {
                    var v = samples[i + c];
                    if (float.IsNaN(v)) continue;

                    var magnitude = Math.Abs(v);
                    if (magnitude > peaks[c]) peaks[c] = magnitude;
                    sumSquares[c] += (double)v * v;
                }

                frames++;
            }
        }
    }

    /// <summary>Reads the levels accumulated since the previous call, then resets.</summary>
    public Reading Read()
    {
        lock (gate)
        {
            var peak = new float[channels];
            var rms = new double[channels];

            for (var c = 0; c < channels; c++)
            {
                peak[c] = peaks[c];
                rms[c] = frames > 0 ? Math.Sqrt(sumSquares[c] / frames) : 0;
                peaks[c] = 0;
                sumSquares[c] = 0;
            }

            var counted = frames;
            frames = 0;

            return new Reading(
                Peak: peak.Select(ToDbfs).ToArray(),
                Rms: rms.Select(v => ToDbfs((float)v)).ToArray(),
                PeakLinear: peak,
                Frames: counted);
        }
    }

    /// <summary>-100 dB stands in for digital silence, which would otherwise be negative infinity.</summary>
    private static double ToDbfs(float amplitude) =>
        amplitude <= 1e-5f ? -100 : Math.Round(20 * Math.Log10(amplitude), 1);

    internal readonly record struct Reading(double[] Peak, double[] Rms, float[] PeakLinear, long Frames);
}
