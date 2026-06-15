# Releasing

Maintainer guide for cutting a Twigo release. Versioning and the changelog are
driven by the git tag, so a release is mostly: update the changelog, tag, review.

## One-time setup (repo secrets)

GitHub repo -> Settings -> Secrets and variables -> Actions:

- `TAURI_SIGNING_PRIVATE_KEY` (+ `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` if the key
  has one) - required; signs the auto-update artifacts.
- macOS signing/notarization (optional; without them the macOS build is
  unsigned): `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`,
  `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`.

## Cut a release

Commits since the last release should use Conventional Commit messages (the PR
title becomes the squash-merge subject), so the changelog groups them correctly.

```bash
# 1. From an up-to-date main, prepend the new version's changelog entries
#    (keeps the curated earlier entries intact):
git cliff --unreleased --tag v0.1.1 --prepend CHANGELOG.md

# 2. Commit the changelog:
git commit -am "chore(release): v0.1.1 changelog"

# 3. Tag and push - this triggers the release workflow:
git tag v0.1.1 && git push origin v0.1.1
```

On the tag push, `.github/workflows/release.yml`:

- stamps the version from the tag into every manifest (`v0.1.1` -> `0.1.1`);
- builds macOS (Apple silicon + Intel) and Linux bundles;
- generates that tag's notes (`git cliff --latest`) into the release body;
- creates a **draft** GitHub Release with the artifacts + `latest.json`.

Then: review the draft (artifacts attached, notes read well) and **Publish**.

## Pre-releases

Tag with a pre-release suffix and it ships as a GitHub pre-release
automatically: `git tag v0.1.0-beta1`.

## Notes

- **Versions are never edited by hand** - the tag is the source of truth; the
  workflow stamps `package.json`, `tauri.conf.json`, and `Cargo.toml`.
- **First release**: `git cliff --latest` has no previous tag, so the auto body
  covers all history. The draft is editable - paste the curated `CHANGELOG.md`
  entry into the body before publishing.
- The local `git cliff` step needs git-cliff installed (`brew install git-cliff`).
