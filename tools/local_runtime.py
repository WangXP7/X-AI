"""Identity shared by the local static server and its launcher (no secrets)."""
import hashlib
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APP_ID = 'x-ai-video-studio'


def workspace_id(root=ROOT):
    path = os.path.normcase(str(Path(root).resolve()))
    return hashlib.sha256(path.encode('utf-8')).hexdigest()


def server_identity():
    package = json.loads((ROOT / 'package.json').read_text(encoding='utf-8-sig'))
    return {'app': APP_ID, 'workspace': workspace_id(),
            'version': package['version'], 'pid': os.getpid()}
