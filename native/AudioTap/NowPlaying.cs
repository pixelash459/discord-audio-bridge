using System.IO;
using System.Runtime.Versioning;
using Windows.Media.Control;
using Windows.Storage.Streams;

namespace AudioTap;

internal sealed record TrackInfo(
    string Title,
    string Artist,
    string Album,
    string AppId,
    string Status,
    string? Artwork);

/// <summary>
/// The current track, read from the Windows system media transport controls.
///
/// This is the same source the volume flyout and the lock screen use, so it works for Spotify, the
/// browser, VLC, and anything else that registers an SMTC session - no per-application integration
/// and no scraping window titles. It is what turns "streaming Spotify.exe" into "streaming the song
/// that is actually playing", which is the difference between a plumbing tool and a nice one.
///
/// Every call is best-effort. The WinRT projection is unavailable in non-interactive sessions, some
/// applications register a session and then never populate it, and none of that should ever affect
/// capture - a missing track just means the panel shows the application name as before.
/// </summary>
[SupportedOSPlatform("windows10.0.17763.0")]
internal static class NowPlaying
{
    /// <summary>Artwork is inlined into JSON, so keep it small enough to send twice a second.</summary>
    private const int MaxArtworkBytes = 256 * 1024;

    private static GlobalSystemMediaTransportControlsSessionManager? manager;

    /// <summary>
    /// Resolves the session manager once. Failure is cached as "unavailable" only for this call:
    /// the manager can legitimately appear later, when the first media application starts.
    /// </summary>
    public static async Task<GlobalSystemMediaTransportControlsSessionManager?> ManagerAsync()
    {
        if (manager is not null) return manager;
        try
        {
            manager = await GlobalSystemMediaTransportControlsSessionManager.RequestAsync();
        }
        catch (Exception)
        {
            manager = null;
        }
        return manager;
    }

    public static async Task<TrackInfo?> ReadAsync(bool withArtwork = true)
    {
        var sessions = await ManagerAsync();
        var session = SafeCurrent(sessions);
        if (session is null) return null;

        try
        {
            var properties = await session.TryGetMediaPropertiesAsync();
            if (properties is null) return null;

            var title = properties.Title?.Trim() ?? string.Empty;
            if (title.Length == 0) return null;

            var status = "Unknown";
            try
            {
                status = session.GetPlaybackInfo().PlaybackStatus.ToString();
            }
            catch (Exception)
            {
                // Some sessions expose properties but not playback info.
            }

            return new TrackInfo(
                Title: title,
                Artist: properties.Artist?.Trim() ?? string.Empty,
                Album: properties.AlbumTitle?.Trim() ?? string.Empty,
                AppId: SafeAppId(session),
                Status: status,
                Artwork: withArtwork ? await ArtworkAsync(properties.Thumbnail) : null);
        }
        catch (Exception)
        {
            return null;
        }
    }

    private static GlobalSystemMediaTransportControlsSession? SafeCurrent(
        GlobalSystemMediaTransportControlsSessionManager? sessions)
    {
        try
        {
            return sessions?.GetCurrentSession();
        }
        catch (Exception)
        {
            return null;
        }
    }

    private static string SafeAppId(GlobalSystemMediaTransportControlsSession session)
    {
        try
        {
            return session.SourceAppUserModelId ?? string.Empty;
        }
        catch (Exception)
        {
            return string.Empty;
        }
    }

    private static async Task<string?> ArtworkAsync(IRandomAccessStreamReference? thumbnail)
    {
        if (thumbnail is null) return null;

        try
        {
            using var source = await thumbnail.OpenReadAsync();
            if (source.Size == 0 || source.Size > MaxArtworkBytes) return null;

            using var stream = source.AsStreamForRead();
            using var buffer = new MemoryStream();
            await stream.CopyToAsync(buffer);
            return Convert.ToBase64String(buffer.ToArray());
        }
        catch (Exception)
        {
            return null;
        }
    }
}
