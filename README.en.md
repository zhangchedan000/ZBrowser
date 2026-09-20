# ZBrowser

ZBrowser is an open-source, local-first multi-profile fingerprint browser for Windows. The project started from the MIT-licensed Prism Browser Community codebase and is being developed independently.

## V1 focus

- Isolated browser profiles: cookies, cache, LocalStorage, extensions, and profile data.
- Configurable network identity: direct, HTTP, HTTPS, SOCKS5, proxy testing, WebRTC leak protection, language, timezone, and geolocation consistency.
- Configurable browser fingerprint: OS, browser brand/version, hardware templates, CPU, screen, GPU, Canvas, WebGL, Audio, fonts, DOMRect, WebGPU, and stable per-profile seed.
- Environment verification: local consistency checks plus BrowserLeaks, Pixelscan, IPhey, and CreepJS in the same profile.
- Environment-check history with drift detection for IP, timezone, language, kernel, hardware template, and seed.

## Open-source Fingerprint Chromium

The Browser Kernel panel can query and install public releases from [adryfish/fingerprint-chromium](https://github.com/adryfish/fingerprint-chromium).

ZBrowser:

- accepts only trusted GitHub release URLs from that repository;
- requires a GitHub-provided SHA-256 digest;
- supports resumable downloads;
- verifies the downloaded archive before installation;
- creates a local integrity manifest for the installed kernel;
- supports verify, switch, rollback, remove, and local-build import.

Chromium `144.0.7559.132` is currently marked as the recommended compatibility baseline. Newer open-source builds are shown as experimental until their fingerprint behavior is validated against ZBrowser's templates.

ZBrowser does **not** crack or bypass Prism Pro licensing and does not use Prism Pro kernel binaries.

## Windows builds

GitHub Actions builds MSI, Portable, and ZIP artifacts from the `dev` branch using Node.js 22.

```text
npm ci
npm run typecheck
npm run dist:win
```

The app package itself does not commit large Chromium binaries into this source repository. Compatible open-source kernels can be installed from inside the app.

## Licensing

ZBrowser additions are released under MIT while preserving the original upstream MIT notice. Third-party notices, including the BSD 3-Clause license used by the current fingerprint Chromium source, are documented in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Do not commit proxy passwords, cookies, tokens, API keys, or account credentials to the repository.
