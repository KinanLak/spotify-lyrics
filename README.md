# LyricWave

App web React pour afficher des paroles synchronisees avec la musique.

## Lancer

```bash
npm install
npm run dev
```

## Spotify

Spotify ne fournit pas les paroles via son API officielle. L'app utilise Spotify Web API pour connaitre le titre en cours et sa position, puis LRCLIB pour recuperer les lyrics synchronises.

1. Cree une app sur <https://developer.spotify.com/dashboard>.
2. Ajoute `http://127.0.0.1:5173` dans les Redirect URIs.
3. Copie `.env.example` vers `.env` et renseigne `VITE_SPOTIFY_CLIENT_ID`.
4. Lance `npm run dev`, clique sur `Connecter Spotify`, puis joue un titre dans Spotify.

## Sans Spotify

Le mode `Local` permet d'importer un fichier audio et un fichier `.lrc`. Exemple de format:

```text
[00:00.00]Premiere ligne
[00:08.40]Deuxieme ligne
```
