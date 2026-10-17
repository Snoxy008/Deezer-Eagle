# Creating Deezer Eagle mods and themes

A **mod** is a folder holding a `manifest.json` and, depending on what it does:

- **JavaScript** that runs inside Deezer's page;
- **CSS** applied to the page;
- **network rules** that block requests (like the adblock);
- **settings** people change in the Eagle library.

A **theme** is even simpler: a `manifest.json` with a colour palette (see [Themes](#themes)).

## Get started in 30 seconds

```powershell
cd C:\my-mods
eagle new my-mod
```

This creates `C:\my-mods\my-mod` from the template and **links** it to Deezer: Deezer reads that
folder directly. Edit `mod.js` or `style.css`, press **Ctrl+Shift+R** in Deezer, and your changes
are there.

To get the console and the inspector, open Eagle → *Settings* → *Developer tools* (or run
`eagle config devtools on`), then press **Ctrl+Shift+I** in Deezer.

`mod.log(...)` messages show up in the console, and an error in your mod shows up in the Eagle
library (sidebar, or **Ctrl+Shift+E**) with the offending line, without breaking the other mods.

## `manifest.json`

```json
{
  "id": "my-mod",
  "name": "My Mod",
  "version": "1.0.0",
  "description": "What my mod does, in one sentence.",
  "author": "your-username",
  "main": "mod.js",
  "styles": ["style.css"],
  "network": {
    "block": ["ads.example.com", "*://*.deezer.com/some/path/*"]
  },
  "settings": [
    { "key": "step", "type": "number", "label": "Step", "default": 5, "min": 1, "max": 25 }
  ]
}
```

| Field | Required | Description |
| --- | --- | --- |
| `id` | yes | Unique identifier: lowercase letters, digits, `-` or `_` (it is the installed folder name). |
| `name` | yes | Display name. |
| `version` | yes | Version, e.g. `1.0.0`. The library announces an update when your repository has a higher one. |
| `description` | no | One sentence, shown in the library and `eagle search`. |
| `author` | no | Your username. |
| `type` | no | `"theme"` for a theme; mods leave it out. |
| `main` | no | JavaScript file run inside the page. |
| `styles` | no | CSS file(s) applied to the page, in order. |
| `network.block` | no | Requests to block, see [below](#blocking-requests-networkblock). |
| `settings` | no | Settings shown in the library, see [below](#settings). |

The `main` and `styles` paths are relative to the mod folder and cannot point outside it.

A mod with only `styles` (no `main`) switches on and off live from the library. A mod with a
script asks for a reload, since a script cannot be "un-run".

## The mod's JavaScript

Your `main` file runs **every time Deezer's page loads**, once the HTML is loaded. Two variables
are available:

### `Eagle`: the shared API

| Function | Description |
| --- | --- |
| `Eagle.observe(selector, callback)` | Calls `callback(element)` for every matching element, **now and whenever a new one appears**. Returns a function that stops it. This is the main building block: Deezer builds its page as you browse. |
| `Eagle.waitFor(selector, { timeout })` | Promise resolved with the first matching element. |
| `Eagle.onNavigate(callback)` | Calls `callback(url)` every time the page changes inside Deezer (album, playlist...). Returns a function that unsubscribes. |
| `Eagle.addStyle(css)` | Adds CSS to the page. Returns a function that removes it. |
| `Eagle.notify(text, { timeout })` | Shows a small notification in the bottom-right corner. |
| `Eagle.player` | The player: current track, playback, volume and events, see [below](#eagleplayer). |
| `Eagle.theme` | Id of the active theme, or `null`. |
| `Eagle.openLibrary(tab)` | Opens the Eagle library on `'installed'`, `'themes'`, `'marketplace'` or `'settings'`. |
| `Eagle.closeLibrary()` | Closes it. |
| `Eagle.mods` | List of installed mods and their status. |
| `Eagle.version` | Deezer Eagle version. |

### `mod`: your mod

| Property | Description |
| --- | --- |
| `mod.id`, `mod.name`, `mod.version` | Info from your manifest. |
| `mod.log(...)`, `mod.warn(...)`, `mod.error(...)` | Like `console.log`, prefixed with your mod's name. |
| `mod.settings.get(key)` | Current value of a [setting](#settings) (its `default` until changed). |
| `mod.settings.set(key, value)` | Changes a setting. |
| `mod.settings.onChange((key, value) => ...)` | Called when a setting changes in the library. Returns a function that unsubscribes. |
| `mod.storage.get(key, fallback)` | Reads a saved value (survives restarts). |
| `mod.storage.set(key, value)` | Saves a value (anything that serializes to JSON). |
| `mod.storage.remove(key)` | Deletes a value. |
| `mod.addStyle(css)` | Same as `Eagle.addStyle`. |

### `Eagle.player`

Built on Deezer's own player. Check `Eagle.player.available` first if your mod may run before
the player is ready.

| Member | Description |
| --- | --- |
| `getTrack()` | `{ id, title, artist, album, duration, cover, url, raw }` for what is playing, or `null`. `duration` is in seconds, `cover` a 500×500 image URL, `raw` Deezer's own object. Podcasts and radios fill what they can. |
| `isPlaying()` | `true` while music plays. |
| `play()`, `pause()`, `togglePlay()` | Playback. |
| `next()`, `previous()` | Change track. |
| `getVolume()`, `setVolume(volume)` | Volume from `0` to `1`. |
| `getPosition()`, `getDuration()`, `seek(seconds)` | Position in the track, in seconds. |
| `on('track', (track) => ...)` | A new track starts. |
| `on('playing', (playing) => ...)` | Play or pause. |
| `on('volume', (volume) => ...)` | The volume changes. |

`on(...)` returns a function that unsubscribes. A control Deezer does not offer throws an
error that says so.

### Example

```js
// Shows the new track in a notification, and pauses when the volume is muted.
Eagle.player.on('track', (track) => {
  if (mod.settings.get('announce')) Eagle.notify(`${track.title} · ${track.artist}`);
});

Eagle.player.on('volume', (volume) => {
  if (volume === 0 && Eagle.player.isPlaying()) Eagle.player.pause();
});

Eagle.observe('[data-testid="album_thumbnail"]', (cover) => {
  cover.title = 'Album';
});
```

### Finding your way in Deezer's page

Deezer's interface is a React app rendered inside `#dzr-app`. Its generated class names change
with every release, but these hooks are stable:

| Selector | What it is |
| --- | --- |
| `.naboo` | the app shell (sidebar, top bar and content) |
| `#page_topbar` | the top bar with the search field |
| `#page_content` | the main content area |
| `#page_player` | the player bar |
| `#page_player [aria-label="volume button"]` | the volume button |
| `[data-testid="..."]` | most components, e.g. `[data-testid="album_thumbnail"]` |
| `svg[data-testid="HouseFilledIcon"]` | icons: `...FilledIcon` marks the current page in the sidebar |

Prefer these, `data-testid` and `aria-label` over generated classes (`.css-1x2y3z`) that change
with every update.

### Good practices

- **No `innerHTML`**: Deezer's page may forbid it (Trusted Types). Build your elements with
  `document.createElement` and `textContent`.
- **No hand-made `<style>` or `<script>` tags**: Deezer's security policy (CSP) may block them.
  Use `Eagle.addStyle` or the `styles` field of the manifest.
- CSS goes through constructed stylesheets, where `@import` is ignored. For a font, use
  `@font-face` with a URL.
- Use Deezer's colour variables (`var(--color-bg-main)`, `var(--color-accent-main)`...) in your
  CSS: your mod then follows light/dark mode and every theme.
- A crashing mod does not affect the others, but a slow mod slows Deezer down: avoid fast
  `setInterval` loops, `Eagle.observe` and `Eagle.player.on` are made for this.

## Settings

Declare settings in the manifest and the library shows them (⚙ on your mod's card); your code
reads them with `mod.settings.get(key)` and hears changes with `mod.settings.onChange`.

```json
"settings": [
  { "key": "announce", "type": "toggle", "label": "Announce new tracks", "default": true },
  { "key": "step", "type": "number", "label": "Step", "description": "In percent.", "default": 5, "min": 1, "max": 25 },
  { "key": "name", "type": "text", "label": "Your name", "default": "" },
  { "key": "colour", "type": "color", "label": "Highlight", "default": "#a238ff" },
  { "key": "position", "type": "select", "label": "Position", "default": "right",
    "options": [{ "value": "left", "label": "Left" }, { "value": "right", "label": "Right" }] }
]
```

`key`, `type` and `default` are required; `label` defaults to the key, `description` is an
optional line under it, and numbers accept `min`, `max` and `step`.

## Themes

A theme is a `manifest.json` with `"type": "theme"` and a palette. Eagle turns the palette into
every colour Deezer uses (including the design tokens its components set at runtime), so you
only pick a handful of colours:

```json
{
  "id": "ocean",
  "type": "theme",
  "name": "Ocean",
  "version": "1.0.0",
  "author": "your-username",
  "dark": true,
  "colors": {
    "background": "#0b1622",
    "surface": "#102033",
    "surfaceHover": "#183047",
    "text": "#e6f1ff",
    "textSecondary": "#9fb3c8",
    "accent": "#4fc3f7",
    "accentHover": "#81d4fa",
    "onAccent": "#0b1622",
    "border": "#1f3a56"
  }
}
```

| Colour | Used for |
| --- | --- |
| `background` *(required)* | the main background |
| `surface` | cards, the sidebar, the player |
| `surfaceHover` | hovered and selected rows, inputs |
| `text` *(required)* | main text and icons |
| `textSecondary` | secondary text |
| `accent` *(required)* | buttons, links, the progress bar |
| `accentHover` | hovered buttons |
| `onAccent` | text and icons on an accent background |
| `border` | dividers and borders |
| `error`, `success`, `warning` | messages |

Missing colours are derived from the others. `"dark": false` tells Deezer the theme is light
(scrollbars, form controls). Colours can be any CSS colour (`#hex`, `rgb()`, `hsl()`).

For fine-tuning, a theme can also have `styles`: that CSS comes with the theme and goes when you
switch to another one. Test a theme you are making with `eagle link` and switch to it in the
library: it applies instantly.

## Blocking requests: `network.block`

Each rule is either:

- a **domain name**: `doubleclick.net` blocks `doubleclick.net` and all its subdomains;
- a **URL pattern** where `*` matches anything: `*://*.deezer.com/ads/*`.

Loading Deezer's main page is never blocked, even by an overly broad rule. Rules apply as soon
as the mod is switched on or off in the library.

## Publishing

1. Create a **public** GitHub repository with your mod or theme folder at its root
   (`manifest.json`, `mod.js`...).
2. Add the **`deezer-eagle-mod` topic** to the repository (gear icon next to "About" on the
   repository page). It then shows up in the Marketplace and in `eagle search`.
3. People install it from the Marketplace, or with:

   ```powershell
   eagle install your-username/your-repo
   ```

Several mods in one repository? Put them in subfolders; they install with
`eagle install your-username/your-repo/path/to/mod`.

When you push a higher `version` in your manifest, the library shows an *Update* button to
everyone who installed it. To pin a version, people can install a tag:
`eagle install your-username/your-repo@v1.0.0`.

### Getting into the official registry

The registry ([`registry.json`](../registry.json)) lets people install a mod by its plain name
and lists it under *Official* in the Marketplace. To add yours, open a pull request that adds an
entry:

```json
{
  "id": "my-mod",
  "name": "My Mod",
  "description": "What my mod does, in one sentence.",
  "author": "your-username",
  "repo": "your-username/your-repo",
  "path": ""
}
```

`path` is the mod's subfolder in the repository (empty if it is at the root), and `id` must match
the one in your `manifest.json`. For a theme, add `"type": "theme"` and its `colors` (at least
`background`, `surface`, `text` and `accent`) so the Marketplace can show a preview.
