from enum import Enum


class Category(str, Enum):
    """Request categories. Add new ones here, then add matching entries in
    model_registry.py (GENERATOR_SPECS / VALIDATOR_SPECS) for each new category."""

    CODE = "CODE"
    GENERAL = "GENERAL"
    MATH = "MATH"
    CREATIVE = "CREATIVE"

    @classmethod
    def from_str(cls, value: str) -> "Category":
        """Parses a router model's raw text output into a Category, falling back
        to GENERAL if the model returned something unrecognized."""
        normalized = value.strip().upper()
        try:
            return cls(normalized)
        except ValueError:
            return cls.GENERAL
