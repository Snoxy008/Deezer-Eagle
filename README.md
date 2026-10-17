# Deezer Eagle 🦅

**Mods and themes for Deezer Desktop**, in the spirit of [Spicetify](https://spicetify.app) for
Spotify: an adblock, themes, playback tools... and anyone can build and share their own mods on
GitHub.

## Install

Open **PowerShell** (no admin rights needed) and paste:

```powershell
iwr -useb https://raw.githubusercontent.com/Snoxy008/Deezer-Eagle/main/install.ps1 | iex
```

That's it. The installer:

1. installs Deezer Eagle in `%LOCALAPPDATA%\DeezerEagle` and adds the `eagle` command;
2. installs the base mods (**AdBlock**, **No Tracking**, **Volume Wheel**) and the themes;
3. patches Deezer Desktop (it is closed and restarted if it was running).

> You need the regular Deezer Desktop app from [deezer.com/download](https://www.deezer.com/download).
> The Microsoft Store version is write-protected by Windows and cannot be modified.

## The Eagle library

An **Eagle** entry appears in Deezer's sidebar, right under *Explore* (**Ctrl+Shift+E** also opens
it). It's a page inside Deezer, in Deezer's own colours:

| Tab | What you do there |
| --- | --- |
| **Mods** | turn mods on and off, change their settings (⚙), update or remove them, see why one crashed |
| **Themes** | switch theme in one click, instantly, no restart |
| **Marketplace** | install official and community mods and themes in one click |
| **Settings** | update Eagle, developer tools, your own CSS, the Eagle folder |

CSS mods and themes switch on and off live; mods with a script ask you to reload Deezer
(*Reload now*). A dot on the Eagle entry tells you when updates are waiting. Mods that do not
come from this repository ask for confirmation in a Windows dialog before installing.

## What's included

| Mod | What it does | Installed |
| --- | --- | --- |
| [AdBlock](mods/adblock) | Blocks ad networks and hides ad slots | yes |
| [No Tracking](mods/no-tracking) | Blocks third-party analytics and telemetry | yes |
| [Volume Wheel](mods/volume-wheel) | Scroll on the volume button to change the volume (step and area configurable) | yes |
| [Media Shortcuts](mods/media-shortcuts) | Ctrl+Alt+Space play/pause, Ctrl+Alt+←/→ previous/next, Ctrl+Alt+↑/↓ volume | from the Marketplace |
| [Sleep Timer](mods/sleep-timer) | A moon button next to the volume stops the music after 15 min to 1 h 30 or at the end of the track, with a fade-out | from the Marketplace |
| [Copy Link](mods/copy-link) | Ctrl+Shift+L copies the link of the open page | from the Marketplace |
| [No Offline Banner](mods/no-offline-banner) | Hides the "application is offline" banner that blockers and VPNs can trigger | from the Marketplace |
| [Hide Upsell](mods/hide-upsell) | Experimental: hides the "go Premium" promotions in the sidebar | from the Marketplace |

**Themes**: [Midnight](themes/midnight) (pure black for OLED), [Dracula](themes/dracula),
[Nord](themes/nord), [Catppuccin Mocha](themes/catppuccin-mocha) and
[Rosé Pine Dawn](themes/rose-pine-dawn) (light). A theme recolours all of Deezer, including the
Eagle library.

## Command line

Everything the library does is also available from PowerShell:

```powershell
eagle list                         # installed mods and themes
eagle search [term]                # find mods (official registry + GitHub)
eagle install copy-link            # install a mod from the registry
eagle install someone/their-mod    # ... or straight from any GitHub repository
eagle disable adblock              # disable a mod (enable turns it back on)
eagle remove copy-link             # remove a mod
eagle theme nord                   # switch theme (eagle theme none: Deezer's colours)
eagle update                       # update mods
eagle help                         # every command
```

| `eagle install` accepts | What gets installed |
| --- | --- |
| `adblock` | the `adblock` mod from the [registry](registry.json) |
| `someone/repo` | the mod at the root of the `someone/repo` GitHub repository |
| `someone/repo/themes/dark` | the mod in the `themes/dark` folder of that repository |
| `someone/repo@v1.2` | a specific branch, tag or commit |
| `https://github.com/someone/repo/tree/main/themes/dark` | a GitHub URL copied from the browser |
| `C:\my-mods\my-mod` | a local folder |

### After a Deezer update

A Deezer update replaces the app's files, which removes the patch. When Deezer installs an
update (the *"restart to complete the update"* banner), Eagle notices it and patches the new
version again automatically a few seconds after the update finishes. If mods are ever missing
anyway (for example after reinstalling Deezer), run `eagle apply`. `eagle status` tells you when
this is needed, and `logs\update.log` in the Eagle folder shows what happened after the last
update.

## Making mods and themes

```powershell
eagle new my-mod     # creates .\my-mod from the template, already hooked into Deezer
```

- A **mod** is a folder with a `manifest.json` and, as needed, JavaScript, CSS, network block
  rules and settings. Its code gets the `Eagle` API: DOM helpers, page changes, notifications,
  per-mod storage and settings, and **`Eagle.player`** to read the current track and control
  playback.
- A **theme** is just a `manifest.json` with a colour palette: Eagle derives every colour Deezer
  uses from it.

Edit the files, press Ctrl+Shift+R in Deezer, and your changes are live. To inspect the page,
turn on *Developer tools* in Eagle's settings, then press Ctrl+Shift+I.

To share it, publish the folder on GitHub and add the **`deezer-eagle-mod` topic** to the
repository: it shows up in the Marketplace and in `eagle search` for everyone. You can also open
a PR that adds it to [`registry.json`](registry.json) so it installs by its plain name.

👉 Full guide: **[docs/creating-mods.md](docs/creating-mods.md)**

## How it works

Deezer Desktop is an [Electron](https://www.electronjs.org/) app whose interface is a web page
(`build/index.html`) bundled in `resources\app.asar`. `eagle apply` renames that archive
(`app.asar` → `_app.asar`) and replaces it with a small loader that:

- starts the Deezer Eagle core, then the original Deezer app without modifying it
  (same name, same data folder: you stay logged in);
- injects the `Eagle` API, the library, the active theme and the enabled mods into Deezer's page;
- blocks the network requests listed by mods (this is how the adblock works);
- patches Deezer again after it updates itself.

If anything goes wrong, `eagle restore` puts the original archive back, byte for byte. If the
Deezer Eagle folder disappears, Deezer starts normally without mods. To start Deezer once
without any mod, set the `DEEZER_EAGLE_DISABLE=1` environment variable.

### Security

- A mod's code runs **inside Deezer's page**, with access to your Deezer account: only install
  mods from authors you trust.
- Mods have **no** access to your computer: they never run in Electron's main process and can
  only read files from their own folder. The library can only install mods from the registry or
  GitHub, and only Deezer's own page can talk to Eagle.
- If a future Deezer version turns on Electron's integrity check, `eagle apply` refuses to patch
  rather than break Deezer.

## Uninstall

```powershell
eagle uninstall
```

Deezer goes back to its original state and everything is removed.

## Development

```powershell
npm test            # core (Node)
npm run test:cli    # PowerShell CLI (pwsh or powershell)
npm run test:e2e    # end to end: a fake Deezer under Electron, patched by the real CLI
```

| Path | Contents |
| --- | --- |
| `install.ps1` | one-line installer |
| `src/cli/eagle.ps1` | the `eagle` command |
| `src/core/stub/index.js` | the loader placed in `app.asar` |
| `src/core/main.js`, `lib.js` | main-process core: reads mods, injects them, blocks requests, serves the library |
| `src/core/preload.js` | bridge between the library and the core |
| `src/core/client.js` | `Eagle` API, player, themes, sidebar entry and library, injected into the page |
| `src/template/` | template used by `eagle new` |
| `mods/`, `themes/` | official mods and themes |
| `registry.json` | registry of mods and themes installable by name |

*Deezer Eagle is not affiliated with or endorsed by Deezer.*
