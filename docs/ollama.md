# Ollama Local AI Setup

This guide covers how to run the Ollama container that provides a local LLM and embedding model for Trovec development.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) (with Docker Compose v2)
- **(Optional)** An NVIDIA GPU with [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) installed — for GPU-accelerated inference

## Quick Start

```bash
docker compose up -d
```

On first run the container will pull two models automatically. This may take a few minutes depending on your connection:

| Model | Type | Size | Purpose |
|---|---|---|---|
| `llama3.2:1b` | LLM | ~1.3 GB | Text generation |
| `nomic-embed-text` | Embedding | ~274 MB | 768-dimension text embeddings |

Once running, the Ollama API is available at **http://localhost:11434**.

### Verify It's Working

```bash
# Check available models
curl http://localhost:11434/api/tags

# Test the LLM
curl http://localhost:11434/api/generate -d '{"model":"llama3.2:1b","prompt":"Hello!","stream":false}'

# Test embeddings
curl http://localhost:11434/api/embed -d '{"model":"nomic-embed-text","input":"Hello world"}'
```

## How It Works

The setup consists of two files:

```
docker-compose.yml          # Service definition
scripts/ollama-init.sh      # Entrypoint script that starts the server and pulls models
```

The init script (`scripts/ollama-init.sh`) replaces the default container entrypoint. It:

1. Starts the Ollama server in the background
2. Waits until the server is ready to accept requests
3. Pulls each model **only if not already downloaded** (skips on subsequent starts)
4. Keeps the server running in the foreground

Model data is persisted in a Docker volume (`ollama_data`), so models survive container restarts.

## Changing Models

The models are configured via environment variables in `docker-compose.yml`:

```yaml
environment:
  - LLM_MODEL=llama3.2:1b
  - EMBEDDING_MODEL=nomic-embed-text
```

To use different models, change these values and restart:

```bash
docker compose down
docker compose up -d
```

Browse available models at [ollama.com/library](https://ollama.com/library).

## GPU vs CPU Mode

The default `docker-compose.yml` is configured for **GPU acceleration** using the NVIDIA Container Toolkit. This section explains how to switch between GPU and CPU-only mode.

### GPU Mode (Default)

The compose file includes an NVIDIA device reservation:

```yaml
deploy:
  resources:
    reservations:
      devices:
        - driver: nvidia
          count: all
          capabilities: [gpu]
```

**Requirements:**

- An NVIDIA GPU (e.g. GeForce RTX series)
- NVIDIA drivers installed on the host
- [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) installed

Verify your GPU is accessible from Docker:

```bash
# Check your GPU is detected on the host
nvidia-smi

# After starting the container, check the logs for GPU detection
docker logs trovec-ollama 2>&1 | grep -i "gpu\|cuda\|nvidia"
```

You should see a line like:

```
inference compute  id=GPU-...  library=CUDA  compute=8.9  name=CUDA0  description="NVIDIA GeForce RTX 4070 ..."
```

### Switching to CPU-Only Mode

If you don't have an NVIDIA GPU, or want to run without GPU acceleration, create a `docker-compose.override.yml` in the project root:

```yaml
# docker-compose.override.yml
services:
  ollama:
    deploy:
      resources:
        reservations:
          devices: []
```

Docker Compose automatically merges this file with `docker-compose.yml`, clearing the GPU device reservation. No other changes needed:

```bash
docker compose down
docker compose up -d
```

To go back to GPU mode, simply delete (or rename) the override file and restart.

> **Tip:** The override file is useful for local-only configuration. Consider adding `docker-compose.override.yml` to `.gitignore` so each developer can choose their own mode without affecting the repo.

### Switching to CPU-Only Mode (Alternative)

If you prefer not to use an override file, you can also use Docker Compose profiles. Comment out or remove the `deploy` block directly in `docker-compose.yml`:

```yaml
services:
  ollama:
    image: ollama/ollama:latest
    # ...
    # deploy:              # <-- comment out or remove this block for CPU-only
    #   resources:
    #     reservations:
    #       devices:
    #         - driver: nvidia
    #           count: all
    #           capabilities: [gpu]
    restart: unless-stopped
```

### Performance Comparison

Benchmarked on an NVIDIA GeForce RTX 4070 Laptop GPU (8 GB VRAM):

| Metric | CPU | GPU | Speedup |
|---|---|---|---|
| LLM tokens/sec | ~37 tok/s | ~169 tok/s | **4.6x** |
| LLM 100-token generation | ~2.9 s | ~772 ms | **3.8x** |
| LLM prompt eval (500 words) | ~220 ms | ~10 ms | **22x** |
| Embedding (single, short text) | ~23 ms | ~24 ms | ~1x |
| Embedding (batch, 10 texts) | ~132 ms | ~78 ms | **1.7x** |
| Embedding (500 words) | ~361 ms | ~32 ms | **11x** |

GPU acceleration is most impactful for LLM inference and longer-text embeddings.

## Benchmarking

A benchmark script is included to measure model performance on your machine:

```bash
npx tsx scripts/benchmark-ollama.ts
```

This tests both models across multiple scenarios (token generation speed, prompt evaluation, embedding latency and throughput) and prints a summary table.

Configuration via environment variables:

```bash
# Change the number of iterations per test (default: 5)
ITERATIONS=10 npx tsx scripts/benchmark-ollama.ts

# Point to a different Ollama host
OLLAMA_HOST=http://192.168.1.100:11434 npx tsx scripts/benchmark-ollama.ts
```

## Common Operations

```bash
# Start the container
docker compose up -d

# Stop the container
docker compose down

# View logs
docker logs -f trovec-ollama

# Restart (e.g. after changing models)
docker compose down && docker compose up -d

# Pull a model manually
docker exec trovec-ollama ollama pull mistral

# List downloaded models
docker exec trovec-ollama ollama list

# Remove a model
docker exec trovec-ollama ollama rm llama3.2:1b

# Reset everything (removes all downloaded models)
docker compose down -v
```

## Troubleshooting

**Container fails to start with GPU error**
Your machine may not have the NVIDIA Container Toolkit installed, or doesn't have an NVIDIA GPU. Switch to CPU-only mode (see above).

**Models fail to download**
Check your internet connection. The container needs outbound access to pull models from `registry.ollama.ai`. You can also check the logs:
```bash
docker logs trovec-ollama
```

**Port 11434 already in use**
Another Ollama instance (or another service) may be using the port. Either stop it, or change the port mapping in `docker-compose.yml`:
```yaml
ports:
  - "11435:11434"   # maps host port 11435 → container port 11434
```

**Slow performance / not using GPU**
Check the container logs for GPU detection. If you don't see the CUDA/GPU line, the container is running in CPU-only mode. Make sure the NVIDIA Container Toolkit is installed and restart Docker.
