# Local vector transport preview

Run `orch vectors connect-local --preview --url http://127.0.0.1:18080` against a local TEI 1.9.4 server.
The URL must be exactly `http://127.0.0.1:PORT` or `http://[::1]:PORT`, with an optional final slash
and a decimal port from 1 to 65535.

The command sends one fixed `orch probe` input with `truncate:false` after checking `/info`.
A valid reply prints `vectors connect-local: PROBE_OK dimension=N`.
Invalid arguments print `vectors connect-local: USAGE`; an unsafe URL or failed probe prints
`vectors connect-local: REFUSED`. The output contains no server text.

`PROBE_OK` reports one transport result and the returned vector length. It does not establish model identity,
token limits, no truncation for future text, semantic quality, privacy, offline behavior, or a standing connection.
The server may log or forward the probe. A strict identity adapter is required before any vector can be saved
or used for semantic recall.
