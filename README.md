# J-WIN : serveur (API + site)

> **Nouveau (v4)** : missions avec photos/vocal et approbation par l'administrateur, dépôts Orange Money et retraits validés par e-mail, e-mail + SMS de bienvenue, validation d'identité optionnelle. Lisez `GUIDE-DEPLOIEMENT.md` pour la mise en ligne.

Ce dossier contient le serveur J-WIN et le site (`public/index.html`, servi à la racine).
Une seule application à héberger : site + API sur la même adresse.

## Ce que fait le serveur
- Comptes : inscription par numéro (code OTP par SMS **et** WhatsApp), connexion par mot de passe ou par code.
- Lecture de la pièce d'identité à l'inscription (OCR, zone lisible par machine + libellés). Les images ne sont jamais conservées.
- Portefeuille tenu en écriture comptable (jamais modifié directement).
- Recharge : page de paiement CinetPay (Orange, MTN, Moov, Wave, cartes). Crédit **uniquement** après relecture du statut chez CinetPay.
- Retrait : le solde est réservé, puis virement CinetPay ; remboursement automatique en cas d'échec.
- Une facture numérotée (FAC-AAAA-000001) est émise pour chaque recharge et chaque retrait.

## Démarrage local
```
npm install
cp .env.example .env    # puis remplir (ou exporter les variables)
OTP_MODE=console JWT_SECRET=dev node server.js
```
Node 22.13 minimum. Tests : `npm test` (le fournisseur CinetPay y est simulé).

## Mise en ligne (ex. Render, Railway, Fly.io)
1. Poussez ce dossier sur GitHub, créez un service « Web » (Docker ou Node).
2. Ajoutez un **disque persistant** monté sur `/app/data` (base SQLite).
3. Renseignez les variables de `.env.example`. `PUBLIC_URL` doit être l'adresse finale en https.
4. Dans le tableau de bord CinetPay, ne configurez rien de plus : les adresses de notification sont envoyées à chaque paiement (`/api/payments/webhook`, `/api/payouts/webhook`).
5. Testez d'abord avec une clé `sk_test_`, puis passez en `sk_live_`.

## Points à savoir avant le lancement
- **Non testé contre le vrai CinetPay** : les chemins d'API viennent du kit officiel, mais aucun appel réel n'a été fait. Faites un cycle complet en sandbox (recharge, retrait, échec).
- Les retraits sont prélevés sur le solde de votre compte marchand CinetPay : provisionnez-le, et vérifiez que les transferts sont activés sur votre compte.
- WhatsApp exige un modèle de message « authentification » approuvé (variable `TWILIO_WHATSAPP_CONTENT_SID`).
- La lecture de pièce a été validée sur des images propres seulement. Pour la production, envisagez un service dédié (ex. Smile ID) avec détection du vivant.
- Non branché au serveur : paiement des missions, changement d'offre, connexion Google/Apple/Microsoft/Yahoo (le point d'entrée `/api/sso` gère Google si `GOOGLE_CLIENT_ID` est fourni ; le bouton du site est désactivé en mode serveur).
- Frais : 1 % sur recharge et retrait par défaut. Facturation : renseignez RCCM et NCC ; faites valider le modèle de facture par votre comptable.
- Aucune donnée d'identité n'est stockée hors nom, prénoms, naissance, type et 3 derniers caractères du numéro de pièce.
