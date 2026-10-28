/**
 * Préchauffe anticipée (SPEC §14) : avance, cibles, apprentissage par épisodes.
 *
 * Les valeurs attendues sont calculées à la main dans chaque test, pas relues du code : un test qui
 * recopie la formule qu'il vérifie ne vérifie rien.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addPreheatTarget, computeLeadMin, createPreheatLearning, fitOutdoorRateModel, predictRate, rateFor,
  stepEpisode, stepPreheatTargets, targetsAfterManualChange, type EpisodeObservation,
} from '../lib/preheat.mjs';
import type { PreheatEpisode, PreheatLearning, PreheatTarget, PresetTemps } from '../lib/types.mjs';

const MIN = 60_000;
const TEMPS: PresetTemps = {
  frost: 7, eco: 17, comfort: 22, boost: 23,
};

function learned(overrides: Partial<PreheatLearning> = {}): PreheatLearning {
  return { ...createPreheatLearning(), accepted: 3, ...overrides };
}

function near(actual: number, expected: number, message?: string): void {
  assert.ok(Math.abs(actual - expected) < 1e-9, message ?? `${actual} ≉ ${expected}`);
}

// --- Avance -----------------------------------------------------------------

test('critère 2 : 19 → 22 °C avec les défauts, 15 + 3 × 60 = 195 min, borné à 180 une fois appris', () => {
  assert.equal(computeLeadMin(22, 19, learned(), 180), 180);
  assert.equal(computeLeadMin(22, 19, learned(), 240), 195, 'sous un plafond plus large, la formule brute');
});

test('critère 2 : tant que moins de 3 remontées sont apprises, l\'avance est plafonnée à 90 min', () => {
  assert.equal(computeLeadMin(22, 19, createPreheatLearning(), 180), 90);
  assert.equal(computeLeadMin(22, 19, learned({ accepted: 2 }), 180), 90);
  assert.equal(computeLeadMin(22, 19, learned({ accepted: 3 }), 180), 180);
});

test('critère 3 : pièce déjà à la consigne visée, aucune avance — pas même le temps mort', () => {
  assert.equal(computeLeadMin(22, 22, learned(), 180), 0);
  assert.equal(computeLeadMin(22, 22.4, learned(), 180), 0);
});

test('l\'avance suit la vitesse apprise : 2 °C à 2 °C/h après 10 min de temps mort = 70 min', () => {
  assert.equal(computeLeadMin(22, 20, learned({ ratePerHour: 2, deadTimeMin: 10 }), 180), 70);
});

// --- Cibles -----------------------------------------------------------------

test('la cible bascule dès que maintenant ≥ échéance − avance, et pas avant', () => {
  const atMs = 600 * MIN;
  const targets: PreheatTarget[] = [{ preset: 'comfort', atMs }];
  const input = {
    targets, learning: learned({ ratePerHour: 2, deadTimeMin: 10 }), roomTemp: 20, currentSetpoint: 17,
    presetTemps: TEMPS, maxLeadMin: 180,
  };

  const early = stepPreheatTargets(input, atMs - 71 * MIN);
  assert.equal(early.fired, null);
  assert.equal(early.wakeUpAtMs, atMs - 70 * MIN, 'le réveil vise l\'instant de démarrage calculé');
  assert.deepEqual(early.remaining, targets);

  const due = stepPreheatTargets(input, atMs - 70 * MIN);
  assert.deepEqual(due.fired, targets[0]);
  assert.equal(due.leadMin, 70);
  assert.deepEqual(due.remaining, []);
  assert.equal(due.wakeUpAtMs, null);
});

test('sans avance calculable (roomTemp null), la cible bascule à son heure exacte', () => {
  const atMs = 600 * MIN;
  const input = {
    targets: [{ preset: 'comfort' as const, atMs }], learning: learned(), roomTemp: null, currentSetpoint: 17,
    presetTemps: TEMPS, maxLeadMin: 180,
  };
  assert.equal(stepPreheatTargets(input, atMs - 1).fired, null);
  assert.notEqual(stepPreheatTargets(input, atMs).fired, null);
});

test('critère 7 : cinq cibles, la cinquième est refusée et la liste reste intacte', () => {
  let targets: readonly PreheatTarget[] = [];
  for (const atMs of [10, 20, 30, 40]) {
    const next = addPreheatTarget(targets, { preset: 'comfort', atMs });
    assert.notEqual(next, null);
    targets = next!;
  }
  assert.equal(addPreheatTarget(targets, { preset: 'boost', atMs: 50 }), null);
  assert.equal(targets.length, 4);
});

test('une cible à la même échéance remplace l\'ancienne, même liste pleine ; la liste reste triée', () => {
  const targets: PreheatTarget[] = [
    { preset: 'comfort', atMs: 40 }, { preset: 'eco', atMs: 10 },
  ];
  assert.deepEqual(addPreheatTarget(targets, { preset: 'boost', atMs: 20 }), [
    { preset: 'eco', atMs: 10 }, { preset: 'boost', atMs: 20 }, { preset: 'comfort', atMs: 40 },
  ]);
  const full: PreheatTarget[] = [10, 20, 30, 40].map((atMs) => ({ preset: 'comfort', atMs }));
  assert.deepEqual(addPreheatTarget(full, { preset: 'boost', atMs: 30 })?.[2], { preset: 'boost', atMs: 30 });
});

test('critère 8 : un changement manuel annule la cible dans [échéance − maxLead, échéance], pas avant', () => {
  const at7h = 7 * 60 * MIN;
  const targets: PreheatTarget[] = [{ preset: 'comfort', atMs: at7h }];

  // 05:30 : dans la fenêtre de 180 min.
  assert.deepEqual(targetsAfterManualChange(targets, at7h - 90 * MIN, 180), []);
  // 22:00 la veille : bien avant.
  assert.deepEqual(targetsAfterManualChange(targets, at7h - 9 * 60 * MIN, 180), targets);
  // Après l'échéance (la cible a dû basculer) : rien n'est retiré par cette règle.
  assert.deepEqual(targetsAfterManualChange(targets, at7h + MIN, 180), targets);
});

// --- Épisodes ---------------------------------------------------------------

function observation(overrides: Partial<EpisodeObservation> = {}): EpisodeObservation {
  return {
    roomTemp: 19,
    roomAtMs: 0,
    outdoorTemp: 5,
    setpoint: 22,
    previousSetpoint: 22,
    regulating: true,
    demand: { kind: 'active', percent: 80 },
    excluded: false,
    ...overrides,
  };
}

/** Rejoue une suite de lectures `[minutes, température]`, un pas par lecture. */
function replay(
  readings: readonly (readonly [number, number])[],
  learning: PreheatLearning = createPreheatLearning(),
  extra: Partial<EpisodeObservation> = {},
): { episode: PreheatEpisode | null; learning: PreheatLearning } {
  let episode: PreheatEpisode | null = null;
  let current = learning;
  readings.forEach(([minutes, temp], index) => {
    const setpoint = extra.setpoint ?? 22;
    // Le premier pas est celui où la consigne CHANGE : c'est lui qui ouvre l'épisode.
    const previousSetpoint = index === 0 ? setpoint - 5 : setpoint;
    const result = stepEpisode(
      episode,
      current,
      observation({
        roomTemp: temp, roomAtMs: minutes * MIN, previousSetpoint, ...extra,
      }),
      minutes * MIN,
    );
    episode = result.episode;
    current = result.learning;
  });
  return { episode, learning: current };
}

test('critère 11 : premier épisode, il remplace le défaut — 12 min de temps mort, 1,5 °C/h', () => {
  const { episode, learning } = replay([[0, 19.0], [12, 19.1], [60, 20.5], [120, 21.8]]);
  assert.equal(episode, null, 'l\'épisode est clos');
  assert.equal(learning.accepted, 1);
  near(learning.deadTimeMin, 12);
  // (21,8 − 19,1) / 1,8 h
  near(learning.ratePerHour, 1.5);
  assert.equal(learning.plateauTemp, null);
  assert.equal(learning.history.length, 1);
  assert.equal(learning.history[0]?.outdoorMean, 5);
});

test('critère 11 : le deuxième épisode fait la moyenne — 2,0 °C/h et 8 min donnent 1,75 et 10', () => {
  const first = replay([[0, 19.0], [12, 19.1], [120, 21.8]]).learning;
  const { learning } = replay([[0, 19.0], [8, 19.1], [89, 21.8]], first);
  assert.equal(learning.accepted, 2);
  near(learning.ratePerHour, 1.75);
  near(learning.deadTimeMin, 10);
});

test('critère 12 : la pièce plafonne, la montée s\'arrête à la première atteinte du maximum', () => {
  const readings: [number, number][] = [[0, 19.0], [10, 19.1], [70, 20.6]];
  for (let minute = 75; minute <= 110; minute += 5) readings.push([minute, 20.6]);

  const before = replay(readings);
  assert.notEqual(before.episode, null, 'à +110 min, le palier ne dure que 40 min');
  assert.equal(before.learning.accepted, 0);

  // Les lectures inchangées gardent leur date de changement : Homey ne date qu'au changement.
  const after = stepEpisode(
    before.episode,
    before.learning,
    observation({ roomTemp: 20.6, roomAtMs: 70 * MIN }),
    115 * MIN,
  );
  assert.equal(after.episode, null);
  assert.equal(after.learning.accepted, 1);
  near(after.learning.deadTimeMin, 10);
  near(after.learning.ratePerHour, 1.5, '(20,6 − 19,1) / 1 h, sans le palier');
  assert.equal(after.learning.plateauTemp, 20.6);
});

test('critère 13 : fenêtre ouverte au milieu, épisode rejeté et compté, apprentissage inchangé', () => {
  const started = replay([[0, 19.0], [12, 19.1]]);
  const result = stepEpisode(started.episode, started.learning, observation({ roomTemp: 19.5, regulating: false }), 30 * MIN);
  assert.equal(result.episode, null);
  assert.equal(result.learning.rejected, 1);
  assert.equal(result.learning.lastRejectReason, 'interrupted');
  assert.equal(result.learning.ratePerHour, createPreheatLearning().ratePerHour);
});

test('critère 13 : demande unknown tout du long, rejet motif demand à l\'arrivée', () => {
  const { learning } = replay([[0, 19.0], [12, 19.1], [120, 21.8]], createPreheatLearning(), { demand: { kind: 'unknown' } });
  assert.equal(learning.lastRejectReason, 'demand');
});

test('une demande unknown isolée ne rejette pas la remontée : la tête n\'a pas encore répondu', () => {
  const started = replay([[0, 19.0]]);
  const blip = stepEpisode(started.episode, started.learning, observation({ roomTemp: 19.0, demand: { kind: 'unknown' } }), 5 * MIN);
  assert.notEqual(blip.episode, null);
  assert.equal(blip.learning.rejected, 0);
});

test('consigne abaissée en route (fenêtre, Éco du soir) : la remontée est comptée interrompue', () => {
  const started = replay([[0, 19.0], [12, 19.1]]);
  const result = stepEpisode(started.episode, started.learning, observation({ setpoint: 7, previousSetpoint: 22 }), 20 * MIN);
  assert.equal(result.episode, null);
  assert.equal(result.learning.lastRejectReason, 'interrupted');
});

test('une hausse avant toute demande est ignorée, pas rejetée : la tête peut signaler en retard', () => {
  const { episode, learning } = replay([[0, 19.0], [20, 19.3]], createPreheatLearning(), { demand: { kind: 'inactive' } });
  assert.notEqual(episode, null);
  assert.equal(episode?.riseAtMs, null);
  assert.equal(learning.rejected, 0);
});

test('arrivée à la consigne sans aucune demande de chaleur : rejet motif demand', () => {
  const { learning } = replay([[0, 19.0], [20, 19.3], [90, 21.8]], createPreheatLearning(), { demand: { kind: 'inactive' } });
  assert.equal(learning.lastRejectReason, 'demand');
});

test('critère 13 : capteur de pièce = émetteur, aucun épisode ne s\'ouvre', () => {
  const { episode, learning } = replay([[0, 19.0], [12, 19.1], [120, 21.8]], createPreheatLearning(), { excluded: true });
  assert.equal(episode, null);
  assert.deepEqual(learning, createPreheatLearning());
});

test('pas d\'épisode sous un écart de 1 °C, hors régulation nominale, ni sans changement de consigne', () => {
  const changed = { previousSetpoint: 17 };
  assert.equal(stepEpisode(null, createPreheatLearning(), observation({ roomTemp: 21.1, ...changed }), 0).episode, null);
  assert.equal(stepEpisode(null, createPreheatLearning(), observation({ regulating: false, ...changed }), 0).episode, null);
  assert.equal(stepEpisode(null, createPreheatLearning(), observation({ roomTemp: 19 }), 0).episode, null,
    'un écart qui dure sans changement de consigne n\'est pas une remontée');
  assert.equal(stepEpisode(null, createPreheatLearning(), observation({ previousSetpoint: null }), 0).episode, null,
    'premier pas après un démarrage : aucune consigne précédente');
  assert.notEqual(stepEpisode(null, createPreheatLearning(), observation({ roomTemp: 21.0, ...changed }), 0).episode, null,
    'pile 1 °C d\'écart : l\'épisode s\'ouvre');
});

test('consigne changée en route : l\'épisode est remplacé dans le même pas, sans rejet compté', () => {
  const started = replay([[0, 19.0]]);
  const result = stepEpisode(started.episode, started.learning, observation({ setpoint: 23, previousSetpoint: 22 }), 5 * MIN);
  assert.equal(result.learning.rejected, 0);
  assert.equal(result.episode?.startMs, 5 * MIN, 'le temps mort court depuis le changement, pas un cycle plus tard');
  assert.equal(result.episode?.setpoint, 23);
});

test('après une fin sur plateau, aucun épisode parasite ne se rouvre sans changement de consigne', () => {
  const readings: [number, number][] = [[0, 19.0], [10, 19.1], [70, 20.6], [115, 20.6], [120, 20.6], [300, 21.2]];
  let episode: PreheatEpisode | null = null;
  let learning = createPreheatLearning();
  readings.forEach(([minutes, temp], index) => {
    const atMs = minutes === 115 || minutes === 120 ? 70 * MIN : minutes * MIN;
    const result = stepEpisode(episode, learning, observation({
      roomTemp: temp, roomAtMs: atMs, previousSetpoint: index === 0 ? 17 : 22,
    }), minutes * MIN);
    episode = result.episode;
    learning = result.learning;
  });
  assert.equal(learning.accepted, 1, 'seul le vrai plateau est appris');
  assert.equal(learning.rejected, 0);
  near(learning.ratePerHour, 1.5, 'le soleil de l\'après-midi n\'a pas été lu comme 0,2 °C/h');
});

test('sonde à grands pas : frémissement et arrivée sur la même lecture, rejet motif coarse', () => {
  const { learning } = replay([[0, 21.0], [40, 21.8]]);
  assert.equal(learning.lastRejectReason, 'coarse');
});

test('une cible qui BAISSE la consigne ne s\'anticipe pas : Éco à 22 h depuis Confort bascule à 22 h pile', () => {
  const atMs = 22 * 60 * MIN;
  const input = {
    targets: [{ preset: 'eco' as const, atMs }],
    learning: learned(),
    // La pièce plafonne à 16,5 °C, sous l'Éco : l'ancien calcul donnait 45 min d'avance.
    roomTemp: 16.5,
    currentSetpoint: 22,
    presetTemps: TEMPS,
    maxLeadMin: 180,
  };
  assert.equal(stepPreheatTargets(input, atMs - MIN).fired, null);
  assert.equal(stepPreheatTargets(input, atMs - MIN).wakeUpAtMs, atMs);
  assert.notEqual(stepPreheatTargets(input, atMs).fired, null);
  // Même chose depuis un boost ou une consigne manuelle au-dessus du Confort visé.
  const fromBoost = { ...input, targets: [{ preset: 'comfort' as const, atMs }], currentSetpoint: 23 };
  assert.equal(stepPreheatTargets(fromBoost, atMs - 60 * MIN).fired, null);
});

test('une cible lointaine qui demande plus d\'avance n\'attend pas derrière une plus proche', () => {
  const six = 6 * 60 * MIN;
  const input = {
    targets: [{ preset: 'eco' as const, atMs: six }, { preset: 'comfort' as const, atMs: six + 30 * MIN }],
    learning: learned(),
    roomTemp: 20.5,
    currentSetpoint: 17,
    presetTemps: TEMPS,
    maxLeadMin: 180,
  };
  // Confort : 15 + 1,5 × 60 = 105 min avant 6 h 30, donc 4 h 45. L'Éco de 6 h, lui, n'a rien à anticiper.
  const result = stepPreheatTargets(input, six + 30 * MIN - 105 * MIN);
  assert.equal(result.fired?.preset, 'comfort');
  assert.deepEqual(result.remaining, [], 'l\'Éco de 6 h est dépassée : elle rebasculerait la pièce en Éco');
  assert.equal(result.wakeUpAtMs, null);
});

test('plusieurs cibles dues à la fois (retour d\'arrêt) : la plus tardive part, les antérieures tombent', () => {
  const six = 6 * 60 * MIN;
  const input = {
    targets: [{ preset: 'eco' as const, atMs: six }, { preset: 'comfort' as const, atMs: six + 30 * MIN },
      { preset: 'eco' as const, atMs: 22 * 60 * MIN }],
    learning: learned(),
    roomTemp: 20.5,
    currentSetpoint: 17,
    presetTemps: TEMPS,
    maxLeadMin: 180,
  };
  const result = stepPreheatTargets(input, 7 * 60 * MIN);
  assert.equal(result.fired?.preset, 'comfort');
  assert.deepEqual(result.remaining, [{ preset: 'eco', atMs: 22 * 60 * MIN }]);
});

test('critère 18 : les seuils se comparent au dixième — départ 16,1, frémissement à 16,2', () => {
  const { episode } = replay([[0, 16.1], [10, 16.2]], createPreheatLearning(), { setpoint: 18 });
  assert.equal(episode?.riseAtMs, 10 * MIN, 'en flottant naïf, 16,2 ≥ 16,1 + 0,1 est faux');
});

test('critère 18 : fin à consigne − 0,2 — consigne 15,3 lecture 15,1, consigne 16,1 lecture 15,9', () => {
  const low = replay([[0, 14.0], [10, 14.1], [60, 15.1]], createPreheatLearning(), { setpoint: 15.3 });
  assert.equal(low.learning.accepted, 1, 'en flottant naïf, 15,1 ≥ 15,3 − 0,2 est faux');
  const high = replay([[0, 14.9], [10, 15.0], [60, 15.9]], createPreheatLearning(), { setpoint: 16.1 });
  assert.equal(high.learning.accepted, 1, 'en flottant naïf, 15,9 ≥ 16,1 − 0,2 est faux');
});

test('vitesse invraisemblable, rejet motif rate', () => {
  const { learning } = replay([[0, 19.0], [10, 19.1], [12, 21.8]]);
  assert.equal(learning.lastRejectReason, 'rate');
});

test('épisode qui dépasse 12 h, rejet motif too_long ; 7 h reste admis (chauffage au sol)', () => {
  const started = replay([[0, 19.0], [10, 19.1]]);
  const slow = stepEpisode(started.episode, started.learning, observation({ roomTemp: 19.2, roomAtMs: 420 * MIN }), 421 * MIN);
  assert.notEqual(slow.episode, null);
  assert.equal(slow.learning.rejected, 0);
  const result = stepEpisode(started.episode, started.learning, observation({ roomTemp: 19.2, roomAtMs: 700 * MIN }), 721 * MIN);
  assert.equal(result.learning.lastRejectReason, 'too_long');
});

// --- Modèle extérieur (lot 2) -------------------------------------------------

/** Historique d'épisodes `[T_ext, vitesse]`, au format persisté. */
function withHistory(points: [number | null, number][], overrides: Partial<PreheatLearning> = {}): PreheatLearning {
  return learned({
    ratePerHour: 1,
    history: points.map(([outdoorMean, ratePerHour], index) => ({
      atMs: index * 24 * 60 * MIN, ratePerHour, deadTimeMin: 15, outdoorMean,
    })),
    ...overrides,
  });
}

// Vitesse = 0,5 + 0,1 × T_ext, exactement : 0 °C → 0,5 ; 5 °C → 1,0 ; 10 °C → 1,5.
const LINE: [number, number][] = [[0, 0.5], [2, 0.7], [5, 1.0], [8, 1.3], [10, 1.5]];

test('modèle extérieur : la pente, le centre et les bornes d\'une droite exacte', () => {
  const model = fitOutdoorRateModel(withHistory(LINE));
  assert.notEqual(model, null);
  near(model!.slope, 0.1);
  near(model!.meanOutdoor, 5);
  assert.deepEqual([model!.minOutdoor, model!.maxOutdoor, model!.minRate, model!.maxRate], [0, 10, 0.5, 1.5]);
  assert.equal(model!.episodes, 5);
});

test('modèle extérieur : refusé sous 5 épisodes, sous 4 °C d\'écart, ou sans T_ext', () => {
  assert.equal(fitOutdoorRateModel(withHistory(LINE.slice(0, 4))), null);
  assert.equal(fitOutdoorRateModel(withHistory([[5, 1], [6, 1.1], [7, 1.2], [8, 1.3], [8.9, 1.4]])), null,
    '3,9 °C d\'écart : pas identifiable');
  assert.equal(fitOutdoorRateModel(withHistory([...LINE.slice(0, 4), [null, 3]])), null,
    'un épisode sans capteur extérieur ne compte pas');
});

test('modèle extérieur : une pente négative (plus vite par grand froid) est refusée', () => {
  assert.equal(fitOutdoorRateModel(withHistory([[0, 1.5], [2, 1.3], [5, 1.0], [8, 0.7], [10, 0.5]])), null);
});

test('modèle extérieur : cinq épisodes bruités (corrélation 0,47) ne font pas une pente', () => {
  assert.equal(fitOutdoorRateModel(withHistory([[4, 0.6], [5, 2.5], [6, 0.7], [7, 1.0], [8, 3.0]])), null);
});

test('modèle extérieur : une correction autour de la moyenne récente, pas son remplacement', () => {
  const model = fitOutdoorRateModel(withHistory(LINE))!;
  near(predictRate(model, 1.0, 0), 0.5);
  // La pièce est devenue plus lente ces derniers matins : moyenne 0,8. Au centre (5 °C), c'est elle
  // qui compte, pas les 1,0 °C/h des vieux épisodes.
  near(predictRate(model, 0.8, 5), 0.8);
  near(predictRate(model, 0.8, 8), 1.1);
});

test('modèle extérieur : jamais plus lent ni plus rapide que les matins mesurés', () => {
  const model = fitOutdoorRateModel(withHistory(LINE))!;
  // −10 °C → bornée à −2 °C : 1,0 − 0,7 = 0,3, relevée au plus lent mesuré, 0,5.
  near(predictRate(model, 1.0, -10), 0.5);
  // 30 °C → bornée à 12 °C : 1,0 + 0,7 = 1,7, abaissée au plus rapide mesuré, 1,5.
  near(predictRate(model, 1.0, 30), 1.5);
});

test('modèle extérieur : sans température dehors ou sans modèle, la moyenne du lot 1', () => {
  assert.equal(rateFor(withHistory(LINE, { ratePerHour: 0.9 }), null), 0.9);
  assert.equal(rateFor(withHistory(LINE.slice(0, 3), { ratePerHour: 0.9 }), 0), 0.9);
  near(rateFor(withHistory(LINE, { ratePerHour: 1.0 }), 0), 0.5);
});

test('modèle extérieur : l\'avance suit la vitesse qu\'on lui donne', () => {
  const learning = withHistory(LINE);
  // 2 °C à rattraper. À 0,5 °C/h : 15 + 240 = 255, plafonnés à 180. À 1,5 : 15 + 80 = 95.
  assert.equal(computeLeadMin(22, 20, learning, 180, 0.5), 180);
  near(computeLeadMin(22, 20, learning, 180, 1.5), 95);
  near(computeLeadMin(22, 20, learning, 180), 135, 'par défaut, la moyenne (1 °C/h)');
});

test('modèle extérieur : la cible part plus tôt un matin froid', () => {
  const atMs = 7 * 60 * MIN;
  const input = {
    targets: [{ preset: 'comfort' as const, atMs }],
    learning: withHistory(LINE),
    roomTemp: 21,
    currentSetpoint: 17,
    presetTemps: TEMPS,
    maxLeadMin: 180,
  };
  // 1 °C : à 10 °C dehors 15 + 40 = 55 min ; à 0 °C, 15 + 120 = 135 min.
  const at = atMs - 100 * MIN;
  assert.equal(stepPreheatTargets({ ...input, outdoorTemp: 10 }, at).fired, null);
  assert.equal(stepPreheatTargets({ ...input, outdoorTemp: 0 }, at).fired?.preset, 'comfort');
});

test('épisode : une T_ext lue sur moins de la moitié des pas n\'est pas enregistrée', () => {
  const series: [number, number, number | null][] = [[0, 19.0, 3], [12, 19.1, null], [60, 20.5, null], [120, 21.8, null]];
  const run = (outdoor: (index: number) => number | null): PreheatLearning => {
    let episode: PreheatEpisode | null = null;
    let learning = createPreheatLearning();
    series.forEach(([minutes, temp], index) => {
      const result = stepEpisode(episode, learning, observation({
        roomTemp: temp, roomAtMs: minutes * MIN, previousSetpoint: index === 0 ? 17 : 22, outdoorTemp: outdoor(index),
      }), minutes * MIN);
      episode = result.episode;
      learning = result.learning;
    });
    return learning;
  };
  const sparse = run((index) => series[index]![2]);
  assert.equal(sparse.accepted, 1);
  assert.equal(sparse.history[0]?.outdoorMean, null, 'une lecture sur quatre');
  const half = run((index) => (index % 2 === 0 ? 4 : null));
  assert.equal(half.history[0]?.outdoorMean, 4, 'deux sur quatre suffisent');
});
