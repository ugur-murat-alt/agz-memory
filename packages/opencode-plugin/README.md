# @vaur94/agz-memory-plugin

English | [Türkçe](README.tr.md)

Optional OpenCode V2 adapter for `@vaur94/agz-memory@0.4.1`. It adds explicit
project binding, redacted capture, bounded retrieval, and staged context
injection to OpenCode `0.0.0-beta-18743`.

The package is safe when merely installed. Defaults are `mode: "off"`, no
bindings, capture disabled, automatic project creation forbidden, semantic
backend `none`, at most eight cards, at most 4,800 characters, and a 300 ms
retrieval deadline.

```jsonc
{
  "plugins": [
    {
      "package": "@vaur94/agz-memory-plugin@0.4.1",
      "options": {
        "mode": "off",
        "autoCreateProjects": false,
        "bindings": [],
        "capture": {
          "enabled": false,
          "allowedKinds": ["preference", "decision"],
          "minConfidence": 0.95
        },
        "retrieval": {
          "semanticBackend": "none",
          "timeoutMs": 300,
          "maxCards": 8,
          "maxCharacters": 4800
        }
      }
    }
  ]
}
```

Keep `off` until the MCP server and database are healthy. Add one explicit
binding, then progress through `shadow-capture`, `shadow-retrieval`, `inject`,
and `auto-write` only after reviewing each stage. A version mismatch, missing or
conflicting binding, database error, or unsupported semantic backend disables
the plugin rather than guessing.

See the repository [README](https://github.com/ugur-murat-alt/agz-memory#readme)
for binding fields, mode behavior, recovery commands, and the security model.

## License

[MIT](https://github.com/ugur-murat-alt/agz-memory/blob/main/LICENSE)
