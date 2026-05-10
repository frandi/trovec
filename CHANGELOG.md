# Changelog

All notable changes to Trovec will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`@trovec/embedder-edge` (new package, `0.1.0`).** Bundled ONNX text embedder for Trovec. Ships the INT8 quantized variant of `bge-small-en-v1.5` (~32 MB) and runs inference in-process via `onnxruntime-node` — no API keys, no Ollama server, no network calls at runtime. Fills the quality gap between `embedder-local` (toy) and `embedder-ollama`/`embedder-openai` (heavyweight setup). The `Embedder.model` identity is `"bge-small-en-v1.5@1.0.0"`, picked up by the v2.3.0 mismatch warning so weight-version changes are surfaced automatically. Node-only in v0.1.0; browser support tracked separately. Versioned independently on a `0.x` line, signaling experimental status.

---

## [Unreleased]

### Added

- **`@trovec/embedder-edge@0.2.0`: tokenizer abstraction + low-level building blocks.** `createEdgeEmbedder` now accepts a `tokenizer?: Tokenizer` option so users can plug in non-WordPiece tokenizers (e.g., SentencePiece) for multilingual or specialized models without forking the package. The package also promotes its runtime primitives to public exports — `loadOnnxSession`, `runInference`, `meanPoolAndNormalize`, `createTokenizer`, `loadTokenizer`, plus the `Tokenizer`, `TokenizerJson`, `EncodeOptions`, `EncodedBatch`, `ModelSpec`, `OnnxSession`, `PoolingInputs` types — so advanced users can compose embedders for non-bundled models or build custom inference paths. Pure additive change; existing users are unaffected.

### Documentation

- **Honest scenario-based recommendation matrix.** `poc/pdf-rag/BENCHMARK.md` rewritten with V3 methodology: NIST SP 800-63B (English-only public-domain PDF, 480 chunks), 480 LLM-paraphrased queries, four local ONNX models (bge-small / bge-base / bge-large / all-MiniLM-L6-v2) compared against `text-embedding-3-small`. Headline finding: bge-base and bge-large both *beat* OpenAI on retrieval quality on English content; bge-small is within ~3 pp of OpenAI at 32× faster query latency. The package README and adapter tables are rewritten accordingly.

---

## [2.3.0] - 2026-05-09

This release lays the groundwork for an upcoming WASM-backed embedder by adding embedder identity tracking to the persisted file format. The change closes a real footgun on its own — it warns when stored vectors and the current embedder come from different embedding spaces — and ensures users upgrading to a future edge-embedder release have the protection in place from day one. All public APIs remain backward compatible with `2.2.0`.

### Added

- **`@trovec/core`: Embedder identity tracking.** Persisted `.trovec` files now record the `Embedder.model` string in a small JSON metadata section, and `create()` emits a `console.warn` on load when the configured embedder differs from the one that produced the stored vectors. This catches the silent-incompatibility footgun that occurs when users swap embedders without rebuilding the collection. The `Embedder` interface is unchanged; existing adapters need no updates. New public type export: `PersistedMetadata`.

### Changed

- **`@trovec/core`: Persisted file format bumped from v1 to v2.** The 16-byte header layout is preserved; a `uint16`-prefixed JSON metadata section now sits between header and entries. **Forward-compatible:** the new core reads existing v1 files silently. **Not backward-compatible:** older `@trovec/core` versions cannot read files written by this release. Users who downgrade after upgrading must rebuild affected collections. WAL and encryption paths are unaffected.
- Internal dependency ranges between `@trovec/*` packages have been tightened from `^2.2.0` to `^2.3.0`.

---

## [2.2.0] - 2026-04-05

This release adds opt-in encryption at rest, a concurrent-safe file storage driver, and a handful of developer-experience improvements across the monorepo. All public APIs remain backward compatible with `2.1.0`.

### Added

- **`@trovec/core`: AES-256-GCM encryption at rest.** Wrap any storage driver with `withEncryption(driver, { key })` to transparently encrypt data on write and decrypt on read. New public exports: `withEncryption`, `decryptBuffer`, `resolveEncryptionKey`, `EncryptionOptions`, `ResolvedEncryption`, `EncryptionError`. (#19)
- **`@trovec/core`: Concurrent file storage driver.** New `createConcurrentFileDriver` uses a write-ahead log and OS-level file locking for safe multi-process access. New public exports: `createConcurrentFileDriver`, `ConcurrentFileDriverOptions`, `ConcurrentFileStorageDriver`, `WalOperation`, `WalAwareDriver`, `isWalAwareDriver`, `LockTimeoutError`, `WalCorruptionError`. (#18)
- **`@trovec/core`: Additional public error classes** exposed at the package entry point: `TrovecError`, `DimensionMismatchError`, `InvalidConfigError`.
- **`@trovec/core`: JSDoc coverage** for the entire public API surface. (#17)
- **`@trovec/core`: Optional `model` property** on the `Embedder` interface for adapter identification. (#15)
- **`@trovec/cli`: `--encryption-key` support** for all commands that read or write `.trovec` files. (#22)
- **`vscode-trovec`: Encryption-aware viewer.** The extension now prompts for a decryption key when opening encrypted `.trovec` files. (#21)
- **Docs:** beginner-friendly concept docs, concurrency and scalability documentation, honest design limits, custom storage drivers guide, and a contributing guide with community health files.

### Fixed

- **`@trovec/cli`:** the version string reported by `trovec --version` was hardcoded and drifted from `package.json`. It is now generated at build time from the manifest. (#16)
- **`@trovec/cli`:** `LICENSE` file was listed in `files` but missing from the package root, so published tarballs shipped without a license file. The file has been added.

### Changed

- All `@trovec/*` packages now include an icon (`icon.png`) and render it at the top of their README on npm.
- All `@trovec/*` packages now declare an `author` field in their manifest.
- Internal dependency ranges between `@trovec/*` packages have been tightened from `^2.0.0` to `^2.2.0`.

---

Earlier releases (`2.0.0`, `2.1.0`, and prior) are not documented here; see the [GitHub release notes](https://github.com/frandi/trovec/releases) and commit history for details.

[2.3.0]: https://github.com/frandi/trovec/compare/v2.2.0...v2.3.0
[2.2.0]: https://github.com/frandi/trovec/compare/v2.1.0...v2.2.0
