// Agent screenshots of one window must show that window alone (#1329). The pinned Cua Driver
// falls back to copying the window's rectangle off the screen when Windows.Graphics.Capture
// fails, and that copy shows whatever covers the window. The driver does not say which path a
// capture took, so the helper decides from the screen itself: when anything else overlaps the
// target, the driver's image is replaced with the helper's own PrintWindow capture of the
// target, which reads the window's own content and never the screen.

using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace Goat.ComputerUse
{
    internal static class CaptureGuard
    {
        [StructLayout(LayoutKind.Sequential)]
        struct RECT { public int Left, Top, Right, Bottom; }

        const uint GW_HWNDPREV = 3;
        const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
        const int DWMWA_CLOAKED = 14;
        // Includes DirectComposition content (WinUI, UWP, Chromium) on Windows 8.1 and later.
        const uint PW_RENDERFULLCONTENT = 2;

        [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr window, uint command);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
        [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out RECT rect);
        [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr window, IntPtr dc, uint flags);
        [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out RECT value, int size);
        [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out int value, int size);

        /// <summary>
        /// Whether any visible window above the target in z-order overlaps its frame, other than
        /// the driver's own cursor overlay. Topmost windows, toasts and popups count. A target
        /// that is gone or minimized is not covered: the driver refuses to capture it.
        /// </summary>
        public static bool Covered(IntPtr target, string driverExecutable)
        {
            if (!NativeMethods.IsWindow(target) || NativeMethods.IsIconic(target)) return false;
            RECT frame;
            if (!Frame(target, out frame)) return true;
            for (IntPtr above = GetWindow(target, GW_HWNDPREV); above != IntPtr.Zero; above = GetWindow(above, GW_HWNDPREV))
            {
                if (!IsWindowVisible(above) || NativeMethods.IsIconic(above) || Cloaked(above)) continue;
                RECT other;
                if (!Frame(above, out other)) return true;
                bool overlaps = other.Left < frame.Right && frame.Left < other.Right && other.Top < frame.Bottom && frame.Top < other.Bottom;
                if (overlaps && !OwnedBy(above, driverExecutable)) return true;
            }
            return false;
        }

        /// <summary>
        /// The target's own pixels as a PNG of exactly width x height, cropped like the driver's
        /// PrintWindow path (DWM frame, 1 px inset) so element coordinates still line up. Null
        /// when Windows draws nothing usable: then no screenshot is better than a wrong one.
        /// </summary>
        public static byte[] CaptureAlone(IntPtr target, int width, int height)
        {
            RECT window;
            if (width <= 0 || height <= 0 || !GetWindowRect(target, out window)) return null;
            int fullWidth = window.Right - window.Left, fullHeight = window.Bottom - window.Top;
            if (fullWidth <= 0 || fullHeight <= 0) return null;
            using (var full = new Bitmap(fullWidth, fullHeight, PixelFormat.Format24bppRgb))
            {
                bool printed;
                using (Graphics graphics = Graphics.FromImage(full))
                {
                    IntPtr dc = graphics.GetHdc();
                    try { printed = PrintWindow(target, dc, PW_RENDERFULLCONTENT); }
                    finally { graphics.ReleaseHdc(dc); }
                }
                if (!printed) return null;
                var crop = new Rectangle(0, 0, fullWidth, fullHeight);
                RECT bounds;
                if (DwmGetWindowAttribute(target, DWMWA_EXTENDED_FRAME_BOUNDS, out bounds, Marshal.SizeOf(typeof(RECT))) == 0)
                {
                    var inset = Rectangle.FromLTRB(bounds.Left + 1 - window.Left, bounds.Top + 1 - window.Top,
                        bounds.Right - 1 - window.Left, bounds.Bottom - 1 - window.Top);
                    if (inset.Width > 0 && inset.Height > 0 && crop.Contains(inset)) crop = inset;
                }
                using (Bitmap cropped = full.Clone(crop, PixelFormat.Format24bppRgb))
                {
                    if (MostlyBlack(cropped)) return null;
                    using (var scaled = new Bitmap(width, height, PixelFormat.Format24bppRgb))
                    {
                        using (Graphics graphics = Graphics.FromImage(scaled))
                        {
                            graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
                            graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
                            graphics.DrawImage(cropped, new Rectangle(0, 0, width, height));
                        }
                        using (var png = new MemoryStream())
                        {
                            scaled.Save(png, ImageFormat.Png);
                            return png.ToArray();
                        }
                    }
                }
            }
        }

        /// <summary>The pixel size of an encoded image, or null when it does not decode.</summary>
        public static Size? ImageSize(byte[] encoded)
        {
            try
            {
                using (var stream = new MemoryStream(encoded))
                using (Image image = Image.FromStream(stream, false, false))
                    return image.Size;
            }
            catch (ArgumentException) { return null; }
        }

        static bool Frame(IntPtr window, out RECT rect)
        {
            if (DwmGetWindowAttribute(window, DWMWA_EXTENDED_FRAME_BOUNDS, out rect, Marshal.SizeOf(typeof(RECT))) == 0) return true;
            return GetWindowRect(window, out rect);
        }

        static bool Cloaked(IntPtr window)
        {
            int cloaked;
            return DwmGetWindowAttribute(window, DWMWA_CLOAKED, out cloaked, sizeof(int)) == 0 && cloaked != 0;
        }

        static bool OwnedBy(IntPtr window, string executable)
        {
            int pid;
            NativeMethods.GetWindowThreadProcessId(window, out pid);
            IntPtr process = NativeMethods.OpenProcess(NativeMethods.PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (process == IntPtr.Zero) return false;
            try
            {
                var name = new StringBuilder(1024);
                int size = name.Capacity;
                return NativeMethods.QueryFullProcessImageNameW(process, 0, name, ref size) &&
                    string.Equals(name.ToString(), executable, StringComparison.OrdinalIgnoreCase);
            }
            finally { NativeMethods.CloseHandle(process); }
        }

        static bool MostlyBlack(Bitmap bitmap)
        {
            BitmapData data = bitmap.LockBits(new Rectangle(0, 0, bitmap.Width, bitmap.Height), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
            try
            {
                var row = new byte[Math.Abs(data.Stride)];
                int samples = 0, dark = 0;
                for (int y = 0; y < bitmap.Height; y += 4)
                {
                    Marshal.Copy(IntPtr.Add(data.Scan0, y * data.Stride), row, 0, row.Length);
                    for (int x = 0; x < bitmap.Width; x += 4)
                    {
                        samples++;
                        if (row[x * 3] < 16 && row[x * 3 + 1] < 16 && row[x * 3 + 2] < 16) dark++;
                    }
                }
                return samples == 0 || dark * 100 >= samples * 98;
            }
            finally { bitmap.UnlockBits(data); }
        }
    }
}

