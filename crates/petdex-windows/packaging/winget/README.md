# WinGet Packaging and Windows Code Signing

This directory contains the WinGet manifest set for `CrafterStation.Petdex` (`Petdex-Setup.exe`), a per-user NSIS installer with zero external runtime dependencies.

## Submitting to `microsoft/winget-pkgs`

1. Publish a GitHub Release (for example `desktop-v0.1.0`) with `Petdex-Setup.exe` attached.
2. Compute the SHA-256 hash of `Petdex-Setup.exe`:
   ```powershell
   (Get-FileHash .\Petdex-Setup.exe -Algorithm SHA256).Hash
   ```
3. Update `PackageVersion`, `InstallerUrl`, and `InstallerSha256` across:
   - `CrafterStation.Petdex.yaml`
   - `CrafterStation.Petdex.installer.yaml`
   - `CrafterStation.Petdex.locale.en-US.yaml`
4. Validate the manifests on Windows:
   ```powershell
   winget validate --manifest crates\petdex-windows\packaging\winget
   ```
5. Submit a pull request to `microsoft/winget-pkgs` placing these three files under:
   ```text
   manifests/c/CrafterStation/Petdex/<version>/
   ```
   Alternatively, use `wingetcreate submit crates\petdex-windows\packaging\winget`.

## Setting Up Free OSS Code Signing with SignPath.io

SignPath.io provides free Authenticode code signing certificates for open-source projects, eliminating Windows SmartScreen warnings for `Petdex-Setup.exe`.

1. Apply for the SignPath Foundation open-source program at <https://signpath.org/projects/>.
2. Once approved, create a project (default slug: `petdex`) and a signing policy (default slug: `release-signing`) in the SignPath dashboard, bound to this GitHub repository and `.github/workflows/desktop-rust-ci.yml`.
3. Add the following GitHub Actions repository secrets:
   - `SIGNPATH_API_TOKEN` (required to enable the CI signing step)
   - `SIGNPATH_ORGANIZATION_ID` (required when `SIGNPATH_API_TOKEN` is set)
   - `SIGNPATH_PROJECT_SLUG` (optional, defaults to `petdex`)
   - `SIGNPATH_SIGNING_POLICY_SLUG` (optional, defaults to `release-signing`)
4. When `SIGNPATH_API_TOKEN` is absent, `.github/workflows/desktop-rust-ci.yml` skips signing and produces unsigned CI artifacts without failing.
