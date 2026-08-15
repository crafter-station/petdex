#!/usr/bin/env python3
"""Prepare the deterministic, repository-local native desktop smoke pet."""

from __future__ import annotations

import argparse
import binascii
import hashlib
import json
from pathlib import Path
import shutil
import struct
import tempfile
import zlib


MIN_SPRITESHEET_BYTES = 1_024
SPRITESHEET_NAME = "spritesheet.png"
FRAME_WIDTH = 192
FRAME_HEIGHT = 208
ATLAS_COLUMNS = 8
ATLAS_ROWS = 11
ATLAS_WIDTH = FRAME_WIDTH * ATLAS_COLUMNS
ATLAS_HEIGHT = FRAME_HEIGHT * ATLAS_ROWS
DECODED_RGBA_SHA256 = (
    "69751247fc378a89cdc6625238eefda22dd30005c441d073eca72609242766ee"
)


def png_chunk(kind: bytes, payload: bytes) -> bytes:
    body = kind + payload
    return struct.pack(">I", len(payload)) + body + struct.pack(">I", binascii.crc32(body))


def write_spritesheet(path: Path) -> None:
    """Write a small, repeatable RGBA v2 atlas without network or Pillow."""
    tile_rows: list[bytes] = []
    atlas_width = ATLAS_WIDTH
    atlas_height = ATLAS_HEIGHT
    for y in range(FRAME_HEIGHT):
        tile = bytearray()
        for x in range(FRAME_WIDTH):
            dx = x - FRAME_WIDTH // 2
            dy = y - 116
            body = (dx * dx * 4 + dy * dy * 3) < 72 * 72 * 4
            ear = ((dx + 47) ** 2 + (dy + 55) ** 2 < 24**2) or (
                (dx - 47) ** 2 + (dy + 55) ** 2 < 24**2
            )
            eye = y in range(99, 108) and (x in range(65, 74) or x in range(118, 127))
            cup = x in range(77, 116) and y in range(143, 183)
            if eye:
                rgba = (25, 29, 38, 255)
            elif cup:
                rgba = (80 + (y % 9) * 5, 169, 214, 255)
            elif body or ear:
                rgba = (179 + (x % 13), 112 + (y % 17), 72, 255)
            else:
                rgba = (0, 0, 0, 0)
            tile.extend(rgba)
        tile_rows.append(b"\x00" + tile * ATLAS_COLUMNS)
    raw = b"".join(tile_rows * ATLAS_ROWS)
    header = struct.pack(">IIBBBBB", atlas_width, atlas_height, 8, 6, 0, 0, 0)
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + png_chunk(b"IHDR", header)
        + png_chunk(b"IDAT", zlib.compress(raw, level=6))
        + png_chunk(b"IEND", b"")
    )


def decoded_rgba_sha256(path: Path) -> str:
    """Hash decoded pixels, avoiding zlib-version-dependent PNG bytes."""
    encoded = path.read_bytes()
    if not encoded.startswith(b"\x89PNG\r\n\x1a\n"):
        raise RuntimeError("fixture spritesheet must be the deterministic PNG atlas")
    offset = 8
    compressed = bytearray()
    dimensions: tuple[int, int] | None = None
    while offset < len(encoded):
        if offset + 12 > len(encoded):
            raise RuntimeError("fixture PNG has a truncated chunk")
        length = struct.unpack(">I", encoded[offset : offset + 4])[0]
        kind = encoded[offset + 4 : offset + 8]
        payload_end = offset + 8 + length
        payload = encoded[offset + 8 : payload_end]
        if payload_end + 4 > len(encoded):
            raise RuntimeError("fixture PNG has a truncated payload")
        if kind == b"IHDR":
            width, height, depth, color, compression, filtering, interlace = struct.unpack(
                ">IIBBBBB", payload
            )
            if (depth, color, compression, filtering, interlace) != (8, 6, 0, 0, 0):
                raise RuntimeError("fixture PNG is not non-interlaced 8-bit RGBA")
            dimensions = (width, height)
        elif kind == b"IDAT":
            compressed.extend(payload)
        offset = payload_end + 4
        if kind == b"IEND":
            break
    if dimensions != (ATLAS_WIDTH, ATLAS_HEIGHT):
        raise RuntimeError(
            f"fixture atlas dimensions are {dimensions}, expected "
            f"{ATLAS_WIDTH}x{ATLAS_HEIGHT}"
        )
    raw = zlib.decompress(bytes(compressed))
    stride = ATLAS_WIDTH * 4
    expected_length = (stride + 1) * ATLAS_HEIGHT
    if len(raw) != expected_length:
        raise RuntimeError("fixture PNG decoded byte count is invalid")
    pixels = bytearray()
    for row in range(ATLAS_HEIGHT):
        start = row * (stride + 1)
        if raw[start] != 0:
            raise RuntimeError("fixture PNG unexpectedly uses a filtered scanline")
        pixels.extend(raw[start + 1 : start + stride + 1])
    return hashlib.sha256(pixels).hexdigest()


def validate_fixture(directory: Path) -> None:
    metadata_path = directory / "pet.json"
    if not metadata_path.is_file():
        raise RuntimeError(f"fixture metadata is missing: {metadata_path}")
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    spritesheet_name = metadata.get("spritesheetPath")
    if spritesheet_name != SPRITESHEET_NAME:
        raise RuntimeError("fixture pet.json must reference the deterministic PNG atlas")
    spritesheet_path = directory / spritesheet_name
    if not spritesheet_path.is_file():
        raise RuntimeError(f"fixture spritesheet is missing: {spritesheet_path}")
    size = spritesheet_path.stat().st_size
    if size < MIN_SPRITESHEET_BYTES:
        raise RuntimeError(
            f"fixture spritesheet is too small: {size} < {MIN_SPRITESHEET_BYTES}"
        )
    expected_hash = metadata.get("decodedRgbaSha256")
    if expected_hash != DECODED_RGBA_SHA256:
        raise RuntimeError("fixture metadata has a missing or unexpected decoded RGBA hash")
    actual_hash = decoded_rgba_sha256(spritesheet_path)
    if actual_hash != expected_hash:
        raise RuntimeError(
            f"fixture decoded RGBA hash mismatch: {actual_hash} != {expected_hash}"
        )


def copy_fixture(source: Path, destination: Path) -> None:
    validate_fixture(source)
    if destination.exists():
        shutil.rmtree(destination)
    destination.mkdir(parents=True)
    source_metadata = json.loads((source / "pet.json").read_text(encoding="utf-8"))
    spritesheet_name = source_metadata["spritesheetPath"]
    shutil.copyfile(source / spritesheet_name, destination / spritesheet_name)
    metadata = {
        "id": "ci-pet",
        "displayName": "CI Pet",
        "description": "Deterministic native desktop smoke fixture",
        "spriteVersionNumber": 2,
        "spritesheetPath": spritesheet_name,
        "decodedRgbaSha256": DECODED_RGBA_SHA256,
    }
    (destination / "pet.json").write_text(
        json.dumps(metadata, separators=(",", ":")), encoding="utf-8"
    )


def generate_fixture(destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        shutil.rmtree(destination)
    destination.mkdir()
    write_spritesheet(destination / SPRITESHEET_NAME)
    metadata = {
        "id": "ci-pet",
        "displayName": "CI Pet",
        "description": "Deterministic native desktop smoke fixture",
        "spriteVersionNumber": 2,
        "spritesheetPath": SPRITESHEET_NAME,
        "decodedRgbaSha256": DECODED_RGBA_SHA256,
    }
    (destination / "pet.json").write_text(
        json.dumps(metadata, separators=(",", ":")), encoding="utf-8"
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dest", type=Path)
    parser.add_argument("--source", type=Path)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()

    if args.self_test:
        with tempfile.TemporaryDirectory(prefix="petdex-native-fixture-") as temp:
            fixture = Path(temp) / "ci-pet"
            generate_fixture(fixture)
            validate_fixture(fixture)
            actual = decoded_rgba_sha256(fixture / SPRITESHEET_NAME)
            if actual != DECODED_RGBA_SHA256:
                raise RuntimeError("self-test did not reproduce the pinned RGBA hash")
        print(f"native desktop fixture self-test: PASS {DECODED_RGBA_SHA256}")
        return
    if args.dest is None:
        parser.error("--dest is required unless --self-test is used")

    destination = args.dest.expanduser().resolve()
    if args.source is not None:
        copy_fixture(args.source.expanduser().resolve(), destination)
    else:
        generate_fixture(destination)
    validate_fixture(destination)
    print(f"{destination} decoded-rgba-sha256={DECODED_RGBA_SHA256}")


if __name__ == "__main__":
    main()
