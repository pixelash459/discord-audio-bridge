using System.Runtime.InteropServices;

namespace BridgeApp;

/// <summary>
/// The small amount of Win32 the shell needs: modern window chrome, and global hotkeys.
///
/// Both exist for the same reason. This is a background tool - the window spends most of its life
/// hidden in the tray while music plays - so muting should not require finding and focusing it,
/// and on the occasions it *is* on screen it should not look like it was built in 2009.
/// </summary>
internal static class Native
{
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;
    /// <summary>DWMWA_USE_IMMERSIVE_DARK_MODE. Paints the title bar to match a dark client area.</summary>
    private const int UseImmersiveDarkMode = 20;

    /// <summary>DWMWA_SYSTEMBACKDROP_TYPE, public since Windows 11 22H2.</summary>
    private const int SystemBackdropType = 38;

    /// <summary>DWMSBT_MAINWINDOW - the Mica material, for a primary window.</summary>
    private const int BackdropMica = 2;

    public const int WmHotkey = 0x0312;

    [Flags]
    public enum HotkeyModifiers : uint
    {
        Alt = 0x0001,
        Control = 0x0002,
        Shift = 0x0004,
        NoRepeat = 0x4000,
    }

    /// <summary>Hotkey identifiers, also used as the WM_HOTKEY wParam.</summary>
    public enum Hotkey
    {
        ToggleMute = 1,
        Stop = 2,
        ShowWindow = 3,
    }

    /// <summary>
    /// Applies dark chrome and, where the OS supports it, the Mica backdrop.
    ///
    /// Both attributes are simply ignored by older builds, so there is no version check: an
    /// unsupported attribute returns a failure HRESULT that we have no use for. Never throws -
    /// cosmetics must not be able to stop the window from opening.
    /// </summary>
    public static void ApplyModernChrome(IntPtr handle)
    {
        if (handle == IntPtr.Zero) return;

        try
        {
            var enabled = 1;
            _ = DwmSetWindowAttribute(handle, UseImmersiveDarkMode, ref enabled, sizeof(int));

            var backdrop = BackdropMica;
            _ = DwmSetWindowAttribute(handle, SystemBackdropType, ref backdrop, sizeof(int));
        }
        catch (Exception)
        {
            // dwmapi.dll missing or the attribute unsupported; the window is merely less pretty.
        }
    }

    /// <summary>
    /// Places a child in a kill-on-close job. If the shell is terminated without running Dispose,
    /// Windows closes this process's job handle and tears down Node, ffmpeg, and AudioTap with it.
    /// </summary>
    public static IntPtr CreateKillOnCloseJob(IntPtr process)
    {
        var job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) return IntPtr.Zero;

        var info = new JobObjectExtendedLimitInformation
        {
            BasicLimitInformation = new JobObjectBasicLimitInformation
            {
                LimitFlags = JobObjectLimitKillOnJobClose,
            },
        };
        var size = Marshal.SizeOf<JobObjectExtendedLimitInformation>();
        var pointer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(info, pointer, false);
            if (!SetInformationJobObject(job, 9, pointer, (uint)size)
                || !AssignProcessToJobObject(job, process))
            {
                _ = CloseHandle(job);
                return IntPtr.Zero;
            }
            return job;
        }
        finally
        {
            Marshal.FreeHGlobal(pointer);
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectBasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectExtendedLimitInformation
    {
        public JobObjectBasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    private static extern IntPtr CreateJobObject(IntPtr securityAttributes, string? name);

    [DllImport("kernel32.dll", SetLastError = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(IntPtr job, int informationClass, IntPtr information, uint length);

    [DllImport("kernel32.dll", SetLastError = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CloseHandle(IntPtr handle);

    [DllImport("dwmapi.dll", SetLastError = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    private static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int size);

    [DllImport("user32.dll", SetLastError = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool RegisterHotKey(IntPtr window, int id, uint modifiers, uint virtualKey);

    [DllImport("user32.dll", SetLastError = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool UnregisterHotKey(IntPtr window, int id);

    [DllImport("user32.dll", SetLastError = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    public static extern bool DestroyIcon(IntPtr handle);
}
