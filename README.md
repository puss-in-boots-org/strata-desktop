# Strata for Windows

**The desktop app for [Strata](https://github.com/balong2000/strata): see
exactly what is using your disk, and where, by app.** Every installed app
and game is added up from all the places it keeps files, and every other
byte on the drive is accounted for too.

It's a 9 MB Tauri 2 app on the WebView2 engine that every Windows 10 and 11
PC already has. **Download:** the [latest release](https://github.com/puss-in-boots-org/strata-desktop/releases/latest)
has a 2 MB installer and a portable exe. They aren't code-signed yet, so
Windows SmartScreen will ask before running them. Strata only reads folder
listings and the registry: nothing leaves your PC, and it never deletes
anything.

## What it offers

### The whole drive at a glance
- **Overview:** a zoomable **sunburst** of the drive: games, apps, your
  files, Windows, leftovers, what needs admin to read, and free space. Click
  a ring to zoom in (animated), click the centre to zoom out; the legend
  and breadcrumbs follow.
- Cards for what you can win back: reclaimable app caches and logs, likely
  leftovers, the Recycle Bin.

### Games and apps from every source
- Steam, Epic, **Xbox app / Game Pass** (DLC stubs folded into their game),
  Microsoft Store apps by their real names, **Minecraft** launcher instances
  (Modrinth, CurseForge, Prism) and everything with an uninstall entry.
- **Games** is a grid of cards with Steam covers, Xbox logos and real app
  icons; **Apps** is a sortable list with icons, sizes and what's
  reclaimable.
- Each game or app has its own page: artwork, its real total, a colour bar
  of **what kind of data** it is (program, data, cache, logs, crash dumps,
  temp), and **every place it lives**, with how sure the match is and why.

### The rest of the disk
- **Your files** and **Windows & system**: folder explorers you can drill
  into, from the drive's top folders down.
- **Leftovers:** folders no installed app claims, with likely leftovers
  (untouched for six months, or game folders a launcher no longer has
  installed) flagged.
- **Developer:** Rust `target` folders, `node_modules`, venvs, package
  caches, SDKs and WSL/Docker disks, each with the command that cleans it.
- **Hidden Windows space:** hibernation and page files, WinSxS, update and
  shader caches and more, each marked safe, use-the-Windows-tool, or keep.

### Quick to get around
- **Search** (`Ctrl+K`) across games, apps, leftovers, pages and commands.
- **Drop any file or folder** on the window to see what it belongs to.
- Dark and light themes, smooth but short animations (off when Windows asks
  for reduced motion), and keyboard control throughout.

## Keyboard

| Keys | Does |
|---|---|
| `Ctrl+K` / `Ctrl+P` | Search |
| `Ctrl+1` ... `Ctrl+7` | Overview, Games, Apps, Your files, Windows & system, Leftovers, Developer |
| `Ctrl+R` | Rescan |
| `Esc` / `Backspace` | Back: out of an app page, the sunburst or a folder |
## Building

You need Rust (stable, MSVC) and Visual Studio 2022's C++ build tools with
the Windows 10 SDK 10.0.19041. Newer toolsets fail on a Tauri dependency,
and `scripts\cargo-msvc.cmd` picks the right one for you:

```text
scripts\cargo-msvc.cmd build --release
target\release\strata-desktop.exe
```

The installer (`target\release\bundle\nsis\Strata_<version>_x64-setup.exe`)
also needs Node.js, for the Tauri CLI:

```text
scripts\build-installer.cmd
```

`strata-core` comes from the private `balong2000/strata` repo, so building
needs read access to it (cargo fetches it with your git sign-in, see
`.cargo/config.toml`). The front end in `ui/` is embedded in the exe: rebuild
after changing it.

Layout:
- `src/main.rs`: the Tauri commands (`inventory`, `dev_items`,
  `system_items`, `list_drives`, `why`, `reveal`, `icon`).
- `ui/`: plain HTML, CSS and JavaScript, no build step.

## License

[GPL-3.0-only](LICENSE).