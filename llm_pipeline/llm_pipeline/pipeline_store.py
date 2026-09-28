"""
Reading and writing pipeline and preset files on behalf of editor clients.

Every client-submitted definition goes through the SAME validator the YAML
loader uses (`PipelineDefinition.model_validate` — which runs
validate_pipeline_dag), then through the ModelCatalog allowlist, and only
then is written. A definition either passes all of that and is written
exactly as validated, or nothing touches the disk.

Writes are atomic (temp file + os.replace in the same directory), so a
reader never sees a half-written file, and optimistic: a save names the
revision (content hash) it was based on, and is refused if the file changed
since. Saves to one name are serialized by a process-local asyncio.Lock —
a recorded single-process compromise, the same kind the rest of this stage
makes; with several workers the revision check still catches most races
but is not atomic across processes.

Saving over an existing file keeps its hand-written comments and layout
(see _preserving_yaml): the new definition is merged into the file's
round-trip YAML document rather than replacing it. New files are written
in one canonical form. Either way the written text is re-parsed through the
validator and must mean exactly the validated definition.
"""

import asyncio
import contextlib
import hashlib
import io
import logging
import os
import re
import tempfile
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, cast

import yaml
from fastapi import Request
from pydantic import BaseModel, ValidationError
from ruamel.yaml import YAML
from ruamel.yaml.comments import CommentedMap, CommentedSeq
from ruamel.yaml.scalarstring import LiteralScalarString

from llm_pipeline.errors import (
    AlreadyExistsError,
    DefinitionInvalidError,
    InvalidNameError,
    PipelineNotFoundError,
    ProtectedPipelineError,
    RevisionConflictError,
    ValidationProblem,
)
from llm_pipeline.model_catalog import ModelCatalog, ModelNotAllowedError, ModelUse, model_identity
from llm_pipeline.pipeline_config import NodePreset, PipelineDefinition, is_safe_name
from llm_pipeline.pipeline_config.effective import effective_node

# Top-level key order for written pipeline files — matches the hand-written
# files in pipelines/ (name first), rather than the model's field order.
_PIPELINE_KEY_ORDER = (
    "name",
    "description",
    "version",
    "execution",
    "defaults",
    "history",
    "nodes",
    "branches",
    "loops",
    "output_node",
    "tests",
)

_COMMENT_LINE = re.compile(r"^\s*#", re.MULTILINE)

logger: logging.Logger = logging.getLogger("llm_pipeline")


class _CanonicalDumper(yaml.SafeDumper):
    """SafeDumper that indents list items under their key (`nodes:\\n  - id`)
    like the hand-written pipeline files, instead of PyYAML's flush-left
    default."""

    def increase_indent(self, flow: bool = False, indentless: bool = False) -> None:
        super().increase_indent(flow, False)


def _represent_str(dumper: yaml.SafeDumper, data: str) -> yaml.ScalarNode:
    # Multi-line prompts as `|` literal blocks — readable and diff-friendly.
    style = "|" if "\n" in data else None
    return dumper.represent_scalar("tag:yaml.org,2002:str", data, style=style)


_CanonicalDumper.add_representer(str, _represent_str)


def revision_of(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()[:16]


def _check_name(name: str) -> None:
    if not is_safe_name(name):
        raise InvalidNameError(f"invalid name {name!r} — use only letters, digits, '-' and '_'")


def _to_json(model: BaseModel) -> dict[str, Any]:
    return model.model_dump(mode="json", by_alias=True, exclude_none=True)


def definition_to_json(definition: PipelineDefinition) -> dict[str, Any]:
    """The wire form of a definition: every set field, aliases applied
    (`from`, not `from_`), unset optional fields omitted."""
    return _to_json(definition)


def _canonical_pipeline(definition: PipelineDefinition) -> dict[str, Any]:
    data = definition_to_json(definition)
    ordered = {key: data[key] for key in _PIPELINE_KEY_ORDER if key in data}
    if not ordered.get("description"):
        ordered.pop("description", None)
    for key in ("branches", "loops"):
        if not ordered.get(key):
            ordered.pop(key, None)
    # Pipeline-wide blocks: only what differs from the built-in defaults.
    blocks = (
        ("defaults", definition.defaults),
        ("history", definition.history),
        ("tests", definition.tests),
    )
    for key, block in blocks:
        pruned = block.model_dump(
            mode="json", by_alias=True, exclude_none=True, exclude_defaults=True
        )
        if pruned:
            ordered[key] = pruned
        else:
            ordered.pop(key, None)
    for node in ordered["nodes"]:
        if node.get("type") == "llm_call":
            del node["type"]
        if node.get("include_history") is True:
            del node["include_history"]
    for branch in ordered.get("branches", []):
        for route in branch["routes"]:
            if route.get("default") is False:
                del route["default"]
    return ordered


def _dump_yaml(data: dict[str, Any]) -> str:
    return yaml.dump(
        data,
        Dumper=_CanonicalDumper,
        sort_keys=False,
        allow_unicode=True,
        default_flow_style=False,
        width=100,
    )


def definition_to_yaml(definition: PipelineDefinition) -> str:
    return _dump_yaml(_canonical_pipeline(definition))


# ---------------------------------------------------------------------------
# Comment-preserving writes
# ---------------------------------------------------------------------------

# `key: { a: 1, b: 2 }` (padded) and `key: {a: 1, b: 2}` (as ruamel emits it),
# optionally followed by a comment. Only a mapping value is matched — a
# quoted prompt containing braces never looks like this.
_PADDED_FLOW_MAP = re.compile(r"^\s*(?:- )?[\w.-]+: \{ .* \}\s*(?:#.*)?$")
_TIGHT_FLOW_MAP = re.compile(r"^(\s*(?:- )?[\w.-]+: )\{(\S.*\S)\}(\s*#.*)?$")
# `key: |`, `- key: >-` … — the start of a block scalar (e.g. a prompt).
_BLOCK_SCALAR_START = re.compile(r"^(\s*)(- )?[\w.-]+: [|>][-+0-9]*\s*(?:#.*)?$")


def _round_trip_yaml() -> YAML:
    rt = YAML()  # round-trip mode: keeps comments, key order and quoting
    rt.preserve_quotes = True
    rt.width = 4096  # never re-wrap an existing long line
    rt.indent(mapping=2, sequence=4, offset=2)  # "  - id: …", like the shipped files
    return rt


def _to_round_trip(value: object) -> object:
    if isinstance(value, dict):
        mapping = CommentedMap()
        for key, item in cast(dict[str, object], value).items():
            mapping[key] = _to_round_trip(item)
        return mapping
    if isinstance(value, list):
        return CommentedSeq([_to_round_trip(item) for item in cast(list[object], value)])
    if isinstance(value, str) and "\n" in value:
        return LiteralScalarString(value)
    return value


def _is_id_list(value: object) -> bool:
    return isinstance(value, list) and all(
        isinstance(item, dict) and "id" in item for item in cast(list[object], value)
    )


def _by_id(value: object) -> dict[object, object]:
    if not _is_id_list(value):
        return {}
    return {cast(dict[str, object], item)["id"]: item for item in cast(list[object], value)}


def _merge(old: object, new: object, old_full: object, canon: object) -> object:
    """The value to write for one position in the document, reusing `old`
    (and the comments attached to it) wherever possible.

    `new` is the full new value, `old_full` the full value the file used to
    mean (defaults included — what it said implicitly), and `canon` the
    canonical form of `new` (defaults pruned), used for anything the file
    didn't contain before."""
    if old == new:
        return old
    if isinstance(old, CommentedMap) and isinstance(new, dict):
        new_map = cast(dict[str, object], new)
        full_map = cast(dict[str, object], old_full) if isinstance(old_full, dict) else {}
        canon_map = cast(dict[str, object], canon) if isinstance(canon, dict) else new_map
        for key in [k for k in old if k not in new_map]:
            del old[key]
        for key, value in new_map.items():
            if key in old:
                old[key] = _merge(old[key], value, full_map.get(key), canon_map.get(key, value))
            elif key in full_map:
                # The file left this implicit; only spell it out if it changed.
                if full_map[key] != value:
                    old[key] = _to_round_trip(canon_map.get(key, value))
            elif key in canon_map:
                old[key] = _to_round_trip(canon_map[key])
        return old
    if isinstance(old, CommentedSeq) and _is_id_list(old) and _is_id_list(new):
        # nodes / branches / loops: match items by id so each keeps its comments.
        old_items, full_items, canon_items = _by_id(old), _by_id(old_full), _by_id(canon)
        new_list = cast(list[dict[str, object]], new)
        merged: list[object] = []
        for item in new_list:
            item_id = item["id"]
            canon_item = canon_items.get(item_id, item)
            if item_id in old_items:
                merged.append(_merge(old_items[item_id], item, full_items.get(item_id), canon_item))
            else:
                merged.append(_to_round_trip(canon_item))
        if [item["id"] for item in new_list] == list(old_items):
            for index, value in enumerate(merged):
                old[index] = value
            return old
        return CommentedSeq(merged)
    if isinstance(old, CommentedSeq) and isinstance(new, list):
        new_values = cast(list[object], new)
        full_values = cast(list[object], old_full) if isinstance(old_full, list) else []
        canon_values = cast(list[object], canon) if isinstance(canon, list) else new_values
        if len(old) == len(new_values):
            # Same length (e.g. branch routes, depends_on): merge position by
            # position in place, keeping comments attached to the list.
            for index, value in enumerate(new_values):
                old[index] = _merge(
                    old[index],
                    value,
                    full_values[index] if index < len(full_values) else None,
                    canon_values[index] if index < len(canon_values) else value,
                )
            return old
        seq = CommentedSeq([_to_round_trip(value) for value in canon_values])
        if old.fa.flow_style():
            seq.fa.set_flow_style()
        return seq
    return _to_round_trip(new)


def _restore_flow_padding(original: str, text: str) -> str:
    """ruamel writes flow mappings as `{a: 1}`; if the file used the padded
    `{ a: 1 }` style, keep it — padding inside flow braces is insignificant
    in YAML, and the caller re-validates the result anyway."""
    if not any(_PADDED_FLOW_MAP.match(line) for line in original.splitlines()):
        return text
    lines: list[str] = []
    block_key_indent: int | None = None  # set while inside a block scalar
    for line in text.splitlines():
        indent = len(line) - len(line.lstrip(" "))
        if block_key_indent is not None and (not line.strip() or indent > block_key_indent):
            lines.append(line)  # block scalar content (prompt text) — never touched
            continue
        block_key_indent = None
        start = _BLOCK_SCALAR_START.match(line)
        if start:
            block_key_indent = len(start[1]) + (2 if start[2] else 0)
            lines.append(line)
            continue
        lines.append(_TIGHT_FLOW_MAP.sub(lambda m: f"{m[1]}{{ {m[2]} }}{m[3] or ''}", line))
    return "\n".join(lines) + ("\n" if text.endswith("\n") else "")


def _preserving_yaml(
    original: str, old_full: dict[str, Any], full: dict[str, Any], canon: dict[str, Any]
) -> str:
    """`original` (the file's current text) with the new content merged in:
    comments, key order, quoting and flow/block style of everything that
    didn't change are kept."""
    rt = _round_trip_yaml()
    document = rt.load(original)
    if not isinstance(document, CommentedMap):
        raise ValueError("not a YAML mapping")
    merged = _merge(document, full, old_full, canon)
    buffer = io.StringIO()
    rt.dump(merged, buffer)
    return _restore_flow_padding(original, buffer.getvalue())


def _describe_validation_error(e: ValidationError, raw: object) -> DefinitionInvalidError:
    """Turns pydantic's error list into one readable message plus, when
    possible, the id of the node at fault — from a PipelineValidationError
    raised by validation.py, or from a `nodes.<index>...` error location."""
    errors = e.errors()
    issues = [
        ValidationProblem(
            location=".".join(str(part) for part in err["loc"]),
            message=err["msg"].removeprefix("Value error, "),
            type=err["type"],
        )
        for err in errors
    ]

    first = errors[0]
    ctx_error = first.get("ctx", {}).get("error")
    node_id: str | None = getattr(ctx_error, "node_id", None)
    loc = first["loc"]
    if node_id is None and len(loc) >= 2 and loc[0] == "nodes" and isinstance(loc[1], int):
        with contextlib.suppress(LookupError, TypeError, AttributeError):
            candidate = cast(dict[str, Any], raw)["nodes"][loc[1]]["id"]
            if isinstance(candidate, str):
                node_id = candidate

    location, message, _ = issues[0]
    summary = f"{location}: {message}" if location else message
    if len(issues) > 1:
        summary += f" (and {len(issues) - 1} more problem(s))"
    return DefinitionInvalidError(summary, node_id, issues)


def parse_definition(raw: object) -> PipelineDefinition:
    """The single validation path for client-submitted definitions — the
    same model_validate the YAML loader calls."""
    try:
        return PipelineDefinition.model_validate(raw)
    except ValidationError as e:
        raise _describe_validation_error(e, raw) from e


def parse_definition_yaml(text: str) -> PipelineDefinition:
    try:
        raw = yaml.safe_load(text)
    except yaml.YAMLError as e:
        raise DefinitionInvalidError(f"not valid YAML: {e}") from e
    if not isinstance(raw, dict):
        raise DefinitionInvalidError("YAML must be a mapping with name, nodes and output_node")
    return parse_definition(raw)


def model_blocks(definition: PipelineDefinition) -> list[ModelUse]:
    """Every model block a definition can call: nodes' own models, the
    pipeline default, the history summarizer and the test judge."""
    uses = [ModelUse(n.id, n.model, f"node '{n.id}'") for n in definition.nodes if n.model]
    if definition.defaults.model is not None:
        uses.append(ModelUse(None, definition.defaults.model, "pipeline default model"))
    if definition.history.summarize is not None:
        uses.append(ModelUse(None, definition.history.summarize.model, "history summarizer"))
    if definition.tests.judge is not None:
        uses.append(ModelUse(None, definition.tests.judge.model, "test judge"))
    return uses


def effective_model_uses(definition: PipelineDefinition) -> list[ModelUse]:
    """The model each node really runs with (defaults applied, options
    merged) — what limit hints must look at."""
    uses = [
        ModelUse(n.id, effective_node(definition, n).model, f"node '{n.id}'")
        for n in definition.nodes
    ]
    if definition.history.summarize is not None:
        uses.append(ModelUse(None, definition.history.summarize.model, "history summarizer"))
    return uses


# In Precondition.revisions: any existing file will do (HTTP's If-Match: *).
ANY_REVISION = "*"


@dataclass(frozen=True)
class Precondition:
    """When a write may go ahead, judged against the revision of the file it
    replaces — compare-and-swap, as HTTP's If-Match and If-None-Match: *.
    The default sets no condition: the write creates or replaces.

    `revisions`: the file must exist at one of these revisions (ANY_REVISION:
    at any). `must_not_exist`: create only."""

    revisions: frozenset[str] | None = None
    must_not_exist: bool = False

    @property
    def is_set(self) -> bool:
        return self.revisions is not None or self.must_not_exist

    def check(self, current: str | None, what: str) -> None:
        """Raises unless a write to `what` (e.g. "pipeline 'x'"), whose file
        is at revision `current` (None: no file), may go ahead."""
        if self.revisions is not None:
            if current is None:
                raise RevisionConflictError(f"{what} no longer exists")
            if ANY_REVISION not in self.revisions and current not in self.revisions:
                raise RevisionConflictError(
                    f"{what} changed since you loaded it — reload it to see the latest "
                    f"version first"
                )
        if self.must_not_exist and current is not None:
            raise AlreadyExistsError(
                f"{what} already exists — load it first, or save under a different name"
            )


# The default for every write: no condition — it creates or replaces.
NO_PRECONDITION = Precondition()


def _revision_on_disk(path: Path) -> str | None:
    return revision_of(path.read_bytes()) if path.is_file() else None


@dataclass(frozen=True)
class StoredPipeline:
    definition: PipelineDefinition
    revision: str
    has_comments: bool
    # False only when a save had to rewrite a commented file canonically.
    comments_preserved: bool = True


@dataclass(frozen=True)
class StoredPreset:
    preset: NodePreset
    revision: str


class PipelineStore:
    def __init__(
        self,
        *,
        pipelines_dir: Path,
        presets_dir: Path,
        on_pipeline_changed: Callable[[str], None],
        catalog: ModelCatalog,
        default_pipeline_name: str | None = None,
    ) -> None:
        """`on_pipeline_changed` is called with a pipeline's name after it is
        saved or deleted — main.py passes PipelineCache.invalidate, so the
        next run rebuilds its graph."""
        self.pipelines_dir = pipelines_dir
        self.presets_dir = presets_dir
        self._on_pipeline_changed = on_pipeline_changed
        self.catalog = catalog
        # Clients fall back to this pipeline, so it can't be deleted.
        self.default_pipeline_name = default_pipeline_name
        self._locks: dict[Path, asyncio.Lock] = {}

    def _lock(self, path: Path) -> asyncio.Lock:
        return self._locks.setdefault(path, asyncio.Lock())

    def _pipeline_path(self, name: str) -> Path:
        _check_name(name)
        return self.pipelines_dir / f"{name}.yaml"

    def _preset_path(self, name: str) -> Path:
        _check_name(name)
        return self.presets_dir / f"{name}.yaml"

    # -- pipelines ---------------------------------------------------------

    def read_pipeline(self, name: str) -> StoredPipeline:
        try:
            path = self._pipeline_path(name)
        except InvalidNameError:
            raise PipelineNotFoundError(name) from None
        if not path.is_file():
            raise PipelineNotFoundError(name)
        content = path.read_bytes()
        text = content.decode("utf-8")
        return StoredPipeline(
            definition=parse_definition_yaml(text),
            revision=revision_of(content),
            has_comments=bool(_COMMENT_LINE.search(text)),
        )

    def _stored_model_identities(self, name: str) -> set[str]:
        try:
            stored = self.read_pipeline(name)
        except (PipelineNotFoundError, DefinitionInvalidError):
            return set()
        return {model_identity(use.model) for use in model_blocks(stored.definition)}

    async def model_issues(
        self, name: str, definition: PipelineDefinition
    ) -> list[ModelNotAllowedError]:
        """What a save of `definition` under `name` would reject, without
        saving — used for live validation feedback."""
        already = self._stored_model_identities(name) if is_safe_name(name) else set()
        return await self.catalog.issues(model_blocks(definition), already)

    async def save_pipeline(
        self, name: str, raw_definition: object, precondition: Precondition = NO_PRECONDITION
    ) -> StoredPipeline:
        """Creates or replaces pipelines/<name>.yaml — if `precondition` holds
        for the file on disk."""
        path = self._pipeline_path(name)
        definition = parse_definition(raw_definition)
        if definition.name != name:
            raise DefinitionInvalidError(
                f"definition name '{definition.name}' must match the pipeline name '{name}'"
            )

        async with self._lock(path):
            current = path.read_bytes() if path.is_file() else None
            precondition.check(
                revision_of(current) if current is not None else None, f"pipeline '{name}'"
            )

            await self.catalog.check(model_blocks(definition), self._stored_model_identities(name))

            text, comments_preserved = self._pipeline_text(
                definition, current.decode("utf-8") if current is not None else None
            )
            _atomic_write(path, text)
            self._on_pipeline_changed(name)

        return StoredPipeline(
            definition,
            revision_of(text.encode("utf-8")),
            has_comments=bool(_COMMENT_LINE.search(text)),
            comments_preserved=comments_preserved,
        )

    def _pipeline_text(
        self, definition: PipelineDefinition, original: str | None
    ) -> tuple[str, bool]:
        """The file text to write, and whether the original's comments were
        kept. Tries a comment-preserving merge into `original`; falls back
        to the canonical form if that fails or wouldn't mean exactly
        `definition`. The canonical form must always round-trip."""
        if original is not None:
            try:
                old_full = definition_to_json(parse_definition_yaml(original))
                text = _preserving_yaml(
                    original,
                    old_full,
                    definition_to_json(definition),
                    _canonical_pipeline(definition),
                )
                if parse_definition_yaml(text) == definition:
                    return text, True
                logger.warning(f"comment-preserving save of '{definition.name}' didn't round-trip")
            except Exception:
                logger.exception(f"comment-preserving save of '{definition.name}' failed")
        text = definition_to_yaml(definition)
        # Defensive: the file must mean exactly what was validated.
        if parse_definition_yaml(text) != definition:
            raise RuntimeError(f"canonical YAML for '{definition.name}' did not round-trip")
        return text, original is None or not _COMMENT_LINE.search(original)

    async def delete_pipeline(self, name: str, precondition: Precondition = NO_PRECONDITION) -> str:
        """Soft-deletes pipelines/<name>.yaml (see _soft_delete) — if
        `precondition` holds — and returns where it went, relative to the
        pipelines directory."""
        path = self._pipeline_path(name)
        if name == self.default_pipeline_name:
            raise ProtectedPipelineError(
                f"'{name}' is the server's default pipeline (DEFAULT_PIPELINE_NAME) and "
                f"can't be deleted"
            )
        async with self._lock(path):
            if not path.is_file():
                raise PipelineNotFoundError(name)
            precondition.check(_revision_on_disk(path), f"pipeline '{name}'")
            moved = _soft_delete(path)
            self._on_pipeline_changed(name)
        return str(moved.relative_to(self.pipelines_dir))

    # -- presets -----------------------------------------------------------

    def _read_preset_file(self, path: Path) -> StoredPreset:
        content = path.read_bytes()
        raw = yaml.safe_load(content)
        try:
            preset = NodePreset.model_validate(raw)
        except ValidationError as e:
            raise _describe_validation_error(e, raw) from e
        return StoredPreset(preset, revision_of(content))

    def list_presets(self) -> list[NodePreset]:
        """Every loadable preset — invalid files are skipped, like
        list_available_pipelines does for pipelines."""
        if not self.presets_dir.is_dir():
            return []
        presets: list[NodePreset] = []
        for path in sorted(self.presets_dir.glob("*.yaml")):
            try:
                presets.append(self._read_preset_file(path).preset)
            except Exception:
                continue
        return presets

    def read_preset(self, name: str) -> StoredPreset:
        try:
            path = self._preset_path(name)
        except InvalidNameError:
            raise FileNotFoundError(name) from None
        if not path.is_file():
            raise FileNotFoundError(name)
        return self._read_preset_file(path)

    async def save_preset(
        self, name: str, raw_preset: object, precondition: Precondition = NO_PRECONDITION
    ) -> StoredPreset:
        """Presets are small, personal building blocks, so saving one creates
        or replaces it — unless the caller sets a `precondition`."""
        path = self._preset_path(name)
        try:
            preset = NodePreset.model_validate(raw_preset)
        except ValidationError as e:
            raise _describe_validation_error(e, raw_preset) from e
        if preset.name != name:
            raise DefinitionInvalidError(
                f"preset name '{preset.name}' must match the name '{name}'"
            )

        async with self._lock(path):
            precondition.check(_revision_on_disk(path), f"preset '{name}'")
            stored: set[str] = set()
            with contextlib.suppress(FileNotFoundError, DefinitionInvalidError):
                stored = {model_identity(self.read_preset(name).preset.model)}
            await self.catalog.check([ModelUse(None, preset.model, "preset")], stored)
            data = _to_json(preset)
            if not data.get("description"):
                data.pop("description", None)
            text = _dump_yaml(data)
            if path.is_file():
                # Same comment-preserving merge as pipelines; the canonical
                # text above is the fallback.
                original = path.read_text(encoding="utf-8")
                try:
                    old = NodePreset.model_validate(yaml.safe_load(original))
                    merged = _preserving_yaml(original, _to_json(old), _to_json(preset), data)
                    if NodePreset.model_validate(yaml.safe_load(merged)) == preset:
                        text = merged
                except Exception:
                    logger.exception(f"comment-preserving save of preset '{name}' failed")
            _atomic_write(path, text)
        return StoredPreset(preset, revision_of(text.encode("utf-8")))

    async def delete_preset(self, name: str, precondition: Precondition = NO_PRECONDITION) -> str:
        """Soft-deletes presets/<name>.yaml — if `precondition` holds — and
        returns where it went, relative to the presets directory."""
        path = self._preset_path(name)
        async with self._lock(path):
            if not path.is_file():
                raise FileNotFoundError(name)
            precondition.check(_revision_on_disk(path), f"preset '{name}'")
            moved = _soft_delete(path)
        return str(moved.relative_to(self.presets_dir))


def _soft_delete(path: Path) -> Path:
    """Moves `path` into a `.deleted/` folder next to it, timestamped, so a
    deletion is recoverable by moving the file back. Listings only look at
    top-level `*.yaml`, so deleted files disappear from every client."""
    trash = path.parent / ".deleted"
    trash.mkdir(exist_ok=True)
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    target = trash / f"{path.stem}.{stamp}.yaml"
    counter = 2
    while target.exists():
        target = trash / f"{path.stem}.{stamp}-{counter}.yaml"
        counter += 1
    os.replace(path, target)
    return target


def _atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # The temp name ends in .tmp so a concurrent `glob("*.yaml")` listing
    # never picks up a half-written file.
    fd, tmp_name = tempfile.mkstemp(dir=path.parent, prefix=f".{path.stem}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_name, path)
    except BaseException:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(tmp_name)
        raise


def get_pipeline_store(request: Request) -> PipelineStore:
    """FastAPI dependency — the PipelineStore built in main.py's lifespan
    and held on app.state (see pipeline_loader.get_pipeline_cache)."""
    store: PipelineStore = request.app.state.pipeline_store
    return store
