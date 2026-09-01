# Contributing To AGZ Memory

Contributions are welcome through GitHub issues and pull requests.

## Before You Start

1. Search existing issues and pull requests.
2. Open an issue before a large behavior, schema, dependency, or public contract
   change.
3. Never include production databases, session transcripts, credentials,
   private paths, or unredacted benchmark fixtures.
4. Keep the MCP surface project-scoped and preserve explicit confirmation for
   destructive operations.

## Local Verification

Use Bun `>=1.3.14`:

```sh
bun install --frozen-lockfile
bun run release:verify
bun test
bun run check
bun run build
npm pack --dry-run --json
```

Add focused tests for every behavior change. Migration changes must prove data
preservation and backup creation. Changes to one public README must update its
English or Turkish counterpart in the same pull request.

## Pull Requests

- Keep changes focused and explain user-visible behavior and risk.
- List exact verification commands and results.
- Call out schema, package, tool, configuration, security, or compatibility
  changes explicitly.
- Do not commit generated `dist/`, databases, coverage, package tarballs, or
  private benchmark fixtures.

By contributing, you agree that your contribution is licensed under the
project's [MIT License](LICENSE) and follows the
[Code of Conduct](CODE_OF_CONDUCT.md).
