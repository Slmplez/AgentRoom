# Vendored hcom core

- Upstream: https://github.com/aannoo/hcom
- Tag: `v0.7.31`
- Commit: `de33e31a0cdbba4c5863f7cc050d8b79aa50bcdf`
- License: MIT; original copyright and license retained in `LICENSE`.
- Local build toolchain: Rust 1.92.0, Windows x64 MSVC. The upstream development
  toolchain pin is not imported. `Cargo.lock` includes the N-API dependencies.

Agent Room changes:

1. Move the original crate entry point into `lib.rs`, export `cli_main`, retain
   a small compatibility CLI entry point. Add the `native` feature and N-API build.
2. Add `embedded.rs`: typed snapshot, send, launch preparation, change notification
   and per-session terminal I/O. Each PTY runs in its own Electron utility process.
3. Capture a launch plan after upstream hook/preprocessing/identity setup, before
   the external terminal or script launcher. Electron starts the prepared CLI.
4. Replace Windows console input/output/resize with channels in native builds.
   Return the session exit through IPC; never terminate the host from `run_pty`.
5. Select the application-owned hook helper explicitly. The CLI is only a
   compatibility entry point for hooks and agent commands, not a resident runtime.
6. App-owned per-run hook preparation skips global legacy-hook deletion and
   persistent permission-file updates. Existing external hcom data is not opened.
7. Block standalone tool launch/PTY/new-terminal/resume entry points in
   application sessions; session creation belongs to the application supervisor.

Upstream modules not used by the desktop UI (TUI, relay, other integrations) are
retained to minimize divergence; their availability in the source is not a claim
that the native desktop exposes or has validated these features. Cross-platform
native terminal support is currently Windows-only.
