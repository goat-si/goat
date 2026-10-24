// Agent screenshots of one window must show that window alone (#1329). The pinned Cua Driver
// falls back to copying the window's rectangle off the screen when Windows.Graphics.Capture
// fails, says nothing about it, and the copy shows whatever covered the window at that moment.
// Checking for covering windows before and after cannot see one that came and went during the
// copy, so the helper never passes the driver's window pixels on: it captures the window itself
// with PrintWindow, which reads the window's own content and never the screen.

using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

namespace Goat.ComputerUse
{
    internal static class CaptureGuard
    {
        [StructLayout(LayoutKind.Sequential)]
        struct RECT { public int Left, Top, Right, Bottom; }

        const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
        // Includes DirectComposition content (WinUI, UWP, Chromium) on Windows 8.1 and later.
        const uint PW_RENDERFULLCONTENT = 2;

        [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out RECT rect);
        [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr window, IntPtr dc, uint flags);
        [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out RECT value, int size);

        /// <summary>
        /// The window's own pixels at native size, cropped like the driver's PrintWindow path (DWM
        /// frame, 1 px inset) so the driver's element coordinates line up. Null when Windows draws
        /// nothing usable: then no screenshot is better than a wrong one.
        /// </summary>
        public static Bitmap CaptureNative(IntPtr target)
        {
            RECT window;
            if (!NativeMethods.IsWindow(target) || NativeMethods.IsIconic(target) || !GetWindowRect(target, out window)) return null;
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
                Bitmap cropped = full.Clone(crop, PixelFormat.Format24bppRgb);
                if (!MostlyBlack(cropped)) return cropped;
                cropped.Dispose();
                return null;
            }
        }

        /// <summary>source's region drawn at exactly width x height, as a PNG.</summary>
        public static byte[] Png(Bitmap source, RectangleF region, int width, int height)
        {
            using (var scaled = new Bitmap(width, height, PixelFormat.Format24bppRgb))
            {
                using (Graphics graphics = Graphics.FromImage(scaled))
                {
                    graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
                    graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
                    graphics.DrawImage(source, new Rectangle(0, 0, width, height), region, GraphicsUnit.Pixel);
                }
                using (var png = new MemoryStream())
                {
                    scaled.Save(png, ImageFormat.Png);
                    return png.ToArray();
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
