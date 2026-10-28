/**
 * Préchauffe anticipée (SPEC §14) : « ce preset, à cette heure », et assez tôt pour y être.
 *
 * Deux mécanismes indépendants vivent ici.
 *
 * 1. Les CIBLES : à chaque pas, la plus proche est comparée à l'avance nécessaire. Quand
 *    `nowMs ≥ atMs − avance`, son preset est appliqué exactement comme un `set_preset` — c'est le
 *    noyau qui fait la bascule, avant la résolution de la consigne, pour que le pas qui bascule
 *    régule déjà sur le nouveau preset.
 * 2. L'APPRENTISSAGE : chaque remontée de température observée en régulation nominale est un
 *    épisode. On en tire un temps mort (de la consigne à la première hausse visible) et une
 *    vitesse (de la première hausse à l'arrivée). Toute remontée compte, pas seulement celles d'une
 *    cible : le passage Éco → Confort de chaque matin suffit à apprendre.
 *
 * Toutes les comparaisons de température se font en DIXIÈMES ENTIERS. En flottant,
 * `16.2 >= 16.1 + 0.1` est faux : avec des sondes au dixième, un seuil sur deux raterait.
 *
 * Pur : aucune horloge, aucune minuterie, aucune mutation des arguments.
 */

import type {
  Demand, EpisodeRejectReason, PreheatEpisode, PreheatLearning, PreheatPreset, PreheatTarget,
  PresetTemps,
} from './types.mjs';
import {
  DEFAULT_PREHEAT_MAX_LEAD_MIN, PREHEAT_DEFAULT_DEAD_TIME_MIN, PREHEAT_DEFAULT_RATE_PER_HOUR,
  PREHEAT_EPISODE, PREHEAT_LEARNED_AFTER_EPISODES, PREHEAT_MAX_TARGETS,
  PREHEAT_UNLEARNED_MAX_LEAD_MIN,
} from './constants.mjs';

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;

export const PREHEAT_PRESETS: readonly PreheatPreset[] = ['frost', 'eco', 'comfort', 'boost'];

/** Une température en dixièmes entiers : la seule forme sous laquelle on la compare. */
export function tenths(value: number): number {
  return Math.round(value * 10);
}

export function createPreheatLearning(): PreheatLearning {
  return {
    deadTimeMin: PREHEAT_DEFAULT_DEAD_TIME_MIN,
    ratePerHour: PREHEAT_DEFAULT_RATE_PER_HOUR,
    accepted: 0,
    rejected: 0,
    lastRejectReason: null,
    plateauTemp: null,
    history: [],
  };
}

// --- Avance -----------------------------------------------------------------

/**
 * Le plafond qui s'applique vraiment. Tant que rien n'est appris, le défaut prudent ne doit pas
 * faire démarrer la chaudière trois heures avant chaque cible : voir
 * `PREHEAT_UNLEARNED_MAX_LEAD_MIN`.
 */
export function effectiveMaxLeadMin(learning: PreheatLearning, maxLeadMin: number): number {
  const configured = Number.isFinite(maxLeadMin) && maxLeadMin >= 0 ? maxLeadMin : DEFAULT_PREHEAT_MAX_LEAD_MIN;
  return learning.accepted < PREHEAT_LEARNED_AFTER_EPISODES
    ? Math.min(configured, PREHEAT_UNLEARNED_MAX_LEAD_MIN)
    : configured;
}

/**
 * Minutes d'avance pour passer de `roomTemp` à `targetTemp`.
 *
 * Zéro quand la pièce y est déjà : le temps mort n'a de sens que s'il y a quelque chose à chauffer.
 * Une première rédaction l'ajoutait sans condition, et une pièce déjà à 22 °C basculait quinze
 * minutes avant l'heure pour rien.
 */
export function computeLeadMin(
  targetTemp: number,
  roomTemp: number,
  learning: PreheatLearning,
  maxLeadMin: number,
): number {
  const gapTenths = tenths(targetTemp) - tenths(roomTemp);
  if (gapTenths <= 0) return 0;

  const lead = learning.deadTimeMin + (gapTenths / 10 / learning.ratePerHour) * 60;
  return Math.min(effectiveMaxLeadMin(learning, maxLeadMin), Math.max(0, lead));
}

// --- Cibles -----------------------------------------------------------------

export interface PreheatTargetsInput {
  targets: readonly PreheatTarget[];
  learning: PreheatLearning;
  /** `null` quand l'avance ne doit pas être calculée : la cible bascule alors à `atMs` pile. */
  roomTemp: number | null;
  /** Consigne choisie AVANT la bascule : une cible qui ne la relève pas n'a rien à anticiper. */
  currentSetpoint: number;
  presetTemps: PresetTemps;
  maxLeadMin: number;
}

export interface PreheatTargetsResult {
  /** La cible qui bascule à ce pas, ou `null`. */
  fired: PreheatTarget | null;
  /** Avance calculée pour la cible qui bascule, en minutes. */
  leadMin: number;
  remaining: readonly PreheatTarget[];
  /** Instant où la cible suivante devra être réévaluée, `null` s'il n'y en a plus. */
  wakeUpAtMs: number | null;
}

/**
 * Évalue TOUTES les cibles et bascule la première, dans l'ordre des échéances, dont l'instant de
 * démarrage est atteint.
 *
 * Ne regarder que la plus proche faisait attendre une cible lointaine derrière elle : « Éco à 6 h »
 * (rien à anticiper) tenait « Confort à 6 h 30 » (90 min d'avance) jusqu'à 6 h, et la pièce
 * arrivait avec une heure de retard. Une seule bascule par pas : le preset est un état, deux
 * bascules dans le même pas n'en laisseraient voir qu'une.
 *
 * La température visée est celle du preset en PRÉSENCE, jamais sa variante absence : la nuit, une
 * présence au mouvement vaut souvent « absent », et calculer sur la température d'absence ferait
 * arriver en retard la personne qui se lève.
 */
export function stepPreheatTargets(input: PreheatTargetsInput, nowMs: number): PreheatTargetsResult {
  const starts = input.targets.map((target) => {
    /*
     * Seule une cible qui RELÈVE la consigne s'anticipe. « Éco à 22 h » dans un salon qui plafonne
     * sous l'Éco aurait sinon quitté le Confort trois quarts d'heure plus tôt : la préchauffe aurait
     * refroidi la pièce. Une cible qui baisse ou maintient la consigne bascule à son heure exacte.
     */
    const targetTemp = input.presetTemps[target.preset];
    const leadMin = input.roomTemp === null || tenths(targetTemp) <= tenths(input.currentSetpoint)
      ? 0
      : computeLeadMin(targetTemp, input.roomTemp, input.learning, input.maxLeadMin);
    return { target, leadMin, startAtMs: target.atMs - leadMin * MS_PER_MINUTE };
  });

  // Parmi les cibles dues, la plus TARDIVE l'emporte, et TOUTES les cibles antérieures tombent avec
  // elle, dues ou non : « Éco à 6 h » restée en attente après un Confort de 6 h 30 parti à 4 h 45
  // aurait rebasculé en Éco à 6 h, et la pièce aurait raté son Confort. `.at(-1)` suppose la liste
  // triée par échéance, ce que garantissent `addPreheatTarget` et `parsePreheatTargets`.
  const due = starts.filter((entry) => nowMs >= entry.startAtMs).at(-1);
  const pending = due === undefined ? starts : starts.filter((entry) => entry.target.atMs > due.target.atMs);
  // Calculé dans le même appel : une bascule n'impose pas un pas supplémentaire juste pour
  // regarder la suivante. Les restantes sont toutes postérieures à la plus tardive due : aucune
  // n'est due, le réveil est toujours dans le futur.
  const wakeUpAtMs = pending.length === 0 ? null : Math.min(...pending.map((entry) => entry.startAtMs));

  return {
    fired: due === undefined ? null : due.target,
    leadMin: due === undefined ? 0 : due.leadMin,
    remaining: pending.map((entry) => entry.target),
    wakeUpAtMs,
  };
}

/**
 * Ajoute une cible. Même échéance : elle remplace. Liste pleine : `null`, à l'appelant de le dire
 * — abandonner la plus lointaine en silence, c'était perdre peut-être celle qu'on vient de poser.
 */
export function addPreheatTarget(
  targets: readonly PreheatTarget[],
  target: PreheatTarget,
): readonly PreheatTarget[] | null {
  const others = targets.filter((existing) => existing.atMs !== target.atMs);
  if (others.length >= PREHEAT_MAX_TARGETS) return null;
  return [...others, target].sort((a, b) => a.atMs - b.atMs);
}

/**
 * Les cibles qui survivent à un changement manuel fait à `nowMs`.
 *
 * Une cible tombe quand `nowMs` est dans sa fenêtre de démarrage possible `[atMs − maxLead, atMs]`.
 * Régler 18 °C à 5 h 30 parce qu'on part tôt ne doit pas se faire écraser par le Confort de 7 h à
 * 5 h 45. Le flow « Éco à 22 h », lui, vient bien avant la fenêtre : la cible du matin survit.
 *
 * `maxLead` est le RÉGLAGE, jamais le plafond effectif d'avant apprentissage : la règle ne doit
 * dépendre ni de l'avance du moment ni du nombre d'épisodes appris.
 */
export function targetsAfterManualChange(
  targets: readonly PreheatTarget[],
  nowMs: number,
  maxLeadMin: number,
): readonly PreheatTarget[] {
  const windowMs = maxLeadMin * MS_PER_MINUTE;
  return targets.filter((target) => !(nowMs >= target.atMs - windowMs && nowMs <= target.atMs));
}

// --- Épisodes ---------------------------------------------------------------

export interface EpisodeObservation {
  /** `null` quand le capteur de pièce est muet au sens du noyau. */
  roomTemp: number | null;
  /** Instant de la MESURE : Homey ne date une lecture qu'à son changement. */
  roomAtMs: number | null;
  outdoorTemp: number | null;
  /** Consigne effective du pas. */
  setpoint: number;
  /** Consigne effective du pas précédent, `null` au premier pas depuis le démarrage. */
  previousSetpoint: number | null;
  /** Faux dès qu'une décision coupe ou abaisse la chauffe : arrêt, mode central, fenêtre. */
  regulating: boolean;
  demand: Demand;
  /** Capteur de pièce = émetteur : aucun apprentissage possible. */
  excluded: boolean;
}

export interface EpisodeResult {
  episode: PreheatEpisode | null;
  learning: PreheatLearning;
}

function reject(learning: PreheatLearning, reason: EpisodeRejectReason): EpisodeResult {
  return {
    episode: null,
    learning: { ...learning, rejected: learning.rejected + 1, lastRejectReason: reason },
  };
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Intègre un épisode terminé. Le premier remplace le défaut, le deuxième fait la moyenne, puis la
 * moyenne glissante prend le relais : sans ce départ en 1/n, il faudrait cinq à sept matins pour
 * effacer une valeur par défaut que rien ne justifie.
 */
function accept(
  learning: PreheatLearning,
  episode: PreheatEpisode,
  endTemp: number,
  endAtMs: number,
  plateau: boolean,
): EpisodeResult {
  const { riseAtMs, riseTemp } = episode;
  if (riseAtMs === null || riseTemp === null) return reject(learning, 'too_small');

  if (tenths(endTemp) - tenths(episode.startTemp) < tenths(PREHEAT_EPISODE.minRise)) {
    return reject(learning, 'too_small');
  }

  // Frémissement et arrivée sur la MÊME lecture : une sonde qui ne rapporte qu'à grands pas. La
  // montée n'a pas pu être chronométrée — ce n'est pas une vitesse aberrante, c'est une sonde trop
  // grossière, et le motif affiché doit le dire.
  if (endAtMs <= riseAtMs) return reject(learning, 'coarse');

  const riseHours = (endAtMs - riseAtMs) / MS_PER_HOUR;
  const ratePerHour = (endTemp - riseTemp) / riseHours;
  if (!(ratePerHour >= PREHEAT_EPISODE.minRatePerHour && ratePerHour <= PREHEAT_EPISODE.maxRatePerHour)) {
    return reject(learning, 'rate');
  }
  const deadTimeMin = Math.max(0, (riseAtMs - episode.startMs) / MS_PER_MINUTE);

  const weight = Math.max(PREHEAT_EPISODE.minWeight, 1 / (learning.accepted + 1));
  const outdoorMean = episode.outdoorCount > 0 ? round(episode.outdoorSum / episode.outdoorCount, 1) : null;

  return {
    episode: null,
    learning: {
      ...learning,
      deadTimeMin: round((1 - weight) * learning.deadTimeMin + weight * deadTimeMin, 2),
      ratePerHour: round((1 - weight) * learning.ratePerHour + weight * ratePerHour, 3),
      accepted: learning.accepted + 1,
      plateauTemp: plateau ? round(endTemp, 1) : null,
      history: [
        ...learning.history,
        {
          atMs: endAtMs, ratePerHour: round(ratePerHour, 3), deadTimeMin: round(deadTimeMin, 2), outdoorMean,
        },
      ].slice(-PREHEAT_EPISODE.historySize),
    },
  };
}

/**
 * Un pas d'observation.
 *
 * Début : la consigne effective vient de CHANGER et dépasse la pièce d'au moins `minGap`, en
 * régulation nominale. Un écart qui dure sans changement de consigne n'est pas une remontée : une
 * pièce qui plafonne sous sa consigne rouvrirait sinon un épisode après chaque fin, et le moindre
 * rayon de soleil s'y lirait comme une vitesse de chauffe de 0,2 °C/h.
 * Frémissement : première lecture ≥ départ + 0,1 °C — elle date le temps mort.
 * Fin : la pièce atteint la consigne moins `endMargin`, OU plafonne — aucune lecture
 * ≥ maximum + 0,1 °C depuis `plateauMs`. Dans ce second cas, la montée s'arrête à la PREMIÈRE
 * atteinte du maximum : compter le palier dans la montée diluerait la vitesse de moitié.
 *
 * Tout épisode écarté est COMPTÉ avec son motif : un apprentissage qui n'aboutit jamais doit se
 * voir, pas laisser l'app tourner indéfiniment sur ses valeurs par défaut.
 */
export function stepEpisode(
  episode: PreheatEpisode | null,
  learning: PreheatLearning,
  obs: EpisodeObservation,
  nowMs: number,
): EpisodeResult {
  if (obs.excluded) return { episode: null, learning };

  /*
   * Consigne changée pendant un épisode : la montée observée est REMPLACÉE par une autre, qui part
   * dans ce même pas. Ce n'est pas une mesure douteuse — la cible du matin qui relève l'Éco de la
   * nuit le fait tous les jours — donc rien n'est compté. Rouvrir au pas suivant datait le départ un
   * cycle trop tard, et le temps mort appris d'autant trop court.
   */
  const changed = episode !== null && tenths(obs.setpoint) !== tenths(episode.setpoint);
  const current = changed ? null : episode;
  // Une consigne ABAISSÉE en route (fenêtre, arrêt central, Éco du soir) interrompt la montée : elle
  // est comptée, sinon une pièce aux fenêtres souvent ouvertes n'apprendrait jamais sans dire pourquoi.
  const base = changed && episode !== null && tenths(obs.setpoint) < tenths(episode.setpoint)
    ? reject(learning, 'interrupted').learning
    : learning;

  if (current === null) {
    const idle: EpisodeResult = { episode: null, learning: base };
    if (!obs.regulating || obs.roomTemp === null) return idle;
    if (obs.previousSetpoint === null || tenths(obs.setpoint) === tenths(obs.previousSetpoint)) return idle;
    if (tenths(obs.setpoint) - tenths(obs.roomTemp) < tenths(PREHEAT_EPISODE.minGap)) return idle;

    return {
      episode: {
        // Le début est l'instant de la DÉCISION (le pas où l'écart apparaît), pas celui de la
        // dernière mesure : c'est de là que court le temps mort.
        startMs: nowMs,
        startTemp: obs.roomTemp,
        setpoint: obs.setpoint,
        riseAtMs: null,
        riseTemp: null,
        maxTemp: obs.roomTemp,
        maxAtMs: obs.roomAtMs ?? nowMs,
        demandSeen: obs.demand.kind === 'active',
        outdoorSum: obs.outdoorTemp ?? 0,
        outdoorCount: obs.outdoorTemp === null ? 0 : 1,
      },
      learning: base,
    };
  }

  if (!obs.regulating) return reject(learning, 'interrupted');
  if (obs.roomTemp === null) return reject(learning, 'sensor');
  if (nowMs - current.startMs > PREHEAT_EPISODE.maxDurationMs) return reject(learning, 'too_long');

  const room = obs.roomTemp;
  const atMs = obs.roomAtMs ?? nowMs;
  const step = tenths(PREHEAT_EPISODE.riseStep);
  let next: PreheatEpisode = {
    ...current,
    demandSeen: current.demandSeen || obs.demand.kind === 'active',
    outdoorSum: current.outdoorSum + (obs.outdoorTemp ?? 0),
    outdoorCount: current.outdoorCount + (obs.outdoorTemp === null ? 0 : 1),
  };

  // Une demande `unknown` (tête en mode consigne qui n'a pas encore répondu) est neutre : elle ne
  // marque pas la demande vue, sans rejeter pour autant. Une montée sans AUCUNE demande vue est
  // rejetée à l'arrivée, motif `demand`.
  // Une hausse avant toute demande est ignorée, pas rejetée : en mode consigne, la tête peut ne
  // signaler qu'elle chauffe qu'au cycle suivant. Le frémissement attend la première demande vue.
  if (next.riseAtMs === null && next.demandSeen && tenths(room) >= tenths(next.startTemp) + step) {
    next = { ...next, riseAtMs: atMs, riseTemp: room };
  }
  if (tenths(room) >= tenths(next.maxTemp) + step) {
    next = { ...next, maxTemp: room, maxAtMs: atMs };
  }

  if (tenths(room) >= tenths(next.setpoint) - tenths(PREHEAT_EPISODE.endMargin)) {
    // Arrivée sans frémissement daté : soit la pièce n'a jamais demandé de chaleur (le soleil, un
    // four), soit la sonde a sauté d'un coup du départ à l'arrivée.
    if (next.riseAtMs === null) return reject(learning, next.demandSeen ? 'coarse' : 'demand');
    return accept(learning, next, room, atMs, false);
  }
  if (
    next.riseAtMs !== null
    && tenths(next.maxTemp) - tenths(next.startTemp) >= tenths(PREHEAT_EPISODE.minRise)
    && nowMs - next.maxAtMs >= PREHEAT_EPISODE.plateauMs
  ) {
    return accept(learning, next, next.maxTemp, next.maxAtMs, true);
  }

  return { episode: next, learning };
}
