"""Exercise bundle accounting with an updater ZIP, including framework symlinks."""

from io import BytesIO
import json
from pathlib import Path
import runpy
import stat
import struct
import unittest
from zipfile import ZipFile, ZipInfo

summary = runpy.run_path(str(Path(__file__).with_name("macos-package-sizes.py")))
bundle_sizes = summary["bundle_sizes"]
payload_sizes = summary["payload_sizes"]


class PackageSizesTest(unittest.TestCase):
    def test_each_file_belongs_to_one_component(self):
        with ZipFile(BytesIO(), "w") as archive:
            contents = "GOAT.app/Contents/"
            for path in (
                "Frameworks/Electron/Versions/A/Electron",
                "Helpers/GOAT Computer Use.app/Contents/MacOS/helper",
                "Resources/app.asar",
                "Resources/app.asar.unpacked/node_modules/example/addon.node",
                "Resources/en.lproj/InfoPlist.strings",
                "Info.plist",
            ):
                archive.writestr(contents + path, b"123")
            link = ZipInfo(contents + "Frameworks/Electron/Versions/Current")
            link.external_attr = (stat.S_IFLNK | 0o777) << 16
            archive.writestr(link, "A")
            archive.writestr("__MACOSX/GOAT.app/Contents/._Info.plist", b"metadata")
            self.assertEqual(
                dict(bundle_sizes(archive)),
                {
                    "Frameworks": 3,
                    "Helpers/GOAT Computer Use.app": 3,
                    "Resources/app.asar": 3,
                    "Resources/app.asar.unpacked": 3,
                    "Other resources": 3,
                    "Other bundle files": 3,
                },
            )

    def test_payload_groups_include_packed_and_external_bytes_once(self):
        files = {}
        body = bytearray()
        for path, data in (
            ("apps/server/dist/bin.mjs", b"server"),
            ("apps/server/dist/client/app.js", b"web"),
            ("node_modules/sdk/index.js", b"sdk"),
            ("patches/sdk.patch", b"diff"),
        ):
            nodes = files
            *parents, name = path.split("/")
            for parent in parents:
                nodes = nodes.setdefault(parent, {"files": {}})["files"]
            nodes[name] = {"size": len(data), "offset": str(len(body))}
            body.extend(data)
        files["addon"] = {"size": 5, "unpacked": True}
        files["alias"] = {"link": "addon"}
        header = json.dumps({"files": files}).encode()
        padded = header + bytes(-len(header) % 4)
        prefix = struct.pack("<4I", 4, 8 + len(padded), 4 + len(padded), len(header))
        with ZipFile(BytesIO(), "w") as archive:
            contents = "GOAT.app/Contents/"
            archive.writestr(contents + "Resources/app.asar", prefix + padded + body)
            for path, data in (
                ("Resources/app.asar.unpacked/addon", b"abcde"),
                ("Resources/app.asar.unpacked/node_modules/sdk/a.node", b"native"),
                ("Resources/node_modules/platform/tool", b"tool"),
                ("Resources/server-compile-cache/cache", b"cache"),
                ("Helpers/GOAT Computer Use.app/Contents/MacOS/helper", b"helper"),
                ("Resources/resource-monitor/bin", b"monitor"),
                ("Frameworks/Electron", b"electron"),
            ):
                archive.writestr(contents + path, data)
            groups = payload_sizes(archive)
            self.assertEqual(groups["Server"], 11)
            self.assertEqual(groups["Web assets"], 3)
            self.assertEqual(groups["npm dependencies"], 13)
            self.assertEqual(groups["Native helpers"], 13)
            self.assertEqual(groups["Dependency patches"], 4)
            self.assertEqual(groups["Frameworks"], 8)
            self.assertEqual(groups[summary["OTHER"]], len(prefix + padded) + 5)
            self.assertEqual(sum(groups.values()), sum(bundle_sizes(archive).values()))


if __name__ == "__main__":
    unittest.main()
