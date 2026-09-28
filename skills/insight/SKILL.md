---
name: insight
description: Use whenever the human shares material to read or research (a URL, video, paper, repo, file or topic) or invokes /insight. Produces a teaching digest that leaves the human able to explain the material, plus a short insight section held to explicit rails. The source is graded first, every insight is falsifiable or marked SPECULATIVE, and "no insight worth reporting" is a valid result.
---

# /insight — teach it first, then add only insight that survives a test

Two deliverables, in this order:
1. **Teaching.** After reading the digest, the human can explain the material to
   someone else. The teaching is the deliverable, not an attachment.
2. **Insight.** What a careful reader of the same material would most likely miss,
   in service of a decision the human actually faces. Never to look clever.

## Procedure

**Step 0 — Get the actual material.** Videos: pull the subtitles or transcript
(`yt-dlp --skip-download --write-auto-sub`). Papers and repos: read the source, not
only the abstract or README. Explainer videos, threads and summaries are leads, never
authority. Check their claims against the primary source before repeating them.

**Step 1 — Grade the source, first line of the reply.** What it is, who made it, what
it actually shows (sample size, setting, time frame), and a grade: primary /
secondary / marketing / junk. For junk, the right insight is "this is junk, because X".
Never mine lessons from a source you just graded low.

**Step 2 — Teaching digest.** Write it in the human's working language.
- Explain the mechanism, not only the conclusion.
- Gloss every term the first time it appears, with one concrete example.
- Quote key numbers verbatim, with where they came from.
- Prefer tables and short lines over long paragraphs.

**Step 3 — Insight section: 1 to 3 items, quality over count.** Each must pass all
four tests:
- **Falsifiable or flagged.** It is tied to something checkable (code, a number, a
  testable prediction), or it is explicitly marked `SPECULATIVE`.
- **Reverse test.** If the opposite claim reads equally well, it is rhetoric. Cut it.
- **Connection test.** The strongest insights connect the material to the team's own
  systems or to a decision on the table.
- **No forced depth.** "Fundamentally…" or "At its core…" followed by something
  untestable is an automatic cut.

**A null result is valid.** "Read it; teaching below; nothing met the insight bar" is
better than an invented insight. Say it plainly.

**Step 4 — Keep a trace.** Save durable material next to the team's other research
(see `/research-library`), and leave a pointer:
`orch mem add research-<slug> -d "<one line: what it is and what it is good for>"`.
Confidential inputs stay local.

## When another agent does the reading

Paste steps 1 to 3 into the task verbatim, and make the quality of the teaching an
acceptance item.
