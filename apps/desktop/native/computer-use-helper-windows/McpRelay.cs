// The agent's MCP connection to Cua Driver on Windows runs through the helper (#1329): GOAT's
// lease proxy starts "GOAT Computer Use.exe mcp ..." where it would start the driver, and the
// helper starts the pinned driver with the same arguments and passes lines both ways.
//
// No pixel the driver captured reaches the agent, because the driver may have copied them off
// the screen (CaptureGuard.cs). A get_window_state screenshot is replaced with the helper's own
// capture of that window at the same size; a zoom with the same region of the helper's capture,
// scaled as the driver scales it; every other image (verify_state, run_script, run_steps, any
// tool added later, or a reply the helper cannot pair with its request) is withheld with a note.
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
        readonly Dictionary<IntPtr, Size> shots = new Dictionary<IntPtr, Size>();
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
            // "image" can only be spelled another way through a \u escape.
            bool mayHoldImage = line.IndexOf("image", StringComparison.Ordinal) >= 0 || line.IndexOf("\\u", StringComparison.Ordinal) >= 0;
            Dictionary<string, object> message = Parse(line);
            if (message == null) return mayHoldImage ? null : line;
            object id;
            Pending call = null;
            if (message.TryGetValue("id", out id) && id != null)
                lock (gate)
                {
                    string key = Key(id);
                    if (pending.TryGetValue(key, out call)) pending.Remove(key);
                }
            if (!mayHoldImage) return line;
            object result, content;
            if (!message.TryGetValue("result", out result) || !(result is Dictionary<string, object>) ||
                !((Dictionary<string, object>)result).TryGetValue("content", out content) || !(content is object[]))
                return line;
            var blocks = new List<object>((object[])content);
            if (!blocks.Exists(IsImage)) return line;
            for (int i = 0; i < blocks.Count; i++)
            {
                if (!IsImage(blocks[i])) continue;
                byte[] own = call == null || call.Window == IntPtr.Zero ? null : Recapture(call, (Dictionary<string, object>)blocks[i]);
                if (own == null)
                {
                    blocks[i] = Text(Withheld);
                    continue;
                }
                var image = new Dictionary<string, object>();
                image["type"] = "image";
                image["mimeType"] = "image/png";
                image["data"] = Convert.ToBase64String(own);
                blocks[i] = image;
            }
            ((Dictionary<string, object>)result)["content"] = blocks.ToArray();
            return json.Serialize(message);
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
                    lock (gate) shots[call.Window] = size.Value;
                    return CaptureGuard.Png(native, new RectangleF(0, 0, native.Width, native.Height), size.Value.Width, size.Value.Height);
                }
            }
            if (call.Tool == "zoom")
            {
                Size shot;
                double x1, y1, x2, y2;
                lock (gate)
                    if (!shots.TryGetValue(call.Window, out shot)) return null;
                if (call.Arguments == null || !Number(call.Arguments, "x1", out x1) || !Number(call.Arguments, "y1", out y1) ||
                    !Number(call.Arguments, "x2", out x2) || !Number(call.Arguments, "y2", out y2) || x2 <= x1 || y2 <= y1)
                    return null;
                using (Bitmap native = capture(call.Window))
                {
                    if (native == null || shot.Width <= 0) return null;
                    // The driver maps zoom coordinates by native width over screenshot width.
                    double scale = (double)native.Width / shot.Width;
                    var region = RectangleF.FromLTRB((float)(x1 * scale), (float)(y1 * scale),
                        (float)Math.Min(x2 * scale, native.Width), (float)Math.Min(y2 * scale, native.Height));
                    if (region.Width <= 0 || region.Height <= 0) return null;
                    return CaptureGuard.Png(native, region, size.Value.Width, size.Value.Height);
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

        static bool IsImage(object block)
        {
            var map = block as Dictionary<string, object>;
            object type;
            if (map == null || !map.TryGetValue("type", out type)) return false;
            if ("image".Equals(type)) return true;
            // An embedded or linked resource can carry an image too.
            object resource, mime;
            if ("resource".Equals(type) && map.TryGetValue("resource", out resource) && resource is Dictionary<string, object>)
                map = (Dictionary<string, object>)resource;
            return map.TryGetValue("mimeType", out mime) && mime is string && ((string)mime).StartsWith("image/", StringComparison.OrdinalIgnoreCase);
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
            try { return json.DeserializeObject(line) as Dictionary<string, object>; }
            catch (ArgumentException) { return null; }
            catch (InvalidOperationException) { return null; }
        }
    }
}
