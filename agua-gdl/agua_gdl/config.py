import re
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent


def _load(path):
    with open(path, encoding="utf-8") as f:
        return yaml.safe_load(f)


def compile_patterns(patterns):
    """Lista de regex (str) -> una sola regex con \\b inicial."""
    return re.compile(r"\b(?:" + "|".join(patterns) + ")")


class Config:
    def __init__(self, config_dir=None):
        d = Path(config_dir) if config_dir else ROOT / "config"
        self.dir = d
        self.sources = _load(d / "sources.yaml")["sources"]
        self.keywords = _load(d / "keywords.yaml")
        self.lexicon = _load(d / "lexicon.yaml")
        self.themes = _load(d / "themes.yaml")
