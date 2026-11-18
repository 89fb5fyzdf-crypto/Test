# Radar French Tech

Site de veille qui sélectionne chaque matin les articles et posts LinkedIn clés sur la French Tech.

## Fonctionnement

1. Chaque jour à 6 h-7 h (heure de Paris), le workflow GitHub Actions `Screening quotidien` lance `scripts/screen.mjs`.
2. Le script récupère :
   - les flux RSS des médias startups et tech (Maddyness, FrenchWeb, Les Echos Start, L'Usine Digitale, JDN, Sifted…) ;
   - des recherches Google News (« French Tech », levées de fonds, licornes, Station F, Bpifrance, Mistral AI…) ;
   - les posts LinkedIn (voir plus bas).
3. Il garde les dernières 36 h, écarte les sujets sans lien avec la France dans les médias généralistes, fusionne un même sujet couvert par plusieurs médias et attribue un **score** : thèmes détectés + poids de la source + bonus quand plusieurs médias couvrent le sujet + fraîcheur.
4. Le résultat est enregistré dans `docs/data/AAAA-MM-JJ.json` (120 jours d'archives), puis le site `docs/` est publié sur GitHub Pages.

Sur le site, on trouve l'essentiel du jour (top 5), des filtres par thème (Levées de fonds, Rachats & IPO, Licornes, IA, Politique & écosystème, Difficultés, Talents), un onglet Articles et un onglet LinkedIn, une recherche, et une navigation dans l'historique.

## Mise en route

1. Fusionnez cette branche dans `main`.
2. **Settings → Pages → Source : GitHub Actions**.
3. **Actions → Screening quotidien → Run workflow** pour lancer la première collecte tout de suite.

## LinkedIn

LinkedIn ne fournit pas d'API publique pour lire les posts, et ses conditions d'utilisation interdisent le scraping. Il y a donc deux façons d'alimenter l'onglet LinkedIn :

- **Recherche automatique (recommandée)** : créez une clé sur [Brave Search API](https://brave.com/search/api/), puis ajoutez-la comme secret `BRAVE_API_KEY` (Settings → Secrets and variables → Actions). Les requêtes de `config/linkedin.json` (`searchQueries`) remontent alors chaque jour les posts publics indexés des dernières 24 h.
- **Curation manuelle** : ajoutez un post repéré dans `posts` :
  ```json
  { "date": "2026-11-19", "url": "https://www.linkedin.com/posts/...", "author": "Nom", "title": "Accroche du post", "summary": "Optionnel" }
  ```
  Les posts ajoutés à la main reçoivent un bonus de score.

La liste `watchlist` affiche dans la colonne de droite des raccourcis vers les comptes à suivre.

## Personnalisation

- `config/sources.json` : flux RSS (`focus: true` = média 100 % startups FR, tous ses articles sont gardés) et recherches Google News.
- `config/keywords.json` : thèmes, mots-clés (expressions régulières) et poids.

## En local

```bash
node scripts/screen.mjs                 # collecte réelle (Node 22+, aucune dépendance)
cd docs && python3 -m http.server 8000  # puis http://localhost:8000
```
