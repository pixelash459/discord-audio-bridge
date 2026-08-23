using System.IO;

namespace BridgeApp;

internal static class Program
{
    // WinForms requires STA; WebView2 does too.
    [STAThread]
    private static void Main(string[] args)
    {
        ApplicationConfiguration.Initialize();

        // One window per machine. A second launch just raises the first, which matters because the
        // bot underneath owns a fixed control port and a voice connection.
        using var singleInstance = new Mutex(true, @"Local\DiscordAudioBridge.Desktop", out var isFirst);
        if (!isFirst)
        {
            MessageBox.Show(
                "Discord Audio Bridge is already running. Look for the headphone icon in the " +
                "notification area, next to the clock.",
                "Already running",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);
            return;
        }

        // --project-root <path> wins, then BRIDGE_PROJECT_ROOT, then a walk up from the exe.
        var index = Array.FindIndex(args, a => a.Equals("--project-root", StringComparison.OrdinalIgnoreCase));
        var overridePath = index >= 0 && index + 1 < args.Length ? args[index + 1] : null;

        string? projectRoot;
        try
        {
            projectRoot = BotProcess.FindProjectRoot(overridePath);
        }
        catch (DirectoryNotFoundException ex)
        {
            MessageBox.Show(ex.Message, "Project not found", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }

        if (projectRoot is null)
        {
            MessageBox.Show(
                "Could not find the discord-audio-bridge project folder.\n\n" +
                "This app starts the bot from src/index.ts, so it needs to know where the " +
                "repository is. It normally finds it by walking up from its own location.\n\n" +
                "If you moved the executable, point it at the repository with either:\n" +
                "    DiscordAudioBridge.exe --project-root C:\\path\\to\\discord-audio-bridge\n" +
                "    setx BRIDGE_PROJECT_ROOT C:\\path\\to\\discord-audio-bridge",
                "Project not found",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return;
        }

        AppLog.Initialize(projectRoot);
        AppDomain.CurrentDomain.UnhandledException += (_, e) =>
        {
            if (e.ExceptionObject is Exception ex) AppLog.Error("unhandled desktop exception", ex);
        };
        Application.ThreadException += (_, e) => AppLog.Error("unhandled UI exception", e.Exception);

        // The bot is disposed after the message loop ends, which stops it only if we started it.
        using var bot = new BotProcess(projectRoot);
        var startMinimized = args.Any(a => a.Equals("--minimized", StringComparison.OrdinalIgnoreCase));
        Application.Run(new MainForm(bot, startMinimized));
        AppLog.Info("desktop launcher stopped");
    }
}
