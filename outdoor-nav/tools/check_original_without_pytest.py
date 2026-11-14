"""Run the original file's simple test functions when pytest is unavailable.

This is explicitly a stdlib compatibility runner, not an implementation of
pytest. It supports only the fixture, raises and skip features used in the
unchanged tests/test_outdoor.py. Use `uv run pytest -q` for the full test suite.
"""
import ast
import inspect
import sys
import tempfile
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


class Raises:
    def __init__(self, exception):
        self.exception_type, self.value = exception, None

    def __enter__(self):
        return self

    def __exit__(self, kind, error, traceback):
        if kind is None:
            raise AssertionError("Expected %s" % self.exception_type)
        if not issubclass(kind, self.exception_type):
            return False
        self.value = error
        return True


def skip(message):
    raise unittest.SkipTest(message)


def main():
    path = ROOT / "tests/test_outdoor.py"
    tree = ast.parse(path.read_text(), filename=str(path))
    tree.body = [node for node in tree.body if not (isinstance(node, ast.Import)
                 and any(alias.name == "pytest" for alias in node.names))]
    shim = types.SimpleNamespace(fixture=lambda f: f, raises=Raises, skip=skip)
    namespace = {"__name__": "original_test_compatibility", "__file__": str(path), "pytest": shim}
    exec(compile(tree, str(path), "exec"), namespace)
    passed, skipped = 0, 0
    for name, function in sorted(namespace.items()):
        if not name.startswith("test_") or not callable(function):
            continue
        with tempfile.TemporaryDirectory() as directory:
            available = {"g": lambda: namespace["g"](), "tmp_path": lambda: Path(directory)}
            kwargs = {key: available[key]() for key in inspect.signature(function).parameters}
            try:
                function(**kwargs)
            except unittest.SkipTest:
                skipped += 1
            else:
                passed += 1
    print("Original test functions: %d passed, %d skipped (stdlib compatibility runner, not pytest)" % (passed, skipped))


if __name__ == "__main__":
    main()
