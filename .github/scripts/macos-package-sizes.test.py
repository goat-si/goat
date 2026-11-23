"""Exercise bundle accounting with an updater ZIP, including framework symlinks."""

from io import BytesIO
from pathlib import Path
import runpy
import stat
import unittest
from zipfile import ZipFile, ZipInfo

bundle_sizes = runpy.run_path(str(Path(__file__).with_name("macos-package-sizes.py")))["bundle_sizes"]


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


if __name__ == "__main__":
    unittest.main()
