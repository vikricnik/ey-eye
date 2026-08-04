"""
A deliberately tiny, sandboxed expression language for loop `exit_when` and
branch `when` conditions.

NEVER uses eval()/exec() — expressions come from YAML files, and while those
are meant to be trusted, version-controlled artifacts (not arbitrary user
input), defense in depth costs nothing here. The AST is walked manually and
only a small whitelist of node types/names/methods is permitted; anything
else raises UnsafeExpressionError instead of silently doing something
unexpected.

Supported syntax, evaluated against a single `output` string variable:
  output.startswith("APPROVE")
  output.endswith("...")
  output.contains("REFUND")        # custom: substring test
  output.equals("EXACT MATCH")     # custom: exact string equality
  output.upper() / .lower() / .strip()   # chainable is NOT supported (v1)
  "REFUND" in output               # Python's `in` operator
  output == "APPROVE"              # equality/inequality
  not output.startswith("X")
  output.contains("A") or output.contains("B")
  output.contains("A") and output.contains("B")
"""

import ast
from typing import cast

_ALLOWED_STR_METHODS = {"startswith", "endswith", "upper", "lower", "strip"}


class UnsafeExpressionError(Exception):
    """Raised when an expression uses anything outside the small allowed
    subset — this is a rejection, not a best-effort partial evaluation."""


def _contains(haystack: str, needle: str) -> bool:
    return needle in haystack


def _equals(a: str, b: str) -> bool:
    return a == b


_CUSTOM_METHODS = {"contains": _contains, "equals": _equals}


def evaluate_condition(expression: str, output: str) -> bool:
    """Evaluates an expression against a node's output text. Raises
    UnsafeExpressionError (unsupported construct) or SyntaxError (invalid
    Python syntax) — callers should let both surface as clear failures
    rather than catching and guessing."""
    tree = ast.parse(expression, mode="eval")
    result = _eval_node(tree.body, output)
    return bool(result)


def validate_expression_syntax(expression: str) -> None:
    """Load-time check: confirms an expression parses and uses only the
    allowed subset, without needing a real `output` value. Used by
    pipeline_config.py so a bad condition fails when the YAML is loaded,
    not the first time a request happens to reach that branch/loop."""
    evaluate_condition(expression, "")


def _eval_node(node: ast.AST, output: str) -> object:
    if isinstance(node, ast.BoolOp):
        values = [_eval_node(v, output) for v in node.values]
        if isinstance(node.op, ast.And):
            return all(values)
        if isinstance(node.op, ast.Or):
            return any(values)
        raise UnsafeExpressionError(f"unsupported boolean operator: {type(node.op).__name__}")

    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
        return not _eval_node(node.operand, output)

    if isinstance(node, ast.Compare):
        if len(node.ops) != 1 or len(node.comparators) != 1:
            raise UnsafeExpressionError("only single comparisons are supported (no chaining)")
        left = _eval_node(node.left, output)
        right = _eval_node(node.comparators[0], output)
        op = node.ops[0]
        if isinstance(op, ast.Eq):
            return left == right
        if isinstance(op, ast.NotEq):
            return left != right
        if isinstance(op, ast.In):
            return left in right  # type: ignore[operator]
        if isinstance(op, ast.NotIn):
            return left not in right  # type: ignore[operator]
        raise UnsafeExpressionError(f"unsupported comparison operator: {type(op).__name__}")

    if isinstance(node, ast.Call):
        if not isinstance(node.func, ast.Attribute):
            raise UnsafeExpressionError(
                "only `output.<method>(...)` method calls are allowed, not bare function calls"
            )
        if not isinstance(node.func.value, ast.Name) or node.func.value.id != "output":
            raise UnsafeExpressionError(
                "method calls are only allowed directly on `output` (no chaining in v1)"
            )
        method_name = node.func.attr
        if node.keywords:
            raise UnsafeExpressionError("keyword arguments are not supported")
        args = [_eval_node(a, output) for a in node.args]

        if method_name in _CUSTOM_METHODS:
            return _CUSTOM_METHODS[method_name](output, *args)  # type: ignore[arg-type]
        if method_name in _ALLOWED_STR_METHODS:
            bound_method = getattr(output, method_name)
            # getattr's return is `Any` (mypy can't know method_name statically),
            # so calling it also evaluates to `Any` — cast makes the static type
            # explicit as `object`, matching this function's declared return
            # type, rather than silently letting an Any leak through (which
            # `warn_return_any` in the strict mypy config would flag).
            return cast(object, bound_method(*args))
        raise UnsafeExpressionError(f"method '{method_name}' is not in the allowed list")

    if isinstance(node, ast.Constant):
        if isinstance(node.value, (str, bool, int, float)) or node.value is None:
            return node.value
        raise UnsafeExpressionError(f"unsupported constant type: {type(node.value).__name__}")

    if isinstance(node, ast.Name):
        if node.id == "output":
            return output
        raise UnsafeExpressionError(
            f"unknown name '{node.id}' — only `output` is available in conditions"
        )

    raise UnsafeExpressionError(f"unsupported expression construct: {type(node).__name__}")
