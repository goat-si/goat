// A harmless window for the Windows computer use smoke (scripts/computer-use-windows-smoke.ts):
// a text box, a check box, a counter button, and a password box that two buttons move focus
// into and out of, so a run can observe, act, see the change, and watch private mode start and
// end. Started with "corner", it opens at the top left instead of the centre. Started with
// "cover", it is instead a solid magenta, topmost, borderless window placed over the middle of
// the fixture window, for the capture guard check (scripts/computer-use-windows-capture-guard-smoke.ts).
using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;

internal static class Fixture
{
    [StructLayout(LayoutKind.Sequential)]
    struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowW(string className, string title);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out RECT rect);

    [STAThread]
    static void Main(string[] arguments)
    {
        Application.EnableVisualStyles();
        if (arguments.Length > 0 && arguments[0] == "cover")
        {
            RECT under;
            if (!GetWindowRect(FindWindowW(null, "GOAT computer use fixture"), out under)) return;
            var cover = new Form
            {
                Text = "GOAT capture guard cover",
                FormBorderStyle = FormBorderStyle.None,
                BackColor = Color.Magenta,
                TopMost = true,
                ShowInTaskbar = false,
                StartPosition = FormStartPosition.Manual,
                Bounds = new Rectangle(under.Left + (under.Right - under.Left) / 4, under.Top + (under.Bottom - under.Top) / 4,
                    (under.Right - under.Left) / 2, (under.Bottom - under.Top) / 2),
            };
            Application.Run(cover);
            return;
        }
        var form = new Form { Text = "GOAT computer use fixture", ClientSize = new Size(420, 230), StartPosition = FormStartPosition.CenterScreen };
        if (arguments.Length > 0 && arguments[0] == "corner")
        {
            form.StartPosition = FormStartPosition.Manual;
            form.Location = new Point(40, 40);
        }
        var note = new TextBox { Name = "note", AccessibleName = "Note", Location = new Point(16, 16), Width = 380 };
        var agree = new CheckBox { Name = "agree", Text = "Agree", Location = new Point(16, 52), AutoSize = true };
        var count = new Label { Name = "count", Text = "Count: 0", Location = new Point(140, 92), AutoSize = true };
        var clicks = 0;
        var add = new Button { Name = "add", Text = "Add one", Location = new Point(16, 86), Width = 110 };
        add.Click += delegate { clicks++; count.Text = "Count: " + clicks; };
        var secret = new TextBox { Name = "secret", AccessibleName = "Secret", UseSystemPasswordChar = true, Location = new Point(16, 170), Width = 380 };
        var focusSecret = new Button { Name = "focusSecret", Text = "Focus secret", Location = new Point(16, 128), Width = 110 };
        focusSecret.Click += delegate { secret.Focus(); };
        var leaveSecret = new Button { Name = "leaveSecret", Text = "Leave secret", Location = new Point(140, 128), Width = 110 };
        leaveSecret.Click += delegate { note.Focus(); };
        form.Controls.AddRange(new Control[] { note, agree, add, count, focusSecret, leaveSecret, secret });
        Application.Run(form);
    }
}
