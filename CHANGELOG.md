# Changelog

All notable changes to Trovec will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[2.2.0]: https://github.com/frandi/trovec/compare/v2.1.0...v2.2.0
