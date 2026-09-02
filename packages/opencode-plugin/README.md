# @vaur94/agz-memory-plugin

English | [Türkçe](README.tr.md)

Optional OpenCode V2 adapter for `@vaur94/agz-memory@0.4.2`. It adds explicit
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
      "package": "@vaur94/agz-memory-plugin@0.4.2",
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

Installing this plugin also installs its exact core dependency, which contains
the `agz-memory` skill catalog. OpenCode does not discover skills inside npm
dependencies automatically; use the explicit versioned `skills` source in the
repository README. The plugin never edits the user's global `AGENTS.md`.

See the repository [README](https://github.com/ugur-murat-alt/agz-memory#readme)
for binding fields, mode behavior, recovery commands, and the security model.

## License

[MIT](https://github.com/ugur-murat-alt/agz-memory/blob/main/LICENSE)
