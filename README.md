# Deezer Eagle 🦅

**Mods for Deezer Desktop**, in the spirit of [Spicetify](https://spicetify.app) for Spotify:
an adblock, themes, small features... and anyone can build and share their own mods on GitHub.

## Install

Open **PowerShell** (no admin rights needed) and paste:

```powershell
iwr -useb https://raw.githubusercontent.com/Snoxy008/Deezer-Eagle/main/install.ps1 | iex
```

That's it. The installer:

1. installs Deezer Eagle in `%LOCALAPPDATA%\DeezerEagle` and adds the `eagle` command;
2. installs the base mods (**AdBlock** and **No Tracking**);
3. patches Deezer Desktop (it is closed and restarted if it was running).

> You need the regular Deezer Desktop app from [deezer.com/download](https://www.deezer.com/download).
> The Microsoft Store version is write-protected by Windows and cannot be modified.

## The Eagle library

Once installed, an **Eagle** entry appears in Deezer's sidebar, right under *Explore*
(**Ctrl+Shift+E** also opens it). It's a page inside Deezer, in Deezer's own colours:

- **Installed**: every mod with its switch, its errors if it crashed, a *Remove* button and
  *Check for updates*;
- **Marketplace**: official mods and community mods from GitHub, installed in one click.
  Mods that do not come from this repository ask for confirmation in a Windows dialog first.

Changes apply when Deezer reloads: the library offers a *Reload now* button.

## Usage

```powershell
eagle list                         # installed mods
eagle search                       # find mods (official registry + GitHub)
eagle install copy-link            # install a mod from the registry
eagle install someone/their-mod    # ... or straight from any GitHub repository
eagle disable adblock              # disable a mod (enable turns it back on)
eagle remove copy-link             # remove a mod
eagle update                       # update mods
eagle help                         # every command
```

Mod changes apply when Deezer reloads: **Ctrl+Shift+R**.

### After a Deezer update

A Deezer update replaces the app's files, which removes the patch. When Deezer installs an
update (the *"restart to complete the update"* banner), Eagle notices it and patches the new
version again automatically a few seconds after the update finishes. If mods are ever missing
anyway (for example after reinstalling Deezer), run:

```powershell
eagle apply
```

(`eagle status` tells you when this is needed, and `logs\update.log` in the Eagle folder shows
what happened after the last update.)

### What `eagle install` accepts

| You type | What gets installed |
| --- | --- |
| `adblock` | the `adblock` mod from the [registry](registry.json) |
| `someone/repo` | the mod at the root of the `someone/repo` GitHub repository |
| `someone/repo/themes/dark` | the mod in the `themes/dark` folder of that repository |
| `someone/repo@v1.2` | a specific branch, tag or commit |
| `https://github.com/someone/repo/tree/main/themes/dark` | a GitHub URL copied from the browser |
| `C:\my-mods\my-mod` | a local folder |

A mod that does not come from this repository asks for confirmation before installing (`-y` skips it).

## Included mods

| Mod | Description | Installed by default |
| --- | --- | --- |
| [`adblock`](mods/adblock) | Blocks ad networks and hides ad slots | yes |
| [`no-tracking`](mods/no-tracking) | Blocks third-party analytics and telemetry | yes |
| [`copy-link`](mods/copy-link) | Ctrl+Shift+L copies the link of the open page | no |

## Making a mod

```powershell
eagle new my-mod     # creates .\my-mod from the template, already hooked into Deezer
```

A mod is a folder with a `manifest.json` and, as needed, JavaScript, CSS and network block rules.
Edit the files, press Ctrl+Shift+R in Deezer, and your changes are live. To inspect the page:
`eagle config devtools on`, then Ctrl+Shift+I in Deezer.

To share it, publish the folder on GitHub and add the **`deezer-eagle-mod` topic** to the
repository: it then shows up in `eagle search` for everyone. You can also open a PR that adds it
to [`registry.json`](registry.json) so it installs by its plain name.

👉 Full guide: **[docs/creating-mods.md](docs/creating-mods.md)**

## How it works

Deezer Desktop is an [Electron](https://www.electronjs.org/) app whose interface is a web page
(`build/index.html`) bundled in `resources\app.asar`. `eagle apply` renames that archive
(`app.asar` → `_app.asar`) and replaces it with a small loader that:

- starts the Deezer Eagle core, then the original Deezer app without modifying it
  (same name, same data folder: you stay logged in);
- injects the `Eagle` API, the library and the code of enabled mods into Deezer's page;
- blocks the network requests listed by mods (this is how the adblock works);
- patches Deezer again after it updates itself.

If anything goes wrong, `eagle restore` puts the original archive back, byte for byte. If the
Deezer Eagle folder disappears, Deezer starts normally without mods. To start Deezer once
without any mod, set the `DEEZER_EAGLE_DISABLE=1` environment variable.

### Security

- A mod's code runs **inside Deezer's page**, with access to your Deezer account: only install
  mods from authors you trust.
- Mods have **no** access to your computer: they never run in Electron's main process and can
  only read files from their own folder.
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
| `src/core/main.js`, `lib.js` | main-process core: reads mods, injects them, blocks requests |
| `src/core/client.js` | `Eagle` API, sidebar entry and library, injected into the page |
| `src/core/preload.js` | bridge between the library and the core (install, enable, remove) |
| `src/template/` | template used by `eagle new` |
| `mods/` | official mods |
| `registry.json` | registry of mods installable by name |

*Deezer Eagle is not affiliated with or endorsed by Deezer.*
