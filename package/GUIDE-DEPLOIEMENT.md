# Mettre J-WIN en ligne (guide pas à pas)

Sans serveur, le site reste une **démonstration** : la lecture automatique de la pièce d'identité (OCR), les e-mails, les SMS,
les missions partagées entre utilisateurs, les dépôts et les retraits ne fonctionnent qu'avec ce serveur.

## 1. Préparer l'e-mail (5 min) — pour que vous et vos utilisateurs receviez les notifications
1. Connectez-vous à **jwin1.2026@gmail.com**, ouvrez *Compte Google > Sécurité* et activez la **validation en deux étapes**.
2. Toujours dans *Sécurité*, cherchez **« Mots de passe des applications »**, créez-en un nommé « J-WIN ».
3. Google affiche 16 caractères : c'est `SMTP_PASS`. Gardez-le, il ne s'affiche qu'une fois.

## 2. SMS (facultatif)
**Plus aucun code n'est demandé** : ni à l'inscription, ni à la connexion. Le compte est créé tout de suite avec le numéro, l'e-mail et le mot de passe.
Twilio ne sert plus qu'aux SMS de notification (bienvenue, validations, paiements). Sans Twilio (`OTP_MODE=console`), les SMS ne partent pas
mais tout le reste fonctionne, e-mails compris. Pour l'activer : compte **Twilio**, numéro capable d'envoyer des SMS en Côte d'Ivoire, puis
`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` et `TWILIO_SMS_FROM`.

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
| Un utilisateur envoie sa pièce d'identité et son selfie (Paramètres) | E-mail « identité à vérifier » | Regardez les photos dans la console (Utilisateurs > fiche), puis **Valider l'identité** ou **Refuser** |

Chaque lien demande une confirmation et n'agit qu'une fois. Ne les transférez à personne.

## 5. La console d'administration : bouton « Admin » du site, ou https://votre-site/admin
- **Première connexion** : nom d'utilisateur `J-WIN`, mot de passe `1234`.
- **Changez-les tout de suite** : Réglages du site > **Accès administrateur** (nom d'utilisateur et mot de passe modifiables à volonté).
  Tant que `1234` est en place, un bandeau rouge s'affiche et la console bloque les données sensibles : pièces d'identité, exports, sauvegarde,
  ajustements de portefeuille, validation des dépôts et retraits, modification des réglages. Vous pouvez tout consulter, mais rien de risqué n'est possible.
  C'est volontaire : ce mot de passe est public dans ce guide.
- **Mot de passe oublié** : dans Render > Environment, ajoutez `ADMIN_RESET_CREDENTIALS=1`, redéployez, reconnectez-vous avec `J-WIN` / `1234`, changez-les, puis **supprimez** la variable.
- Vous pouvez aussi imposer un mot de passe de départ avec les variables `ADMIN_USER` et `ADMIN_PASSWORD` (dans ce cas il n'y a plus de mode restreint).

Contenu de la console :
- **Tableau de bord** : inscriptions, missions, volumes, soldes, commissions J-WIN, files d'attente.
- **À traiter** : missions à approuver (avec photos et vocal), dépôts à valider, retraits à payer, identités à vérifier.
- **Utilisateurs** : recherche, fiche complète, suspension/réactivation, statut d'identité et photos de la pièce, ajustement de portefeuille (motif obligatoire), mot de passe temporaire.
- **Missions, Dépôts et retraits, Transactions** : suivi et actions, factures émises.
- **Réglages du site** (effet immédiat) : bandeau d'annonce, maintenance, frais, limites, numéro Orange Money, contacts, mode de paiement et d'identité, message à tous, accès administrateur.
- **Exports et sauvegarde** : CSV (Excel) et sauvegarde complète de la base.
- **Système et journal** : état du serveur, test d'envoi d'e-mail et de SMS, journal de toutes vos actions.

Faites une sauvegarde régulièrement (au moins chaque semaine) et gardez-la ailleurs que sur le serveur. Pour modifier les textes ou le design du site lui-même, il faut modifier le code : demandez-le à votre développeur ou à Claude, puis republiez.

## 6. Connexion des utilisateurs par lien e-mail (remplace Google/Apple/Microsoft)
Un utilisateur saisit son adresse e-mail, reçoit un lien de J-WIN (valable 15 minutes, utilisable une seule fois) et un clic le connecte ou crée son compte.
Cela marche avec **toute messagerie** (Gmail, Yahoo, Outlook, iCloud…), sans configuration chez Google.
Les e-mails partent **de jwin1.2026@gmail.com par le serveur**, à condition d'avoir renseigné `SMTP_USER` et `SMTP_PASS` (le mot de passe d'application Gmail de 16 caractères, voir étape 1).
Sans `SMTP_PASS`, aucun e-mail ne part : l'inscription par e-mail, les alertes d'administrateur et « mot de passe oublié » sont alors impossibles.
Vérifiez avec **Système et journal > Envoyer l'e-mail**.

## 7. Inscription, vérification et limites
- **Inscription** : nom, prénoms, date de naissance, numéro, e-mail, mot de passe (ou messagerie Google une fois configurée). Aucun code à saisir. Les numéros et e-mails ne sont donc pas prouvés : un même numéro ou e-mail ne peut servir qu'à un compte.
- **Profil non vérifié** au départ : au maximum **3 missions créées et 3 réalisées** (modifiable dans Réglages du site), et **pas de retrait**.
- **Vérification** : depuis Paramètres, l'utilisateur envoie sa CNI ou son passeport (le numéro est lu automatiquement) et un selfie. Vous contrôlez et validez ; les limites Standard (100 créées / 50 réalisées par trimestre) s'appliquent alors. `KYC_MODE=auto` valide sans contrôle humain.
- **Mot de passe oublié** : l'utilisateur reçoit un lien par e-mail (valable 1 heure, utilisable une seule fois).

## 8. Limites actuelles (à connaître)
- Les offres Entreprise ne sont pas encore facturées côté serveur : tous les comptes ont les limites de l'offre Standard (100 créées / 50 réalisées par trimestre).
- Apple / Microsoft / Yahoo : non branchés (Google uniquement). Le paiement automatique CinetPay reste disponible (`PAYMENT_MODE=cinetpay`).
- Contrôle d'identité : `KYC_MODE=auto` fait confiance aux informations saisies. Passez en `manual` pour valider vous-même chaque personne.

## 9. Fonctionnement des missions (version actuelle)

1. **Création** : le créateur publie, l'administrateur approuve (lien reçu par e-mail ou depuis la console).
2. **Candidature** : les réalisateurs *postulent*. Le créateur voit leur nom, leurs prénoms, leur note J-WIN sur 5 (moyenne des avis reçus), leur nombre de missions et un éventuel message, puis **choisit** un réalisateur (les autres sont prévenus).
3. **Discussion** : dès la première candidature, créateur et candidat échangent par messages dans l'application (icône 💬). Le numéro de téléphone (boutons *Appeler* et *WhatsApp*) n'est partagé qu'une fois le réalisateur choisi. L'administrateur peut relire la discussion d'une mission dans la console (fiche mission) en cas de litige.
4. **Annulation** : le créateur peut annuler tant qu'aucun réalisateur n'est choisi. Ensuite, **seul l'administrateur** peut annuler (console, fiche mission, bouton *Annuler la mission*). Le réalisateur peut se retirer : la mission redevient ouverte.
5. **Preuves** : le réalisateur envoie texte, lien, photos (4 max) et/ou message vocal. Le créateur **approuve** (son portefeuille est débité, le réalisateur est crédité, commission incluse) ou **demande une correction**. À l'approbation, il note la prestation (1 à 5) ; le réalisateur note ensuite le créateur.
6. **Notifications** : chaque étape crée une notification dans l'application (cloche, rafraîchie toutes les 15 s), en plus de l'e-mail et du SMS.
7. **Modération** (console > *Avis et modération*) : liste des avis, suppression d'un avis abusif (la note est recalculée), fiche utilisateur avec ses notes et ses avis, bouton **Bannir le compte**, message direct à un utilisateur, note interne.

Nouvelles tables : `applications`, `messages`, `notifs`. Les migrations se font toutes seules au démarrage (rien à faire sur Render).
