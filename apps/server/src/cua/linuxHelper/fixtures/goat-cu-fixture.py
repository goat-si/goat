#!/usr/bin/env python3
"""GOAT computer use fixture for Linux: a GTK 3 window with known accessible roles.

A counter button, a text entry, a password entry and a scrolled list, so a live run can observe,
act, read the effect back and see private mode start when the password entry takes focus.
"""
import sys

import gi

gi.require_version("Gtk", "3.0")
from gi.repository import Gtk  # noqa: E402

window = Gtk.Window(title="GOAT CU Fixture")
window.set_default_size(420, 320)
window.connect("destroy", Gtk.main_quit)
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8, margin=12)
window.add(box)

count = {"value": 0}
counter = Gtk.Entry(text="0", editable=False)
counter.get_accessible().set_name("Count")
box.pack_start(counter, False, False, 0)


def increment(_button):
    count["value"] += 1
    counter.set_text(str(count["value"]))
    print("clicked", count["value"], flush=True)


button = Gtk.Button(label="Increment")
button.connect("clicked", increment)
box.pack_start(button, False, False, 0)

name = Gtk.Entry()
name.set_placeholder_text("Name")
name.get_accessible().set_name("Name")
box.pack_start(name, False, False, 0)

secret = Gtk.Entry()
secret.set_visibility(False)
secret.get_accessible().set_name("Password")
box.pack_start(secret, False, False, 0)

if "--focus-password" in sys.argv:
    secret.grab_focus()
else:
    name.grab_focus()

window.show_all()
Gtk.main()


