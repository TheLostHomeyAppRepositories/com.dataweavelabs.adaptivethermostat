/**
 * Présence du logement : la source « Présence de Homey » et le délai avant absence.
 *
 * La présence dit si quelqu'un est dans le LOGEMENT ; elle bascule rarement. Un détecteur de
 * mouvement, lui, dit si quelqu'un bouge dans une PIÈCE, et retombe dès que personne ne bouge. En
 * service, un radar choisi comme source de présence a fait passer le logement en absence toutes les
 * quelques minutes : un Boost de préchauffe s'appliquait à sa température d'absence, 17 °C au lieu
 * de 21 °C, dans un salon occupé.
 *
 * Deux remèdes, ici purs : la géolocalisation de Homey comme source, et un délai qui ne déclare un
 * capteur « absent » qu'après un temps sans nouvelle détection.
 *
 * Pur : le hub va chercher les utilisateurs, ce module ne fait que les lire.
 */

import { matchesCapability } from './capabilityMatch.mjs';
import type { Reading } from './types.mjs';

/**
 * Identifiant réservé désignant la présence de Homey à la place d'un appareil. Il vit dans le
 * `store` du thermostat comme un identifiant d'appareil ; c'est le hub qui le reconnaît.
 */
export const PRESENCE_SOURCE_ID = 'homey:presence';

/** Intervalle entre deux interrogations : un retour à la maison doit se voir dans la minute. */
export const PRESENCE_POLL_MS = 60_000;

/** Nouvelle tentative après un échec. */
export const PRESENCE_RETRY_MS = 60_000;

/** Au-delà, la requête est abandonnée. */
export const PRESENCE_FETCH_TIMEOUT_MS = 30_000;

/**
 * Délai avant absence par défaut, en minutes. Une heure couvre une pièce immobile le temps d'un
 * film ; plus court, le salon repasserait en absence pendant la soirée.
 */
export const DEFAULT_PRESENCE_OFF_DELAY_MIN = 60;

/**
 * Au-delà, un détecteur resté sur « quelqu'un » sans changer n'est plus cru : pile morte, chat
 * devant un radar. Sans borne, il retiendrait l'absence de la présence de Homey pendant les sept
 * jours du seuil de fraîcheur — tout le congé d'une famille partie, chauffé au Confort. Douze heures
 * dépassent une soirée ou une nuit devant un mmWave sans le moindre changement d'état.
 */
export const ACTIVITY_STUCK_MS = 12 * 60 * 60_000;

/**
 * Une capability qui ne dit QUE le mouvement — `alarm_motion` ou l'une de ses sous-capabilities,
 * comme `alarm_motion.person` d'une caméra. Elle retombe dès que personne ne bouge et demande le
 * délai avant absence. Un `alarm_presence` ou `alarm_occupancy` — mmWave, appareil virtuel
 * « quelqu'un à la maison » piloté par géofence, état d'une alarme — dit déjà la présence, et son
 * absence s'applique tout de suite, comme avant le délai.
 */
export function isMotionOnlyCapability(capabilityId: string | undefined): boolean {
  return capabilityId !== undefined && matchesCapability([capabilityId], 'alarm_motion');
}

/**
 * Depuis quand un détecteur dit « quelqu'un » SANS INTERRUPTION. `lastUpdated` ne suffit pas : un
 * détecteur figé qui re-rapporte la même valeur le fait avancer, et ne paraîtrait jamais figé. Le
 * lecteur garde donc la première fois qu'il l'a vu passer à vrai. `null` quand il dit « personne » ;
 * une lecture absente ne change rien à ce qu'on savait.
 */
export function trueSinceMs(reading: Reading<boolean> | null, previous: number | null): number | null {
  if (reading === null) return previous;
  if (!reading.value) return null;
  return previous ?? reading.atMs;
}

/**
 * Au-delà, on n'a pas regardé le détecteur assez longtemps pour savoir s'il est resté à vrai sans
 * interruption : son « vrai depuis » repart de la lecture courante. Sans cette borne, un détecteur
 * vu à vrai il y a une semaine, puis ignoré — forçage par Flow, famille géolocalisée à la maison —
 * paraîtrait figé à l'instant même où quelqu'un passe devant lui.
 */
export const DETECTOR_OBSERVATION_GAP_MS = 30 * 60_000;

/**
 * Dernière activité qu'une lecture de détecteur atteste : l'instant où il est retombé, ou
 * maintenant s'il voit quelqu'un. `stuckSinceMs` borne ce « maintenant » à `ACTIVITY_STUCK_MS`
 * après le premier « vrai » vu sans interruption ; `null` ne borne rien — un vrai capteur de
 * présence reste légitimement à vrai toute une nuit. `null` si le détecteur n'a rien rapporté. Une
 * lecture périmée compte encore : un détecteur hors ligne garde la dernière activité qu'il a vue.
 */
export function detectorActivityAtMs(
  reading: Reading<boolean> | null,
  nowMs: number,
  stuckSinceMs: number | null,
): number | null {
  if (reading === null) return null;
  if (!reading.value) return reading.atMs;
  return stuckSinceMs === null ? nowMs : Math.min(nowMs, stuckSinceMs + ACTIVITY_STUCK_MS);
}

/** La présence de Homey ne peut tenir lieu QUE de source de présence. */
export function isPresenceMisused(sourceKey: string, deviceId: string | null): boolean {
  return deviceId === PRESENCE_SOURCE_ID && sourceKey !== 'presence';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Quelqu'un est-il à la maison, d'après une réponse `users.getUsers()` ? Daté à la requête.
 *
 * Limite connue : un utilisateur actif resté « à la maison » — téléphone perdu, géolocalisation
 * coupée après un dernier passage chez soi — garde le logement présent. Homey n'expose pas l'âge
 * de cette information ; c'est à l'utilisateur de désactiver un compte qui ne sert plus.
 *
 * Présent dès qu'UN utilisateur actif est géolocalisé à la maison. `null` quand la réponse ne dit
 * rien d'exploitable — aucun utilisateur actif portant un `present` booléen : on ne déclare pas un
 * logement vide sur une réponse vide.
 *
 * Daté à la requête, et non au dernier changement : un départ en vacances de deux semaines doit
 * rester une absence FRAÎCHE. Daté au changement, il deviendrait périmé au bout du seuil de
 * fraîcheur, et une présence périmée vaut « présent » — le chauffage repartirait dans un logement
 * vide.
 */
export function parseUsersPresence(raw: unknown, fetchedAtMs: number): { value: boolean; atMs: number } | null {
  if (!isRecord(raw)) return null;
  const users = Array.isArray(raw) ? raw : Object.values(raw);

  let known = false;
  for (const user of users) {
    if (!isRecord(user) || user.enabled === false) continue;
    if (user.present === true) return { value: true, atMs: fetchedAtMs };
    if (user.present === false) known = true;
  }
  return known ? { value: false, atMs: fetchedAtMs } : null;
}

/**
 * Applique le délai avant absence à une lecture de capteur.
 *
 * Un « absent » plus récent que `delayMs` vaut encore « présent ». `atMs` est l'instant où le
 * capteur est passé à faux — Homey le date ainsi —, donc le délai ne demande aucun état et survit à
 * un redémarrage. `wakeUpAtMs` est l'instant où la lecture basculera d'elle-même : sans réveil à
 * cette échéance, l'absence n'arriverait qu'au prochain cycle.
 *
 * Une lecture périmée passe telle quelle : son interprétation appartient au lecteur.
 */
export function holdAbsence(
  reading: Reading<boolean> | null,
  nowMs: number,
  delayMs: number,
): { reading: Reading<boolean> | null; wakeUpAtMs: number | null } {
  if (reading === null || reading.value || reading.stale || delayMs <= 0) {
    return { reading, wakeUpAtMs: null };
  }
  const absentAtMs = reading.atMs + delayMs;
  if (nowMs >= absentAtMs) return { reading, wakeUpAtMs: null };
  return { reading: { ...reading, value: true }, wakeUpAtMs: absentAtMs };
}
