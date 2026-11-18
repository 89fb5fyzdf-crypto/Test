# Radar French Tech

Site de veille qui sélectionne chaque matin les articles clés sur la French Tech.

Site en ligne : https://89fb5fyzdf-crypto.github.io/Test/

## Fonctionnement

1. Chaque jour vers 6 h-7 h (heure de Paris), le workflow GitHub Actions `Screening quotidien` lance `scripts/screen.mjs`.
2. Le script récupère :
   - les flux RSS des médias startups et tech (Maddyness, FrenchWeb, JDN, Sifted, TechCrunch, Siècle Digital, BFM Tech) ;
   - des recherches Google News : thèmes (« French Tech », levées de fonds, licornes, Station F, Bpifrance, Mistral AI) et médias dont le flux bloque les robots (Les Echos, L'Usine Digitale, EU-Startups, suivis via `site:`).
3. Il garde les 36 dernières heures et écarte les sujets sans lien avec la France dans les médias généralistes.
4. Il **regroupe les articles qui parlent du même sujet** : titres proches, ou même entreprise citée (« Genesis AI », « QONTO »…) pour le même type d'événement (levée, rachat). Tous les articles du sujet sont listés dans un menu déroulant.
5. Il prépare un **résumé sans IA** (gratuit) : les phrases les plus informatives des articles (texte complet quand le flux le fournit) et des **chiffres clés** repérés automatiquement pour les levées de fonds (montant, tour, valorisation, investisseurs). Un clic sur un titre ouvre ce résumé.
6. Chaque sujet reçoit un **score** : thèmes détectés + fiabilité de la source + bonus quand plusieurs médias en parlent + fraîcheur.
7. Le résultat est enregistré dans `docs/data/AAAA-MM-JJ.json` (120 jours d'archives), puis le site `docs/` est publié sur GitHub Pages.

Toute modification de `config/`, `scripts/` ou `docs/` sur `main` relance une collecte et republie le site.

## Personnalisation

- `config/sources.json` : flux RSS (`focus: true` = média 100 % startups FR, tous ses articles sont gardés) et recherches Google News (texte simple, ou `{ "query", "label", "weight" }`).
- `config/keywords.json` : thèmes, mots-clés (expressions régulières), expressions à ignorer (`exclude`) et poids.
- `docs/topo.svg` : motif de courbes de niveau du fond (généré, répétable).

## En local

```bash
node scripts/screen.mjs                 # collecte réelle (Node 22+, aucune dépendance)
cd docs && python3 -m http.server 8000  # puis http://localhost:8000
```
