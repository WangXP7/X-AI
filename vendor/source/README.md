# FFmpeg source and build material

This directory travels with the separately licensed FFmpeg WebAssembly binary.
It is not loaded by the browser and contains no application secrets or user media.

- `ffmpeg.wasm-v12.15-source.tar.gz`: upstream repository at commit `71aa99d37c02a7b4c435275ca9ef50e612f6efa1` (wrapper 0.12.15; core package 0.12.10).
- `Dockerfile.upstream`: unmodified build recipe from that revision.
- `source-origin.json`: wrapper/build source archive provenance and hash.
- `dependencies.json`: source archives named by that recipe, their resolved commits, URLs and SHA-256 hashes. Includes the zimg googletest submodule.
- Emscripten 3.1.40's `tools/ports/sdl2.py` selects SDL `release-2.24.2`, also included.

To examine or rebuild, unpack the wrapper source, read its development instructions,
Dockerfile and build scripts, and use the versions recorded here. The original build
recipe uses moving branches for some dependencies (including x264 and lame); the
manifest records the revisions resolved when this bundle was prepared. Upstream's
npm binary does not provide a complete dependency commit lockfile. This project did
not rebuild the npm binary and does not claim bit-for-bit reproducibility from the
available source snapshot. The executable files are the unmodified published npm
release; versions and checksums are in `../integrity.json`.

`tools/fetch-vendor-sources.py` preserves existing verified archive records and can
retrieve missing materials. It is a maintainer tool, not an installation step.
Each upstream archive retains its own license/copyright files; preserve these along
with `../ffmpeg-core/LICENSE.GPL-2.0` and `../../THIRD_PARTY.md` when redistributing.
