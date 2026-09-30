"""Independently verify the real ZIP produced by the browser asset test."""
import hashlib
import json
from pathlib import Path
import zipfile

root = Path(__file__).resolve().parents[1] / 'test-results'
expected = json.loads((root / 'assets-zip-expected.json').read_text(encoding='utf-8'))
with zipfile.ZipFile(root / 'assets-batch.zip') as archive:
    assert archive.testzip() is None, 'ZIP CRC verification failed'
    names = archive.namelist()
    assert len(names) == len(set(name.lower() for name in names))
    assert len(names) == len(expected) + 1
    manifest = json.loads(archive.read('X-AI_素材清单.json'))
    by_id = {a['id']: a for a in expected}
    assert len(manifest['assets']) == len(expected)
    for asset in manifest['assets']:
        data = archive.read(asset['archiveName'])
        assert hashlib.sha256(data).hexdigest() == by_id[asset['id']]['sha256']
        assert asset['sha256'] == by_id[asset['id']]['sha256']
        assert '/' not in asset['archiveName'] and '\\' not in asset['archiveName']
print(f'ZIP verified: {len(expected)} media files, unique UTF-8 names, original SHA-256, all CRCs passed.')
