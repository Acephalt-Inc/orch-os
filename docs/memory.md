# Explicit personal memory

`orch memory` stores one assertion and one supplied-text source in the current workspace's personal private partition.
It does not verify the assertion. A matching quote proves only that the submitted quote matches a span of the submitted text.

```text
orch memory add --expected-generation N
orch memory show --id UUID
orch memory list [--after UUID] [--limit N]
orch memory forget --id UUID --expected-revision R --expected-generation N
orch memory recall --query TEXT [--all-terms] [--limit N]
```

`add` reads one UTF-8 JSON object from stdin with exactly `title`, `assertion`, `polarity`, and `source`.
`source` has exactly `text`, `fragmentStart`, `fragmentEnd`, and `quote`.
Offsets count UTF-8 bytes, and the quote must match the selected span exactly.
`polarity` is `affirmed`, `negated`, or `uncertain`.
Use `list` to get the current generation, starting at 0 for an empty partition.
Use the returned generation when adding or forgetting; forget also requires the fact's revision.
The list cursor is an exclusive fact ID in ascending order, and each page has at most 20 current facts.

`recall` searches the titles and assertions of current facts in this workspace's personal partition.
It uses literal English and Chinese terms. `--all-terms` requires every query term; otherwise any term may match.
The default result limit is 8, and `--limit` accepts 1 through 20. Queries are limited to 2,048 UTF-8 bytes and
64 distinct terms. Matching is case-insensitive and uses Unicode normalization; punctuation separates terms.
It does not search source quotes, interpret dates, translate, or find synonyms and paraphrases.

Success is one JSON line with `generation`, ranked `items`, `omitted`, and `partial`.
Each item includes a score, displayed title and assertion, expiry, a source-quote excerpt, and a citation containing
the fact ID, revision, digest, scope reference, source ID and hash, fragment byte offsets, and checked time.
The quote excerpt is at most 1,024 UTF-8 bytes; the complete output line is at most 16,384 bytes.
Results are ranked by a fixed term score, with fact ID breaking ties. `omitted` counts matched facts left out by
the result or byte limit. A first item too large for the line limit is refused without a partial result.
The citation identifies the stored source at read time; it is not a live check of an external source.
The command does not change the stored facts or generation. Another writer may change them between calls.
Matches indicate relevance, not truth, verification, approval, or an instruction.

Facts expire from show and list 90 days after capture. Expiry does not mean the assertion became false.
The command refuses reads and writes if the sampled wall clock is earlier than the last recorded write or store commit.
An observed rollback may require correcting the host clock before retrying.
Recall checks for rollback against the last recorded write and store commit. Smaller clock changes can go undetected.

The version 1 fact record has 22 top-level keys. Its `time` object contains exactly `recordedAt`, `updatedAt`,
`eventTime`, `validTime`, `expiresAt`, and `reviewDueAt`; its `lineage` object contains exactly `derivedFrom`,
`evidencePacket`, `coverageGeneration`, `evidenceCount`, `supersedes`, `supersededBy`, and `replacedAt`.
The record digest covers the canonical JSON of every field except `digest`, including both nested objects.

Forget removes the fact and its inline source text from the current managed canonical state and leaves a body-free tombstone.
It does not erase copies outside that state, backups, older storage media blocks, or facts shared by other tools.
A same-account process can replace local files; this command does not authenticate a person or protect against same-user tampering.
Completed writes rely on the private store's local filesystem guarantees and are not a physical erasure or power-loss guarantee.
Mac and Linux are the supported private-store platforms; Windows private access currently refuses.
