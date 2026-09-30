# Third-party components

The application uses original HTML/CSS/JavaScript and an original SVG X-AI logo. No private production artwork, dialogue, generated film or API key is distributed with this repository.

## FFmpeg WebAssembly

|Component|Version|License|Location|
|---|---|---|---|
|@ffmpeg/ffmpeg|0.12.15|MIT|vendor/ffmpeg/|
|@ffmpeg/core (single thread)|0.12.10|GPL-2.0-or-later|vendor/ffmpeg-core/|

Packages were obtained from the npm registry and copied from their `dist/esm` distributions. The core is a separate WebAssembly program, used by the FFmpeg JavaScript wrapper in a browser worker. The core includes GPL components such as libx264. Preserve notices and the GPL text when redistributing it.

Upstream source and build instructions:

- https://github.com/ffmpegwasm/ffmpeg.wasm
- https://github.com/ffmpegwasm/ffmpeg.wasm/tree/v12.15 (commit `71aa99d37c02a7b4c435275ca9ef50e612f6efa1`; packages/core/package.json is 0.12.10)
- https://www.npmjs.com/package/@ffmpeg/core/v/0.12.10
- https://www.npmjs.com/package/@ffmpeg/ffmpeg/v/0.12.15

The GPL license is included at `vendor/ffmpeg-core/LICENSE.GPL-2.0`. Upstream source and build material are bundled under `vendor/source/`: the wrapper/build repository, FFmpeg n5.1.4, the codec and text rendering dependencies, Emscripten 3.1.40, its SDL2 2.24.2 port and the zimg test submodule. The archive list includes SHA-256 hashes and resolved source revisions. See `vendor/source/README.md` for provenance and reproducibility limits. No changes were made to the vendored executable code. Keep this source bundle, licenses and notices with redistributions. Modified builds must include their corresponding modified source under the applicable license.

The original X-AI application source is licensed under MIT. The separately distributed FFmpeg binaries remain under their own license; the MIT notice does not relicense FFmpeg or its dependencies.
