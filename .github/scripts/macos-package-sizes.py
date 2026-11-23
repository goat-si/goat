"""Report installer bytes and bundle components of the macOS updater ZIP."""

from collections import Counter
from pathlib import Path, PurePosixPath
import stat
import sys
from zipfile import ZipFile


def bundle_sizes(archive):
    sizes = Counter()
    for entry in archive.infolist():
        parts = PurePosixPath(entry.filename).parts
        if (
            len(parts) < 3
            or not parts[0].endswith(".app")
            or parts[1] != "Contents"
            or entry.is_dir()
            or stat.S_ISLNK(entry.external_attr >> 16)
        ):
            continue
        component = parts[2]
        if component == "Resources" and len(parts) >= 4:
            if parts[3] == "app.asar" or (len(parts) > 4 and not parts[3].endswith(".lproj")):
                component += "/" + parts[3]
            else:
                component = "Other resources"
        elif component == "Helpers" and len(parts) >= 4:
            component += "/" + parts[3]
        elif len(parts) == 3:
            component = "Other bundle files"
        sizes[component] += entry.file_size
    return sizes


def report(directory):
    print("### macOS release downloads\n")
    for asset in sorted(directory.iterdir()):
        if asset.suffix not in (".dmg", ".zip"):
            continue
        print(f"- `{asset.name}` — {asset.stat().st_size / 2**20:,.2f} MiB")

    for asset in sorted(directory.glob("*.zip")):
        with ZipFile(asset) as archive:
            sizes = bundle_sizes(archive)
        if not sizes:
            raise ValueError(f"No app bundle found in {asset.name}")
        print(f"\n#### Uncompressed files in `{asset.name}`\n")
        print("| Bundle component | MiB |\n| --- | ---: |")
        for name, size in sizes.most_common():
            print(f"| {name} | {size / 2**20:,.2f} |")
        total = sum(sizes.values())
        print(f"| **Total regular file bytes** | **{total / 2**20:,.2f}** |")


if __name__ == "__main__":
    report(Path(sys.argv[1]))
