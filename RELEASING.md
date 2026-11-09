# Releasing Outline

Releases are built on GitHub's machines by the **Release** workflow
(`.github/workflows/release.yml`) and published as a GitHub release. Installed
copies of Outline find new releases through the update manifest, `latest.json`,
that each release carries (see `src-tauri/src/updater.rs`).

## The updater signing key

Outline only installs updates signed with the key whose public half is built into
it (`plugins.updater.pubkey` in `src-tauri/tauri.conf.json`). The private key is
at `~/.tauri/outline-updater.key` on the Mac it was made on (no password). It is
Outline's own, separate from Magnolia's.

- **Back it up somewhere safe** (a password manager). If it's lost, installed
  copies can never verify another update, and everyone has to reinstall by hand.
- **Add it to GitHub** as the repository secret `TAURI_SIGNING_PRIVATE_KEY`, once:
  ```sh
  gh secret set TAURI_SIGNING_PRIVATE_KEY --repo caledavis/Outline < ~/.tauri/outline-updater.key
  ```
  The workflow stops at once if the secret is missing.
- To sign a local build too (to rehearse an update, below), export it first:
  ```sh
  export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/outline-updater.key)"
  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
  ```
  Without it, `npm run tauri build` stops with "no private key" after building.

## Cutting a release

1. **Bump the version** in `package.json`, `src-tauri/tauri.conf.json` and
   `src-tauri/Cargo.toml`, build once so `Cargo.lock` follows, and commit.
   The updater only offers a version higher than the installed one.
2. **Tag and push:** `git tag vX.Y.Z && git push origin vX.Y.Z`. The workflow
   creates a draft release and uploads each platform's installers and signed
   update payloads to it.
3. **Write the release notes** in the draft's description on GitHub. The update
   window shows them (as Markdown), so keep them for the people using Outline.
4. **Write the update manifest** once all four builds have uploaded:
   ```sh
   npm run release:finish
   ```
   It downloads the draft's signatures, writes `latest.json` with the draft's
   notes and uploads it. Run it again if you change the notes.
5. **Publish** the draft. Until then, installed copies can't see it.

## What gets uploaded

| File | Purpose |
|---|---|
| `Outline-mac-arm64.dmg` / `-x64.dmg` | Installers |
| `Outline-mac-arm64.app.tar.gz` / `-x64…` (+ `.sig`) | Mac update payloads |
| `Outline-win-x64-setup.exe` / `Outline-win-x64.msi` (+ `.sig`) | Installers, and the update payloads for each kind of install |
| `Outline-win-portable-x64.exe` | The portable app (it can't update itself: its update window opens the download page) |
| `Outline-linux-x86_64.AppImage` / `-amd64.deb` / `-x86_64.rpm` (+ `.sig`) | Linux packages, and the update payloads for each |
| `latest.json` | The update manifest |

`latest.json` lists one payload per kind of install (`darwin-aarch64`,
`windows-x86_64-msi`, `linux-x86_64-deb`…), so each copy updates with the
installer it came from. A deb or rpm install asks for a password to install.

## Trying the update window

Development builds don't check for updates. Run one with
`OUTLINE_FAKE_UPDATE=1 npm run tauri dev` to walk the window through a pretend
update (`=uptodate` and `=error` show those outcomes instead).

## Rehearsing an update before release

To try a real download and install without publishing anything, serve a
manifest from your own computer:

1. With the signing key exported, build the current version and install it
   (open the `.dmg` under `src-tauri/target/release/bundle/dmg/`).
2. Set a higher, throwaway version (don't commit it) and build again.
3. Gather the new build's payload and signature, write a manifest for them and
   serve it:
   ```sh
   mkdir -p ~/update-test
   cp src-tauri/target/release/bundle/macos/Outline.app.tar.gz ~/update-test/Outline-mac-arm64.app.tar.gz
   cp src-tauri/target/release/bundle/macos/Outline.app.tar.gz.sig ~/update-test/Outline-mac-arm64.app.tar.gz.sig
   echo "Test notes — **Markdown** works." > ~/update-test/notes.md
   node scripts/release.mjs manifests X.Y.Z ~/update-test ~/update-test/notes.md --base-url http://localhost:8000/
   python3 -m http.server 8000 -d ~/update-test
   ```
4. Open the installed Outline pointed at it:
   ```sh
   open -n --env OUTLINE_UPDATE_ENDPOINT=http://localhost:8000/latest.json /Applications/Outline.app
   ```
   `OUTLINE_UPDATE_ENDPOINT` makes a release build check that manifest instead
   of GitHub's. Signatures are still checked against the built-in key.
5. Check the prompt and its notes, Remind Me Later, Skip This Version (Check for
   Updates… still offers it), Install Update → Cancel, then Install and
   Relaunch, and that About Outline shows the new version.
