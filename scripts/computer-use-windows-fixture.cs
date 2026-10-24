// A harmless window for the Windows computer use smoke (scripts/computer-use-windows-smoke.ts):
// a text box, a check box, a counter button, and a password box that two buttons move focus
// into and out of, so a run can observe, act, see the change, and watch private mode start and
// end.
using System;
using System.Drawing;
using System.Windows.Forms;

internal static class Fixture
{
    [STAThread]
    static void Main()
    {
        Application.EnableVisualStyles();
        var form = new Form { Text = "GOAT computer use fixture", ClientSize = new Size(420, 230), StartPosition = FormStartPosition.CenterScreen };
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
