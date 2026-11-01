using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace Goat.ComputerUse
{
    /// <summary>Win32 entry points the helper uses. Everything here is in-box on Windows 10 1607+.</summary>
    internal static class NativeMethods
    {
        public const uint CREATE_SUSPENDED = 0x00000004;
        public const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
        public const uint CREATE_NO_WINDOW = 0x08000000;
        public const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
        public const int STARTF_USESTDHANDLES = 0x00000100;
        public const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
        public const uint TOKEN_QUERY = 0x0008;
        public const uint GENERIC_READ = 0x80000000;
        public const uint GENERIC_WRITE = 0x40000000;
        public const uint OPEN_EXISTING = 3;
        public const uint FILE_READ_ATTRIBUTES = 0x80;
        public const uint FILE_SHARE_READ = 1;
        public const uint FILE_SHARE_WRITE = 2;
        public const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
        public const uint DUPLICATE_SAME_ACCESS = 2;
        public const int ERROR_FILE_NOT_FOUND = 2;
        public const int ERROR_PIPE_BUSY = 231;
        public const int ERROR_SEM_TIMEOUT = 121;
        public const uint WAIT_OBJECT_0 = 0;
        public const uint DESKTOP_READOBJECTS = 0x0001;
        public const int UOI_NAME = 2;
        public const uint MONITOR_DEFAULTTONEAREST = 2;
        public const int TokenElevation = 20;
        public const int TokenIntegrityLevel = 25;
        public const int JobObjectExtendedLimitInformation = 9;
        public const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
        public const uint JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION = 0x400;
        public const int WTSConnectState = 8;
        public const uint HANDLE_FLAG_INHERIT = 1;
        public static readonly IntPtr PROC_THREAD_ATTRIBUTE_HANDLE_LIST = (IntPtr)0x00020002;

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct STARTUPINFO
        {
            public int cb;
            public string lpReserved;
            public string lpDesktop;
            public string lpTitle;
            public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute;
            public int dwFlags;
            public short wShowWindow;
            public short cbReserved2;
            public IntPtr lpReserved2;
            public IntPtr hStdInput, hStdOutput, hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct STARTUPINFOEX
        {
            public STARTUPINFO StartupInfo;
            public IntPtr lpAttributeList;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct PROCESS_INFORMATION
        {
            public IntPtr hProcess, hThread;
            public int dwProcessId, dwThreadId;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct SECURITY_ATTRIBUTES
        {
            public int nLength;
            public IntPtr lpSecurityDescriptor;
            public bool bInheritHandle;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass, SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct IO_COUNTERS
        {
            public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
            public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct PROCESS_BASIC_INFORMATION
        {
            public IntPtr ExitStatus, PebBaseAddress, AffinityMask, BasePriority, UniqueProcessId, InheritedFromUniqueProcessId;
        }

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern bool CreateProcessW(string applicationName, StringBuilder commandLine, IntPtr processAttributes,
            IntPtr threadAttributes, bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory,
            ref STARTUPINFOEX startupInfo, out PROCESS_INFORMATION processInformation);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value,
            IntPtr size, IntPtr previousValue, IntPtr returnSize);

        [DllImport("kernel32.dll")]
        public static extern void DeleteProcThreadAttributeList(IntPtr list);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool CreatePipe(out SafeFileHandle readPipe, out SafeFileHandle writePipe, ref SECURITY_ATTRIBUTES attributes, int size);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool SetHandleInformation(SafeHandle handle, uint mask, uint flags);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern IntPtr GetStdHandle(int handle);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern uint ResumeThread(IntPtr thread);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool CloseHandle(IntPtr handle);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool TerminateProcess(IntPtr process, uint exitCode);

        [DllImport("kernel32.dll")]
        public static extern IntPtr GetCurrentProcess();

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target,
            uint access, bool inherit, uint options);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern int GetFinalPathNameByHandleW(SafeFileHandle file, StringBuilder path, int length, uint flags);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int length);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool TerminateJobObject(IntPtr job, uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern bool WaitNamedPipeW(string name, uint timeout);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool GetNamedPipeServerProcessId(SafeFileHandle pipe, out uint serverProcessId);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool ProcessIdToSessionId(uint processId, out uint sessionId);

        [DllImport("kernel32.dll")]
        public static extern uint WTSGetActiveConsoleSessionId();

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern IntPtr OpenProcess(uint access, bool inherit, int processId);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern bool QueryFullProcessImageNameW(IntPtr process, int flags, StringBuilder name, ref int size);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);

        [DllImport("advapi32.dll", SetLastError = true)]
        public static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);

        [DllImport("advapi32.dll", SetLastError = true)]
        public static extern bool GetTokenInformation(IntPtr token, int infoClass, IntPtr info, int length, out int returned);

        [DllImport("advapi32.dll")]
        public static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);

        [DllImport("advapi32.dll")]
        public static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);

        [DllImport("ntdll.dll")]
        public static extern int NtQueryInformationProcess(IntPtr process, int infoClass, ref PROCESS_BASIC_INFORMATION info, int length, out int returned);

        [DllImport("wtsapi32.dll", SetLastError = true)]
        public static extern bool WTSQuerySessionInformationW(IntPtr server, uint sessionId, int infoClass, out IntPtr buffer, out int bytes);

        [DllImport("wtsapi32.dll")]
        public static extern void WTSFreeMemory(IntPtr memory);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool CloseDesktop(IntPtr desktop);

        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern bool GetUserObjectInformationW(IntPtr handle, int index, StringBuilder info, int length, out int needed);

        [DllImport("user32.dll")]
        public static extern bool IsWindow(IntPtr window);

        [DllImport("user32.dll")]
        public static extern bool IsIconic(IntPtr window);

        [DllImport("user32.dll")]
        public static extern uint GetWindowThreadProcessId(IntPtr window, out int processId);

        [DllImport("user32.dll")]
        public static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);

        [DllImport("user32.dll")]
        public static extern uint GetDpiForWindow(IntPtr window);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetWindowTextW(IntPtr window, StringBuilder text, int max);

        public static Win32Exception LastError(string what)
        {
            int code = Marshal.GetLastWin32Error();
            return new Win32Exception(code, what + " failed (" + code + ")");
        }
    }

    /// <summary>The documented shell interface that names a window's virtual desktop.</summary>
    [ComImport, Guid("a5cd92ff-29be-454c-8d04-d82879fb3f1b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IVirtualDesktopManager
    {
        [PreserveSig] int IsWindowOnCurrentVirtualDesktop(IntPtr topLevelWindow, out bool onCurrentDesktop);
        [PreserveSig] int GetWindowDesktopId(IntPtr topLevelWindow, out Guid desktopId);
        [PreserveSig] int MoveWindowToDesktop(IntPtr topLevelWindow, ref Guid desktopId);
    }

    [ComImport, Guid("aa509086-5ca9-4c25-8f95-589d3c07b48a")]
    internal class VirtualDesktopManager { }
}
