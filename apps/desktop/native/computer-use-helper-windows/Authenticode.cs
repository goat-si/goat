using System;
using System.Runtime.InteropServices;

namespace Goat.ComputerUse
{
    /// <summary>WinVerifyTrust with the generic Authenticode policy, without UI and without a network revocation fetch.</summary>
    internal static class Authenticode
    {
        static readonly Guid GenericVerifyV2 = new Guid("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");
        const uint WTD_UI_NONE = 2;
        const uint WTD_REVOKE_NONE = 0;
        const uint WTD_CHOICE_FILE = 1;
        const uint WTD_STATEACTION_VERIFY = 1;
        const uint WTD_STATEACTION_CLOSE = 2;
        const uint WTD_CACHE_ONLY_URL_RETRIEVAL = 0x1000;

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct WINTRUST_FILE_INFO
        {
            public uint cbStruct;
            public string pcwszFilePath;
            public IntPtr hFile;
            public IntPtr pgKnownSubject;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct WINTRUST_DATA
        {
            public uint cbStruct;
            public IntPtr pPolicyCallbackData;
            public IntPtr pSIPClientData;
            public uint dwUIChoice;
            public uint fdwRevocationChecks;
            public uint dwUnionChoice;
            public IntPtr pFile;
            public uint dwStateAction;
            public IntPtr hWVTStateData;
            public IntPtr pwszURLReference;
            public uint dwProvFlags;
            public uint dwUIContext;
            public IntPtr pSignatureSettings;
        }

        [DllImport("wintrust.dll", CharSet = CharSet.Unicode)]
        static extern int WinVerifyTrust(IntPtr window, [MarshalAs(UnmanagedType.LPStruct)] Guid action, ref WINTRUST_DATA data);

        public static bool Verify(string path)
        {
            var file = new WINTRUST_FILE_INFO { cbStruct = (uint)Marshal.SizeOf(typeof(WINTRUST_FILE_INFO)), pcwszFilePath = path };
            IntPtr filePointer = Marshal.AllocHGlobal(Marshal.SizeOf(file));
            try
            {
                Marshal.StructureToPtr(file, filePointer, false);
                var data = new WINTRUST_DATA
                {
                    cbStruct = (uint)Marshal.SizeOf(typeof(WINTRUST_DATA)),
                    dwUIChoice = WTD_UI_NONE,
                    fdwRevocationChecks = WTD_REVOKE_NONE,
                    dwUnionChoice = WTD_CHOICE_FILE,
                    pFile = filePointer,
                    dwStateAction = WTD_STATEACTION_VERIFY,
                    dwProvFlags = WTD_CACHE_ONLY_URL_RETRIEVAL,
                };
                int status = WinVerifyTrust(IntPtr.Zero, GenericVerifyV2, ref data);
                data.dwStateAction = WTD_STATEACTION_CLOSE;
                WinVerifyTrust(IntPtr.Zero, GenericVerifyV2, ref data);
                return status == 0;
            }
            finally
            {
                Marshal.DestroyStructure(filePointer, typeof(WINTRUST_FILE_INFO));
                Marshal.FreeHGlobal(filePointer);
            }
        }
    }
}
