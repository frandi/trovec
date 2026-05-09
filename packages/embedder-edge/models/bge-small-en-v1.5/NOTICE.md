# bge-small-en-v1.5 — bundled model attribution

The `@trovec/embedder-edge` package bundles model weights derived from
`BAAI/bge-small-en-v1.5`. The exact ONNX export shipped here is the INT8
quantized variant from the `Xenova/bge-small-en-v1.5` mirror, which
re-publishes the BAAI weights in formats compatible with web/edge
ONNX runtimes.

## Source

- Upstream model: <https://huggingface.co/BAAI/bge-small-en-v1.5>
- ONNX mirror used for the bundled file: <https://huggingface.co/Xenova/bge-small-en-v1.5>
- Pinned revision and per-file SHA256 checksums: see `manifest.json` in this directory.

## License

The upstream BAAI weights are released under the **MIT License**
(see <https://huggingface.co/BAAI/bge-small-en-v1.5#license>). The
Xenova ONNX mirror redistributes those weights without re-licensing.

## Why a quantized variant

The full-precision (FP32) ONNX export is ~127 MB. INT8 quantization
reduces this to ~32 MB while preserving most retrieval quality
(typically a 0.5–1.5 percentage-point drop on MTEB benchmarks). For an
edge-targeted package where install size and resident memory matter
more than the last fraction of a quality point, INT8 is the
appropriate trade-off.

Users who need the full-precision model can override `modelPath` in
`createEdgeEmbedder({ modelPath })` to point at their own ONNX file.
