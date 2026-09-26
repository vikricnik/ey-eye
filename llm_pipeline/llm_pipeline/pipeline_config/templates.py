"""
The one Jinja environment every pipeline template goes through — node
prompt templates, history turn templates, summary prompts — for both
validation (parsing) and rendering.

It is SANDBOXED: templates arrive from editor clients, not just reviewed
files, and plain Jinja lets a template reach Python internals
(`{{ cycler.__init__.__globals__.os… }}`) and run code on the server. The
sandbox refuses that attribute access (SecurityError) while keeping
everything prompts legitimately use — variables, `.output`, if/for, filters.
"""

from jinja2 import meta, nodes
from jinja2.sandbox import ImmutableSandboxedEnvironment

_ENV = ImmutableSandboxedEnvironment()


def undeclared_variables(source: str) -> set[str]:
    """Top-level names a template reads. Raises jinja2.TemplateSyntaxError
    for malformed templates."""
    return set(meta.find_undeclared_variables(_ENV.parse(source)))


def render(source: str, variables: dict[str, object]) -> str:
    # str(): render() is typed loosely; keep the declared `-> str` honest.
    return str(_ENV.from_string(source).render(**variables))


def unguarded_references(source: str, names: set[str]) -> set[str]:
    """Which of `names` the template uses outside an `{% if x is defined %}`
    guard (or `… if x is defined …` expression) — the uses that fail when x
    hasn't run. Raises jinja2.TemplateSyntaxError for malformed templates."""
    found: set[str] = set()

    def visit(node: nodes.Node, guarded: frozenset[str]) -> None:
        if isinstance(node, nodes.If):
            visit(node.test, guarded)
            for child in node.body:
                visit(child, guarded | _defined_by(node.test))
            for child in [*node.elif_, *node.else_]:
                visit(child, guarded)
            return
        if isinstance(node, nodes.CondExpr):
            visit(node.test, guarded)
            visit(node.expr1, guarded | _defined_by(node.test))
            if node.expr2 is not None:
                visit(node.expr2, guarded)
            return
        if _is_defined_test(node):
            return  # `x is defined` itself doesn't use x's output
        if isinstance(node, nodes.Name) and node.name in names and node.name not in guarded:
            found.add(node.name)
        for child in node.iter_child_nodes():
            visit(child, guarded)

    visit(_ENV.parse(source), frozenset())
    return found


def _is_defined_test(node: nodes.Node) -> bool:
    return (
        isinstance(node, nodes.Test)
        and node.name in ("defined", "undefined")
        and isinstance(node.node, nodes.Name)
    )


def _defined_by(test: nodes.Node) -> frozenset[str]:
    """Names a condition proves defined when it's true: `x is defined`, and
    every such term of an `and` (an `or` proves nothing about either side)."""
    if (
        isinstance(test, nodes.Test)
        and test.name == "defined"
        and isinstance(test.node, nodes.Name)
    ):
        return frozenset({test.node.name})
    if isinstance(test, nodes.And):
        return _defined_by(test.left) | _defined_by(test.right)
    return frozenset()
