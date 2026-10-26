# MAX! Cube (eQ-3)

Votre installation de chauffage **eQ-3 MAX!** dans Gladys, par le port local
du **MAX! Cube** (TCP 62910) sur votre réseau, sans cloud :

- **thermostats de radiateur** (MAX! Heating Thermostat et Thermostat+) :
  **température** de la pièce (quand le Cube la donne), **consigne**, **mode**
  (auto, chauffage, arrêt), **mode MAX!** (auto, manual, vacation, boost),
  **état du chauffage** et **ouverture de la vanne** (%), **pile faible**,
  **erreur de liaison radio** ;
- **thermostats muraux** (MAX! Wall Thermostat) : **température**,
  **consigne**, **mode**, **mode MAX!**, pile, liaison ;
- **contacts de fenêtre** (MAX! Shutter Contact) : **ouvert / fermé**, pile,
  liaison ;
- le **Cube** lui-même : **budget radio utilisé** (%) et **emplacements de
  commande libres**.

> **Cette intégration n'a jamais été testée avec un vrai Cube.** Cette
> première version a été écrite à partir de la description du protocole
> (Bouni/max-cube-protocol) et de la bibliothèque python-maxcube-api (celle
> de Home Assistant), et testée seulement contre un faux Cube. Dites sur le
> forum de Gladys ce qui marche et ce qui ne marche pas.

Intégration non officielle, sans lien avec eQ-3. Le matériel MAX! n'est plus
fabriqué, mais il reste très installé ; le portail eQ-3 n'est pas utilisé.

## Ce qu'il faut

- Un **MAX! Cube** (la passerelle LAN) sur votre réseau, avec ses appareils
  déjà appairés et rangés par pièce dans le logiciel MAX! (les noms des pièces
  et des appareils viennent de là). Les boutons poussoirs (MAX! Eco Switch)
  sont ignorés.
- Un **seul client à la fois** peut être connecté à un Cube. Par défaut,
  Gladys garde sa connexion ouverte : le logiciel MAX! ne peut pas se
  connecter pendant ce temps. Décochez **Garder la connexion ouverte** pour
  que Gladys n'ouvre une connexion que le temps d'une lecture ou d'une
  commande ; le logiciel MAX! peut alors se connecter entre deux lectures.

## Configuration

- **Adresse du Cube** : son adresse IP sur votre réseau (`192.168.1.40`),
  visible dans votre box ou le logiciel MAX! ; un port peut suivre (62910 par
  défaut). Préférez l'adresse IP : un nom en `.local` (mDNS) ne se résout pas
  dans le conteneur de l'intégration. Donnez au Cube une adresse fixe dans
  votre box ; si elle change, saisissez la nouvelle : les appareils et leur
  historique sont gardés (ils sont reconnus par leur numéro de série). Pas de
  mot de passe : le Cube n'en demande pas sur son port local.
- **Autoriser les commandes de consigne** et **Autoriser les commandes de
  mode** : désactivées par défaut (voir Commandes).
- **Garder la connexion ouverte** : cochée par défaut (voir ci-dessus).
- **Langue des appareils** : français (par défaut) ou anglais.

Ouvrez ensuite l'onglet **Découverte** et créez les appareils à suivre. Les
appareils sont nommés `Pièce - Nom` d'après le logiciel MAX!. Le bouton
**Tester la connexion** lit le Cube et liste ce qu'il montre ; il ne relit
jamais le Cube moins d'une minute après la lecture précédente (il montre
alors la dernière lecture), mais il n'attend pas la pause de nouvel essai
après une panne.

## Lectures

- Le Cube est lu toutes les **minutes** (sa propre mémoire, sans trafic
  radio : les appareils MAX! ne se signalent au Cube qu'à leur rythme, et le
  Cube garde leurs dernières valeurs). Avec la connexion gardée ouverte, un
  appareil qui se signale au Cube est affiché aussitôt. Seules les valeurs qui
  changent sont envoyées à Gladys (et chacune au moins toutes les 10 minutes).
- La **température** d'un thermostat de radiateur n'est donnée par le Cube
  que par moments (quand la vanne bouge, en mode auto ou manuel) ; celle d'un
  thermostat mural l'est toujours. Un appareil que le Cube n'a pas encore
  entendu (pas de valeurs) apparaît **injoignable** et l'état le dit.
- Le **mode** suit les modes de Gladys : **auto** (3) quand le thermostat
  suit son programme hebdomadaire, **chauffage** (1) en manuel, en boost ou
  en vacances, **arrêt** (0) quand la consigne est 4,5 °C (vanne fermée). Le
  **mode MAX!** (texte : `auto`, `manual`, `vacation`, `boost`) donne le
  détail.
- Le contact de fenêtre vaut **1 fermé, 0 ouvert** (capteur d'ouverture de
  Gladys).
- Les noms des pièces et des appareils sont relus à chaque nouvelle
  connexion (au plus tard toutes les 6 heures avec la connexion gardée).

## Commandes

Par défaut, Gladys ne fait que **lire**. Une fois une option cochée, le
tableau de bord, les scènes, les assistants vocaux (Siri / HomeKit, Alexa,
Google Home) et le service Thermostat de Gladys peuvent agir.

- **Autoriser les commandes de consigne** : la **consigne** d'un thermostat de
  radiateur ou mural, de **5 à 30 °C**, arrondie au demi-degré (la résolution
  du thermostat), dans les bornes réglées sur l'appareil (le Cube les donne) ;
  une valeur en dehors est refusée, jamais ramenée dans les bornes. En mode
  auto, la consigne vaut jusqu'au prochain point du programme hebdomadaire ;
  sinon elle passe le thermostat en manuel (un boost ou un mode vacances en
  cours se termine). Comme le logiciel MAX!, la consigne est envoyée à **toute
  la pièce** du thermostat (les thermostats d'une pièce sont liés entre eux).
- **Autoriser les commandes de mode** :
  - **auto** (3) : retour au programme hebdomadaire de l'appareil ;
  - **chauffage** (1) : manuel à la consigne actuelle, ou à la température
    confort réglée sur l'appareil quand la vanne était fermée (refusé si le
    Cube ne la donne pas) ;
  - **arrêt** (0) : manuel à 4,5 °C, la consigne « arrêt » de MAX! (vanne
    fermée). Le thermostat applique sa propre protection hors-gel telle que
    décrite par eQ-3 : vérifiez la notice de votre appareil avant de laisser
    un radiateur à l'arrêt en hiver ;
  - **refroidissement** (2) : refusé, un thermostat MAX! ne refroidit pas.
- Juste avant d'agir, Gladys **demande au Cube ses valeurs courantes** et
  décide sur cette lecture seulement. Une commande n'est **pas envoyée**
  quand : l'option est décochée (vérifiée à l'arrivée de la commande et de
  nouveau juste avant l'envoi) ; la valeur n'est pas un nombre de 5 à 30 °C,
  ou le mode n'est pas 0, 1 ou 3 ; l'appareil n'est plus appairé au Cube ;
  le Cube n'a pas encore de valeurs pour lui (pas entendu par radio) ; les
  bornes de l'appareil ne laissent aucune valeur valable ; la lecture échoue
  (pas de réponse en 2,7 s, connexion fermée) ; la configuration a changé
  entre-temps ; ou la valeur demandée est déjà celle du Cube (rien à faire,
  commande acquittée).
- Quand la commande ne peut pas être vérifiée en 3,5 s, rien n'est envoyé et
  Gladys affiche un échec. Une fois envoyée, Gladys répond au plus 4,3 s après
  votre commande : « acceptée par le Cube » quand le Cube a répondu qu'il la
  transmet par radio, « envoyée, sans confirmation » s'il n'a pas encore
  répondu, « rejetée » s'il l'a rejetée (budget radio de l'heure épuisé, ou
  plus d'emplacement libre : l'état de l'intégration l'affiche). Le Cube ne
  confirme pas que le thermostat a appliqué la commande : celui-ci l'applique
  quand il écoute le Cube (en général dans la minute). Le Cube est relu 5 s
  après chaque commande envoyée, puis toutes les minutes ; la valeur affichée
  est toujours celle que le Cube donne, jamais celle demandée.
- Les commandes passent une par une (un seul Cube, une seule connexion). Une
  commande d'**arrêt** passe avant les autres commandes en attente ; si la
  connexion au Cube ne répond plus (un échange sans réponse depuis 2,5 s),
  elle la ferme et en ouvre une nouvelle. Elle reste soumise à l'option
  **Autoriser les commandes de mode** et aux refus listés ci-dessus.
- Le budget radio du Cube (1 % du temps par heure, en Europe) limite le nombre
  de commandes par heure ; l'état de l'intégration prévient à partir de 80 %.
- Le programme hebdomadaire, le boost, le mode vacances, les températures
  confort et éco, le décalage de température et l'appairage restent dans le
  logiciel MAX!.

## Problèmes de connexion

- **Cube injoignable** ou qui ne répond pas : tous les appareils apparaissent
  injoignables ; nouvel essai après 1 min, puis de plus en plus rarement
  jusqu'à toutes les 10 min (jamais plus vite que la lecture normale). Le
  message le plus fréquent : un autre client (le logiciel MAX!, une autre
  intégration) occupe la connexion du Cube.
- **Cette adresse ne répond pas comme un MAX! Cube** : l'adresse ou le port
  (62910) est faux, ou un autre service répond.
- Après un redémarrage de l'intégration, le Cube n'est jamais relu moins
  d'une minute après la lecture précédente (l'heure de la dernière lecture
  est gardée dans `/data`).
- Les journaux ne contiennent rien de ce que le Cube envoie (ni numéros de
  série, ni noms, ni valeurs), seulement des mots à nous (pas de connexion,
  pas de réponse à temps…).

## Limites

- Un seul Cube par intégration.
- Pas de boost, de mode vacances, de programme hebdomadaire, de températures
  confort / éco, d'appairage ni de suppression d'appareils depuis Gladys.
- Les boutons poussoirs (Eco Switch) ne sont pas publiés.
- Jamais testée avec un vrai Cube.
