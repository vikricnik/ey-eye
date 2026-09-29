import { useState } from "react";
import {
  DraftError,
  EXPECTATION_KINDS,
  expectationParts,
  makeExpectation,
  modelWithIdentity,
  parseModelIdentity,
  removeTestCase,
  setTestJudge,
  testCases,
  uniqueCaseName,
  upsertTestCase,
} from "@llm-pipeline/client";
import type {
  CaseResult,
  EvalCase,
  ExpectationKind,
  ModelsResponse,
  PipelineDefinition,
  VariantRequest,
  VariantSummary,
} from "@llm-pipeline/client";
import { CommitInput, Field, ModelPicker } from "../editor/fields";
import { formatDuration } from "../format";

/** `removed` says what a deletion removed; the app then offers to undo it. */
type Edit = (op: (d: PipelineDefinition) => PipelineDefinition, coalesce?: string, removed?: string) => void;

/** A test run in progress or finished: results by case and variant. */
export interface TestRunState {
  status: "running" | "done" | "error" | "stopped";
  cases: string[];
  variants: string[];
  results: Record<string, CaseResult>;
  current?: { case: string; variant: string } | undefined;
  summaries?: VariantSummary[];
  error?: string;
}

export const resultKey = (testCase: string, variant: string) => `${testCase}\u0000${variant}`;

const KIND_LABEL: Record<ExpectationKind, string> = {
  contains: "contains",
  not_contains: "doesn't contain",
  check: "check",
  judge: "judge: meets",
};
const KIND_PLACEHOLDER: Record<ExpectationKind, string> = {
  contains: "Paris (case-insensitive)",
  not_contains: "I'm sorry",
  check: 'output.startswith("Yes")',
  judge: "answers in one sentence",
};

function CaseEditor(props: { definition: PipelineDefinition; testCase: EvalCase; editable: boolean; onEdit: Edit; onRenamed: (name: string) => void }) {
  const { testCase, editable, onEdit } = props;
  const expect = testCase.expect ?? [];
  const save = (next: EvalCase, coalesce?: string, removed?: string) =>
    onEdit((d) => upsertTestCase(d, next, testCase.name), coalesce ? `test:${testCase.name}:${coalesce}` : undefined, removed);
  const setExpectation = (index: number, kind: ExpectationKind, value: string) =>
    save({ ...testCase, expect: expect.map((e, i) => (i === index ? makeExpectation(kind, value) : e)) }, `expect:${index}`);

  return (
    <section className="case-editor">
      <Field label="Name">
        <CommitInput
          value={testCase.name}
          disabled={!editable}
          ariaLabel="Test case name"
          onCommit={(name) => {
            if (!name || name === testCase.name) return;
            try {
              upsertTestCase(props.definition, { ...testCase, name }, testCase.name);
            } catch (err) {
              if (err instanceof DraftError) return; // a clash: keep the old name
              throw err;
            }
            save({ ...testCase, name });
            props.onRenamed(name);
          }}
        />
      </Field>
      <Field label="Message" hint="sent with no conversation before it">
        <textarea
          rows={3}
          value={testCase.input}
          disabled={!editable}
          onChange={(e) => save({ ...testCase, input: e.target.value }, "input")}
        />
      </Field>
      <div className="field">
        <span className="field-label">The answer must</span>
        {expect.length === 0 && <p className="field-hint">Nothing yet — the case just shows its answer.</p>}
        {expect.map((expectation, i) => {
          const { kind, value } = expectationParts(expectation);
          return (
            <div className="row expectation-row" key={i}>
              <select
                value={kind}
                disabled={!editable}
                aria-label="Kind of expectation"
                onChange={(e) => setExpectation(i, e.target.value as ExpectationKind, value)}
              >
                {EXPECTATION_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABEL[k]}
                  </option>
                ))}
              </select>
              <input
                type="text"
                value={value}
                placeholder={KIND_PLACEHOLDER[kind]}
                disabled={!editable}
                aria-label="Expected"
                onChange={(e) => setExpectation(i, kind, e.target.value)}
              />
              {editable && (
                <button
                  type="button"
                  className="ghost icon"
                  aria-label="Remove expectation"
                  onClick={() =>
                    save({ ...testCase, expect: expect.filter((_, j) => j !== i) }, undefined, `Removed an expectation from "${testCase.name}"`)
                  }
                >
                  ✕
                </button>
              )}
            </div>
          );
        })}
        {editable && (
          <button
            type="button"
            className="ghost small"
            onClick={() => save({ ...testCase, expect: [...expect, makeExpectation("contains", "")] })}
          >
            + expectation
          </button>
        )}
      </div>
    </section>
  );
}

function ResultCell(props: { result: CaseResult | undefined; running: boolean; selected: boolean; onSelect: () => void }) {
  const { result } = props;
  if (!result) {
    return <td className={`result-cell ${props.running ? "running" : "pending"}`}>{props.running ? "running…" : "—"}</td>;
  }
  const state = result.error ? "error" : result.passed === null ? "unchecked" : result.passed ? "pass" : "fail";
  const label = { error: "error", unchecked: "answered", pass: "passed", fail: "failed" }[state];
  const failed = result.expectations.filter((e) => !e.passed).length;
  return (
    <td className={`result-cell ${state}${props.selected ? " selected" : ""}`}>
      <button type="button" className="result-button" onClick={props.onSelect} title="show the answer and each expectation">
        <span className="result-state">
          {label}
          {state === "fail" ? ` (${failed}/${result.expectations.length})` : ""}
        </span>
        <span className="result-meta">
          {formatDuration(result.duration_ms)}
          {result.prompt_tokens + result.completion_tokens > 0
            ? ` · ${(result.prompt_tokens + result.completion_tokens).toLocaleString("en-US")} tok`
            : ""}
        </span>
      </button>
    </td>
  );
}

function ResultDetail({ result }: { result: CaseResult }) {
  return (
    <section className="result-detail">
      <h4>
        {result.case} · {result.variant}
      </h4>
      {result.error ? (
        <p className="problem error">{result.error}</p>
      ) : (
        <>
          <pre className="message-text">{result.answer}</pre>
          {result.expectations.length > 0 && (
            <ul className="expectation-results">
              {result.expectations.map((e, i) => (
                <li key={i} className={e.passed ? "pass" : "fail"}>
                  <span className="expectation-mark">{e.passed ? "✓" : "✗"}</span>
                  <span>
                    {KIND_LABEL[e.kind]} <code>{e.expected}</code>
                    {e.detail && <span className="field-hint"> — {e.detail}</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

/**
 * The pipeline's test cases: messages to run it with and what the answers
 * must satisfy. Runs use the draft as it is — no need to save — and a
 * comparison runs every case again with other models for one node.
 */
export function TestsView(props: {
  definition: PipelineDefinition;
  editable: boolean;
  models: ModelsResponse | null;
  onEdit: Edit;
  onRefreshModels: () => void;
  run: TestRunState | null;
  onRun: (request: { cases?: string[]; variants: VariantRequest[] }) => void;
  /** Stops the test run in progress. */
  onStop: () => void;
  /** The latest message sent, to turn into a case. */
  lastMessage: string | null;
}) {
  const { definition, editable, onEdit, run } = props;
  const cases = testCases(definition);
  const [selected, setSelected] = useState<string | null>(cases[0]?.name ?? null);
  const [compareNode, setCompareNode] = useState(definition.nodes[0]?.id ?? "");
  const [compareModels, setCompareModels] = useState<string[]>([""]);
  const [detail, setDetail] = useState<string | null>(null);
  const testCase = cases.find((c) => c.name === selected) ?? null;
  const running = run?.status === "running";
  const judge = definition.tests?.judge;
  const needsJudge = cases.some((c) => (c.expect ?? []).some((e) => e.judge !== undefined));

  const addCase = (input: string) => {
    const name = uniqueCaseName(definition);
    onEdit((d) => upsertTestCase(d, { name, input }));
    setSelected(name);
  };
  const variants: VariantRequest[] = compareModels
    .filter(Boolean)
    .map((identity) => ({
      label: parseModelIdentity(identity).name,
      models: { [compareNode]: parseModelIdentity(identity) },
    }));
  const selectedResult = detail ? run?.results[detail] : undefined;

  return (
    <div className="tests-layout">
      <aside className="case-list" aria-label="Test cases">
        <div className="conversation-list-head">
          <h3>Test cases</h3>
          {editable && (
            <button type="button" className="ghost small" onClick={() => addCase("")}>
              + add
            </button>
          )}
        </div>
        {editable && props.lastMessage && (
          <button type="button" className="ghost small" onClick={() => addCase(props.lastMessage!)} title={props.lastMessage}>
            + from the last message
          </button>
        )}
        {cases.length === 0 ? (
          <p className="dim">No test cases yet. A case is a message and what its answer must satisfy.</p>
        ) : (
          <ul>
            {cases.map((c) => (
              <li key={c.name} className={c.name === selected ? "current" : ""}>
                <button type="button" className="conversation-open" onClick={() => setSelected(c.name)} title={c.input}>
                  <span className="conversation-title">{c.name}</span>
                  <span className="conversation-meta">
                    {(c.expect ?? []).length} expectation{(c.expect ?? []).length === 1 ? "" : "s"}
                  </span>
                </button>
                {editable && (
                  <button
                    type="button"
                    className="ghost icon palette-remove"
                    aria-label={`Delete test case ${c.name}`}
                    onClick={() => onEdit((d) => removeTestCase(d, c.name), undefined, `Deleted the test case "${c.name}"`)}
                  >
                    ✕
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {(needsJudge || judge) && (
          <Field label="Judge model" hint="grades the “judge” expectations — PASS or FAIL">
            <ModelPicker
              model={judge?.model}
              models={props.models}
              limits={null}
              emptyOption="none"
              disabled={!editable}
              onRefresh={props.onRefreshModels}
              onChange={(identity) =>
                onEdit((d) =>
                  setTestJudge(d, identity ? modelWithIdentity(d.tests?.judge?.model, identity) : undefined)
                )
              }
            />
          </Field>
        )}
        <p className="field-hint">Saved with the pipeline, in its YAML file.</p>
      </aside>

      <div className="tests-main">
        {testCase ? (
          <CaseEditor
            key={testCase.name}
            definition={definition}
            testCase={testCase}
            editable={editable}
            onEdit={onEdit}
            onRenamed={setSelected}
          />
        ) : (
          cases.length > 0 && <p className="dim">Select a test case to edit it.</p>
        )}

        <section className="tests-run">
          <h3>Run</h3>
          {!editable && <p className="dim">Running tests needs editing enabled on the server.</p>}
          <div className="row">
            {running && (
              <button type="button" className="danger" onClick={props.onStop} title="Stop the test run (Esc)">
                Stop
              </button>
            )}
            <button
              type="button"
              disabled={!editable || running || cases.length === 0}
              title={cases.length === 0 ? "Add a test case first (+ add, above)" : undefined}
              onClick={() => props.onRun({ variants: [] })}
            >
              Run all cases
            </button>
            {testCase && (
              <button
                type="button"
                className="ghost"
                disabled={!editable || running}
                onClick={() => props.onRun({ cases: [testCase.name], variants: [] })}
              >
                Run “{testCase.name}”
              </button>
            )}
          </div>
          <div className="compare">
            <span className="field-label">Compare models</span>
            <p className="field-hint">Runs every case as the pipeline is now, and again with each model below for one node.</p>
            <div className="row">
              <select value={compareNode} onChange={(e) => setCompareNode(e.target.value)} aria-label="Node to compare">
                {definition.nodes.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.id}
                  </option>
                ))}
              </select>
            </div>
            {compareModels.map((identity, i) => (
              <div className="row" key={i}>
                <ModelPicker
                  model={identity ? parseModelIdentity(identity) : undefined}
                  models={props.models}
                  limits={null}
                  emptyOption="choose a model…"
                  onRefresh={props.onRefreshModels}
                  onChange={(value) => setCompareModels((ms) => ms.map((m, j) => (j === i ? value : m)))}
                />
                {compareModels.length > 1 && (
                  <button
                    type="button"
                    className="ghost icon"
                    aria-label="Remove model"
                    onClick={() => setCompareModels((ms) => ms.filter((_, j) => j !== i))}
                  >
                    ✕
                  </button>
                )}
              </div>
            ))}
            <div className="row">
              {compareModels.length < 3 && (
                <button type="button" className="ghost small" onClick={() => setCompareModels((ms) => [...ms, ""])}>
                  + model
                </button>
              )}
              <button
                type="button"
                disabled={!editable || running || cases.length === 0 || variants.length === 0}
                title={
                  cases.length === 0
                    ? "Add a test case first (+ add, above)"
                    : variants.length === 0
                      ? "Choose a model to compare with first"
                      : undefined
                }
                onClick={() => props.onRun({ variants })}
              >
                Run comparison
              </button>
            </div>
          </div>
        </section>

        {run && (
          <section className="tests-results">
            <h3>
              Results{" "}
              {run.status === "running" && run.current && (
                <span className="dim">
                  — running {run.current.case} · {run.current.variant}
                </span>
              )}
              {run.status === "stopped" && <span className="dim">— stopped; the cases that finished are kept</span>}
            </h3>
            {run.error && <p className="problem error">{run.error}</p>}
            <div className="results-scroll">
              <table className="results-grid">
                <thead>
                  <tr>
                    <th>case</th>
                    {run.variants.map((v) => (
                      <th key={v}>{v}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {run.cases.map((c) => (
                    <tr key={c}>
                      <th scope="row">{c}</th>
                      {run.variants.map((v) => (
                        <ResultCell
                          key={v}
                          result={run.results[resultKey(c, v)]}
                          running={run.current?.case === c && run.current.variant === v}
                          selected={detail === resultKey(c, v)}
                          onSelect={() => setDetail(resultKey(c, v))}
                        />
                      ))}
                    </tr>
                  ))}
                </tbody>
                {run.summaries && (
                  <tfoot>
                    <tr>
                      <th scope="row">total</th>
                      {run.summaries.map((s) => (
                        <td key={s.variant} className="result-summary">
                          {s.passed + s.failed + s.errors > 0 ? `${s.passed}/${s.passed + s.failed + s.errors} passed` : "no checks"}
                          <span className="result-meta">
                            {formatDuration(s.duration_ms)} · {(s.prompt_tokens + s.completion_tokens).toLocaleString("en-US")} tok
                          </span>
                        </td>
                      ))}
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
            {selectedResult && <ResultDetail result={selectedResult} />}
          </section>
        )}
      </div>
    </div>
  );
}
