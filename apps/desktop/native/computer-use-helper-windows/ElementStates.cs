// What Cua Driver 0.37.0 leaves out of a Windows read (#1286): a toggle that is Indeterminate
// (the driver reports On and Off as selected, nothing else) and whether an element is expanded.
// The helper reads both straight from UI Automation; @goat/shared/computerUseWindows joins them
// to the driver's elements by screen rectangle, role and label within the same read, so each
// entry carries the label the driver would give it.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading;
using System.Windows;
using System.Windows.Automation;

namespace Goat.ComputerUse
{
    internal static class ElementStates
    {
        const int MaxVisited = 5000;
        const int MaxElements = 2000;
        const int BudgetMs = 2500;
        const int TimeoutMs = 3000;
        /// <summary>
        /// One UI Automation walk at a time: a walk stuck in a hung app keeps its thread, and a
        /// second request must not leave another one behind it.
        /// </summary>
        static int walking;

        public static Dictionary<string, object> Read(int processId, long windowId)
        {
            IntPtr window = new IntPtr(windowId);
            int owner;
            if (windowId == 0 || !NativeMethods.IsWindow(window))
                throw new HelperException("window_not_found", "That window is gone.");
            NativeMethods.GetWindowThreadProcessId(window, out owner);
            if (owner != processId)
                throw new HelperException("owner_mismatch", "That window belongs to another process.");
            if (Interlocked.CompareExchange(ref walking, 1, 0) != 0)
                throw new HelperException("automation_busy", "UI Automation is still reading a window that did not answer. Try again later.");
            var elements = new List<object>();
            bool truncated = false;
            bool done = WindowsFacts.RunBounded(delegate
            {
                try { truncated = Walk(window, elements); }
                finally { Interlocked.Exchange(ref walking, 0); }
                return true;
            }, TimeoutMs, false);
            if (!done) throw new HelperException("automation_timeout", "UI Automation did not read that window in time.");
            var result = new Dictionary<string, object>();
            result["elements"] = elements.ToArray();
            result["truncated"] = truncated;
            return result;
        }

        /// <summary>Depth-first over the control view; true when it stopped before the end.</summary>
        static bool Walk(IntPtr window, List<object> elements)
        {
            var cache = new CacheRequest { TreeScope = TreeScope.Element };
            foreach (AutomationProperty property in new[]
            {
                AutomationElement.BoundingRectangleProperty, AutomationElement.ControlTypeProperty,
                AutomationElement.NameProperty, AutomationElement.AutomationIdProperty, AutomationElement.HelpTextProperty,
                ValuePattern.ValueProperty, AutomationElement.IsTogglePatternAvailableProperty,
                AutomationElement.IsExpandCollapsePatternAvailableProperty, TogglePattern.ToggleStateProperty,
                ExpandCollapsePattern.ExpandCollapseStateProperty,
            })
                cache.Add(property);
            var walker = TreeWalker.ControlViewWalker;
            var clock = Stopwatch.StartNew();
            int visited = 0;
            var stack = new Stack<AutomationElement>();
            using (cache.Activate())
            {
                AutomationElement root = AutomationElement.FromHandle(window);
                for (AutomationElement child = walker.GetFirstChild(root, cache); child != null; child = walker.GetNextSibling(child, cache))
                    stack.Push(child);
                while (stack.Count > 0)
                {
                    if (++visited > MaxVisited || clock.ElapsedMilliseconds > BudgetMs || elements.Count == MaxElements) return true;
                    AutomationElement element = stack.Pop();
                    var entry = Entry(element);
                    if (entry != null) elements.Add(entry);
                    for (AutomationElement child = walker.GetFirstChild(element, cache); child != null; child = walker.GetNextSibling(child, cache))
                        stack.Push(child);
                }
            }
            return false;
        }

        static Dictionary<string, object> Entry(AutomationElement element)
        {
            bool toggles = (bool)element.GetCachedPropertyValue(AutomationElement.IsTogglePatternAvailableProperty);
            bool expands = (bool)element.GetCachedPropertyValue(AutomationElement.IsExpandCollapsePatternAvailableProperty);
            if (!toggles && !expands) return null;
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
            string label = Label(element);
            if (label != null) entry["label"] = label;
            if (toggles)
            {
                object toggle = element.GetCachedPropertyValue(TogglePattern.ToggleStateProperty, true);
                if (toggle is ToggleState)
                    entry["toggle"] = (ToggleState)toggle == ToggleState.On ? "on" : (ToggleState)toggle == ToggleState.Off ? "off" : "indeterminate";
            }
            if (expands)
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

        /// <summary>The driver's label: the first of name, value, automation id and help text that is not blank.</summary>
        static string Label(AutomationElement element)
        {
            foreach (AutomationProperty property in new[]
            {
                AutomationElement.NameProperty, ValuePattern.ValueProperty,
                AutomationElement.AutomationIdProperty, AutomationElement.HelpTextProperty,
            })
            {
                var text = element.GetCachedPropertyValue(property, true) as string;
                if (text != null && text.Trim().Length > 0) return text;
            }
            return null;
        }
    }
}
