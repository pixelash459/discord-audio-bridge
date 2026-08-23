using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Serialization;
using NAudio.CoreAudioApi;
using NAudio.Wave;

namespace AudioTap;

internal sealed record DeviceInfo(
    string Id,
    string Name,
    bool IsDefault,
    int SampleRate,
    int Channels,
    string SampleFormat);

internal sealed record ProcessInfo(
    uint Pid,
    string Name,
    string DisplayName,
    string State,
    float Peak,
    string DeviceId,
    string? Icon = null);

internal static class Enumerate
{
    public static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    public static List<DeviceInfo> Devices()
    {
        using var enumerator = new MMDeviceEnumerator();

        string? defaultId = null;
        try
        {
            using var def = enumerator.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia);
            defaultId = def.ID;
        }
        catch (Exception)
        {
            // No render endpoint at all. Leave defaultId null.
        }

        var results = new List<DeviceInfo>();
        foreach (var device in enumerator.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active))
        {
            using (device)
            {
                var format = Formats.Normalise(device.CreateAudioClient().MixFormat);
                results.Add(new DeviceInfo(
                    device.ID,
                    device.FriendlyName,
                    device.ID == defaultId,
                    format.SampleRate,
                    format.Channels,
                    Formats.ToFfmpegName(format)));
            }
        }

        return results;
    }

    /// <summary>
    /// Every process currently holding a render session on any active endpoint. This is the list a
    /// user actually wants to pick from - it is short, and it only contains apps that make sound.
    /// </summary>
    public static List<ProcessInfo> Processes(bool withIcons = false)
    {
        using var enumerator = new MMDeviceEnumerator();
        var byPid = new Dictionary<uint, ProcessInfo>();

        foreach (var device in enumerator.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active))
        {
            using (device)
            {
                SessionCollection sessions;
                try
                {
                    sessions = device.AudioSessionManager.Sessions;
                }
                catch (Exception)
                {
                    continue; // some virtual endpoints refuse session enumeration
                }

                for (var i = 0; i < sessions.Count; i++)
                {
                    var session = sessions[i];
                    uint pid;
                    try
                    {
                        pid = session.GetProcessID;
                    }
                    catch (Exception)
                    {
                        continue;
                    }

                    if (pid == 0) continue;

                    var state = session.State.ToString();
                    var peak = Safe(() => session.AudioMeterInformation.MasterPeakValue, 0f);
                    var display = Safe(() => session.DisplayName, string.Empty);
                    var name = ProcessName(pid);
                    if (string.IsNullOrWhiteSpace(display)) display = name;

                    // A process can render on several endpoints. Keep the liveliest entry.
                    if (byPid.TryGetValue(pid, out var existing) && existing.Peak >= peak) continue;

                    byPid[pid] = new ProcessInfo(
                        pid,
                        name,
                        display,
                        state,
                        peak,
                        device.ID,
                        withIcons ? AppIcons.For(pid) : null);
                }
            }
        }

        return byPid.Values
            .OrderByDescending(p => p.State == "Active")
            .ThenByDescending(p => p.Peak)
            .ThenBy(p => p.Name, StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    private static string ProcessName(uint pid)
    {
        try
        {
            using var process = Process.GetProcessById((int)pid);
            return process.ProcessName;
        }
        catch (Exception)
        {
            return $"pid {pid}";
        }
    }

    private static T Safe<T>(Func<T> get, T fallback)
    {
        try { return get(); }
        catch (Exception) { return fallback; }
    }
}

internal static class Formats
{
    /// <summary>
    /// The mix format is almost always WAVE_FORMAT_EXTENSIBLE. Collapse it to the plain
    /// WaveFormat it actually represents so the encoding/bit-depth checks below work.
    /// </summary>
    public static WaveFormat Normalise(WaveFormat format) =>
        format is WaveFormatExtensible extensible ? Safe(extensible) : format;

    private static WaveFormat Safe(WaveFormatExtensible extensible)
    {
        try { return extensible.ToStandardWaveFormat(); }
        catch (Exception) { return extensible; }
    }

    /// <summary>Maps a WaveFormat onto the raw-PCM demuxer name ffmpeg expects after -f.</summary>
    public static string ToFfmpegName(WaveFormat format) => format.Encoding switch
    {
        WaveFormatEncoding.IeeeFloat when format.BitsPerSample == 32 => "f32le",
        WaveFormatEncoding.IeeeFloat when format.BitsPerSample == 64 => "f64le",
        WaveFormatEncoding.Pcm when format.BitsPerSample == 16 => "s16le",
        WaveFormatEncoding.Pcm when format.BitsPerSample == 24 => "s24le",
        WaveFormatEncoding.Pcm when format.BitsPerSample == 32 => "s32le",
        _ => "unsupported",
    };

    public static int BytesPerSample(WaveFormat format) => format.BitsPerSample / 8;
}
