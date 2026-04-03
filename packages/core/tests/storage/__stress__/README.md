# Stress & Limit Tests

These tests validate the concurrent file driver (WAL + file locking) under real-world conditions and find its practical limits. They are **excluded from `npm test`** and must be run explicitly.

## Running

```bash
# All stress tests (~70-120s)
npm run test:stress --workspace=packages/core

# Performance benchmarks (outputs markdown tables)
npm run test:bench --workspace=packages/core
```

## Test Categories

### Multi-Process Correctness (`multi-process.test.ts`)

Tests real OS-level process isolation using `child_process.fork()`. Each child process gets its own `ConcurrentFileDriver` instance with a separate PID, exercising the actual `open(path, 'wx')` lock contention across processes.

| Test | Description |
|------|-------------|
| 1.1 | Two writers without WAL -- lock prevents write corruption |
| 1.2 | Two writers with WAL -- WAL append locking across processes |
| 1.3 | Writer + reader concurrent access -- consistent snapshots |
| 1.4 | SIGKILL mid-write -- stale lock recovery with dead PID |
| 1.5 | SIGKILL during WAL append -- CRC catches partial entries |
| 1.6 | Three concurrent writers -- no deadlocks under N>2 contention |

### Crash Recovery (`crash-recovery.test.ts`)

Simulates failures by directly manipulating WAL and base files, then verifies the system recovers correctly.

| Test | Description |
|------|-------------|
| 2.1 | Corrupt WAL entry mid-file -- stops at last valid entry |
| 2.2 | Truncated WAL (file cut short) -- recovers valid prefix |
| 2.3 | Header-only WAL (no entries) -- returns empty, no error |
| 2.4 | Sub-header WAL (<12 bytes) -- returns empty, marked truncated |
| 2.5 | Corrupt base file -- throws decompression error (not silent) |
| 2.6 | Base OK + WAL corrupt -- recovers base + valid WAL entries |
| 2.7 | Stale `.tmp` file from interrupted write -- atomic rename handles it |
| 2.8 | WAL survives across reloads -- checkpoint cleans up correctly |

### Stress & Load (`stress.test.ts`)

Pushes the system to find performance cliffs and resource exhaustion bugs. Each test logs timing metrics to stdout.

| Test | Description | Key Metric |
|------|-------------|------------|
| 3.1 | 500 rapid add+flush cycles (WAL) | avg ms/flush |
| 3.2 | 1000 WAL entries without checkpoint | read time before/after checkpoint |
| 3.3 | Large vectors (768, 1536, 3072 dimensions) | flush/read time, file size |
| 3.4 | 10K entries, 128d | flush/read time, file size |
| 3.5 | 50K entries, 128d | flush/read time, file size |
| 3.6 | 1000 direct WAL appends | entries/sec throughput |
| 3.7 | 10 async tasks, 100 cycles each | sustained contention, data integrity |

### Scalability Limits (`scalability.test.ts`)

Finds the practical ceiling for Trovec's file-based approach. Results can be used for documentation.

| Test | Description | Break Condition |
|------|-------------|-----------------|
| 5.1 | Progressive dataset size (1K to 100K) | Flush or read > 10s |
| 5.2 | WAL growth without checkpoint (100 to 10K entries) | Read > 5s |
| 5.3 | N concurrent processes (2, 4, 8) | Throughput degradation |
| 5.4 | 3072d x 10K entries | Any operation > 30s |
| 5.5 | INT8 vs F32 at 768d x 10K | Size and speed comparison |

### Performance Benchmarks (`benchmarks/concurrent-file.bench.ts`)

Standalone script that outputs markdown tables for documentation. Measures:

- Single-process add throughput (adds/sec across dimensions and batch sizes)
- WAL append latency vs full write (crossover point)
- Read latency with growing WAL size
- Checkpoint duration vs WAL size
- File size analysis (compressed vs uncompressed, across quantization types)
- Memory usage (heap delta when loading datasets)

## Threshold Reference

| Metric | Good | Warning | Limit |
|--------|------|---------|-------|
| Flush time | < 1s | 1-10s | > 10s |
| Read time | < 500ms | 500ms-5s | > 5s |
| File size | < 100MB | 100-500MB | > 500MB |
| Memory | < 500MB | 500MB-1GB | > 1GB |
| Lock acquisition | < 100ms | 100ms-1s | Timeout |

## Architecture

Multi-process tests use an IPC-based worker (`tests/fixtures/worker.ts`) that receives commands from the parent test process. Each worker creates its own driver and Trovec instance, providing real PID isolation. Communication flows through `process.send()` / `process.on('message')`.
