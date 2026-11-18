# Radar

Site de veille qui sélectionne plusieurs fois par jour les articles clés de la **French Tech** et de la **European Tech** (hors France, priorité aux plus grosses levées). Un sélecteur dans la barre du haut bascule d'une édition à l'autre. L'interface est en anglais ; le contenu French Tech reste en français, le contenu European Tech est en anglais. Thème sombre par défaut, mode clair via le bouton en bas de page. Une ouverture (grand logo sur un radar discret ; un toucher n'importe où plonge dans les courbes de niveau et dévoile le site) s'affiche à la première visite de la journée ; « Revoir l'introduction » en bas de page la rejoue.

Site en ligne : https://89fb5fyzdf-crypto.github.io/Test/

## Fonctionnement

1. Quatre fois par jour (9 h 30, 13 h 30, 18 h 30 et 21 h 30, heure de Paris), le workflow GitHub Actions `Screening quotidien` lance `scripts/screen.mjs`.
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

- European Tech : `config/sources-eu.json` (sources anglophones, surtout britanniques ; `exclude` écarte la France ; `amountBoost` fait monter les mega levées) et `config/keywords-eu.json` (thèmes en anglais). Données dans `docs/data/eu/`.

- `config/sources.json` : flux RSS (`focus: true` = média 100 % startups FR, tous ses articles sont gardés) et recherches Google News (texte simple, ou `{ "query", "label", "weight" }`).
- `config/keywords.json` : thèmes, mots-clés (expressions régulières), expressions à ignorer (`exclude`) et poids.
- `docs/topo.svg` : motif de courbes de niveau du fond (généré, répétable).

## En local

```bash
node scripts/screen.mjs                 # collecte réelle (Node 22+, aucune dépendance)
cd docs && python3 -m http.server 8000  # puis http://localhost:8000
```
