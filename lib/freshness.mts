/**
 * Datation et fraîcheur d'une lecture de capteur.
 *
 * Extrait de `runtime/hub.mts` pour être testable sans Homey : ce fichier porte les deux décisions
 * qui déterminent si la régulation pilote une vraie mesure ou une valeur morte —
 *  1. d'où vient l'horodatage d'une lecture (jamais de l'horloge courante) ;
 *  2. à partir de quel âge cette lecture cesse d'être croyable.
 *
 * Pur : aucune référence à Homey, aucune lecture d'horloge (`nowMs` est toujours un paramètre).
 */

/**
 * Origine retenue pour l'horodatage, dans l'ordre de préférence.
 *
 * - `lastUpdated` : `capabilitiesObj[capId].lastUpdated`. Champ mis à jour en place par le
 *   websocket `homey-api`, donc la source la plus proche de l'émetteur réel.
 * - `lastChanged` : `DeviceCapability.lastChanged`. Dérivé du `transactionTime` de l'émetteur, il
 *   vaut `null` dès que celui-ci ne l'envoie pas : jamais s'y fier seul.
 * - `listener` : instant où le listener a effectivement tiré. Dernier recours, mais honnête —
 *   c'est un minorant de l'âge réel, pas une valeur inventée.
 */
export type TimestampSource = 'lastUpdated' | 'lastChanged' | 'listener';

export interface TimestampCandidates {
  lastUpdatedMs: number | null;
  lastChangedMs: number | null;
  listenerFiredAtMs: number | null;
}

export interface ResolvedTimestamp {
  atMs: number;
  /** Conservée pour le journal : sans elle, un « pourquoi cette mesure paraît fraîche » est indiagnosticable. */
  source: TimestampSource;
}

/**
 * Convertit en millisecondes d'époque ce que `homey-api` peut mettre dans un champ de date.
 *
 * `Device.transformGet` convertit `lastUpdated` en `Date`, mais `DeviceCapability.setValue` y
 * réinjecte un nombre et le websocket une chaîne ISO : les trois formes existent réellement.
 * Tout le reste — `null`, `undefined`, `NaN`, date invalide, époque 0 — retourne `null`, car une
 * date fausse acceptée ici deviendrait une lecture éternellement fraîche.
 */
export function toEpochMs(value: unknown): number | null {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  }
  return null;
}

/**
 * Choisit l'horodatage d'une lecture parmi les trois sources disponibles.
 *
 * Retourne `null` quand aucune source n'est exploitable. C'est volontaire et c'est le point le plus
 * important du fichier : `Date.now()` par défaut produirait une lecture qui ne paraîtrait JAMAIS
 * périmée, donc une régulation qui continuerait à chauffer sur un capteur muet depuis des heures.
 * Une lecture non datable est une lecture absente.
 */
export function resolveTimestamp(candidates: TimestampCandidates): ResolvedTimestamp | null {
  const { lastUpdatedMs, lastChangedMs, listenerFiredAtMs } = candidates;

  if (lastUpdatedMs !== null) return { atMs: lastUpdatedMs, source: 'lastUpdated' };
  if (lastChangedMs !== null) return { atMs: lastChangedMs, source: 'lastChanged' };
  if (listenerFiredAtMs !== null) return { atMs: listenerFiredAtMs, source: 'listener' };

  return null;
}

export interface StaleInput {
  atMs: number;
  nowMs: number;
  /**
   * Seuil de fraîcheur fourni par l'APPELANT, par nature de source — jamais un seuil global :
   * un capteur de température dans une pièce stable se tait légitimement vingt minutes, un contact
   * de fenêtre des jours entiers. `Infinity` désactive le critère d'âge.
   */
  freshnessMs: number;
  /** `device.available`. Un appareil indisponible rend sa lecture inutilisable quel que soit son âge. */
  available: boolean;
  /**
   * Dernier signe de vie de l'APPAREIL, voir `deviceReportedAtMs`. `null` ou absent : seul l'âge
   * de la mesure compte.
   */
  deviceReportedAtMs?: number | null;
  /**
   * `device.lastSeenAt` : le dernier message reçu de l'appareil, quel qu'il soit. Voir
   * `SEEN_STABLE_MAX_MS` pour ce qu'il autorise, et surtout pour ce qu'il n'autorise pas.
   */
  deviceSeenAtMs?: number | null;
}

/**
 * Âge maximal d'une mesure inchangée sur un appareil que Homey voit encore.
 *
 * Un détecteur de fumée frient ne remonte que sa température, et Homey ne la date qu'à son
 * changement : 95 minutes à 18,6 °C dans une cuisine stable suffisaient à suspendre la pièce,
 * alors que l'appareil avait parlé cinq minutes plus tôt. Rien d'autre que `lastSeenAt` ne pouvait
 * en témoigner.
 *
 * Borné, parce que `lastSeenAt` prouve qu'un appareil est joignable, pas que sa mesure est vraie :
 * une TRVZB sous le pilote Sonoff officiel était vue à la minute avec une température figée depuis
 * six semaines. Au-delà de six heures, une valeur qui ne bouge pas n'est plus crue, vue ou non.
 */
export const SEEN_STABLE_MAX_MS = 6 * 60 * 60_000;

/** Ce que `deviceReportedAtMs` lit de chaque capability d'un appareil. */
export interface ReportedCapability {
  lastUpdated?: unknown;
  setable?: boolean;
}

/**
 * L'instant où l'appareil a remonté quoi que ce soit pour la dernière fois, ou `null`.
 *
 * Homey ne fait avancer `lastUpdated` qu'au CHANGEMENT de valeur. Un module Netatmo interrogé
 * toutes les dix minutes dans une pièce stable garde donc sa température horodatée de son dernier
 * changement : deux heures de 18,6 °C la faisaient passer pour morte, et la pièce ne chauffait plus,
 * pendant que son CO2 et sa batterie, remontés par le même relevé, étaient datés de la minute.
 *
 * Seules les capabilities NON inscriptibles comptent. Une consigne ou un `onoff` avancent quand
 * l'app écrit : sur une TRVZB qui sert aussi de capteur de pièce, nos propres écritures feraient
 * passer pour fraîche une mesure figée.
 *
 * Le prix accepté : une sonde de température morte sur un appareil dont le reste répond paraîtra
 * fraîche. Pour un module dont tout vient du même relevé, c'est le bon compromis.
 */
export function deviceReportedAtMs(
  capabilities: Readonly<Record<string, ReportedCapability | undefined>> | null | undefined,
): number | null {
  let latest: number | null = null;
  for (const cap of Object.values(capabilities ?? {})) {
    if (cap === undefined || cap.setable === true) continue;
    const ms = toEpochMs(cap.lastUpdated);
    if (ms !== null && (latest === null || ms > latest)) latest = ms;
  }
  return latest;
}

/** Vrai quand la lecture ne doit plus être crue. */
export function computeStale(input: StaleInput): boolean {
  const {
    atMs, nowMs, freshnessMs, available,
    deviceReportedAtMs: reportedAtMs = null, deviceSeenAtMs: seenAtMs = null,
  } = input;

  // Règle non négociable : indisponible ⇒ périmé, même horodaté à l'instant.
  if (!available) return true;

  // Horodatage aberrant : traité comme périmé plutôt que comme frais.
  if (!Number.isFinite(atMs) || !Number.isFinite(nowMs)) return true;

  // Une valeur inchangée reste vraie tant que l'appareil répond : voir `deviceReportedAtMs`.
  // Le max, jamais le remplacement : un signe de vie plus ancien que la mesure ne la vieillit pas.
  const lastSeenMs = reportedAtMs !== null && Number.isFinite(reportedAtMs)
    ? Math.max(atMs, reportedAtMs)
    : atMs;

  // Un horodatage dans le futur (dérive d'horloge de l'émetteur) n'est pas une raison de périmer.
  const ageMs = Math.max(0, nowMs - lastSeenMs);
  if (ageMs <= freshnessMs) return false;

  // Vu dans le délai de fraîcheur : la mesure inchangée reste vraie, jusqu'à `SEEN_STABLE_MAX_MS`.
  const seenRecently = seenAtMs !== null && Number.isFinite(seenAtMs)
    && nowMs - seenAtMs <= freshnessMs;
  return !(seenRecently && ageMs <= SEEN_STABLE_MAX_MS);
}
