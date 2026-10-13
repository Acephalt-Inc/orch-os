# Knowledge demo

The knowledge demo looks up one of two fixed questions in a synthetic corpus that is compiled into the program, and prints the stored passage with its citation. No service is connected.

## Running it

Run the packaged command:

```sh
orch knowledge query --connection demo --question-id invoice-terms
orch knowledge query --connection demo --question-id approval-threshold
```

`orch knowledge` is a command of the packaged `orch` program.

`--help` prints the usage with the line `Synthetic demo; no service connected.` and exits 0.

## Arguments

`orch knowledge` accepts the `query` command with `--connection demo` and `--question-id invoice-terms` or `--question-id approval-threshold`, each given once. The `--option=value` spelling is accepted as well.

Any other command, option or value, a repeated or missing option, or more than 512 UTF-8 bytes of arguments (one separator byte is counted between two arguments) is refused with exit 2, before the corpus is consulted. The refusal is the fixed line `{"status":"ERROR","code":"USAGE"}` on stderr. Nothing that was typed is printed back.

`-h` or `--help` in an option position prints the usage and exits 0 as soon as it is read: arguments after it are not examined, and a stray word before it is not reported. An unknown command, an unknown option or an invalid value that comes before it is refused as above. The length limit and the repeated-option check apply whether or not a help flag is present.

## Output

On success the command prints one JSON line on stdout and exits 0:

```json
{"status":"OK","mode":"synthetic","question_id":"invoice-terms","answer":"Invoices are due in 45 days.","citation":{"document_id":"invoice-policy","revision":2,"fragment":"terms","sha256":"8510033480b28305f4fa09b137ad6222e702a2fcb15ff849d705879029cb2b72","retrieved_at":"2026-10-13T12:00:00.000Z","checked_at":"2026-10-13T12:00:00.000Z"}}
```

`answer` is the stored passage, quoted as it is. No answer is generated, and text inside a passage that reads like an instruction is printed like any other text. `sha256` is the SHA-256 of the passage text. `retrieved_at` and `checked_at` are the program's own clock readings, taken after the lookup reply and after the recheck reply.

The citation is checked again before anything is printed. If the document was revoked, replaced or removed in between, no passage is printed.

The corpus also holds an older revision of the invoice text, a revoked document and a document of another reader. None of them is printed.

On failure the command prints `{"status":"ERROR","code":"<code>"}` on stderr and nothing on stdout, and exits 1:

| Code | Meaning |
|---|---|
| `UNAVAILABLE` | No passage was found, the lookup or the recheck failed, or the clock gave no usable time. |
| `DENIED` | A reply was for another principal or collection. |
| `STALE` | The citation changed or was revoked before output. |
| `INVALID_RESPONSE` | A reply was malformed or too large, or held an unknown field, a control character or a digest that does not match its text. |
| `TIMEOUT` | The query did not finish within 5 seconds. |

The command line has no way to make the built-in corpus fail, so from `orch knowledge` only `USAGE` can be produced on purpose. The other codes are exercised by tests that inject a transport.

## Limits

- A reply from the corpus is at most 8 KiB and holds at most one passage of at most 1 KiB. The success line is at most 8 KiB.
- One query has a 5-second deadline and is not retried. After the deadline no further lookup or recheck starts and nothing more is printed.
- The result does not depend on the home directory, the working directory, environment variables or stored notes. The command opens no file other than its own program files, writes none, opens no network connection and starts no process.
- The demo shows only this synthetic contract. It does not show a live protocol, authentication, service authorization, real citation freshness, host isolation, or that any answer is true.
