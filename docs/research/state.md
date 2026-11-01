# UI state: what is kept, where, and how it survives a quit

Research of 2026-11-01 for M1 step 2, before Twigo kept anything on disk.
It read the source of VS Code, Zed, Freelens and Tauri at commits and tags, and the docs of k9s and Kubernetes.
The design it led to is in [ARCHITECTURE](../ARCHITECTURE.md) 4.8.

## What the editors teach

- **State has scopes, and sizes are not a workspace's.**
  VS Code's storage has an application, a profile and a workspace scope ([storage.ts at 1306698](https://github.com/microsoft/vscode/blob/1306698e328e5e531f5e632301d30020aa994eff/src/vs/platform/storage/common/storage.ts#L234-L256)).
  Its layout keeps the side bar's and the panel's sizes per profile, and whether they show per workspace ([layout.ts at 1306698](https://github.com/microsoft/vscode/blob/1306698e328e5e531f5e632301d30020aa994eff/src/vs/workbench/browser/layout.ts#L2879-L2907)), so a switch of workspace does not move the splits.
  The owner chose the same for Twigo's spaces: sizes are the app's, visibility and editors the space's.
- **Writes are batched, and a quit flushes.**
  VS Code flushes its storage every minute when idle and at once on shutdown ([storage.ts at 1306698](https://github.com/microsoft/vscode/blob/1306698e328e5e531f5e632301d30020aa994eff/src/vs/platform/storage/common/storage.ts#L336)).
- **A broken store must not stop the app.**
  VS Code copies its SQLite file to `.backup` on a clean close, puts the copy back when the file fails to open, and runs from memory when that fails too ([storage.ts at 1306698](https://github.com/microsoft/vscode/blob/1306698e328e5e531f5e632301d30020aa994eff/src/vs/base/parts/storage/node/storage.ts#L245-L314)).
- **Old state grows without bound unless something prunes it.**
  VS Code's per-workspace folders piled up to gigabytes ([microsoft/vscode#142972](https://github.com/microsoft/vscode/issues/142972)).
- **Schemas change, so readers must tolerate what an older version wrote.**
  Zed keeps an append-only list of SQL migrations and leaves deprecated columns in place "so users can downgrade Zed" ([persistence.rs at d94f32a](https://github.com/zed-industries/zed/blob/d94f32a1d948c273ab7d5a9fd344e3fd22f971eb/crates/workspace/src/persistence.rs#L541-L548)).
  Twigo has no users yet, so it keeps a version number and reads each value field by field, falling back to defaults, instead of migrating.

## What the Kubernetes clients teach

- **Key state by what stays stable.**
  Freelens names a cluster `md5(file path + ":" + context name)` ([compute-diff.injectable.ts at 27429de](https://github.com/freelensapp/freelens/blob/27429deda3fb8056bf411aaeb193afc371827315/packages/core/src/main/catalog-sources/kubeconfig-sync/compute-diff.injectable.ts#L85)), so a kubeconfig that moves, or a `KUBECONFIG` that lists it under another path, becomes a new cluster without its settings.
  After kubectl's merge a context's name is unique and does not depend on its file, so Twigo keys a one-context space by the context's name.
- **Context names are not file names.**
  k9s keeps a context's state in `clusters/<cluster>/<context>/config.yaml` under its data directory ([config docs](https://k9scli.io/topics/config/)).
  EKS contexts are ARNs with `:` and `/`, so Twigo keeps names as keys inside one file.

## What Tauri does on macOS

- **⌘Q never asks the app.**
  tao's app delegate implements `applicationWillTerminate:` and not `applicationShouldTerminate:` ([app_delegate.rs at tao-v0.37.2](https://github.com/tauri-apps/tao/blob/tao-v0.37.2/src/platform_impl/macos/app_delegate.rs#L62)).
  The predefined Quit item, ⌘Q, the Dock's Quit and logout reach the app as `terminate:`, so no `RunEvent::ExitRequested` comes that the app could hold ([tauri-apps/tauri#9198](https://github.com/tauri-apps/tauri/issues/9198), open on 2026-11-01).
  A plan that held the exit until the webview flushed would lose those quits.
- **`RunEvent::Exit` still comes, synchronously.**
  `applicationWillTerminate:` calls `AppState::exit`, which sends `LoopDestroyed` ([app_state.rs at tao-v0.37.2](https://github.com/tauri-apps/tao/blob/tao-v0.37.2/src/platform_impl/macos/app_state.rs#L271-L273)), and tauri-runtime-wry turns that into `RunEvent::Exit` ([lib.rs at tauri-runtime-wry-v2.12.3](https://github.com/tauri-apps/tauri/blob/tauri-runtime-wry-v2.12.3/crates/tauri-runtime-wry/src/lib.rs#L4131-L4132)).
  tauri-plugin-window-state saves there ([lib.rs at window-state-v2.5.0](https://github.com/tauri-apps/plugins-workspace/blob/window-state-v2.5.0/plugins/window-state/src/lib.rs#L529)).
  Rust can write what it holds; it cannot ask the webview for anything any more.
  So the webview sends each change at once, and Rust batches the disk writes and writes the rest on `Exit`.

## kubectl's sources

- `KUBECONFIG` lists files to merge; without it kubectl reads `$HOME/.kube/config` alone; the first file to set a value or map key wins, and paths inside a file are relative to it ([Kubernetes docs](https://kubernetes.io/docs/concepts/configuration/organize-cluster-access-kubeconfig/#merging-kubeconfig-files)).
- client-go skips a listed file that does not exist ([loader.go at v0.34.0](https://github.com/kubernetes/client-go/blob/v0.34.0/tools/clientcmd/loader.go#L227-L232)).
- kube-client 4.2.0 implements the merge rules and resolves relative paths ([file_config.rs at 4.2.0](https://github.com/kube-rs/kube/blob/4.2.0/kube-client/src/config/file_config.rs#L441-L554)); Twigo reads and merges the files one at a time with it, so a file that fails to parse or merge costs only its own contexts.
