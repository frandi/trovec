# Concurrency

## The Problem: Multiple Processes, One Database

When multiple processes (or multiple instances of your application) access the same Trovec collection on disk simultaneously, things can go wrong. If two processes try to write the file at the same time, the result can be a corrupted file — a mix of bytes from both writes that neither process can read.

Trovec's **concurrent file driver** solves this with two mechanisms: **file locking** and an optional **Write-Ahead Log (WAL)**.

## File Locking

File locking ensures that only one process can modify a collection file at a time. Before any read or write, the driver creates a **lock file** (e.g., `mycollection.trovec.lock`) on disk. The operating system guarantees that only one process can create this file — if another process tries, it knows the lock is taken and waits.

### How It Works

1. **Acquire** — The driver tries to create the lock file exclusively. If it succeeds, it holds the lock.
2. **Wait** — If the lock file already exists, the driver retries every 200ms (configurable via `lockRetryInterval`) until the lock is released or a timeout is reached (`lockAcquireTimeout`, default 10 seconds).
3. **Release** — After the operation completes, the lock file is deleted so other processes can proceed.

### Handling Crashes

What if a process crashes while holding the lock? The lock file would remain on disk, blocking everyone else forever. To prevent this, the driver uses a **heartbeat mechanism**:

- While holding the lock, the process updates a timestamp in the lock file every few seconds.
- Other processes check this timestamp. If the heartbeat is older than `staleLockTimeout` (default 30 seconds), the lock is considered **stale** and is removed automatically.

This ensures that a crashed process never permanently blocks access to the data.

## Two Modes of Operation

### Mode 1: Locking Only (Default)

With locking only (`wal: false`), every flush serializes the entire collection and writes it to disk under the lock.

```
Process A                           Process B
─────────                           ─────────
flush()                             flush()
  ├─ serialize entire collection      ├─ serialize entire collection
  ├─ acquire lock ✅                  ├─ acquire lock ⏳ waiting...
  ├─ write full file                  │
  ├─ release lock                     │
  │                                   ├─ acquire lock ✅
  │                                   ├─ write full file (replaces A's)
  │                                   ├─ release lock
```

The lock **prevents file corruption** (no interleaved writes), but this is a **last-writer-wins** model. Process B's write completely replaces Process A's file. If they added different entries, Process A's entries are lost.

This mode is fine when only one process writes at a time, or when processes always read the latest state before writing.

### Mode 2: WAL Enabled

With WAL enabled (`wal: true`), mutations are **appended** as small delta entries instead of rewriting the entire file. This means both processes' changes are preserved.

```
Process A                           Process B
─────────                           ─────────
add("doc1", vector1)                add("doc2", vector2)

flush()                             flush()
  ├─ acquire lock ✅                  ├─ acquire lock ⏳ waiting...
  ├─ append {put "doc1"}             │
  │  to WAL file                      │
  ├─ release lock                     │
  │                                   ├─ acquire lock ✅
  │                                   ├─ append {put "doc2"}
  │                                   │  to WAL file
  │                                   ├─ release lock
```

Because the WAL is **append-only**, Process B doesn't overwrite Process A's entry — it appends after it. Both deltas are preserved in the `.wal` file.

### How Reading Works with WAL

When any process reads the collection:

1. Acquire lock
2. Read the **base file** (the last full snapshot)
3. Read the **WAL file** and validate each entry's CRC32 checksum
4. **Replay** WAL entries on top of the base data — applying puts and deletes in order
5. Release lock

The result is a merged view that includes changes from all processes.

## WAL Checkpoint (Compaction)

Over time, the WAL file grows as more operations are appended. To prevent it from growing indefinitely, the driver performs a **checkpoint** when the WAL entry count exceeds `checkpointThreshold` (default 1000 entries).

A checkpoint:

1. Reads the base file and replays all WAL entries (just like a normal read)
2. Writes the merged result as a new base file
3. Deletes the WAL file
4. Resets the sequence counter

This entire operation happens under the lock, so it's safe even with concurrent access.

## File Layout

```
.trovec/
  mycollection.trovec          # Base file (compressed snapshot)
  mycollection.trovec.lock     # Lock file (exists only while lock is held)
  mycollection.trovec.wal      # WAL file (exists only when WAL is enabled)
```

## Configuration

```ts
import { create, createConcurrentFileDriver } from '@trovec/core';

const driver = createConcurrentFileDriver({
  directory: './data',

  // Locking options
  staleLockTimeout: 30_000,    // Consider lock stale after 30s without heartbeat
  lockAcquireTimeout: 10_000,  // Give up waiting for lock after 10s
  lockRetryInterval: 200,      // Retry every 200ms while waiting

  // WAL options
  wal: true,                   // Enable Write-Ahead Log
  checkpointThreshold: 1000,   // Checkpoint after 1000 WAL entries
});

const db = await create({
  dimensions: 384,
  metric: 'cosine',
  storageDriver: driver,
});
```

## Performance Under Contention

The concurrent file driver uses an **exclusive lock with sleep-polling** — only one process holds the lock at a time, and waiting processes retry every `lockRetryInterval` (default 200ms). This design is simple and correct, but it means tail latency grows as concurrency increases.

### Theoretical Worst Case

In the worst case, where all N processes attempt to flush at the exact same instant:

- `t_op` = time one process holds the lock (typically ~1-5ms for a WAL append)
- `r` = `lockRetryInterval` (default 200ms)
- Total time ≈ `N × t_op + (N-1) × r/2`

The polling interval dominates in this model. At ~100 simultaneous flushes, total wait time approaches `lockAcquireTimeout` (default 10s).

### Empirical Results

In practice, operations naturally stagger — processes aren't all flushing at the exact same instant. Stress tests with 2-32 concurrent processes (50 ops/worker, WAL enabled, 3 dimensions) show:

| Processes | Total (ms) | Throughput (ops/s) | Avg flush (ms) | P95 (ms) | P99 (ms) | Max (ms) | Failures |
|---|---|---|---|---|---|---|---|
| 2 | 381 | 263 | 3.9 | 5 | 11 | 210 | 0 |
| 4 | 712 | 281 | 8.3 | 5 | 213 | 619 | 0 |
| 8 | 1,558 | 257 | 16.0 | 6 | 618 | 1,432 | 0 |
| 16 | 3,262 | 245 | 32.9 | 9 | 848 | 2,249 | 0 |
| 32 | 6,542 | 245 | 65.9 | 405 | 1,864 | 3,713 | 0 |

Key observations:

- **Throughput stays roughly flat** (~245-280 ops/s) because operations interleave naturally rather than all contending at once.
- **Median flush time (p50) stays under 2ms** across all tiers — most individual flushes encounter no contention.
- **Tail latency is where contention shows up**: p99 grows from 11ms at 2 processes to 1.8s at 32 processes. The max flush time reaches 3.7s at 32 processes.
- **No failures** up to 32 processes with the default `lockAcquireTimeout` of 30s, though individual operations can stall for seconds.

### Read Performance

Reads also acquire the lock and have an additional cost: **WAL replay is O(W)** where W is the number of WAL entries since the last checkpoint. With many concurrent writers, W grows faster between checkpoints, making every read progressively slower until compaction happens.

### Practical Sweet Spot

The concurrent file driver works well for **a handful of concurrent processes** (roughly 2-10). In this range, throughput is stable, tail latency is manageable, and the system is functionally transparent.

Beyond ~10 processes, the system still functions correctly, but individual operations can experience multi-second stalls due to lock contention. This makes it unsuitable for latency-sensitive workloads at higher concurrency levels.

## Design Limits

Trovec is a lightweight, zero-dependency vector database library. The concurrency model is intentionally simple — it prioritizes correctness and minimal footprint over high-throughput concurrent access.

If your workload involves many concurrent writers (dozens or more) with latency requirements, you have likely outgrown what Trovec is designed for. In that case, consider a purpose-built database engine with built-in concurrency primitives (write-ahead logging with shared-memory coordination, MVCC, or a dedicated write coordinator).

Addressing high concurrency properly would require OS-specific lock primitives, a shared-memory coordinator, or an embedded database engine — all of which conflict with Trovec's zero-dependency, lightweight design philosophy.

## Performance at Scale (Data Size)

WAL append performance is independent of collection size — it stays under 1ms whether the base has 1K or 1M entries. However, operations that touch the full dataset (init, read, checkpoint, full flush) scale linearly with the number of entries.

Benchmarks with 128-dimension F32 vectors, single process:

| Entries | Init | WAL append (avg) | Read | Checkpoint | File size | RSS memory |
|---|---|---|---|---|---|---|
| 1K | 47ms | 0.85ms | 18ms | 40ms | 0.9MB | 80MB |
| 10K | 139ms | 0.31ms | 137ms | 113ms | 9.3MB | 227MB |
| 100K | 1.4s | 0.35ms | 1.5s | 1.2s | 93MB | 888MB |
| 500K | 10s | 0.40ms | 13s | 9.1s | 464MB | 3.6GB |
| 1M | 40s | 0.89ms | 51s | 28s | 929MB | 7.2GB |

Key observations:

- **WAL append is O(1)** — avg flush stays 0.3-0.9ms regardless of base size, confirming that write contention is independent of data size.
- **Init and read scale linearly** — at 100K entries, init takes ~1.4s which is acceptable. At 500K+ entries, init exceeds 10s and reads exceed 13s, making interactive use impractical.
- **Memory is the primary constraint** — Trovec loads all data into memory. At 128 dimensions, 100K entries uses ~888MB RSS, while 1M entries requires ~7.2GB. Higher dimensions (384d, 768d) multiply this proportionally.
- **100K entries is the practical comfort zone** — sub-2s operations, ~93MB file, under 1GB RSS. This scales with dimensions: 100K entries at 384d would use roughly 3x the memory (~2.5GB).

## When to Use Which Mode

| Scenario | Recommended Mode |
|---|---|
| Single process, simple use case | Locking only (default) |
| Multiple processes writing concurrently | WAL enabled |
| Frequent small updates (add/delete) | WAL enabled (avoids full rewrites) |
| Infrequent bulk writes | Locking only (simpler, no WAL overhead) |
