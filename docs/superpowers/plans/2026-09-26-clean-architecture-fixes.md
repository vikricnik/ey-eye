# Clean Architecture Fixes (CA-001 … CA-007) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve the seven findings of the clean architecture review of the pipeline engine without changing any behaviour a user or API client can observe.

**Architecture:** One `Topology` object in `pipeline_config` becomes the only code that enumerates "what runs after what" (CA-001), pinned to the TypeScript client by a shared conformance fixture (CA-006). The definition layer stops reaching outward — to the provider package facade (CA-002) and the wire contract (CA-003). Nodes receive their collaborators as one `NodeServices` object (CA-004), the store notifies instead of holding the cache (CA-005), and the node run function is split into named steps (CA-007).

**Tech Stack:** Python 3.12, Pydantic 2, LangGraph 0.2, pytest; TypeScript 5 (node:test via tsx).

**Spec:** the "Clean Architecture Review" in this session (findings CA-001 … CA-007) plus arxitect `skills/architect/implementer-prompt.md`.

## Global Constraints

- No change to any HTTP request/response shape, YAML format, or CLI/web behaviour.
- Backend gate after every task, from `llm_pipeline/`: `uv run pytest -q`, `uv run ruff check .`, `uv run ruff format --check .`, `uv run mypy llm_pipeline`, `uv run pyright llm_pipeline tests`.
- TypeScript gate for tasks touching `packages/`, `cli/` or `web/`: `npm test` and `npm run typecheck` in each of `packages/client`, `cli`, `web`.
- Do not commit: the user commits.

## Review Focus

- A pipeline where a loop's `exit_to` also lists the loop source in `depends_on` — `Topology` must not treat that as a plain edge (it's the loop's exit), or loop scopes grow past the loop's own exit. Pinned in Task 2.
- A loop exiting to `END` — must not appear as a node anywhere in topology results. Pinned in Task 2.
- Loading/validating a definition must still work with no LLM-related environment configured — i.e. without importing `settings`. Pinned in Task 1.
- An unsaved, *invalid* draft must still render on the editor canvas — so the client keeps deriving topology locally (see Task 3's design note). Pinned by the existing web tests plus Task 3.
- Graphs built without explicit services must keep using the real provider registry (`get_provider`) — production paths build graphs that way. Pinned in Task 6.

---

### Task 1: Definition layer imports provider *types* only (CA-002)

**Files:**
- Modify: `llm_pipeline/llm_pipeline/pipeline_config/schema.py:21`
- Modify: `llm_pipeline/llm_pipeline/pipeline_config/effective.py:15`
- Test: `llm_pipeline/tests/test_import_boundaries.py` (new)

**Interfaces:** none new.

- [ ] **Step 1: Write the failing test**

```python
"""Import boundaries that keep the definition model independent of the
infrastructure around it (CA-002)."""

import subprocess
import sys


def test_loading_the_definition_model_does_not_load_the_provider_layer() -> None:
    # A fresh interpreter: this test process has long since imported everything.
    probe = (
        "import sys, llm_pipeline.pipeline_config\n"
        "loaded = [m for m in ('llm_pipeline.providers.registry', 'llm_pipeline.settings')"
        " if m in sys.modules]\n"
        "print(','.join(loaded))"
    )
    result = subprocess.run(
        [sys.executable, "-c", probe], capture_output=True, text=True, check=True
    )
    assert result.stdout.strip() == ""
```

- [ ] **Step 2: Run it — expect FAIL** (`llm_pipeline.providers.registry,llm_pipeline.settings`)

Run: `uv run pytest tests/test_import_boundaries.py -q`

- [ ] **Step 3: Import from the dependency-free module** — in both files:

```python
from llm_pipeline.providers.base import OllamaOptions, ProviderType
```

- [ ] **Step 4: Run the test, then the backend gate — expect PASS.** If still failing, find the remaining importer with `python -X importtime -c "import llm_pipeline.pipeline_config" 2>&1 | grep -E "registry|settings"` and fix it the same way.

---

### Task 2: One `Topology` for "what runs after what" (CA-001)

**Files:**
- Create: `llm_pipeline/llm_pipeline/pipeline_config/topology.py`
- Modify: `llm_pipeline/llm_pipeline/pipeline_config/__init__.py` (export `Topology`, `RouteInto`)
- Modify: `llm_pipeline/llm_pipeline/pipeline_config/activation.py` (use `Topology`; delete `_loop_scopes`, `plain_deps`, `routes_into` construction)
- Modify: `llm_pipeline/llm_pipeline/pipeline_config/validation.py` (`_check_no_conflicting_conditional_edges` uses `Topology.destinations`)
- Modify: `llm_pipeline/llm_pipeline/rerun.py` (`downstream` → `Topology.reachable_from`)
- Modify: `llm_pipeline/llm_pipeline/dag_builder/loops.py` (delete `nested_loops`), `llm_pipeline/llm_pipeline/dag_builder/graph.py` (use `Topology(definition).nested_loops()`)
- Test: `llm_pipeline/tests/test_topology.py` (new)

**Interfaces:**
- Produces: `Topology(definition)` with `conditional_sources: frozenset[str]`, `loop_exit_targets: frozenset[str]`, `plain_dependencies(node_id) -> list[str]`, `routes_into(node_id) -> list[RouteInto]`, `destinations(source) -> set[str]`, `successors(node_id, *, skip_exit_of: str | None = None) -> set[str]`, `reachable_from(node_id, *, skip_exit_of: str | None = None) -> set[str]`, `loop_scope(loop_id) -> set[str]`, `nested_loops() -> dict[str, list[str]]`; `RouteInto(source: str, branch_id: str, route_index: int)`.

- [ ] **Step 1: Write the failing tests** (`tests/test_topology.py`)

```python
from typing import Any

from llm_pipeline.pipeline_config import PipelineDefinition, RouteInto, Topology


def _definition(nodes: list[dict[str, Any]], **rest: Any) -> PipelineDefinition:
    return PipelineDefinition.model_validate(
        {
            "name": "p",
            "defaults": {"model": {"provider": "ollama", "model": "m"}},
            "nodes": [{"prompt_template": "x", **n} for n in nodes],
            **rest,
        }
    )


ROUTED = _definition(
    [{"id": "c"}, {"id": "a"}, {"id": "b"}, {"id": "j", "depends_on": ["a", "b"]}],
    branches=[{"id": "br", "from": "c", "routes": [
        {"when": '"A" in output', "to": ["a", "b"]}, {"default": True, "to": "b"}]}],
    output_node="j",
)

NESTED = _definition(
    [
        {"id": "plan"},
        {"id": "draft", "depends_on": ["plan"]},
        {"id": "check", "depends_on": ["draft"]},
        {"id": "review", "depends_on": ["check"]},  # inner loop's exit, declared on its source
    ],
    loops=[
        {"id": "inner", "from": "check", "back_to": "draft", "exit_to": "review",
         "exit_when": "False"},
        {"id": "outer", "from": "review", "back_to": "plan", "exit_to": "END",
         "exit_when": "False"},
    ],
    output_node="review",
)


def test_routes_into_names_every_route_that_starts_a_node() -> None:
    assert Topology(ROUTED).routes_into("b") == [RouteInto("c", "br", 0), RouteInto("c", "br", 1)]


def test_successors_follow_depends_on_routes_and_loop_exits() -> None:
    topology = Topology(NESTED)
    assert topology.successors("plan") == {"draft"}
    assert topology.successors("check") == {"review"}  # the loop's exit, not a plain edge
    assert topology.successors("check", skip_exit_of="inner") == set()
    assert topology.successors("review") == set()  # exit to END is not a node


def test_loop_scope_stops_at_the_loops_own_exit_but_passes_inner_exits() -> None:
    topology = Topology(NESTED)
    assert topology.loop_scope("inner") == {"draft", "check"}
    assert topology.loop_scope("outer") == {"plan", "draft", "check", "review"}


def test_nested_loops_are_found_in_one_direction_only() -> None:
    assert Topology(NESTED).nested_loops() == {"outer": ["inner"], "inner": []}


def test_destinations_of_a_branch_and_a_loop_source() -> None:
    assert Topology(ROUTED).destinations("c") == {"a", "b"}
    assert Topology(NESTED).destinations("check") == {"draft", "review"}
    assert Topology(NESTED).destinations("review") == {"plan"}


def test_reachable_from_includes_the_start() -> None:
    assert Topology(ROUTED).reachable_from("a") == {"a", "j"}
```


- [ ] **Step 2: Run — expect FAIL** (`ImportError: cannot import name 'RouteInto'`).

Run: `uv run pytest tests/test_topology.py -q`

- [ ] **Step 3: Create `pipeline_config/topology.py`**

```python
"""
Who runs after whom in a pipeline definition.

Three kinds of edge lead from one node to the next: a depends_on entry, a
branch route, and a loop's exit (a loop's way back to its back_to is not
"after"). This module is the one place that enumerates them — activation.py
(which joins can wait for all inputs), loop nesting, rerun.py (what a
re-run repeats) and validation.py (which depends_on entries are really a
branch's or loop's) all ask it instead of re-deriving the edges.
packages/client/src/topology.ts mirrors the subset the editor needs; both
are pinned by contracts/topology-cases.json.
"""

from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    # Type hint only — validation.py builds a Topology while a
    # PipelineDefinition is being validated, so a runtime import is circular.
    from llm_pipeline.pipeline_config.schema import PipelineDefinition


@dataclass(frozen=True)
class RouteInto:
    """A branch route that starts a node."""

    source: str
    branch_id: str
    route_index: int


class Topology:
    def __init__(self, definition: "PipelineDefinition") -> None:
        node_ids = {n.id for n in definition.nodes}
        self._loops = {loop.id: loop for loop in definition.loops}
        # Nodes whose outgoing edges belong entirely to a branch or loop.
        self.conditional_sources = frozenset(definition.conditional_sources)
        self.loop_exit_targets = frozenset(
            loop.exit_to for loop in definition.loops if loop.exit_to in node_ids
        )

        self._plain = {
            n.id: [d for d in n.depends_on if d not in self.conditional_sources]
            for n in definition.nodes
        }
        self._dependents: dict[str, set[str]] = {}
        for node_id, deps in self._plain.items():
            for dep in deps:
                self._dependents.setdefault(dep, set()).add(node_id)

        self._routes_into: dict[str, list[RouteInto]] = {}
        self._route_targets: dict[str, set[str]] = {}
        for branch in definition.branches:
            for index, route in enumerate(branch.routes):
                for target in route.targets:
                    self._routes_into.setdefault(target, []).append(
                        RouteInto(branch.from_, branch.id, index)
                    )
                    self._route_targets.setdefault(branch.from_, set()).add(target)

        # source node -> (loop id, exit node) for loops exiting to a node
        self._exits: dict[str, list[tuple[str, str]]] = {}
        for loop in definition.loops:
            if loop.exit_to in node_ids:
                self._exits.setdefault(loop.from_, []).append((loop.id, loop.exit_to))

    def plain_dependencies(self, node_id: str) -> list[str]:
        """depends_on without the entries that are really a branch's or a
        loop's edge (those come from routes_into / the loop instead)."""
        return self._plain[node_id]

    def routes_into(self, node_id: str) -> list[RouteInto]:
        return self._routes_into.get(node_id, [])

    def destinations(self, source: str) -> set[str]:
        """Where a branch or loop source may send the run: its route
        targets, or its loop's back_to and exit node."""
        found = set(self._route_targets.get(source, set()))
        for loop in self._loops.values():
            if loop.from_ == source:
                found.add(loop.back_to)
        found.update(exit_to for _, exit_to in self._exits.get(source, []))
        return found

    def successors(self, node_id: str, *, skip_exit_of: str | None = None) -> set[str]:
        """Nodes that run right after `node_id`: its dependents, its route
        targets, and where its loops exit to — except the exit of loop
        `skip_exit_of`."""
        after = set(self._dependents.get(node_id, set()))
        after.update(self._route_targets.get(node_id, set()))
        after.update(
            exit_to for loop_id, exit_to in self._exits.get(node_id, []) if loop_id != skip_exit_of
        )
        return after

    def reachable_from(self, node_id: str, *, skip_exit_of: str | None = None) -> set[str]:
        """`node_id` and every node that runs after it."""
        reached, pending = set[str](), [node_id]
        while pending:
            current = pending.pop()
            if current not in reached:
                reached.add(current)
                pending.extend(self.successors(current, skip_exit_of=skip_exit_of))
        return reached

    def loop_scope(self, loop_id: str) -> set[str]:
        """The nodes a loop runs again on each pass: everything after its
        back_to, through inner loops' exits, up to its own exit."""
        return self.reachable_from(self._loops[loop_id].back_to, skip_exit_of=loop_id)

    def nested_loops(self) -> dict[str, list[str]]:
        """loop id -> the loops entirely inside it (their back_to and from_
        both run again on each of its passes). Two loops that would each
        count as inside the other — possible only through odd branch
        cycles — are left alone: resetting each other, neither would end."""
        scopes = {loop_id: self.loop_scope(loop_id) for loop_id in self._loops}

        def inside(inner: str, outer: str) -> bool:
            loop = self._loops[inner]
            return inner != outer and {loop.back_to, loop.from_} <= scopes[outer]

        return {
            outer: [inner for inner in self._loops if inside(inner, outer) and not inside(outer, inner)]
            for outer in self._loops
        }
```

Export in `pipeline_config/__init__.py`: add `from llm_pipeline.pipeline_config.topology import RouteInto, Topology` and both names to `__all__`.

- [ ] **Step 4: Run the new tests — expect PASS.**

- [ ] **Step 5: Rewrite the four consumers on top of `Topology`** (the existing suite is the regression test — every join, loop, nesting, rerun and validation test must stay green):
  - `activation.py`: in `_Activation.__init__`, `self.topology = Topology(definition)`; replace `self.plain_deps(...)` with `self.topology.plain_dependencies(...)`, the `routes_into` loop with `self.topology.routes_into(node_id)` yielding tokens `("route", r.branch_id, str(r.route_index))` from `r.source`, `self.exit_targets` with `self.topology.loop_exit_targets`, and `_loop_scopes` with `{node: {loop ids whose topology.loop_scope contains node}}`. Delete `_loop_scopes` and `plain_deps`; `inputs_that_may_never_arrive` uses `activation.topology.plain_dependencies`.
  - `validation.py` `_check_no_conflicting_conditional_edges`: replace the `allowed_destinations` construction with `topology = Topology(definition)` and `topology.destinations(dep)`.
  - `rerun.py`: `def downstream(definition, node_id): return Topology(definition).reachable_from(node_id)`.
  - `dag_builder/loops.py`: delete `nested_loops` (and the now-unused `END_SENTINEL`/`PipelineDefinition` imports); `graph.py`: `nested = Topology(definition).nested_loops()`.

- [ ] **Step 6: Backend gate — expect all green.**

---

### Task 3: Shared topology conformance fixture (CA-006)

**Design note (deviation from the review's recommendation):** the review suggested having the server return derived topology to the client. The editor renders *unsaved and invalid* drafts, for which `/pipelines/validate` returns 422 with no topology — so the canvas must keep deriving topology locally. Instead, both implementations are pinned to one fixture, so they cannot drift silently.

**Files:**
- Create: `contracts/topology-cases.json`
- Create: `packages/client/src/topology.ts` (extracted from `graphModel.ts`), export from `packages/client/src/index.ts`
- Modify: `packages/client/src/graphModel.ts` (use `conditionalSources`, `branchTargets`, `effectiveRoots`)
- Test: `llm_pipeline/tests/test_topology_contract.py`, `packages/client/test/topology.test.ts`

**Interfaces:**
- Consumes: `Topology` (Task 2), `PipelineDefinition.effective_root_ids`, `branch_targets`.
- Produces (TS): `conditionalSources(detail: PipelineDetail): Set<string>`, `branchTargets(detail: PipelineDetail): Set<string>`, `effectiveRoots(detail: PipelineDetail): string[]`.

- [ ] **Step 1: Write the fixture** — `contracts/topology-cases.json`, `{"cases": [...]}`, each `{"name", "definition", "expected": {"effective_roots", "conditional_sources", "branch_targets"}}` (lists sorted). Cases (definitions are full `PipelineDefinition` JSON with `defaults.model` set): `diamond` (a → b, c → d), `branch` (classify → a | default b), `multi-target-route` (route to `[a, b]`, default `c`), `loop` (generate ⇄ critique, exit END), `nested-loops` (Task 2's NESTED), `branch-target-declares-its-source` (target lists `depends_on: [classify]`), `two-branches-one-target` (x → t | default u, y → t | default u), `loop-exits-to-node`.

- [ ] **Step 2: Write both failing tests**

```python
# llm_pipeline/tests/test_topology_contract.py
"""The server side of contracts/topology-cases.json — the client side is
packages/client/test/topology.test.ts. Same cases, same expectations."""

import json
from pathlib import Path
from typing import Any

import pytest

from llm_pipeline.pipeline_config import PipelineDefinition, Topology

CASES = json.loads(
    (Path(__file__).parents[2] / "contracts" / "topology-cases.json").read_text()
)["cases"]


@pytest.mark.parametrize("case", CASES, ids=lambda c: c["name"])
def test_server_topology_matches_the_shared_contract(case: dict[str, Any]) -> None:
    definition = PipelineDefinition.model_validate(case["definition"])
    expected = case["expected"]
    assert sorted(definition.effective_root_ids) == expected["effective_roots"]
    assert sorted(Topology(definition).conditional_sources) == expected["conditional_sources"]
    assert sorted(definition.branch_targets) == expected["branch_targets"]
```

```ts
// packages/client/test/topology.test.ts
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { detailFromDefinition } from "../src/graphModel.js";
import { branchTargets, conditionalSources, effectiveRoots } from "../src/topology.js";
import type { PipelineDefinition } from "../src/types.js";

interface TopologyCase {
  name: string;
  definition: PipelineDefinition;
  expected: { effective_roots: string[]; conditional_sources: string[]; branch_targets: string[] };
}

const { cases } = JSON.parse(
  readFileSync(new URL("../../../contracts/topology-cases.json", import.meta.url), "utf8")
) as { cases: TopologyCase[] };

describe("topology contract (same cases as llm_pipeline/tests/test_topology_contract.py)", () => {
  for (const c of cases) {
    it(c.name, () => {
      const detail = detailFromDefinition(c.definition);
      assert.deepEqual([...effectiveRoots(detail)].sort(), c.expected.effective_roots);
      assert.deepEqual([...conditionalSources(detail)].sort(), c.expected.conditional_sources);
      assert.deepEqual([...branchTargets(detail)].sort(), c.expected.branch_targets);
    });
  }
});
```

- [ ] **Step 3: Run both — Python passes once the fixture is right (it pins existing server behaviour); TS FAILS** (`topology.js` missing).

- [ ] **Step 4: Create `packages/client/src/topology.ts`** by moving the rules out of `buildGraphModel`:

```ts
import type { PipelineDetail } from "./types.js";
import { routeTargets } from "./types.js";

/** Who runs after whom — the editor's copy of the server's rules
 * (llm_pipeline/pipeline_config/topology.py and schema.py). Both are pinned
 * by contracts/topology-cases.json: change one, the other's test fails. */

/** Nodes whose outgoing edges belong entirely to a branch or loop. */
export function conditionalSources(detail: PipelineDetail): Set<string> {
  return new Set([...detail.branches.map((b) => b.from), ...detail.loops.map((l) => l.from)]);
}

/** Nodes some branch route starts. */
export function branchTargets(detail: PipelineDetail): Set<string> {
  return new Set(detail.branches.flatMap((b) => b.routes.flatMap(routeTargets)));
}

/** Nodes that start as soon as the run does: no dependencies, and not
 * waiting for a branch to route to them. */
export function effectiveRoots(detail: PipelineDetail): string[] {
  const targets = branchTargets(detail);
  return detail.nodes.filter((n) => n.depends_on.length === 0 && !targets.has(n.id)).map((n) => n.id);
}
```

In `graphModel.ts` `buildGraphModel`: replace the inline `conditionalSources` / `branchTargets` sets with calls to these, and `isEffectiveRoot` with `roots.has(nodeId)` where `const roots = new Set(effectiveRoots(detail))`. Add `export * from "./topology.js";` to `index.ts`.

- [ ] **Step 5: TS gate in `packages/client`, `cli`, `web`; backend gate — expect green.**

---

### Task 4: Definition and history logic stop importing the wire contract (CA-003)

**Files:**
- Create: `llm_pipeline/llm_pipeline/conversation.py` (`ConversationTurn` moves here)
- Modify: `llm_pipeline/llm_pipeline/api_schemas.py` (import `ConversationTurn` from `conversation` — same class, wire shape unchanged)
- Modify: `llm_pipeline/llm_pipeline/history.py:24`, `llm_pipeline/llm_pipeline/preview.py:14` (import from `conversation`)
- Modify: `llm_pipeline/llm_pipeline/pipeline_config/loader.py` (`PipelineFile` instead of `PipelineSummary`)
- Modify: `llm_pipeline/llm_pipeline/routers/health.py` (map `PipelineFile` → `PipelineSummary`)
- Test: `llm_pipeline/tests/test_import_boundaries.py`

**Interfaces:**
- Produces: `llm_pipeline.conversation.ConversationTurn` (fields `prompt`, `final_answer`, `outputs`); `pipeline_config.PipelineFile(name, description, filename)` frozen dataclass; `list_available_pipelines(directory) -> list[PipelineFile]`.

- [ ] **Step 1: Add the failing boundary test**

```python
def test_definition_and_history_logic_do_not_import_the_wire_contract() -> None:
    probe = (
        "import sys, llm_pipeline.pipeline_config, llm_pipeline.history\n"
        "print('llm_pipeline.api_schemas' in sys.modules)"
    )
    result = subprocess.run(
        [sys.executable, "-c", probe], capture_output=True, text=True, check=True
    )
    assert result.stdout.strip() == "False"
```

- [ ] **Step 2: Run — expect FAIL** (`True`).

- [ ] **Step 3: Create `conversation.py`**

```python
"""
A conversation's earlier turns: what clients send back as context and what
history.py folds into prompts. Framework-free, so the history logic and the
wire contract (api_schemas.py uses this same class) share one type without
the inner layer importing the outer one.
"""

from pydantic import BaseModel


class ConversationTurn(BaseModel):
    """One prior exchange, sent by the client as conversation context."""

    prompt: str
    final_answer: str
    # Node outputs the pipeline asked to remember with this turn (its
    # `history.remember`) — clients send back what `remembered` gave them.
    outputs: dict[str, str] = {}
```

In `api_schemas.py` delete the class and add `from llm_pipeline.conversation import ConversationTurn as ConversationTurn` (explicit re-export: routers and tests import it from here). `history.py`, `preview.py`: `from llm_pipeline.conversation import ConversationTurn`.

In `pipeline_config/loader.py`:

```python
@dataclass(frozen=True)
class PipelineFile:
    """A loadable pipeline on disk, as listings show it."""

    name: str
    description: str
    filename: str
```

`list_available_pipelines` returns `list[PipelineFile]` (same fields); export `PipelineFile` from `pipeline_config/__init__.py`. In `routers/health.py` add

```python
def _summaries() -> list[PipelineSummary]:
    return [
        PipelineSummary(name=p.name, description=p.description, filename=p.filename)
        for p in list_available_pipelines(settings.pipelines_path)
    ]
```

and use it at lines 31 and 44 (`openai_compat.py` only reads `.name` — unchanged).

- [ ] **Step 4: Backend gate — expect green** (incl. `test_health.py`, `test_history.py`, `test_openai_compat.py`, which prove the wire shapes are unchanged).

---

### Task 5: The store announces changes instead of holding the cache (CA-005)

**Files:**
- Modify: `llm_pipeline/llm_pipeline/pipeline_config/loader.py` (receives `SAFE_NAME_PATTERN` + its comment from `pipeline_loader.py`), `pipeline_config/__init__.py` (export it)
- Modify: `llm_pipeline/llm_pipeline/pipeline_loader.py` (import `SAFE_NAME_PATTERN` from `pipeline_config`)
- Modify: `llm_pipeline/llm_pipeline/pipeline_store.py:55,398-414,495,549`
- Modify: `llm_pipeline/llm_pipeline/main.py:83-89`
- Test: `llm_pipeline/tests/test_import_boundaries.py`

**Interfaces:**
- Produces: `PipelineStore(pipelines_dir, presets_dir, on_pipeline_changed: Callable[[str], None], catalog, default_pipeline_name=None)`.

- [ ] **Step 1: Add the failing boundary test**

```python
def test_the_store_does_not_depend_on_graph_compilation() -> None:
    probe = (
        "import sys, llm_pipeline.pipeline_store\n"
        "print('llm_pipeline.dag_builder' in sys.modules)"
    )
    result = subprocess.run(
        [sys.executable, "-c", probe], capture_output=True, text=True, check=True
    )
    assert result.stdout.strip() == "False"
```

- [ ] **Step 2: Run — expect FAIL** (`True`).

- [ ] **Step 3: Implement** — move `SAFE_NAME_PATTERN`; in `PipelineStore.__init__` replace `cache: PipelineCache` with `on_pipeline_changed: Callable[[str], None]`, documented as *"called with a pipeline's name after it is saved or deleted — main.py passes PipelineCache.invalidate, so the next run rebuilds its graph"*, stored as `self._on_pipeline_changed`; replace both `self.cache.invalidate(name)` with `self._on_pipeline_changed(name)`; drop the `pipeline_loader` import. In `main.py` pass `on_pipeline_changed=app.state.pipeline_cache.invalidate` and keep the comment about writing through the same cache.

- [ ] **Step 4: Backend gate — expect green** (`test_editing_api.py` covers save → re-run picking up the change).

---

### Task 6: Nodes receive their services (CA-004)

**Files:**
- Modify: `llm_pipeline/llm_pipeline/dag_builder/node_types.py` (`NodeServices`, `ProviderFactory`; `NodeBuilder`, `build_llm_call_node`, `build_node` take `services`)
- Modify: `llm_pipeline/llm_pipeline/dag_builder/graph.py` (`build_graph(definition, services=None)`), `dag_builder/__init__.py` (export `NodeServices`)
- Modify: `llm_pipeline/llm_pipeline/pipeline_loader.py` (`PipelineCache.node_services` property; `get` uses it)
- Modify: `llm_pipeline/llm_pipeline/routers/editing.py:267` (`build_graph(definition, cache.node_services)`)
- Modify tests that call `build_graph` directly: `tests/test_dag_builder.py`, `tests/test_labels.py`, `tests/test_multi_target_routes.py` — pass `NodeServices(provider_factory=...)` instead of monkeypatching `node_types.get_provider`. (API-level tests that go through the app keep their monkeypatch — they don't build graphs themselves.)

**Interfaces:**
- Produces: `ProviderFactory = Callable[[ModelSpec], LLMProvider]`; `@dataclass(frozen=True) class NodeServices(provider_factory: ProviderFactory = get_provider, circuit_breaker: CircuitBreaker | None = None, context_probe: ContextProbe | None = None)`; `build_graph(definition: PipelineDefinition, services: NodeServices | None = None) -> CompiledStateGraph`; `PipelineCache.node_services -> NodeServices`.

- [ ] **Step 1: Write the failing test** (in `tests/test_dag_builder.py`)

```python
@pytest.mark.asyncio
async def test_nodes_call_the_injected_provider_factory() -> None:
    asked: list[ModelSpec] = []

    def factory(spec: ModelSpec) -> LLMProvider:
        asked.append(spec)
        return _EchoProvider("fake")

    definition = load_pipeline_definition(FIXTURES_DIR / "diamond.yaml")
    await build_graph(definition, NodeServices(provider_factory=factory)).ainvoke(
        {"input": "x", "contextual_input": "x", "node_outputs": {}, "loop_counts": {}}
    )
    assert [s.model for s in asked] == ["test-model"] * 4
```

- [ ] **Step 2: Run — expect FAIL** (`ImportError: NodeServices`).

- [ ] **Step 3: Implement**

```python
# node_types.py
ProviderFactory = Callable[[ModelSpec], LLMProvider]


@dataclass(frozen=True)
class NodeServices:
    """What a compiled graph's nodes call out to — passed in rather than
    looked up, so a graph can run against fakes (tests) or with state scoped
    to its owner (a PipelineCache's circuit breaker)."""

    # The provider for a node's model; the cached registry lookup by default.
    provider_factory: ProviderFactory = get_provider
    circuit_breaker: CircuitBreaker | None = None
    context_probe: ContextProbe | None = None
```

`NodeBuilder.__call__(self, node_cfg, definition, services: NodeServices) -> NodeCallable`; `build_llm_call_node(node_cfg, definition, services: NodeServices)` uses `services.provider_factory(spec)`, `services.circuit_breaker`, `services.context_probe`; `build_node(node_cfg, definition, services)`. `graph.py`: `def build_graph(definition, services: NodeServices | None = None)`, `services = services or NodeServices()`, docstring moves from the two old parameters to `services`. `PipelineCache`: keep `circuit_breaker` / `context_probe` attributes (used by `ask.py`, `editing.py`'s judge), add

```python
    @property
    def node_services(self) -> NodeServices:
        return NodeServices(circuit_breaker=self.circuit_breaker, context_probe=self.context_probe)
```

and `build_graph(definition, self.node_services)` in `get`.

- [ ] **Step 4: Convert the direct-build tests** — in each test of the three files, delete `monkeypatch.setattr(node_types_module, "get_provider", <factory>)` and pass `NodeServices(provider_factory=<factory>)` to that test's `build_graph(...)` call; drop the `monkeypatch` parameter where nothing else uses it, and the `node_types_module` import where unused.

- [ ] **Step 5: Backend gate — expect green**, and `grep -c 'setattr(node_types_module, "get_provider"' tests/test_dag_builder.py tests/test_labels.py tests/test_multi_target_routes.py` → all `0`.

---

### Task 7: Split the node run function into named steps (CA-007)

**Files:**
- Modify: `llm_pipeline/llm_pipeline/dag_builder/node_types.py`

**Interfaces:**
- Produces (module-private): `_render_or_fail(node_cfg, effective, state) -> str`, `_replayed_result(node_cfg, spec, output) -> NodeResult`, `_finalize_answer(node_cfg, effective, text) -> str`, `async _context_window(model, spec, probe) -> int | None`, `_node_usage(usage, context_window, prompt_chars) -> NodeUsage`.

- [ ] **Step 1: No new test** — pure refactor. The regression tests are the existing ones: rendering errors (`test_prompt_referencing_an_output_that_did_not_run_yet_fails`), replay (`test_rerun_and_preview.py`), labels (`test_labels.py`), usage and context window (`test_usage.py`).

- [ ] **Step 2: Extract** — move the bodies verbatim:

```python
def _render_or_fail(node_cfg: NodeConfig, effective: EffectiveNode, state: PipelineState) -> str:
    """The node's prompt; an output the template needs but that didn't run
    on this path fails the run naming the node."""
    try:
        return render_node_prompt(node_cfg, effective, state)
    except UndefinedError as e:
        raise PipelineExecutionError(
            f"Node '{node_cfg.id}': its prompt uses output that isn't available on "
            f"this run ({e.message}) — wrap it in {{% if <node> is defined %}}",
            node_id=node_cfg.id,
        ) from e


def _replayed_result(node_cfg: NodeConfig, spec: ModelSpec, output: str) -> NodeResult:
    return {
        "node_id": node_cfg.id,
        "model_name": spec.identity,
        "output": output,
        "duration_ms": 0.0,
        "replayed": True,
    }


def _finalize_answer(node_cfg: NodeConfig, effective: EffectiveNode, text: str) -> str:
    """What the node outputs: the model's text without its reasoning (when
    the node strips it) and, for a classifier, exactly the label it names."""
    answer = strip_reasoning(text) if effective.strip_reasoning else text
    if node_cfg.labels is None:
        return answer
    label = match_label(answer, node_cfg.labels)
    if label is None:
        raise PipelineExecutionError(
            f"Node '{node_cfg.id}' answered {answer[:200]!r}, which names none of "
            f"its labels ({', '.join(node_cfg.labels)}) — or more than one",
            node_id=node_cfg.id,
        )
    return label


async def _context_window(
    model: NodeModelConfig, spec: ModelSpec, probe: ContextProbe | None
) -> int | None:
    """The context size the model ran with: its configured num_ctx, else
    what Ollama reports for the loaded model."""
    if model.options is not None and model.options.num_ctx is not None:
        return model.options.num_ctx
    if probe is not None and spec.provider == ProviderType.OLLAMA:
        return await probe(spec.model)
    return None


def _node_usage(usage: Usage, context_window: int | None, prompt_chars: int) -> NodeUsage:
    return {
        "prompt_tokens": usage.prompt_tokens,
        "completion_tokens": usage.completion_tokens,
        "generation_ms": usage.generation_ms,
        "context_window": context_window,
        # Ollama counts tokens AFTER cutting a prompt that didn't fit, so
        # clients also compare the length that was sent.
        "prompt_chars": prompt_chars,
    }
```

`node_fn` then: `prompt = _render_or_fail(...)`; replay → `return {"node_outputs": {node_cfg.id: _replayed_result(node_cfg, spec, replay[node_cfg.id])}}`; call; `answer = _finalize_answer(node_cfg, effective, generation.text)`; build `result`; if usage: `result["usage"] = _node_usage(generation.usage, await _context_window(model, spec, services.context_probe), len(prompt) + len(effective.system_prompt or ""))`. `announce_start` stays a closure (it needs `writer`, `prompt`, `replaying`).

- [ ] **Step 3: Backend gate — expect green**; `node_fn` should be ≈ 50 lines.

---

## Self-review notes

- Spec coverage: CA-001 → Task 2; CA-002 → Task 1; CA-003 → Task 4; CA-004 → Task 6; CA-005 → Task 5; CA-006 → Task 3 (with the documented deviation); CA-007 → Task 7.
- CA-003 scope: `evaluation.py` keeps building its response DTOs — those models *are* its streamed output, and mapping through a parallel domain type would duplicate them without decoupling anything; recorded as an accepted trade-off.
- Type consistency: `NodeServices`, `Topology`, `RouteInto`, `PipelineFile`, `on_pipeline_changed` are used with the same names/signatures in every task that consumes them.
