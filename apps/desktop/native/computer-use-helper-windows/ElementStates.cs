// What Cua Driver 0.37.0 leaves out of a Windows read (#1286): a toggle that is Indeterminate
// (the driver reports On and Off as selected, nothing else) and whether an element is expanded.
// The helper reads both straight from UI Automation; @goat/shared/computerUseWindows joins them
// to the driver's elements by screen rectangle, role and name within the same read.

using System;
using System.Collections.Generic;
using System.Windows;
using System.Windows.Automation;

namespace Goat.ComputerUse
{
    internal static class ElementStates
    {
        const int MaxElements = 2000;
        const int TimeoutMs = 3000;

        public static Dictionary<string, object> Read(int processId, long windowId)
        {
            IntPtr window = new IntPtr(windowId);
            int owner;
            if (windowId == 0 || !NativeMethods.IsWindow(window))
                throw new HelperException("window_not_found", "That window is gone.");
            NativeMethods.GetWindowThreadProcessId(window, out owner);
            if (owner != processId)
                throw new HelperException("owner_mismatch", "That window belongs to another process.");
            var elements = new List<object>();
            bool truncated = false;
            bool done = WindowsFacts.RunBounded(delegate
            {
                var cache = new CacheRequest { TreeScope = TreeScope.Element };
                cache.Add(AutomationElement.BoundingRectangleProperty);
                cache.Add(AutomationElement.ControlTypeProperty);
                cache.Add(AutomationElement.NameProperty);
                cache.Add(AutomationElement.IsTogglePatternAvailableProperty);
                cache.Add(AutomationElement.IsExpandCollapsePatternAvailableProperty);
                cache.Add(TogglePattern.ToggleStateProperty);
                cache.Add(ExpandCollapsePattern.ExpandCollapseStateProperty);
                var stateful = new OrCondition(
                    new PropertyCondition(AutomationElement.IsTogglePatternAvailableProperty, true),
                    new PropertyCondition(AutomationElement.IsExpandCollapsePatternAvailableProperty, true));
                AutomationElementCollection found;
                using (cache.Activate())
                    found = AutomationElement.FromHandle(window).FindAll(TreeScope.Descendants, stateful);
                foreach (AutomationElement element in found)
                {
                    if (elements.Count == MaxElements) { truncated = true; break; }
                    var entry = Entry(element);
                    if (entry != null) elements.Add(entry);
                }
                return true;
            }, TimeoutMs, false);
            if (!done) throw new HelperException("automation_timeout", "UI Automation did not read that window in time.");
            var result = new Dictionary<string, object>();
            result["elements"] = elements.ToArray();
            result["truncated"] = truncated;
            return result;
        }

        static Dictionary<string, object> Entry(AutomationElement element)
        {
            var bounds = (Rect)element.GetCachedPropertyValue(AutomationElement.BoundingRectangleProperty);
            if (bounds.IsEmpty || bounds.Width <= 0 || bounds.Height <= 0) return null;
            var entry = new Dictionary<string, object>();
            var frame = new Dictionary<string, object>();
            frame["x"] = (int)Math.Round(bounds.X);
            frame["y"] = (int)Math.Round(bounds.Y);
            frame["w"] = (int)Math.Round(bounds.Width);
            frame["h"] = (int)Math.Round(bounds.Height);
            entry["frame"] = frame;
            var type = (ControlType)element.GetCachedPropertyValue(AutomationElement.ControlTypeProperty);
            entry["role"] = type.ProgrammaticName.Replace("ControlType.", "");
            entry["label"] = (string)element.GetCachedPropertyValue(AutomationElement.NameProperty);
            if ((bool)element.GetCachedPropertyValue(AutomationElement.IsTogglePatternAvailableProperty))
            {
                object toggle = element.GetCachedPropertyValue(TogglePattern.ToggleStateProperty, true);
                if (toggle is ToggleState)
                    entry["toggle"] = (ToggleState)toggle == ToggleState.On ? "on" : (ToggleState)toggle == ToggleState.Off ? "off" : "indeterminate";
            }
            if ((bool)element.GetCachedPropertyValue(AutomationElement.IsExpandCollapsePatternAvailableProperty))
            {
                object expand = element.GetCachedPropertyValue(ExpandCollapsePattern.ExpandCollapseStateProperty, true);
                if (expand is ExpandCollapseState)
                {
                    switch ((ExpandCollapseState)expand)
                    {
                        case ExpandCollapseState.Collapsed: entry["expand"] = "collapsed"; break;
                        case ExpandCollapseState.Expanded: entry["expand"] = "expanded"; break;
                        case ExpandCollapseState.PartiallyExpanded: entry["expand"] = "partial"; break;
                        case ExpandCollapseState.LeafNode: entry["expand"] = "leaf"; break;
                    }
                }
            }
            return entry;
        }
    }
}
