"""Framework-free persistence core for A2UI Form Profile v1 submissions.

The frozen protocol models live exclusively in :mod:`agent_core.a2ui`.  The
optional FastAPI router is deliberately isolated in :mod:`.http` so importing
this package never adds a web-framework dependency to the text Agent runtime.
"""

from .config import A2UISettings
from .forms import FormSnapshot, InMemoryFormRegistry
from .repository import SQLiteSubmissionRepository
from .service import SubmissionPort, SubmissionService

__all__ = [
    "A2UISettings",
    "FormSnapshot",
    "InMemoryFormRegistry",
    "SQLiteSubmissionRepository",
    "SubmissionPort",
    "SubmissionService",
]
