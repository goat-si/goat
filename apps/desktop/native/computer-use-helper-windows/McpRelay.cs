// The agent's MCP connection to Cua Driver on Windows runs through the helper (#1329): GOAT's
// lease proxy starts "GOAT Computer Use.exe mcp ..." where it would start the driver, and the
// helper starts the pinned driver with the same arguments and passes lines both ways. Only two
// tools are touched. A window screenshot (get_window_state) of a covered window is replaced
// with the helper's own capture of that window, or withheld; a zoom of a covered window is
// withheld. Their screenshot_out_file argument is dropped so every image comes back inline,
// where the helper can see it. Everything else passes byte for byte.

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Web.Script.Serialization;

namespace Goat.ComputerUse
{
    internal sealed class McpRelay
    {
        public const string Replaced =
            "GOAT replaced this screenshot with a capture of the window alone, because another window covers it.";
        public const string Withheld =
            "GOAT withheld this screenshot: another window covers this window and Windows could not capture it alone. " +
            "Move the covering window or bring this one to the front, then read it again.";
        public const string ZoomWithheld =
            "GOAT withheld this zoom: another window covers this window, and a zoom could show what covers it. " +
            "Move the covering window or bring this one to the front, then zoom again.";

        sealed class Pending
        {
            public string Tool;
            public IntPtr Window;
            public bool Covered;
        }

        readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 64 * 1024 * 1024 };
        readonly Dictionary<string, Pending> pending = new Dictionary<string, Pending>();
        readonly object gate = new object();
        readonly Func<IntPtr, bool> covered;
        readonly Func<IntPtr, int, int, byte[]> captureAlone;

        public McpRelay(Func<IntPtr, bool> covered, Func<IntPtr, int, int, byte[]> captureAlone)
        {
            this.covered = covered;
            this.captureAlone = captureAlone;
        }

        /// <summary>A line from the agent, as the driver should receive it.</summary>
        public string Inbound(string line)
        {
            Dictionary<string, object> message = Parse(line);
            object id, method, parameters, name, arguments;
            if (message == null || !message.TryGetValue("id", out id) || id == null ||
                !message.TryGetValue("method", out method) || !"tools/call".Equals(method) ||
                !message.TryGetValue("params", out parameters) || !(parameters is Dictionary<string, object>) ||
                !((Dictionary<string, object>)parameters).TryGetValue("name", out name) ||
                !("get_window_state".Equals(name) || "zoom".Equals(name)))
                return line;
            var call = (Dictionary<string, object>)parameters;
            if (!call.TryGetValue("arguments", out arguments) || !(arguments is Dictionary<string, object>)) return line;
            var given = (Dictionary<string, object>)arguments;
            IntPtr window = WindowOf(given);
            lock (gate)
                pending[json.Serialize(id)] = new Pending { Tool = (string)name, Window = window, Covered = window != IntPtr.Zero && covered(window) };
            if (!given.Remove("screenshot_out_file")) return line;
            return json.Serialize(message);
        }

        /// <summary>A line from the driver, as the agent should receive it.</summary>
        public string Outbound(string line)
        {
            lock (gate)
                if (pending.Count == 0) return line;
            Dictionary<string, object> message = Parse(line);
            object id;
            if (message == null || !message.TryGetValue("id", out id) || id == null) return line;
            Pending call;
            lock (gate)
            {
                string key = json.Serialize(id);
                if (!pending.TryGetValue(key, out call)) return line;
                pending.Remove(key);
            }
            object result, content;
            if (!message.TryGetValue("result", out result) || !(result is Dictionary<string, object>) ||
                !((Dictionary<string, object>)result).TryGetValue("content", out content) || !(content is object[]))
                return line;
            var blocks = new List<object>((object[])content);
            if (!blocks.Exists(IsImage)) return line;
            // Checked again now: a window that came on top while the driver captured counts too.
            bool coveredNow = call.Window == IntPtr.Zero || call.Covered || covered(call.Window);
            if (!coveredNow) return line;
            bool replaced = false, withheld = false;
            for (int i = 0; i < blocks.Count; i++)
            {
                if (!IsImage(blocks[i])) continue;
                byte[] own = call.Tool == "get_window_state" && call.Window != IntPtr.Zero ? Recapture(call.Window, (Dictionary<string, object>)blocks[i]) : null;
                if (own != null)
                {
                    var image = new Dictionary<string, object>();
                    image["type"] = "image";
                    image["mimeType"] = "image/png";
                    image["data"] = Convert.ToBase64String(own);
                    blocks[i] = image;
                    replaced = true;
                }
                else
                {
                    blocks[i] = Text(call.Tool == "zoom" ? ZoomWithheld : Withheld);
                    withheld = true;
                }
            }
            if (replaced && !withheld) blocks.Add(Text(Replaced));
            ((Dictionary<string, object>)result)["content"] = blocks.ToArray();
            return json.Serialize(message);
        }

        byte[] Recapture(IntPtr window, Dictionary<string, object> image)
        {
            object data;
            if (!image.TryGetValue("data", out data) || !(data is string)) return null;
            byte[] encoded;
            try { encoded = Convert.FromBase64String((string)data); }
            catch (FormatException) { return null; }
            Size? size = CaptureGuard.ImageSize(encoded);
            return size.HasValue ? captureAlone(window, size.Value.Width, size.Value.Height) : null;
        }

        static IntPtr WindowOf(Dictionary<string, object> arguments)
        {
            object value;
            if (!arguments.TryGetValue("window_id", out value) || value == null) return IntPtr.Zero;
            try { return new IntPtr(Convert.ToInt64(value)); }
            catch (FormatException) { return IntPtr.Zero; }
            catch (InvalidCastException) { return IntPtr.Zero; }
            catch (OverflowException) { return IntPtr.Zero; }
        }

        static bool IsImage(object block)
        {
            var map = block as Dictionary<string, object>;
            object type;
            return map != null && map.TryGetValue("type", out type) && "image".Equals(type);
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
