"""Load an OpenWebUI tool without OpenWebUI.

These files run inside an OpenWebUI worker, so their imports and their whole calling convention
belong to a server that is not present here. Two stubs are enough to drive the real source: a
`pydantic` whose `Field` leaves the declared default as an ordinary class attribute, and a
`requests` whose `get`/`post` each test supplies.

Nothing is copied or re-implemented: `load()` executes the shipped file, so a test that passes is a
statement about what actually ships.
"""

from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parent.parent


def _install_pydantic() -> None:
    module = types.ModuleType('pydantic')

    class BaseModel:
        def __init__(self, **kwargs):
            for key, value in kwargs.items():
                setattr(self, key, value)

    module.BaseModel = BaseModel
    # A valve is declared `NAME: type = Field(default=...)`, so returning the default leaves it as a
    # plain class attribute and an instance reads it unchanged. Overrides go through BaseModel above.
    module.Field = lambda default=None, **kwargs: default
    sys.modules['pydantic'] = module


class FakeRequests(types.ModuleType):
    """A `requests` module whose verbs a test sets per case.

    An unset verb raises rather than returning something empty: a tool that reaches the network by a
    path the test did not anticipate should fail loudly, not quietly pass on a fabricated blank.
    """

    def __init__(self):
        super().__init__('requests')
        self.get = self._refuse('get')
        self.post = self._refuse('post')

    @staticmethod
    def _refuse(verb: str):
        def refuse(*args, **kwargs):
            raise AssertionError(f'requests.{verb} was called but this test set no handler for it')

        return refuse


def install() -> FakeRequests:
    """Put the stubs in place. Must run before `load()`, which imports them."""
    _install_pydantic()
    fake = FakeRequests()
    sys.modules['requests'] = fake
    return fake


def load(name: str):
    """Execute `openwebui/<name>.py` and hand back the module.

    :param name: the tool file's basename without `.py`.
    """
    path = TOOLS_DIR / f'{name}.py'
    spec = importlib.util.spec_from_file_location(f'owui_{name}', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Recorder:
    """Collects what a tool emits, standing in for OpenWebUI's `__event_emitter__`."""

    def __init__(self):
        self.events: list[dict] = []

    async def __call__(self, event: dict) -> None:
        self.events.append(event)

    def of_type(self, event_type: str) -> list[dict]:
        return [e for e in self.events if e.get('type') == event_type]

    def descriptions(self) -> list[str]:
        return [e['data'].get('description', '') for e in self.of_type('status')]
