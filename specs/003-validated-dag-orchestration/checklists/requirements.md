# Specification Quality Checklist: Single-Host Resource-Aware DAG Runner (Platform Stage 1)

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-08-27
**Last revised**: 2026-08-27 (rescoped to Stage 1)
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

### Current shape

3 user stories, 54 functional requirements (FR-001–FR-054, contiguous),
10 success criteria. Scoped to Stage 1 of
[ROADMAP.md](../../ROADMAP.md).

### Revision history

**2026-08-27 — rescoped from 4 stages to 1.** The first draft carried 6
user stories and 74 requirements, spanning the roadmap's Stage 1 (runner),
parts of Stages 2–3 (stored plans), Stage 4 (the LLM planner), and an
unstaged tool-discovery interface. The supplied platform brief stages
these deliberately — the planner belongs after durable orchestration and
the deterministic compiler exist, because it is only safe once validation
and compilation are solid and only useful once runs survive a restart.

Removed and deferred to their own specs:

- User Story 4 (LLM workflow planner) and its FR-040–FR-048 → Stage 4
- User Story 5 (stored/compiled plans) and its FR-049–FR-053 → Stages 2–3
- User Story 6 (MCP tool discovery) and its FR-059–FR-065 → deferred, see
  ROADMAP.md
- Planning and stored-plan endpoints (former FR-055, FR-056)

Added while rescoping:

- **FR-025, failure categorization.** The brief's acceptance criteria
  require a failed node to report an error *category*, not just an
  identifier, and Stage 2's per-category retry and fallback policies
  depend on that classification existing from the start. Adding it now
  avoids reclassifying every failure later.
- **FR-047**, visible failure when a run is interrupted by shutdown —
  a direct consequence of this stage keeping run state in memory.
- **FR-044**, workflow listing and structural inspection.
- **SC-010**, requiring every shipped workflow definition to be migrated
  to the new schema, making the migration cost explicit rather than
  implied.
- An **"Accepted Stage 1 compromises"** section recording the five
  architectural shortcuts this stage knowingly takes (in-process heavy
  model, single-request execution, process-local locks, in-memory state,
  inline outputs). The brief warns against these becoming permanent; they
  are now documented as Stage 2's job to replace rather than inherit.

### Validation findings

- **Implementation-detail containment**: the source brief is written as a
  technical design, naming specific libraries, model servers, and
  protocols. Those are kept out of the Requirements section — which
  speaks of "fast models served over HTTP by a local model server" and
  "the heavy reasoning model" — and recorded under **Assumptions →
  User-mandated technical constraints**, so they reach `plan.md`'s
  Technical Context without weakening testability. Protocol-level terms
  that are genuine requirement content (HTTP reachability, non-streaming
  operation, timeouts) were retained.

- **Fixed in the first validation pass**: SC-003 originally said run time
  should be "close to the slowest single branch" (unmeasurable — now a
  1.5x bound), and SC-008 asserted planner success without a rate (that
  criterion has since moved to Stage 4 along with the planner).

### Downstream notes

- Spec `002-dynamic-dag-airllm-mcp` is superseded. Its
  `contracts/mcp-tools.md` and `research.md` remain the starting point
  for the deferred MCP spec.
- Spec `001-visual-dag-graph` was removed on 2026-08-27; it targeted the
  pre-Stage-1 schema. Recoverable from git at commit `97240fd`.

- Items marked incomplete require spec updates before `/speckit-clarify` or `/speckit-plan`.
