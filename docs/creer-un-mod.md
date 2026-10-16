# Créer un mod Deezer Eagle

Un mod est un dossier qui contient un `manifest.json` et, selon ce qu'il fait :

- du **JavaScript** exécuté dans la page de Deezer ;
- du **CSS** appliqué à la page (un thème, c'est juste un mod avec du CSS) ;
- des **règles réseau** qui bloquent des requêtes (comme l'adblock).

## Démarrer en 30 secondes

```powershell
cd C:\mes-mods
eagle new mon-mod
```

Ça crée `C:\mes-mods\mon-mod` à partir du modèle et le **lie** à Deezer : Deezer lit directement
ce dossier. Modifie `mod.js` ou `style.css`, appuie sur **Ctrl+Shift+R** dans Deezer, et tes
changements sont là.

Pour avoir la console et l'inspecteur :

```powershell
eagle config devtools on   # puis redémarre Deezer et appuie sur Ctrl+Shift+I
```

Les messages de `mod.log(...)` apparaissent dans la console, et une erreur dans ton mod s'affiche
dans le panneau Eagle (**Ctrl+Shift+E**) avec la ligne fautive, sans casser les autres mods.

## `manifest.json`

```json
{
  "id": "mon-mod",
  "name": "Mon Mod",
  "version": "1.0.0",
  "description": "Ce que fait mon mod, en une phrase.",
  "author": "ton-pseudo",
  "main": "mod.js",
  "styles": ["style.css"],
  "network": {
    "block": ["pubs.exemple.com", "*://*.deezer.com/un/chemin/*"]
  }
}
```

| Champ | Obligatoire | Description |
| --- | --- | --- |
| `id` | oui | Identifiant unique : minuscules, chiffres, `-` ou `_` (c'est le nom du dossier installé). |
| `name` | oui | Nom affiché. |
| `version` | oui | Version du mod, par exemple `1.0.0`. Affichée par `eagle update`. |
| `description` | non | Une phrase, affichée dans le panneau Eagle et `eagle search`. |
| `author` | non | Ton pseudo. |
| `main` | non | Fichier JavaScript exécuté dans la page. |
| `styles` | non | Fichier(s) CSS appliqués à la page, dans l'ordre. |
| `network.block` | non | Requêtes à bloquer, voir plus bas. |

Les chemins de `main` et `styles` sont relatifs au dossier du mod et ne peuvent pas en sortir.

## Le JavaScript du mod

Ton fichier `main` s'exécute **à chaque chargement de la page de Deezer**, une fois le HTML
chargé. Deux variables sont disponibles :

### `Eagle` : l'API commune

| Fonction | Description |
| --- | --- |
| `Eagle.observe(selecteur, callback)` | Appelle `callback(element)` pour chaque élément qui correspond, **maintenant et à chaque fois qu'il en apparaît un nouveau**. Renvoie une fonction pour arrêter. C'est l'outil de base : Deezer construit sa page au fur et à mesure. |
| `Eagle.waitFor(selecteur, { timeout })` | Promesse résolue avec le premier élément qui correspond. |
| `Eagle.onNavigate(callback)` | Appelle `callback(url)` à chaque changement de page dans Deezer (album, playlist...). Renvoie une fonction pour se désabonner. |
| `Eagle.addStyle(css)` | Ajoute du CSS à la page. Renvoie une fonction qui le retire. |
| `Eagle.notify(texte, { timeout })` | Affiche une petite notification en bas à droite. |
| `Eagle.togglePanel()` | Ouvre ou ferme le panneau Eagle. |
| `Eagle.mods` | Liste des mods installés et leur état. |
| `Eagle.version` | Version de Deezer Eagle. |

### `mod` : ton mod

| Propriété | Description |
| --- | --- |
| `mod.id`, `mod.name`, `mod.version` | Infos de ton manifest. |
| `mod.log(...)`, `mod.warn(...)`, `mod.error(...)` | Comme `console.log`, préfixé par le nom de ton mod. |
| `mod.storage.get(cle, defaut)` | Lit une valeur sauvegardée (survit aux redémarrages). |
| `mod.storage.set(cle, valeur)` | Sauvegarde une valeur (tout ce qui passe en JSON). |
| `mod.storage.remove(cle)` | Supprime une valeur. |
| `mod.addStyle(css)` | Identique à `Eagle.addStyle`. |

### Exemple

```js
// Masque le bouton "Essayer Premium" et prévient quand on ouvre un album.
Eagle.observe('[data-testid="upgrade-button"]', (button) => {
  button.style.display = 'none';
});

Eagle.onNavigate((url) => {
  if (url.includes('/album/')) Eagle.notify('Bonne écoute !');
});

const launches = mod.storage.get('launches', 0) + 1;
mod.storage.set('launches', launches);
mod.log(`Deezer lancé ${launches} fois avec ce mod`);
```

> Les sélecteurs ci-dessus sont des exemples : utilise l'inspecteur (Ctrl+Shift+I) pour trouver
> ceux de la version actuelle de Deezer. Préfère les attributs stables comme `data-testid`
> ou `aria-label` aux classes générées (`.css-1x2y3z`) qui changent à chaque mise à jour.

### Bonnes pratiques

- **Pas de `innerHTML`** : la page de Deezer peut l'interdire (Trusted Types). Crée tes éléments
  avec `document.createElement` et `textContent`.
- **Pas de `<style>` ni de `<script>` ajoutés à la main** : la politique de sécurité (CSP) de
  Deezer peut les bloquer. Utilise `Eagle.addStyle` ou le champ `styles` du manifest.
- Le CSS passe par des feuilles de style construites : `@import` y est ignoré. Pour une police,
  utilise `@font-face` avec une URL.
- Un mod qui plante n'affecte pas les autres, mais un mod lent ralentit Deezer : évite les
  boucles `setInterval` rapides, `Eagle.observe` est fait pour ça.

## Bloquer des requêtes : `network.block`

Chaque règle est soit :

- un **nom de domaine** : `doubleclick.net` bloque `doubleclick.net` et tous ses sous-domaines ;
- un **motif d'URL** où `*` remplace n'importe quoi : `*://*.deezer.com/ads/*`.

Le chargement de la page principale de Deezer n'est jamais bloqué, même par une règle trop large.
Les règles sont relues à chaque rechargement (Ctrl+Shift+R).

## Publier ton mod

1. Crée un dépôt GitHub **public** avec ton dossier de mod à la racine
   (`manifest.json`, `mod.js`...).
2. Ajoute le **topic `deezer-eagle-mod`** au dépôt (roue dentée à côté de « About » sur la page du
   dépôt). Ton mod apparaît alors dans `eagle search`.
3. Les gens l'installent avec :

   ```powershell
   eagle install ton-pseudo/ton-depot
   ```

Plusieurs mods dans un même dépôt ? Mets-les dans des sous-dossiers ; on les installe avec
`eagle install ton-pseudo/ton-depot/chemin/du/mod`.

`eagle update` récupère la dernière version de ta branche par défaut. Pour figer une version,
les gens peuvent installer un tag : `eagle install ton-pseudo/ton-depot@v1.0.0`.

### Entrer dans le registre officiel

Le registre ([`registry.json`](../registry.json)) permet d'installer un mod par son simple nom
(`eagle install mon-mod`). Pour y ajouter le tien, ouvre une pull request qui ajoute une entrée :

```json
{
  "id": "mon-mod",
  "name": "Mon Mod",
  "description": "Ce que fait mon mod, en une phrase.",
  "author": "ton-pseudo",
  "repo": "ton-pseudo/ton-depot",
  "path": ""
}
```

`path` est le sous-dossier du mod dans le dépôt (vide s'il est à la racine), et `id` doit être le
même que dans ton `manifest.json`.
