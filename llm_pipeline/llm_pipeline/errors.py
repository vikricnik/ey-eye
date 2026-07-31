class PipelineExecutionError(Exception):
    """Raised when an entire pipeline tier has no usable output left — e.g. every
    generator configured for a category failed, or no candidates survived to be
    judged. Distinct from ProviderError (one model failing), this represents total
    failure of a tier after graceful degradation was already attempted."""
