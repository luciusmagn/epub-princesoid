#!/usr/bin/env python3
"""Decode Gemini's schema-less protobuf conversation export.

The export currently observed in this repo has this useful shape:

  field 2: conversation id
  field 3:
    field 1:
      field 1: title
      repeated field 2:
        field 1: user prompt
        field 2: model response
    field 2: opaque metadata/cache blob

This script intentionally keeps the parser small and schema-less so it can be
used on raw exports without a .proto file.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


WIRE_VARINT = 0
WIRE_FIXED64 = 1
WIRE_LENGTH_DELIMITED = 2
WIRE_FIXED32 = 5


@dataclass(frozen=True)
class Field:
    number: int
    wire_type: int
    value: int | bytes


def read_varint(data: bytes, offset: int) -> tuple[int, int]:
    value = 0
    shift = 0

    while offset < len(data):
        byte = data[offset]
        offset += 1
        value |= (byte & 0x7F) << shift

        if byte < 0x80:
            return value, offset

        shift += 7
        if shift > 70:
            raise ValueError("varint is too long")

    raise ValueError("unexpected end of file while reading varint")


def parse_fields(data: bytes) -> list[Field]:
    fields: list[Field] = []
    offset = 0

    while offset < len(data):
        key, offset = read_varint(data, offset)
        number = key >> 3
        wire_type = key & 0x07

        if number == 0:
            raise ValueError("invalid protobuf field number 0")

        if wire_type == WIRE_VARINT:
            value, offset = read_varint(data, offset)
            fields.append(Field(number, wire_type, value))
            continue

        if wire_type == WIRE_FIXED64:
            value = data[offset : offset + 8]
            if len(value) != 8:
                raise ValueError("truncated fixed64 field")
            offset += 8
            fields.append(Field(number, wire_type, value))
            continue

        if wire_type == WIRE_LENGTH_DELIMITED:
            length, offset = read_varint(data, offset)
            value = data[offset : offset + length]
            if len(value) != length:
                raise ValueError("truncated length-delimited field")
            offset += length
            fields.append(Field(number, wire_type, value))
            continue

        if wire_type == WIRE_FIXED32:
            value = data[offset : offset + 4]
            if len(value) != 4:
                raise ValueError("truncated fixed32 field")
            offset += 4
            fields.append(Field(number, wire_type, value))
            continue

        raise ValueError(f"unsupported protobuf wire type {wire_type}")

    return fields


def length_fields(fields: Iterable[Field], number: int) -> list[bytes]:
    values: list[bytes] = []
    for field in fields:
        if field.number == number and field.wire_type == WIRE_LENGTH_DELIMITED:
            assert isinstance(field.value, bytes)
            values.append(field.value)
    return values


def text_field(fields: Iterable[Field], number: int) -> str:
    values = length_fields(fields, number)
    if not values:
        return ""
    return values[0].decode("utf-8", errors="replace")


def decode_export(data: bytes) -> dict[str, object]:
    top = parse_fields(data)
    conversation_id = text_field(top, 2)
    envelopes = length_fields(top, 3)

    if not envelopes:
        raise ValueError("missing conversation envelope in field 3")

    envelope = parse_fields(envelopes[0])
    conversations = length_fields(envelope, 1)
    metadata_blobs = length_fields(envelope, 2)

    if not conversations:
        raise ValueError("missing conversation body in field 3.1")

    body = parse_fields(conversations[0])
    title = text_field(body, 1)
    turns = []

    for raw_turn in length_fields(body, 2):
        turn = parse_fields(raw_turn)
        turns.append(
            {
                "prompt": text_field(turn, 1),
                "response": text_field(turn, 2),
            }
        )

    return {
        "conversation_id": conversation_id,
        "title": title,
        "turn_count": len(turns),
        "turns": turns,
        "ignored_metadata_bytes": sum(len(blob) for blob in metadata_blobs),
    }


def write_markdown(decoded: dict[str, object], path: Path) -> None:
    turns = decoded["turns"]
    assert isinstance(turns, list)

    lines = [
        f"# {decoded['title']}",
        "",
        f"- Conversation ID: `{decoded['conversation_id']}`",
        f"- Turns: {decoded['turn_count']}",
        f"- Ignored metadata/cache bytes: {decoded['ignored_metadata_bytes']}",
        "",
    ]

    for index, turn in enumerate(turns, start=1):
        assert isinstance(turn, dict)
        lines.extend(
            [
                f"## Turn {index}",
                "",
                "### User",
                "",
                str(turn["prompt"]).strip(),
                "",
                "### Gemini",
                "",
                str(turn["response"]).strip(),
                "",
            ]
        )

    path.write_text("\n".join(lines), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("export", type=Path)
    parser.add_argument("--markdown", type=Path, required=True)
    parser.add_argument("--json", type=Path)
    args = parser.parse_args()

    decoded = decode_export(args.export.read_bytes())
    args.markdown.parent.mkdir(parents=True, exist_ok=True)
    write_markdown(decoded, args.markdown)

    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(
            json.dumps(decoded, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )


if __name__ == "__main__":
    main()
