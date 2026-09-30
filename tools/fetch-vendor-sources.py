"""Retrieve upstream source archives named by the vendored FFmpeg build recipe.

Development/distribution utility only; never called by the web application.
Each resolved revision and archive hash is recorded for future redistribution.
"""
import concurrent.futures
import hashlib
import json
from pathlib import Path
import time
import urllib.request

ROOT = Path(__file__).resolve().parent.parent / 'vendor' / 'source'
SOURCES = [
    ('FFmpeg/FFmpeg', 'n5.1.4'), ('ffmpegwasm/x264', '4-cores'),
    ('ffmpegwasm/x265', '3.4'), ('ffmpegwasm/libvpx', 'v1.13.1'),
    ('ffmpegwasm/lame', 'master'), ('ffmpegwasm/Ogg', 'v1.3.4'),
    ('ffmpegwasm/theora', 'v1.1.1'), ('ffmpegwasm/opus', 'v1.3.1'),
    ('ffmpegwasm/vorbis', 'v1.3.3'), ('ffmpegwasm/zlib', 'v1.2.11'),
    ('ffmpegwasm/libwebp', 'v1.3.2'), ('ffmpegwasm/freetype2', 'VER-2-10-4'),
    ('fribidi/fribidi', 'v1.0.9'), ('harfbuzz/harfbuzz', '5.2.0'),
    ('libass/libass', '0.15.0'), ('sekrit-twc/zimg', 'release-3.0.5'),
    ('emscripten-core/emscripten', '3.1.40'), ('libsdl-org/SDL', 'release-2.24.2'),
]

def read(url):
    for attempt in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent':'X-AI-source-bundle'}), timeout=120) as response:
                return response.read()
        except Exception:
            if attempt == 2:
                raise
            time.sleep(2)

def fetch(item):
    repo, ref = item
    manifest = ROOT / 'dependencies.json'
    if manifest.exists():
        for prior in json.loads(manifest.read_text(encoding='utf-8')):
            if prior['repository'] == 'https://github.com/'+repo and prior['build_ref'] == ref:
                saved = ROOT / prior['archive']
                if saved.exists() and hashlib.sha256(saved.read_bytes()).hexdigest() == prior['sha256']:
                    return prior
    commit = json.loads(read(f'https://api.github.com/repos/{repo}/commits/{ref}'))['sha']
    url = f'https://codeload.github.com/{repo}/tar.gz/{commit}'
    path = ROOT / (repo.replace('/', '_') + '-' + ref + '.tar.gz')
    payload = path.read_bytes() if path.exists() else read(url)
    path.write_bytes(payload)
    print(f'{repo}: {len(payload)} bytes', flush=True)
    return {'repository':'https://github.com/'+repo, 'build_ref':ref, 'resolved_commit':commit,
            'archive':path.name, 'url':url, 'bytes':len(payload), 'sha256':hashlib.sha256(payload).hexdigest()}

if __name__ == '__main__':
    ROOT.mkdir(exist_ok=True, parents=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(fetch, SOURCES))
    zimg = next(row for row in results if row['repository'].endswith('/zimg'))
    submodule = json.loads(read('https://api.github.com/repos/sekrit-twc/zimg/contents/test/extra/googletest?ref='+zimg['resolved_commit']))
    results.append(fetch(('google/googletest', submodule['sha'])))
    (ROOT/'dependencies.json').write_text(json.dumps(results, indent=2)+'\n', encoding='utf-8')
