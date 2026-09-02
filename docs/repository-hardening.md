# Repository Hardening Checklist

Repository: `ugur-murat-alt/agz-memory`

Verified on: 2026-09-02

The checks below are GitHub repository controls and cannot be enforced by the package source alone. The verification performed for 0.5.0 found that `main` had no classic branch protection, no repository ruleset, no deployment environment, and Actions allowed all actions without repository-level SHA-pinning enforcement. Workflow actions in this repository are nevertheless pinned by commit SHA.

## Required `main` Ruleset

GitHub screen: **Settings > Rules > Rulesets > New branch ruleset**

Target: default branch, `main`

Enable:

- Restrict deletions.
- Block force pushes.
- Require a pull request before merging.
- Require at least one approval.
- Dismiss stale approvals when new commits are pushed.
- Require review from Code Owners when a `CODEOWNERS` file is introduced.
- Require conversation resolution.
- Require status checks to pass.
- Require branches to be up to date before merging.
- Require signed commits.
- Require linear history.

Required status checks should include every 0.5.0 CI gate rather than only the aggregate job name:

- Linux minimum Bun type/test/build/package gate.
- Linux current Bun type/test/build/package gate.
- macOS current Bun gate.
- Windows current Bun gate.
- Property/security tests.
- Multiprocess stress tests.
- Restore fault tests.
- Benchmark gate.
- CodeQL.
- Dependency review for pull requests.

Do not grant bypass permission to ordinary contributors. Keep the repository administrator bypass limited to documented emergency recovery.

## Signed Commits and Tags

GitHub screen: **Settings > Rules > Rulesets > Require signed commits**

Local verification:

```sh
git log --show-signature -1
git tag -v v0.5.0
```

Create the release tag from the reviewed merge commit. Do not move an existing release tag.

## Release Environment

GitHub screen: **Settings > Environments > New environment**

Name: `npm-release`

Configure:

- Required reviewer.
- Deployment branch restricted to protected `main` and version tags.
- No long-lived npm token when trusted publishing is available.

The publish workflow should use npm trusted publishing with OpenID Connect and provenance:

```yaml
permissions:
  contents: read
  id-token: write
```

```sh
npm publish --provenance --access public
```

Verify the published package exposes provenance and that npm `gitHead`, Git tag SHA, GitHub Release SHA, and reviewed merge commit all match.

## Actions Policy

GitHub screen: **Settings > Actions > General > Actions permissions**

Prefer **Allow enterprise actions and select non-enterprise actions** if the account plan supports it. Require full-length commit SHA pinning for third-party actions. Keep workflow token permissions read-only by default and grant narrower write permissions per job.

Repository verification commands:

```sh
gh api repos/ugur-murat-alt/agz-memory/branches/main/protection
gh api repos/ugur-murat-alt/agz-memory/rulesets
gh api repos/ugur-murat-alt/agz-memory/actions/permissions
gh api repos/ugur-murat-alt/agz-memory/environments
```

Expected release condition:

- The protection endpoint or active ruleset reports required pull requests, reviews, signed commits, required status checks, no force push, and no deletion.
- At least one protected `npm-release` environment exists.
- Actions policy and workflow files both enforce immutable action versions.

## npm Package Policy

- Enable npm two-factor authentication for authorization and writes.
- Enable trusted publishing for both `@vaur94/agz-memory` and `@vaur94/agz-memory-plugin`.
- Require provenance on both packages.
- Deprecate, do not overwrite, a compromised version.
- Test the packed artifacts together in a clean directory before publish.
- Verify registry integrity, package contents, imports, exact nine-tool MCP catalog, and inert plugin defaults after publish.

## Release Evidence

Attach or link:

- Ruleset export or settings screenshots.
- Required-check list and successful run URLs.
- Signed merge commit and tag verification.
- Release environment protection.
- npm provenance statement for both packages.
- Pack SHA-256 values and clean-install smoke output.

Repository setting changes remain a release blocker until independently verified. Source documentation does not itself close AGZ-064.
