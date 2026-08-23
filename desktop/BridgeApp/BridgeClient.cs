using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace BridgeApp;

/// <summary>What the shell needs to know about the bridge, distilled from the control snapshot.</summary>
internal sealed record BridgeState(bool Ready, bool Streaming, bool Muted, string? Label, string? Track)
{
    public static readonly BridgeState Offline = new(false, false, false, null, null);

    /// <summary>One line for the tray tooltip, which Windows truncates at 127 characters.</summary>
    public string Tooltip
    {
        get
        {
            if (!Ready) return "Discord Audio Bridge — connecting";
            if (!Streaming) return "Discord Audio Bridge — idle";
            var what = Track ?? Label ?? "audio";
            var line = $"{(Muted ? "Muted" : "Streaming")}: {what}";
            return line.Length > 120 ? $"{line[..119]}…" : line;
        }
    }
}

/// <summary>
/// A very small client for the loopback control API.
///
/// The shell used to be a pure WebView host, which meant the tray icon could say nothing about
/// what the bot was doing and the tray menu could not do anything either. Reading the same snapshot
/// the panel reads - and posting the same two actions - is what lets the icon reflect state and the
/// menu carry Mute and Stop, so the common case never needs the window at all.
/// </summary>
internal sealed class BridgeClient
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(3) };

    private readonly ControlEndpoint endpoint;

    public BridgeClient(ControlEndpoint endpoint) => this.endpoint = endpoint;

    /// <summary>The guild of the first live session, which is what the tray actions operate on.</summary>
    public string? PrimaryGuildId { get; private set; }

    public async Task<BridgeState> ReadAsync(CancellationToken cancel)
    {
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, endpoint.StateUrl);
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", endpoint.Token);
            using var response = await Http.SendAsync(request, cancel);
            if (!response.IsSuccessStatusCode) return BridgeState.Offline;

            using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync(cancel));
            var root = json.RootElement;

            var ready = root.TryGetProperty("bot", out var bot)
                && bot.TryGetProperty("ready", out var readyValue)
                && readyValue.ValueKind == JsonValueKind.True;

            string? track = null;
            if (root.TryGetProperty("nowPlaying", out var playing) && playing.ValueKind == JsonValueKind.Object)
            {
                var title = playing.TryGetProperty("title", out var t) ? t.GetString() : null;
                var artist = playing.TryGetProperty("artist", out var a) ? a.GetString() : null;
                if (!string.IsNullOrWhiteSpace(title))
                {
                    track = string.IsNullOrWhiteSpace(artist) ? title : $"{artist} - {title}";
                }
            }

            if (!root.TryGetProperty("sessions", out var sessions)
                || sessions.ValueKind != JsonValueKind.Array
                || sessions.GetArrayLength() == 0)
            {
                PrimaryGuildId = null;
                return new BridgeState(ready, false, false, null, track);
            }

            var first = sessions[0];
            PrimaryGuildId = first.TryGetProperty("guildId", out var guild) ? guild.GetString() : null;
            var muted = first.TryGetProperty("muted", out var mutedValue)
                && mutedValue.ValueKind == JsonValueKind.True;

            string? label = null;
            if (first.TryGetProperty("sources", out var sourcesValue)
                && sourcesValue.ValueKind == JsonValueKind.Array)
            {
                var labels = sourcesValue.EnumerateArray()
                    .Select(source => source.TryGetProperty("label", out var value) ? value.GetString() : null)
                    .Where(value => !string.IsNullOrWhiteSpace(value));
                label = string.Join(" + ", labels!);
            }
            if (string.IsNullOrWhiteSpace(label)
                && first.TryGetProperty("source", out var source)
                && source.TryGetProperty("label", out var labelValue))
            {
                label = labelValue.GetString();
            }

            return new BridgeState(ready, true, muted, label, track);
        }
        catch (Exception)
        {
            // A poll that fails is not news: the bot may be restarting. The caller shows "offline"
            // and tries again on the next tick.
            return BridgeState.Offline;
        }
    }

    public Task<bool> ToggleMuteAsync(bool muted, CancellationToken cancel) =>
        PostAsync("mute", $"{{\"guildId\":\"{PrimaryGuildId}\",\"muted\":{(muted ? "true" : "false")}}}", cancel);

    public Task<bool> StopAsync(CancellationToken cancel) =>
        PostAsync("stop", $"{{\"guildId\":\"{PrimaryGuildId}\"}}", cancel);

    private async Task<bool> PostAsync(string route, string body, CancellationToken cancel)
    {
        if (string.IsNullOrEmpty(PrimaryGuildId)) return false;

        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, $"http://127.0.0.1:{endpoint.Port}/api/{route}")
            {
                Content = new StringContent(body, Encoding.UTF8, "application/json"),
            };
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", endpoint.Token);
            using var response = await Http.SendAsync(request, cancel);
            return response.IsSuccessStatusCode;
        }
        catch (Exception ex)
        {
            AppLog.Error($"tray action failed: {route}", ex);
            return false;
        }
    }
}
