import pytest

from llm_pipeline.safe_eval import (
    evaluate_condition,
    validate_expression_syntax,
    UnsafeExpressionError,
)


@pytest.mark.parametrize(
    "expression,output,expected",
    [
        ('output.startswith("APPROVE")', "APPROVE, looks good", True),
        ('output.startswith("APPROVE")', "REVISE: fix the intro", False),
        ('output.contains("REFUND")', "This is a REFUND request", True),
        ('"REFUND" in output', "This is a REFUND request", True),
        ('output == "APPROVE"', "APPROVE", True),
        ('output == "APPROVE"', "approve", False),
        ('not output.startswith("REVISE")', "APPROVE", True),
        ('output.contains("A") or output.contains("B")', "contains B only", True),
        ('output.contains("A") and output.contains("B")', "contains B only", False),
        ('output.equals("exact")', "exact", True),
        ('output.equals("exact")', "not exact", False),
    ],
)
def test_allowed_expressions_evaluate_correctly(
    expression: str, output: str, expected: bool
) -> None:
    assert evaluate_condition(expression, output) is expected


@pytest.mark.parametrize(
    "expression",
    [
        'output.upper().startswith("X")',  # method chaining not supported
        'output.strip().startswith("X")',
        '__import__("os").system("echo pwned")',  # arbitrary code execution attempt
        "open('/etc/passwd').read()",
        "1 + 1",  # arithmetic not in the allowed grammar
        "some_undefined_name",
    ],
)
def test_disallowed_expressions_raise_unsafe_error(expression: str) -> None:
    with pytest.raises(UnsafeExpressionError):
        evaluate_condition(expression, "anything")


def test_validate_expression_syntax_passes_for_valid_expression() -> None:
    validate_expression_syntax('output.startswith("APPROVE")')  # should not raise


def test_validate_expression_syntax_rejects_unsafe_expression() -> None:
    with pytest.raises(UnsafeExpressionError):
        validate_expression_syntax('__import__("os")')


def test_invalid_python_syntax_raises_syntax_error() -> None:
    with pytest.raises(SyntaxError):
        evaluate_condition("output.startswith(", "anything")
