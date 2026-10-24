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
                try { truncated = Walk(window, processId, elements); }
                finally { Interlocked.Exchange(ref walking, 0); }
                return true;
            }, TimeoutMs, false);
            if (!done) throw new HelperException("automation_timeout", "UI Automation did not read that window in time.");
            var result = new Dictionary<string, object>();
            result["elements"] = elements.ToArray();
            result["truncated"] = truncated;
            return result;
        }

        /// <summary>
        /// Depth-first over the control view, one UI Automation call at a time, each counted
        /// against one budget before it is made; true when the budget stopped it. Like the
        /// driver, a CoreWindow app (Calculator, Settings) whose window element is an empty
        /// wrapper is read from the desktop root's elements of the same process instead.
        /// </summary>
        static bool Walk(IntPtr window, int processId, List<object> elements)
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
            cache.Add(AutomationElement.ProcessIdProperty);
            var budget = new Budget(elements);
            using (cache.Activate())
            {
                AutomationElement root = AutomationElement.FromHandle(window);
                if (Subtree(root, cache, elements, budget)) return true;
                if (elements.Count > 0 || IsSal(window)) return false;
                // The empty-wrapper case: walk this process's top-level elements instead.
                var walker = TreeWalker.ControlViewWalker;
                for (AutomationElement top = budget.Call() ? walker.GetFirstChild(AutomationElement.RootElement, cache) : null;
                     top != null; top = budget.Call() ? walker.GetNextSibling(top, cache) : null)
                {
                    if ((int)top.GetCachedPropertyValue(AutomationElement.ProcessIdProperty) != processId) continue;
                    var entry = Entry(top);
                    if (entry != null) elements.Add(entry);
                    if (Subtree(top, cache, elements, budget)) return true;
                }
                return budget.Spent;
            }
        }

        /// <summary>Every descendant of root, lazily; true when the budget stopped it.</summary>
        static bool Subtree(AutomationElement root, CacheRequest cache, List<object> elements, Budget budget)
        {
            var walker = TreeWalker.ControlViewWalker;
            var ancestors = new Stack<AutomationElement>();
            AutomationElement node = budget.Call() ? walker.GetFirstChild(root, cache) : null;
            while (node != null)
            {
                var entry = Entry(node);
                if (entry != null) elements.Add(entry);
                if (!budget.Call()) return true;
                AutomationElement child = walker.GetFirstChild(node, cache);
                if (child != null) { ancestors.Push(node); node = child; continue; }
                while (true)
                {
                    if (!budget.Call()) return true;
                    AutomationElement sibling = walker.GetNextSibling(node, cache);
                    if (sibling != null) { node = sibling; break; }
                    if (ancestors.Count == 0) return budget.Spent;
                    node = ancestors.Pop();
                }
            }
            return budget.Spent;
        }

        /// <summary>One node and time budget shared by a whole read, checked before every call.</summary>
        sealed class Budget
        {
            readonly Stopwatch clock = Stopwatch.StartNew();
            readonly List<object> elements;
            int calls;
            public bool Spent;

            public Budget(List<object> elements) { this.elements = elements; }

            public bool Call()
            {
                if (++calls > MaxVisited || clock.ElapsedMilliseconds > BudgetMs || elements.Count >= MaxElements) Spent = true;
                return !Spent;
            }
        }

        /// <summary>LibreOffice's SAL windows hang on the root walk; the driver skips it for them too.</summary>
        static bool IsSal(IntPtr window)
        {
            var name = new System.Text.StringBuilder(64);
            return GetClassNameW(window, name, name.Capacity) > 0 && name.ToString().StartsWith("SAL", StringComparison.Ordinal);
        }

        [System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
        static extern int GetClassNameW(IntPtr window, System.Text.StringBuilder name, int max);

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
