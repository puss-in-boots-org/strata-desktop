# Strata for Windows

**The desktop app for [Strata](https://github.com/balong2000/strata): see
exactly what is using your disk, and where, by app.** It has a quiet
Obsidian-style interface: an icon ribbon, a filterable list, a note-like
page for each app, a graph of where your apps keep their files, and a quick
switcher for everything.

It's a 9 MB Tauri 2 app on the WebView2 engine that every Windows 10 and 11
PC already has. Strata only reads folder listings and the registry:
nothing leaves your PC, and it never deletes anything.

## What it offers

### Apps, whole
- Every installed app with its **real total**: the install folder plus its
  `AppData`, `ProgramData`, `My Games`, shader caches and other folders,
  wherever they are. A full scan takes about 2 seconds.
- Each app's page shows its size, how much is **reclaimable** (cache, logs,
  crash dumps, temp), a colour bar of **what kind of data** it is, and
  **where it lives**, one row per folder. Each row says how sure the match
  is and why.
- One click opens any folder in Explorer.

### The rest of the disk
- **Overview:** how full each drive is, the biggest apps, and which places
  (Program Files, AppData\Local...) hold the most.
- **Unclaimed:** folders no installed app claims, with **possible
  leftovers** from apps you've uninstalled flagged.
- **Developer clutter:** Rust `target` folders, `node_modules`, venvs, build
  output, package caches, SDKs and WSL/Docker disks. Each shows the command
  that cleans it, with a copy button.
- **Hidden Windows space:** hibernation and page files, WinSxS, update
  caches, shader caches, the Recycle Bin and more. Each is marked safe,
  use-the-Windows-tool, or keep, with how to shrink it.

### Obsidian-style, but simpler
- **Graph view:** apps linked to the places their files live. Node size
  is disk use, and hovering highlights a node's neighbours. Drag, zoom, and
  click an app to open it.
- **Quick switcher** (`Ctrl+P`): fuzzy search across apps, folders, dev
  items, Windows items and commands.
- **Drop any file or folder** on the window to see which app it belongs to.
- Snappy and animated: the selection slides, bars grow, numbers count up,
  and pages fade in. All of it stays under a quarter of a second, and it
  turns off when Windows asks for reduced motion.
- Dark and light themes, a resizable sidebar, and keyboard control
  throughout.

## Keyboard

| Keys | Does |
|---|---|
| `Ctrl+P` / `Ctrl+K` | Quick switcher |
| `Ctrl+1` ... `Ctrl+5` | Apps, Unclaimed, Developer clutter, Windows, Graph |
| `↑` `↓` | Move through the list |
| `Ctrl+F` | Filter the list |
| `Ctrl+R` | Rescan |
| `Esc` | Close / back to the overview |

## Building

You need Rust (stable, MSVC) and Visual Studio 2022's C++ build tools with
the Windows 10 SDK 10.0.19041. Newer toolsets fail on a Tauri dependency,
and `scripts\cargo-msvc.cmd` picks the right one for you:

```text
scripts\cargo-msvc.cmd build --release
target\release\strata-desktop.exe
```

`strata-core` comes from the private `balong2000/strata` repo, so building
needs read access to it (cargo fetches it with your git sign-in, see
`.cargo/config.toml`). The front end in `ui/` is embedded in the exe: rebuild
after changing it.

Layout:
- `src/main.rs`: the Tauri commands (`inventory`, `dev_items`,
  `system_items`, `list_drives`, `why`, `reveal`).
- `ui/`: plain HTML, CSS and JavaScript, no build step.

## License

[GPL-3.0-only](LICENSE).
