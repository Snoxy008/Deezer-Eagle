# Creating a Deezer Eagle mod

A mod is a folder holding a `manifest.json` and, depending on what it does:

- **JavaScript** that runs inside Deezer's page;
- **CSS** applied to the page (a theme is just a mod with CSS);
- **network rules** that block requests (like the adblock).

## Get started in 30 seconds

```powershell
cd C:\my-mods
eagle new my-mod
```

This creates `C:\my-mods\my-mod` from the template and **links** it to Deezer: Deezer reads that
folder directly. Edit `mod.js` or `style.css`, press **Ctrl+Shift+R** in Deezer, and your changes
are there.

To get the console and the inspector:

```powershell
eagle config devtools on   # then restart Deezer and press Ctrl+Shift+I
```

`mod.log(...)` messages show up in the console, and an error in your mod shows up in the Eagle
panel (**Ctrl+Shift+E**) with the offending line, without breaking the other mods.

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
  }
}
```

| Field | Required | Description |
| --- | --- | --- |
| `id` | yes | Unique identifier: lowercase letters, digits, `-` or `_` (it is the installed folder name). |
| `name` | yes | Display name. |
| `version` | yes | Mod version, e.g. `1.0.0`. Shown by `eagle update`. |
| `description` | no | One sentence, shown in the Eagle panel and `eagle search`. |
| `author` | no | Your username. |
| `main` | no | JavaScript file run inside the page. |
| `styles` | no | CSS file(s) applied to the page, in order. |
| `network.block` | no | Requests to block, see below. |

The `main` and `styles` paths are relative to the mod folder and cannot point outside it.

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
| `Eagle.togglePanel()` | Opens or closes the Eagle panel. |
| `Eagle.mods` | List of installed mods and their status. |
| `Eagle.version` | Deezer Eagle version. |

### `mod`: your mod

| Property | Description |
| --- | --- |
| `mod.id`, `mod.name`, `mod.version` | Info from your manifest. |
| `mod.log(...)`, `mod.warn(...)`, `mod.error(...)` | Like `console.log`, prefixed with your mod's name. |
| `mod.storage.get(key, fallback)` | Reads a saved value (survives restarts). |
| `mod.storage.set(key, value)` | Saves a value (anything that serializes to JSON). |
| `mod.storage.remove(key)` | Deletes a value. |
| `mod.addStyle(css)` | Same as `Eagle.addStyle`. |

### Example

```js
// Hides the "Try Premium" button and says hi when an album opens.
Eagle.observe('[data-testid="upgrade-button"]', (button) => {
  button.style.display = 'none';
});

Eagle.onNavigate((url) => {
  if (url.includes('/album/')) Eagle.notify('Enjoy the album!');
});

const launches = mod.storage.get('launches', 0) + 1;
mod.storage.set('launches', launches);
mod.log(`Deezer started ${launches} times with this mod`);
```

> The selectors above are examples: use the inspector (Ctrl+Shift+I) to find the ones in the
> current version of Deezer. Prefer stable attributes such as `data-testid` or `aria-label` over
> generated classes (`.css-1x2y3z`) that change with every update.

### Good practices

- **No `innerHTML`**: Deezer's page may forbid it (Trusted Types). Build your elements with
  `document.createElement` and `textContent`.
- **No hand-made `<style>` or `<script>` tags**: Deezer's security policy (CSP) may block them.
  Use `Eagle.addStyle` or the `styles` field of the manifest.
- CSS goes through constructed stylesheets, where `@import` is ignored. For a font, use
  `@font-face` with a URL.
- A crashing mod does not affect the others, but a slow mod slows Deezer down: avoid fast
  `setInterval` loops, `Eagle.observe` is made for this.

## Blocking requests: `network.block`

Each rule is either:

- a **domain name**: `doubleclick.net` blocks `doubleclick.net` and all its subdomains;
- a **URL pattern** where `*` matches anything: `*://*.deezer.com/ads/*`.

Loading Deezer's main page is never blocked, even by an overly broad rule. Rules are read again
on every reload (Ctrl+Shift+R).

## Publishing your mod

1. Create a **public** GitHub repository with your mod folder at its root
   (`manifest.json`, `mod.js`...).
2. Add the **`deezer-eagle-mod` topic** to the repository (gear icon next to "About" on the
   repository page). Your mod then shows up in `eagle search`.
3. People install it with:

   ```powershell
   eagle install your-username/your-repo
   ```

Several mods in one repository? Put them in subfolders; they install with
`eagle install your-username/your-repo/path/to/mod`.

`eagle update` fetches the latest version of your default branch. To pin a version, people can
install a tag: `eagle install your-username/your-repo@v1.0.0`.

### Getting into the official registry

The registry ([`registry.json`](../registry.json)) lets people install a mod by its plain name
(`eagle install my-mod`). To add yours, open a pull request that adds an entry:

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
the one in your `manifest.json`.
