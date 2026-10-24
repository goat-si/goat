// The agent's MCP connection to Cua Driver on Windows runs through the helper (#1329): GOAT's
// lease proxy starts "GOAT Computer Use.exe mcp ..." where it would start the driver, and the
// helper starts the pinned driver with the same arguments and passes lines both ways.
//
// No pixel the driver captured reaches the agent, because the driver may have copied them off
// the screen (CaptureGuard.cs). A get_window_state screenshot is replaced with the helper's own
// capture of that window at the same size; a zoom with the region the driver would have cut from
// the helper's capture. Everything else in any message that is or could be an image (other
// tools' images, structured or error data, notifications, binary resources, encoded image
// strings, a reply the helper cannot pair with its request) is withheld with a note, and a driver
// line the helper cannot read is dropped.
// screenshot_out_file is dropped wherever it appears, so no image is written around the relay.
// A request the helper cannot read is refused instead of forwarded unread.

using System;
using System.Collections;
using System.Collections.Generic;
using System.Drawing;
using System.Web.Script.Serialization;

namespace Goat.ComputerUse
{
    internal sealed class McpRelay
    {
        public const string Withheld =
            "GOAT withheld this image: it could show other windows, and GOAT could not capture the window by itself. " +
            "Read the window with get_window_state.";
        public const string Unreadable =
            "GOAT's computer use relay takes one JSON-RPC request object per line.";

        sealed class Pending
        {
            public string Tool;
            public IntPtr Window;
            public Dictionary<string, object> Arguments;
        }

        readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 64 * 1024 * 1024 };
        readonly Dictionary<string, Pending> pending = new Dictionary<string, Pending>();
        /// <summary>Each window's last screenshot size as the agent saw it; zoom coordinates are in it.</summary>
        readonly Dictionary<IntPtr, Shot> shots = new Dictionary<IntPtr, Shot>();

        /// <summary>A screenshot as delivered, and the native width it was drawn from: the driver's zoom scale.</summary>
        struct Shot
        {
            public Size Delivered;
            public int NativeWidth;
        }
        readonly object gate = new object();
        readonly Func<IntPtr, Bitmap> capture;

        public McpRelay(Func<IntPtr, Bitmap> capture)
        {
            this.capture = capture;
        }

        /// <summary>
        /// A line from the agent as the driver should receive it, or null when it must not be
        /// forwarded; then refusal is the answer to send the agent instead.
        /// </summary>
        public string Inbound(string line, out string refusal)
        {
            refusal = null;
            Dictionary<string, object> message = Parse(line);
            if (message == null)
            {
                refusal = "{\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{\"code\":-32600,\"message\":" + json.Serialize(Unreadable) + "}}";
                return null;
            }
            object id, method, parameters;
            if (!message.TryGetValue("method", out method) || !"tools/call".Equals(method) ||
                !message.TryGetValue("params", out parameters) || !(parameters is Dictionary<string, object>))
                return line;
            var call = (Dictionary<string, object>)parameters;
            object name, arguments;
            call.TryGetValue("name", out name);
            call.TryGetValue("arguments", out arguments);
            var given = arguments as Dictionary<string, object>;
            if (message.TryGetValue("id", out id) && id != null)
                lock (gate)
                    pending[Key(id)] = new Pending
                    {
                        Tool = name as string,
                        Window = given == null ? IntPtr.Zero : WindowOf(given),
                        Arguments = given,
                    };
            return DropOutFiles(arguments) ? json.Serialize(message) : line;
        }

        /// <summary>A line from the driver as the agent should receive it, or null to drop it.</summary>
        public string Outbound(string line)
        {
            Dictionary<string, object> message = Parse(line);
            // A line that cannot be read cannot be shown to hold no image.
            if (message == null) return null;
            object id;
            Pending call = null;
            if (message.TryGetValue("id", out id) && id != null)
                lock (gate)
                {
                    string key = Key(id);
                    if (pending.TryGetValue(key, out call)) pending.Remove(key);
                }
            bool changed = false;
            // The only images that pass are the helper's own, in the result's content of a paired
            // window read or zoom; everything anywhere else that could be one is withheld.
            var own = new HashSet<object>();
            object result, content;
            if (call != null && call.Window != IntPtr.Zero && message.TryGetValue("result", out result) &&
                result is Dictionary<string, object> &&
                ((Dictionary<string, object>)result).TryGetValue("content", out content) && content is object[])
            {
                var blocks = (object[])content;
                for (int i = 0; i < blocks.Length; i++)
                {
                    var block = blocks[i] as Dictionary<string, object>;
                    object type;
                    if (block == null || !block.TryGetValue("type", out type) || !"image".Equals(type)) continue;
                    byte[] captured = Recapture(call, block);
                    if (captured == null) continue;
                    var image = new Dictionary<string, object>();
                    image["type"] = "image";
                    image["mimeType"] = "image/png";
                    image["data"] = Convert.ToBase64String(captured);
                    blocks[i] = image;
                    own.Add(image);
                    changed = true;
                }
            }
            // The id is the agent's own, echoed; it stays exactly as the agent sent it.
            object echoed;
            bool hasId = message.TryGetValue("id", out echoed);
            message.Remove("id");
            Scrub(message, own, ref changed);
            if (hasId) message["id"] = echoed;
            return changed ? json.Serialize(message) : line;
        }

        /// <summary>
        /// Replaces everything that is or could be an image with a note: image and resource-link
        /// blocks, anything with a blob, anything whose MIME type is an image or is not text, an
        /// embedded resource holding one, and strings that carry an encoded image anywhere in them.
        /// </summary>
        object Scrub(object value, HashSet<object> own, ref bool changed)
        {
            var map = value as Dictionary<string, object>;
            if (map != null)
            {
                if (own.Contains(map)) return map;
                if (ImageLike(map))
                {
                    changed = true;
                    return Text(Withheld);
                }
                foreach (string key in new List<string>(map.Keys)) map[key] = Scrub(map[key], own, ref changed);
                return map;
            }
            var array = value as object[];
            if (array != null)
            {
                for (int i = 0; i < array.Length; i++) array[i] = Scrub(array[i], own, ref changed);
                return array;
            }
            var text = value as string;
            if (text != null && EncodedImage(text))
            {
                changed = true;
                return Withheld;
            }
            return value;
        }

        static bool ImageLike(Dictionary<string, object> map)
        {
            string type = Field(map, "type");
            if (type != null && (type.Equals("image", StringComparison.OrdinalIgnoreCase) || type.Equals("resource_link", StringComparison.OrdinalIgnoreCase)))
                return true;
            if (map.ContainsKey("blob")) return true;
            string mime = Field(map, "mimeType") ?? Field(map, "mime_type") ?? Field(map, "mediaType");
            if (mime != null && mime.Trim().StartsWith("image/", StringComparison.OrdinalIgnoreCase)) return true;
            if (mime != null && map.ContainsKey("data") && !mime.Trim().StartsWith("text/", StringComparison.OrdinalIgnoreCase)) return true;
            object resource;
            return map.TryGetValue("resource", out resource) && resource is Dictionary<string, object> && ImageLike((Dictionary<string, object>)resource);
        }

        /// <summary>
        /// A data: image URL anywhere, any base64 or base64url run long enough to hold a picture
        /// (1024 characters, whatever it decodes to), or a shorter run that decodes to the start
        /// of a PNG, JPEG, GIF, WebP, BMP, TIFF or ICO file at any of its first offsets.
        /// </summary>
        static bool EncodedImage(string text)
        {
            if (text.IndexOf("data:image", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            for (int i = 0; i < text.Length;)
            {
                if (!Base64Char(text[i])) { i++; continue; }
                int start = i;
                while (i < text.Length && Base64Char(text[i])) i++;
                int length = i - start;
                if (length >= 1024) return true;
                for (int offset = 0; offset + 16 <= length && offset < 64; offset++)
                    if (ImageMagic(text.Substring(start + offset, 16))) return true;
            }
            return false;
        }

        static bool Base64Char(char c)
        {
            return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '+' || c == '/' || c == '-' || c == '_' || c == '=';
        }

        static bool ImageMagic(string chunk)
        {
            byte[] b;
            try { b = Convert.FromBase64String(chunk.Replace('-', '+').Replace('_', '/')); }
            catch (FormatException) { return false; }
            if (b.Length < 12) return false;
            return (b[0] == 0x89 && b[1] == 0x50 && b[2] == 0x4E && b[3] == 0x47) ||
                (b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF) ||
                (b[0] == 0x47 && b[1] == 0x49 && b[2] == 0x46 && b[3] == 0x38) ||
                (b[0] == 0x52 && b[1] == 0x49 && b[2] == 0x46 && b[3] == 0x46 && b[8] == 0x57 && b[9] == 0x45 && b[10] == 0x42 && b[11] == 0x50) ||
                (b[0] == 0x42 && b[1] == 0x4D && b[6] == 0 && b[7] == 0 && b[8] == 0 && b[9] == 0) ||
                (b[0] == 0x49 && b[1] == 0x49 && b[2] == 0x2A && b[3] == 0x00) ||
                (b[0] == 0x4D && b[1] == 0x4D && b[2] == 0x00 && b[3] == 0x2A) ||
                (b[0] == 0x00 && b[1] == 0x00 && b[2] == 0x01 && b[3] == 0x00 && b[5] == 0x00);
        }

        static string Field(Dictionary<string, object> map, string name)
        {
            object value;
            return map.TryGetValue(name, out value) ? value as string : null;
        }

        byte[] Recapture(Pending call, Dictionary<string, object> image)
        {
            Size? size = SizeOf(image);
            if (!size.HasValue) return null;
            if (call.Tool == "get_window_state")
            {
                using (Bitmap native = capture(call.Window))
                {
                    if (native == null) return null;
                    lock (gate) shots[call.Window] = new Shot { Delivered = size.Value, NativeWidth = native.Width };
                    return CaptureGuard.Png(native, new RectangleF(0, 0, native.Width, native.Height), size.Value.Width, size.Value.Height);
                }
            }
            if (call.Tool == "zoom")
            {
                Shot shot;
                double x1, y1, x2, y2;
                lock (gate)
                    if (!shots.TryGetValue(call.Window, out shot)) return null;
                if (call.Arguments == null || !Number(call.Arguments, "x1", out x1) || !Number(call.Arguments, "y1", out y1) ||
                    !Number(call.Arguments, "x2", out x2) || !Number(call.Arguments, "y2", out y2) || x2 <= x1 || y2 <= y1)
                    return null;
                using (Bitmap native = capture(call.Window))
                {
                    if (native == null || shot.Delivered.Width <= 0) return null;
                    // The driver's own crop, so its from_zoom mapping lands where the agent points:
                    // screenshot to native by the scale kept with that screenshot (as the driver keeps
                    // it), then 20% padding, whole pixels, clamped (cursor-overlay capture_utils.rs
                    // crop_png_to_jpeg), cut from a fresh capture as the driver cuts from a fresh one.
                    double scale = (double)shot.NativeWidth / shot.Delivered.Width;
                    double nx1 = x1 * scale, ny1 = y1 * scale, nx2 = x2 * scale, ny2 = y2 * scale;
                    double padX = Math.Max(nx2 - nx1, 1) * 0.20, padY = Math.Max(ny2 - ny1, 1) * 0.20;
                    int cx1 = Math.Min((int)Math.Max(nx1 - padX, 0), native.Width);
                    int cy1 = Math.Min((int)Math.Max(ny1 - padY, 0), native.Height);
                    int cx2 = Math.Min((int)Math.Min(nx2 + padX, native.Width), native.Width);
                    int cy2 = Math.Min((int)Math.Min(ny2 + padY, native.Height), native.Height);
                    int cw = Math.Max(cx2 - cx1, 1), ch = Math.Max(cy2 - cy1, 1);
                    if (cx1 + cw > native.Width || cy1 + ch > native.Height) return null;
                    return CaptureGuard.Png(native, new RectangleF(cx1, cy1, cw, ch), size.Value.Width, size.Value.Height);
                }
            }
            return null;
        }

        static Size? SizeOf(Dictionary<string, object> image)
        {
            object data;
            if (!image.TryGetValue("data", out data) || !(data is string)) return null;
            try { return CaptureGuard.ImageSize(Convert.FromBase64String((string)data)); }
            catch (FormatException) { return null; }
        }

        /// <summary>Removes every screenshot_out_file, nested ones included; true when any was there.</summary>
        static bool DropOutFiles(object value)
        {
            bool dropped = false;
            var map = value as Dictionary<string, object>;
            if (map != null)
            {
                foreach (string key in new List<string>(map.Keys))
                {
                    if (key.EndsWith("out_file", StringComparison.OrdinalIgnoreCase)) { map.Remove(key); dropped = true; }
                    else dropped |= DropOutFiles(map[key]);
                }
            }
            else if (value is IList)
                foreach (object item in (IList)value) dropped |= DropOutFiles(item);
            return dropped;
        }

        /// <summary>
        /// The id as JSON. A reply whose id does not come back identical (the serializer turns
        /// some strings into dates) finds no pending call, and its images are then withheld.
        /// </summary>
        string Key(object id)
        {
            return id.GetType().Name + ":" + json.Serialize(id);
        }

        static bool Number(Dictionary<string, object> arguments, string name, out double value)
        {
            value = 0;
            object raw;
            if (!arguments.TryGetValue(name, out raw) || raw == null) return false;
            try { value = Convert.ToDouble(raw, System.Globalization.CultureInfo.InvariantCulture); }
            catch (FormatException) { return false; }
            catch (InvalidCastException) { return false; }
            return !double.IsNaN(value) && !double.IsInfinity(value);
        }

        static IntPtr WindowOf(Dictionary<string, object> arguments)
        {
            object value;
            if (!arguments.TryGetValue("window_id", out value) || value == null) return IntPtr.Zero;
            try { return new IntPtr(Convert.ToInt64(value, System.Globalization.CultureInfo.InvariantCulture)); }
            catch (FormatException) { return IntPtr.Zero; }
            catch (InvalidCastException) { return IntPtr.Zero; }
            catch (OverflowException) { return IntPtr.Zero; }
        }

        static Dictionary<string, object> Text(string text)
        {
            var block = new Dictionary<string, object>();
            block["type"] = "text";
            block["text"] = text;
            return block;
        }

        Dictionary<string, object> Parse(string line)
        {
            try { return json.DeserializeObject(PlainSlashes(line)) as Dictionary<string, object>; }
            catch (ArgumentException) { return null; }
            catch (InvalidOperationException) { return null; }
        }

        /// <summary>
        /// The same JSON with every escaped slash written as \u002F. .NET's reader turns a string
        /// spelled "\/Date(...)\/" into a date, which would change ids and values it writes back.
        /// </summary>
        static string PlainSlashes(string line)
        {
            if (line.IndexOf("\\/", StringComparison.Ordinal) < 0) return line;
            var plain = new System.Text.StringBuilder(line.Length + 16);
            for (int i = 0; i < line.Length; i++)
            {
                char c = line[i];
                if (c == '\\' && i + 1 < line.Length)
                {
                    if (line[i + 1] == '/') plain.Append("\\u002F");
                    else plain.Append(c).Append(line[i + 1]);
                    i++;
                    continue;
                }
                plain.Append(c);
            }
            return plain.ToString();
        }
    }
}
