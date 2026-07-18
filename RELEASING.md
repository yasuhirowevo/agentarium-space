# Releasing Agentarium Space

The default macOS release uses free ad-hoc code signing and does not require
the Apple Developer Program, a Developer ID certificate, or notarization.
Homebrew installs the finished applications from a separate tap; it does not
build the Node.js source on a user's machine.

Ad-hoc signing satisfies the executable-signing requirement on Apple silicon,
but it does not identify the publisher or bypass Gatekeeper. Developer ID
signing and notarization remain an optional enhancement.

## One-time free setup

1. Create the public repository `yasuhirowevo/homebrew-tap` with a `main`
   branch and a top-level `Casks/` directory.
2. Create a fine-grained GitHub token limited to that tap repository with
   read/write access to repository contents and pull requests.
3. Configure only this required Actions secret in
   `yasuhirowevo/agentarium-space`:

| Secret | Value |
|---|---|
| `HOMEBREW_TAP_TOKEN` | Fine-grained token for the tap repository |

No Apple account, certificate, Apple secret, or paid membership is required
for this default release path.

## Optional Developer ID signing and notarization

To publish a release that opens without the usual unidentified-developer
warning, configure all of the following Actions secrets. Configure either the
complete set or none of them; the workflow rejects partial configuration.

| Optional secret | Value |
|---|---|
| `MAC_CSC_LINK` | Base64-encoded Developer ID Application PKCS #12 certificate |
| `MAC_CSC_KEY_PASSWORD` | Password for the PKCS #12 certificate |
| `APPLE_API_KEY_BASE64` | Base64-encoded contents of the notarization `.p8` file |
| `APPLE_API_KEY_ID` | App Store Connect API key ID |
| `APPLE_API_ISSUER` | App Store Connect API issuer ID |

The workflow maps the first two values to electron-builder's `CSC_LINK` and
`CSC_KEY_PASSWORD` variables and decodes the API key to a temporary file.
This optional path requires access to Apple's Developer ID and notarization
services, but Homebrew support itself does not.

See the electron-builder documentation for [macOS code signing][signing] and
[notarization][notarization].

## Local verification

The default commands create an ad-hoc-signed application without any paid
certificate:

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm run package:mac --arm64
codesign --verify --deep --strict "dist/mac-arm64/Agentarium Space.app"
pnpm run smoke:package "dist/mac-arm64/Agentarium Space.app" arm64
pnpm run dist:mac --arm64
```

For an Intel package, use `--x64`; electron-builder writes the unpacked app to
`dist/mac/Agentarium Space.app`. The packaged smoke test uses an empty temporary
home directory and does not read the developer's Claude Code or Codex CLI
session logs.

When the optional Developer ID and notarization credentials are available,
set `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY` (the `.p8` file path),
`APPLE_API_KEY_ID`, and `APPLE_API_ISSUER`, then run:

```bash
pnpm run dist:mac:signed --arm64
```

The command rejects missing or partial credentials instead of silently
publishing a signed but unnotarized ZIP.

On Windows with PowerShell 7, verify the x64 unpacked application and portable
EXE with:

```powershell
pnpm install --frozen-lockfile
pnpm test
pnpm run scan
pnpm run package:win
pnpm run smoke:package:win "dist/win-unpacked/Agentarium Space.exe" x64
pnpm run dist:win
$version = node -p "require('./package.json').version"
pnpm run smoke:portable:win "dist/agentarium-space-$version-windows-x64.exe"
```

## Publish a release

1. Update `package.json` to the release version and merge that change to
   `main`.
2. Tag that exact commit as `v<version>` and push the tag.
3. Watch the **Release** workflow. It will:
   - reject a tag that does not match `package.json` or is not reachable from
     `main`;
   - require the free `HOMEBREW_TAP_TOKEN`, then run tests and scan;
   - build and ad-hoc-sign each architecture on a native macOS runner by
     default;
   - use Developer ID signing, notarization, and staple only when all optional
     Apple secrets are configured;
   - build the Windows x64 portable EXE on a native Windows runner;
   - verify the selected signature mode, architecture, minimum macOS version,
     loopback-only network policy, privacy-related `Info.plist` keys, ZIP
     layout, and actual packaged-app startup;
   - verify the unpacked Windows application's local server and Electron
     window, then verify that the final portable EXE keeps its loopback server
     running;
   - place both ZIPs and the Windows EXE in a Draft GitHub Release and publish
     it only after all three artifacts have passed;
   - render the architecture-specific Cask, audit and fetch both downloads,
     and open a Draft PR in `yasuhirowevo/homebrew-tap`.
4. Review the Cask version, URLs, and both SHA-256 values, then merge the tap
   PR. Do not push Cask updates directly to the tap's `main` branch.

The public assets are:

```text
agentarium-space-<version>-macos-arm64.zip
agentarium-space-<version>-macos-x64.zip
agentarium-space-<version>-windows-x64.exe
```

Each ZIP must contain only `Agentarium Space.app` at its root. If any release
check fails, fix the cause and publish a new patch version; do not replace a
published asset behind an existing checksum.

After the first tap PR is merged, users can install with:

```bash
brew install --cask yasuhirowevo/tap/agentarium-space
```

For an ad-hoc-signed release, `brew install` succeeds but Gatekeeper may block
the first launch. After verifying the release source, users can try opening the
app once and then use **System Settings > Privacy & Security > Open Anyway**, as
described by [Apple][gatekeeper]. The Cask does not disable or remove quarantine.

[gatekeeper]: https://support.apple.com/102445
[signing]: https://www.electron.build/docs/features/code-signing/code-signing-mac/
[notarization]: https://www.electron.build/docs/notarization/
