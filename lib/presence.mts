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
