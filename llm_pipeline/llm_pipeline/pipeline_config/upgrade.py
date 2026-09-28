"""
Reading pipelines and presets written for an older schema version.

Version 2 renamed what version 1 called:

    version 1                           version 2
    model: {provider, model}            model: {provider, name}
    output_node: a  |  [a, b]           output_nodes: [a, b]
    execution.max_history_turns         history.max_turns

Version-1 keys are still accepted, from files and API request bodies alike:
schema.py's "before" validators upgrade a copy of the input before
validating it. Everything is written as version 2.

How keys are changed is up to a `KeyEdits`. The default suits plain dicts;
pipeline_store.py passes one that keeps each key's position and comment, to
upgrade a file's round-trip YAML document before merging a save into it.
"""

from collections.abc import Mapping, MutableMapping
from copy import deepcopy
from typing import Any, Protocol, TypeAlias, cast

SCHEMA_VERSION = 2

Document: TypeAlias = MutableMapping[str, Any]


class KeyEdits(Protocol):
    def replace_key(self, mapping: Document, old: str, new: str, value: object) -> None:
        """Puts `new: value` where `old` was."""
        ...

    def insert_key(self, mapping: Document, index: int, key: str, value: object) -> None:
        """Adds `key: value` at `index` in the mapping's key order."""
        ...

    def move_key(self, source: Document, old: str, target: Document, index: int, new: str) -> None:
        """Moves `old` out of `source`, into `target` as `new`, at `index`."""
        ...


class PlainEdits:
    """For plain dicts, whose key order nothing depends on."""

    def replace_key(self, mapping: Document, old: str, new: str, value: object) -> None:
        del mapping[old]
        mapping[new] = value

    def insert_key(self, mapping: Document, index: int, key: str, value: object) -> None:
        mapping[key] = value

    def move_key(self, source: Document, old: str, target: Document, index: int, new: str) -> None:
        target[new] = source.pop(old)


_PLAIN = PlainEdits()


def _child(mapping: Document | None, key: str) -> Document | None:
    value = None if mapping is None else mapping.get(key)
    return cast(Document, value) if isinstance(value, MutableMapping) else None


def _both(old: str, new: str) -> ValueError:
    return ValueError(f"'{old}' is the version-1 name of '{new}' — use only '{new}'")


def upgrade_model_block(block: Document, edits: KeyEdits = _PLAIN) -> None:
    """`{provider, model}` → `{provider, name}`, in place."""
    if "model" in block:
        if "name" in block:
            raise _both("model", "name")
        edits.replace_key(block, "model", "name", block["model"])


def _model_blocks(document: Document) -> list[Document]:
    nodes = document.get("nodes")
    holders = [
        cast(Document, node) if isinstance(node, MutableMapping) else None
        for node in (cast(list[object], nodes) if isinstance(nodes, list) else [])
    ]
    holders += [
        _child(document, "defaults"),
        _child(_child(document, "history"), "summarize"),
        _child(_child(document, "tests"), "judge"),
    ]
    return [block for holder in holders if (block := _child(holder, "model")) is not None]


def _move_max_history_turns(document: Document, edits: KeyEdits) -> None:
    execution = _child(document, "execution")
    if execution is None or "max_history_turns" not in execution:
        return
    history = _child(document, "history")
    if history is None:
        edits.insert_key(document, list(document).index("execution") + 1, "history", {})
        history = cast(Document, document["history"])
    elif "max_turns" in history:
        raise _both("execution.max_history_turns", "history.max_turns")
    edits.move_key(execution, "max_history_turns", history, 0, "max_turns")
    if not execution:
        del document["execution"]


def upgrade_pipeline(document: Document, edits: KeyEdits = _PLAIN) -> None:
    """Upgrades a pipeline document to the current version, in place."""
    version = document.get("version", SCHEMA_VERSION)
    if isinstance(version, int) and not 1 <= version <= SCHEMA_VERSION:
        raise ValueError(f"version {version} is not one this server reads (1 to {SCHEMA_VERSION})")
    for block in _model_blocks(document):
        upgrade_model_block(block, edits)
    if "output_node" in document:
        if "output_nodes" in document:
            raise _both("output_node", "output_nodes")
        value = document["output_node"]
        edits.replace_key(
            document, "output_node", "output_nodes", [value] if isinstance(value, str) else value
        )
    _move_max_history_turns(document, edits)
    if version == 1:
        document["version"] = SCHEMA_VERSION


def upgrade_preset(document: Document, edits: KeyEdits = _PLAIN) -> None:
    """Upgrades a preset document to the current version, in place."""
    if (block := _child(document, "model")) is not None:
        upgrade_model_block(block, edits)


def upgraded_pipeline(data: object) -> object:
    """An upgraded copy of `data` when it's a mapping; anything else as is."""
    if not isinstance(data, Mapping):
        return data
    document = deepcopy(dict(cast(Mapping[str, Any], data)))
    upgrade_pipeline(document)
    return document


def upgraded_model_block(data: object) -> object:
    """An upgraded copy of `data` when it's a mapping; anything else as is."""
    if not isinstance(data, Mapping):
        return data
    block = dict(cast(Mapping[str, Any], data))
    upgrade_model_block(block)
    return block
