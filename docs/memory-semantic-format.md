# Semantic vector directory, version 1

`orch memory semantic validate --dir PATH` checks one directory before import. Success prints
`semantic validate: VALID rows=N dimension=N shards=N` and exits 0. A rejected directory prints
`semantic validate: REFUSED` to stderr and exits 1. Invalid command arguments print
`semantic validate: USAGE` to stderr and exit 2. Output never includes input bytes or paths.

## Files

The directory contains only `manifest.json`, `rows.jsonl`, and the shards listed by the manifest.
Shard names are sequential: `vectors-0000.f32`, `vectors-0001.f32`, and so on. Links, extra entries,
nonregular files, and files with more than one hard link are refused.

`manifest.json` is one strict JSON object with exactly these fields:

| Field | Required value |
| --- | --- |
| `schemaVersion` | `1` |
| `datasetId` | 1–128 ASCII characters from `A-Z a-z 0-9 _ -` |
| `scopeBinding` | Object with exactly `kind: "personal"`, `userStoreId`, `workspaceId`; both IDs use the same rule as `datasetId` |
| `generation` | Safe integer at least 1 |
| `modelFingerprint` | 64 lowercase hexadecimal characters |
| `dimension` | Safe integer from 1 to 1536 |
| `rowCount` | Safe integer from 1 to 1000 |
| `status` | `"complete"` |
| `shards` | Array of 1–16 objects described below |

Each shard object has exactly `name`, `byteCount`, `rowCount`, and `sha256`. Its name matches its
zero-based position, its row count is 1–4096, its byte count equals the complete file length, and
`sha256` is the lowercase SHA-256 digest of the complete file. Shard row counts sum to `rowCount`.

`rows.jsonl` has exactly `rowCount` LF-terminated UTF-8 lines in vector order. Every line is one
strict JSON object with exactly `datasetId`, `scopeBinding`, `id`, `revision`, `digest`,
`sourceRevision`, `sourceHash`, `chunkStart`, `chunkEnd`, `chunkHash`, `embeddingInputHash`,
and `modelFingerprint`. Dataset, scope, and fingerprint equal the manifest values. `id` is a unique
lowercase canonical UUID. Revisions are safe integers at least 1. Chunk offsets are safe integers
with `0 <= chunkStart < chunkEnd`; they claim UTF-8 byte offsets. The four hash fields are 64
lowercase hexadecimal characters. Blank lines, CR, BOM, and an unterminated final line are refused.

Each shard starts with eight ASCII bytes `ORCHVEC1`, then little-endian unsigned 32-bit version
`1`, dimension, and row count. The remaining bytes are exactly `rowCount * dimension` little-endian
IEEE-754 binary32 values in row-major order. Every value is finite. Each vector has nonzero squared
Euclidean norm within 0.001 of 1. The validator never changes vector bytes.

## Limits and scope

| Item | Maximum |
| --- | ---: |
| Directory entries | 18 |
| Manifest | 64 KiB |
| Rows file | 1 MiB |
| Manifest plus rows | 1 MiB |
| One row line | 8 KiB |
| One shard | 2 MiB, including header |
| All shards | 2 MiB, including headers |
| All required files | 3 MiB |
| JSON nesting / keys per object / array entries | 8 / 32 / 1000 |

Validation reads only the explicit directory. It does not import, index, activate, scan other
directories, contact a model or network service, or write files. It checks the shape and internal
integrity of the supplied bytes. It cannot verify that vectors represent their claimed text, that a
fingerprint identifies the producer, or that an ID is current or authorized. The consumer must check
those claims against its own store. A same-user process can replace a path between directory listing
and file opening; this command does not provide race-free path security.
On platforms without a no-follow file open, the command refuses the directory.
