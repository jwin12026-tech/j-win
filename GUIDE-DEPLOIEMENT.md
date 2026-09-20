# Mettre J-WIN en ligne (guide pas à pas)

Sans serveur, le site reste une **démonstration** : la lecture automatique de la pièce d'identité (OCR), les e-mails, les SMS,
les missions partagées entre utilisateurs, les dépôts et les retraits ne fonctionnent qu'avec ce serveur.

## 1. Préparer l'e-mail (5 min) — pour que vous et vos utilisateurs receviez les notifications
1. Connectez-vous à **jwin1.2026@gmail.com**, ouvrez *Compte Google > Sécurité* et activez la **validation en deux étapes**.
2. Toujours dans *Sécurité*, cherchez **« Mots de passe des applications »**, créez-en un nommé « J-WIN ».
3. Google affiche 16 caractères : c'est `SMTP_PASS`. Gardez-le, il ne s'affiche qu'une fois.

## 2. SMS et WhatsApp (facultatif mais nécessaire pour les codes de vérification)
Créez un compte **Twilio**, achetez un numéro capable d'envoyer des SMS en Côte d'Ivoire, puis notez `TWILIO_ACCOUNT_SID`,
`TWILIO_AUTH_TOKEN` et le numéro (`TWILIO_SMS_FROM`). Sans Twilio, mettez `OTP_MODE=console` : les codes s'affichent dans
les journaux du serveur (utile pour tester, pas pour de vrais utilisateurs).

## 3. Publier sur Render (10 min)
1. Créez un compte gratuit sur **github.com**, puis un dépôt vide « j-win » et envoyez-y le contenu de ce dossier (bouton *Add file > Upload files*).
2. Créez un compte sur **render.com** > *New + > Blueprint* > choisissez votre dépôt. Render lit `render.yaml`.
3. Renseignez les variables demandées (`SMTP_PASS`, Twilio…). Laissez `PUBLIC_URL` vide pour l'instant.
4. Quand Render a fini, copiez l'adresse du site (ex. `https://j-win.onrender.com`), collez-la dans la variable `PUBLIC_URL` et redémarrez.
5. Ouvrez l'adresse : c'est le vrai site. Créez un compte de test.

> Le disque persistant (plan *starter*, ≈ 7 $/mois) est indispensable : sans lui, comptes, soldes et missions disparaissent à chaque redémarrage.

## 4. Comment vous gérez la plateforme (tout arrive dans votre boîte jwin1.2026@gmail.com)
| Événement | Ce que vous recevez | Ce que vous faites |
|---|---|---|
| Un utilisateur crée une mission | E-mail « mission à approuver » (photos, vocal, montant) + SMS | Bouton **Approuver** ou **Refuser** : la mission devient visible par tous |
| Un utilisateur dépose de l'argent | E-mail « dépôt à valider » avec référence `DEP-…` | Vérifiez la réception sur votre Orange Money +225 07 88 33 02 48, puis **Valider le dépôt** : son portefeuille est crédité et sa facture émise |
| Un utilisateur demande un retrait | E-mail « retrait à payer » (montant net, numéro, moyen) | Envoyez l'argent, puis cliquez **J'ai payé** (ou **Refuser** : il est remboursé) |
| Nouvel inscrit (si `KYC_MODE=manual`) | E-mail « identité à vérifier » | **Valider l'identité** ou **Refuser** |

Chaque lien demande une confirmation et n'agit qu'une fois. Ne les transférez à personne.

## 5. La console d'administration : https://votre-site/admin
Définissez `ADMIN_PASSWORD` (un mot de passe long et unique) puis ouvrez `/admin`. Vous y trouvez :
- **Tableau de bord** : inscriptions, missions, volumes, soldes, commissions J-WIN, files d'attente.
- **À traiter** : missions à approuver (avec photos et vocal), dépôts à valider, retraits à payer, identités à vérifier.
- **Utilisateurs** : recherche, fiche complète, suspension/réactivation, statut d'identité, ajustement de portefeuille (motif obligatoire), mot de passe temporaire.
- **Missions, Dépôts et retraits, Transactions** : suivi et actions, factures émises.
- **Réglages du site** (effet immédiat, sans redéployer) : bandeau d'annonce, mode maintenance, frais, limites, numéro Orange Money, contacts, mode de paiement et d'identité, message e-mail à tous les utilisateurs.
- **Exports et sauvegarde** : CSV (Excel) des utilisateurs, missions, mouvements, paiements, factures, journal ; sauvegarde complète de la base.
- **Système et journal** : état du serveur, test d'envoi d'e-mail et de SMS, journal de toutes vos actions.

Faites une sauvegarde régulièrement (au moins chaque semaine) et gardez-la ailleurs que sur le serveur. Pour modifier les textes ou le design du site lui-même, il faut modifier le code : demandez-le à votre développeur ou à Claude, puis republiez.

## 6. Limites actuelles (à connaître)
- Les offres Entreprise ne sont pas encore facturées côté serveur : tous les comptes ont les limites de l'offre Standard (100 créées / 50 réalisées par trimestre).
- Apple / Microsoft / Yahoo : non branchés (Google uniquement). Le paiement automatique CinetPay reste disponible (`PAYMENT_MODE=cinetpay`).
- Contrôle d'identité : `KYC_MODE=auto` fait confiance aux informations saisies. Passez en `manual` pour valider vous-même chaque personne.
