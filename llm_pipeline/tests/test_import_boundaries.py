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


def test_definition_and_history_logic_do_not_import_the_wire_contract() -> None:
    probe = (
        "import sys, llm_pipeline.pipeline_config, llm_pipeline.history\n"
        "print('llm_pipeline.api_schemas' in sys.modules)"
    )
    result = subprocess.run(
        [sys.executable, "-c", probe], capture_output=True, text=True, check=True
    )
    assert result.stdout.strip() == "False"


def test_the_store_does_not_depend_on_graph_compilation() -> None:
    probe = (
        "import sys, llm_pipeline.pipeline_store\n"
        "print('llm_pipeline.dag_builder' in sys.modules)"
    )
    result = subprocess.run(
        [sys.executable, "-c", probe], capture_output=True, text=True, check=True
    )
    assert result.stdout.strip() == "False"


def test_every_provider_reexport_resolves_and_is_listed() -> None:
    import llm_pipeline.providers as providers

    for name in providers.__all__:
        assert getattr(providers, name) is not None, name
    assert set(providers.__all__) <= set(dir(providers))
