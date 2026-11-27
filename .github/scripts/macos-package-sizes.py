"""Report installer bytes and bundle components of the macOS updater ZIP."""

from collections import Counter
from pathlib import Path, PurePosixPath
import json
import stat
import struct
import sys
from zipfile import ZipFile


def bundle_files(archive):
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
        yield entry, parts[2:]


def bundle_sizes(archive):
    sizes = Counter()
    for entry, parts in bundle_files(archive):
        component = parts[0]
        if component == "Resources" and len(parts) >= 2:
            if parts[1] == "app.asar" or (len(parts) > 2 and not parts[1].endswith(".lproj")):
                component += "/" + parts[1]
            else:
                component = "Other resources"
        elif component == "Helpers" and len(parts) >= 2:
            component += "/" + parts[1]
        elif len(parts) == 1:
            component = "Other bundle files"
        sizes[component] += entry.file_size
    return sizes


# Use logical (uncompressed) bytes everywhere, including files outside app.asar.
OTHER = "Other bundle files and archive metadata"
PAYLOAD_GROUPS = (
    "Server",
    "Web assets",
    "npm dependencies",
    "Native helpers",
    "Dependency patches",
    "Frameworks",
    OTHER,
)


def app_group(parts):
    if parts[:4] == ("apps", "server", "dist", "client"):
        return "Web assets"
    if parts[:3] == ("apps", "server", "dist"):
        return "Server"
    if parts[:1] == ("node_modules",):
        return "npm dependencies"
    if parts[:1] == ("patches",):
        return "Dependency patches"
    return OTHER


def packed_files(nodes, parents=()):
    for name, node in nodes.items():
        parts = (*parents, name)
        if "files" in node:
            yield from packed_files(node["files"], parts)
        elif "offset" in node and not node.get("unpacked"):
            yield parts, node["size"]


def asar_sizes(archive, entry):
    # ASAR starts with two Chromium Pickles: the header size, then its JSON string.
    # Reading only their header avoids extracting or buffering the application.
    with archive.open(entry) as stream:
        prefix = stream.read(16)
        if len(prefix) != 16:
            raise ValueError(f"Truncated ASAR header in {entry.filename}")
        size_word, header, payload, length = struct.unpack("<4I", prefix)
        if not (
            size_word == 4
            and header == payload + 4
            and length <= header - 8
            and header + 8 <= entry.file_size
        ):
            raise ValueError(f"Invalid ASAR header in {entry.filename}")
        nodes = json.loads(stream.read(length))["files"]

    sizes = Counter()
    for parts, size in packed_files(nodes):
        sizes[app_group(parts)] += size
    remainder = entry.file_size - sum(sizes.values())
    if remainder < header + 8:
        raise ValueError(f"ASAR payload exceeds archive size in {entry.filename}")
    sizes[OTHER] += remainder
    return sizes


def payload_sizes(archive):
    sizes = Counter(dict.fromkeys(PAYLOAD_GROUPS, 0))
    for entry, parts in bundle_files(archive):
        if parts == ("Resources", "app.asar"):
            sizes.update(asar_sizes(archive, entry))
            continue
        if parts[:2] == ("Resources", "app.asar.unpacked"):
            group = app_group(parts[2:])
        elif parts[:2] == ("Resources", "node_modules"):
            group = "npm dependencies"
        elif parts[:2] == ("Resources", "server-compile-cache"):
            group = "Server"
        elif parts[0] == "Helpers" or (
            parts[0] == "Resources"
            and len(parts) > 1
            and parts[1] in ("resource-monitor", "cua-driver", "browser-secret")
        ):
            group = "Native helpers"
        elif parts[0] == "Frameworks":
            group = "Frameworks"
        else:
            group = OTHER
        sizes[group] += entry.file_size
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
            groups = payload_sizes(archive)
        if not sizes:
            raise ValueError(f"No app bundle found in {asset.name}")
        print(f"\n#### Uncompressed files in `{asset.name}`\n")
        print("| Bundle component | MiB |\n| --- | ---: |")
        for name, size in sizes.most_common():
            print(f"| {name} | {size / 2**20:,.2f} |")
        total = sum(sizes.values())
        print(f"| **Total regular file bytes** | **{total / 2**20:,.2f}** |")

        print("\n| Payload group | Bytes | MiB |\n| --- | ---: | ---: |")
        for group, size in groups.items():
            print(f"| {group} | {size:,} | {size / 2**20:,.2f} |")


if __name__ == "__main__":
    report(Path(sys.argv[1]))
