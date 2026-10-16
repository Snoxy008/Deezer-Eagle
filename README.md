# Deezer Eagle 🦅

**Des mods pour Deezer Desktop**, à la manière de [Spicetify](https://spicetify.app) pour Spotify :
un adblock, des thèmes, des petites fonctionnalités… et n'importe qui peut créer et partager
ses propres mods sur GitHub.

## Installation

Ouvre **PowerShell** (pas besoin d'être administrateur) et colle :

```powershell
iwr -useb https://raw.githubusercontent.com/Snoxy008/Deezer-Eagle/main/install.ps1 | iex
```

C'est tout. L'installeur :

1. installe Deezer Eagle dans `%LOCALAPPDATA%\DeezerEagle` et ajoute la commande `eagle` ;
2. installe les mods de base (**AdBlock** et **No Tracking**) ;
3. patche Deezer Desktop (il est fermé puis relancé s'il tournait).

> Il faut la version classique de Deezer Desktop, téléchargée sur
> [deezer.com/download](https://www.deezer.com/fr/download). La version Microsoft Store
> est protégée en écriture par Windows et ne peut pas être modifiée.

Dans Deezer, **Ctrl+Shift+E** ouvre le panneau Eagle avec la liste des mods actifs.

## Utilisation

```powershell
eagle list                    # mods installés
eagle search                  # trouver des mods (registre officiel + GitHub)
eagle install copy-link       # installer un mod du registre
eagle install pseudo/son-mod  # ... ou directement depuis n'importe quel dépôt GitHub
eagle disable adblock         # désactiver un mod (enable pour le réactiver)
eagle remove copy-link        # supprimer un mod
eagle update                  # mettre à jour les mods
eagle help                    # toutes les commandes
```

Les changements de mods s'appliquent au rechargement de Deezer : **Ctrl+Shift+R**.

### Après une mise à jour de Deezer

Quand Deezer se met à jour, il remplace ses fichiers et les mods disparaissent. Relance simplement :

```powershell
eagle apply
```

(`eagle status` te dit si c'est nécessaire.)

### Formats acceptés par `eagle install`

| Tu tapes | Ce qui est installé |
| --- | --- |
| `adblock` | le mod `adblock` du [registre](registry.json) |
| `pseudo/depot` | le mod à la racine du dépôt GitHub `pseudo/depot` |
| `pseudo/depot/themes/sombre` | le mod du dossier `themes/sombre` de ce dépôt |
| `pseudo/depot@v1.2` | une branche, un tag ou un commit précis |
| `https://github.com/pseudo/depot/tree/main/themes/sombre` | une URL GitHub copiée depuis le navigateur |
| `C:\mes-mods\mon-mod` | un dossier local |

Un mod qui ne vient pas de ce dépôt demande une confirmation avant l'installation (`-y` pour la passer).

## Mods inclus

| Mod | Description | Installé par défaut |
| --- | --- | --- |
| [`adblock`](mods/adblock) | Bloque les régies publicitaires et masque les emplacements de pub | oui |
| [`no-tracking`](mods/no-tracking) | Bloque les outils de mesure d'audience et de télémétrie tiers | oui |
| [`copy-link`](mods/copy-link) | Ctrl+Shift+L copie le lien de la page ouverte | non |

## Créer un mod

```powershell
eagle new mon-mod     # crée le dossier .\mon-mod à partir du modèle, déjà branché sur Deezer
```

Un mod, c'est un dossier avec un `manifest.json` et, au choix, du JavaScript, du CSS et des
règles de blocage réseau. Modifie les fichiers, appuie sur Ctrl+Shift+R dans Deezer, et c'est en
place. Pour inspecter la page : `eagle config devtools on`, puis Ctrl+Shift+I dans Deezer.

Pour le partager, publie le dossier sur GitHub et ajoute le **topic `deezer-eagle-mod`** au dépôt :
il apparaît alors dans `eagle search` pour tout le monde. Tu peux aussi proposer une PR qui
l'ajoute à [`registry.json`](registry.json) pour qu'il s'installe avec son simple nom.

👉 Le guide complet : **[docs/creer-un-mod.md](docs/creer-un-mod.md)**

## Comment ça marche

Deezer Desktop est une application [Electron](https://www.electronjs.org/) qui affiche le site
deezer.com. `eagle apply` renomme l'archive de l'application (`resources\app.asar` →
`resources\_app.asar`) et la remplace par un petit chargeur qui :

- démarre le cœur de Deezer Eagle, puis l'application Deezer d'origine, sans rien y modifier
  (même nom, même dossier de données : tu restes connecté) ;
- injecte l'API `Eagle` et le code des mods activés dans la page de Deezer ;
- bloque les requêtes réseau listées par les mods (c'est comme ça que fonctionne l'adblock).

Si quelque chose ne va pas, `eagle restore` remet l'archive d'origine en place à l'octet près.
Si le dossier de Deezer Eagle disparaît, Deezer démarre normalement sans mods. Pour lancer
Deezer une fois sans aucun mod : définis la variable d'environnement `DEEZER_EAGLE_DISABLE=1`.

### Sécurité

- Le code d'un mod s'exécute **dans la page de Deezer**, avec accès à ton compte Deezer :
  n'installe que des mods dont tu fais confiance à l'auteur.
- Les mods n'ont **pas** accès à ton ordinateur : ils ne s'exécutent jamais dans le processus
  principal d'Electron et ne peuvent lire que les fichiers de leur propre dossier.
- Si une future version de Deezer active la vérification d'intégrité d'Electron, `eagle apply`
  refuse de patcher plutôt que de casser Deezer.

## Désinstaller

```powershell
eagle uninstall
```

Deezer retrouve son état d'origine et tout est supprimé.

## Développement

```powershell
npm test            # cœur (Node)
npm run test:cli    # CLI PowerShell (pwsh ou powershell)
npm run test:e2e    # bout en bout : un faux Deezer sous Electron, patché par la vraie CLI
```

| Dossier | Contenu |
| --- | --- |
| `install.ps1` | installeur en une ligne |
| `src/cli/eagle.ps1` | la commande `eagle` |
| `src/core/stub/index.js` | le chargeur placé dans `app.asar` |
| `src/core/main.js`, `lib.js` | cœur côté processus principal : lecture des mods, injection, blocage réseau |
| `src/core/client.js` | API `Eagle` et panneau, injectés dans la page |
| `src/template/` | modèle utilisé par `eagle new` |
| `mods/` | mods officiels |
| `registry.json` | registre des mods installables par leur nom |

*Deezer Eagle n'est ni affilié à Deezer ni approuvé par Deezer.*
