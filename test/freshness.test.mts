import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SEEN_STABLE_MAX_MS, computeStale, deviceReportedAtMs, resolveTimestamp, toEpochMs,
} from '../lib/freshness.mjs';
import type { TimestampCandidates } from '../lib/freshness.mjs';

const MINUTE = 60_000;

const NONE: TimestampCandidates = {
  lastUpdatedMs: null,
  lastChangedMs: null,
  listenerFiredAtMs: null,
};

// --- toEpochMs -------------------------------------------------------------

test('toEpochMs accepte les trois formes que homey-api produit réellement', () => {
  assert.equal(toEpochMs(new Date(1_700_000_000_000)), 1_700_000_000_000);
  assert.equal(toEpochMs(1_700_000_000_000), 1_700_000_000_000);
  assert.equal(toEpochMs('2023-11-14T22:13:20.000Z'), 1_700_000_000_000);
});

test('toEpochMs refuse tout ce qui ne date rien', () => {
  assert.equal(toEpochMs(null), null);
  assert.equal(toEpochMs(undefined), null);
  assert.equal(toEpochMs(''), null);
  assert.equal(toEpochMs('pas une date'), null);
  assert.equal(toEpochMs(new Date('invalide')), null);
  assert.equal(toEpochMs(Number.NaN), null);
  assert.equal(toEpochMs(0), null);
  assert.equal(toEpochMs(-1), null);
  assert.equal(toEpochMs({}), null);
});

// --- resolveTimestamp ------------------------------------------------------

test('priorité 1 : lastUpdated l\'emporte sur les deux autres', () => {
  const resolved = resolveTimestamp({ lastUpdatedMs: 100, lastChangedMs: 200, listenerFiredAtMs: 300 });
  assert.deepStrictEqual(resolved, { atMs: 100, source: 'lastUpdated' });
});

test('priorité 2 : lastChanged prend le relais quand lastUpdated manque', () => {
  const resolved = resolveTimestamp({ lastUpdatedMs: null, lastChangedMs: 200, listenerFiredAtMs: 300 });
  assert.deepStrictEqual(resolved, { atMs: 200, source: 'lastChanged' });
});

test('priorité 3 : l\'instant du listener est le dernier recours', () => {
  const resolved = resolveTimestamp({ lastUpdatedMs: null, lastChangedMs: null, listenerFiredAtMs: 300 });
  assert.deepStrictEqual(resolved, { atMs: 300, source: 'listener' });
});

test('aucune source : null, et surtout pas l\'instant courant', () => {
  assert.equal(resolveTimestamp(NONE), null);
});

// --- computeStale ----------------------------------------------------------

test('lecture récente sous le seuil : fraîche', () => {
  const stale = computeStale({ atMs: 0, nowMs: 10 * MINUTE, freshnessMs: 20 * MINUTE, available: true });
  assert.equal(stale, false);
});

test('lecture exactement au seuil : encore fraîche', () => {
  const stale = computeStale({ atMs: 0, nowMs: 20 * MINUTE, freshnessMs: 20 * MINUTE, available: true });
  assert.equal(stale, false);
});

test('lecture au-delà du seuil : périmée', () => {
  const stale = computeStale({ atMs: 0, nowMs: 20 * MINUTE + 1, freshnessMs: 20 * MINUTE, available: true });
  assert.equal(stale, true);
});

test('le seuil vient de l\'appelant : le même âge est périmé pour un capteur de température et frais pour un contact de fenêtre', () => {
  const atMs = 0;
  const nowMs = 6 * 60 * MINUTE; // six heures
  assert.equal(computeStale({ atMs, nowMs, freshnessMs: 20 * MINUTE, available: true }), true);
  assert.equal(computeStale({ atMs, nowMs, freshnessMs: 3 * 24 * 60 * MINUTE, available: true }), false);
});

test('appareil indisponible : périmé quel que soit l\'âge, même horodaté à l\'instant', () => {
  const stale = computeStale({ atMs: 1_000, nowMs: 1_000, freshnessMs: 20 * MINUTE, available: false });
  assert.equal(stale, true);
});

test('freshnessMs infini : jamais périmé tant que l\'appareil répond', () => {
  const stale = computeStale({ atMs: 0, nowMs: 10 ** 12, freshnessMs: Infinity, available: true });
  assert.equal(stale, false);
});

test('horodatage dans le futur (dérive d\'horloge) : traité comme frais, pas comme périmé', () => {
  const stale = computeStale({ atMs: 10 * MINUTE, nowMs: 0, freshnessMs: MINUTE, available: true });
  assert.equal(stale, false);
});

// --- deviceReportedAtMs ----------------------------------------------------

test('Netatmo stable : une température inchangée reste fraîche tant que le module remonte son CO2', () => {
  // Relevé de la salle de bain le 2026-10-26 : 18,6 °C datés de 04:30, CO2 et batterie de 06:00.
  const reportedAtMs = deviceReportedAtMs({
    measure_temperature: { lastUpdated: '2026-10-26T04:30:46.723Z' },
    measure_co2: { lastUpdated: '2026-10-26T06:00:47.302Z' },
    measure_battery: { lastUpdated: '2026-10-26T06:00:47.301Z' },
  });
  const atMs = Date.parse('2026-10-26T04:30:46.723Z');
  const nowMs = Date.parse('2026-10-26T06:03:19.490Z');
  const freshnessMs = 60 * MINUTE;

  assert.equal(computeStale({ atMs, nowMs, freshnessMs, available: true }), true, 'sans signe de vie');
  assert.equal(computeStale({ atMs, nowMs, freshnessMs, available: true, deviceReportedAtMs: reportedAtMs }), false);
});

test('nos propres écritures ne sont pas un signe de vie : les capabilities inscriptibles sont ignorées', () => {
  // Une TRVZB capteur de pièce : l'app lui écrit sa consigne, sa sonde, elle, s'est tue.
  const reportedAtMs = deviceReportedAtMs({
    measure_temperature: { lastUpdated: 1_000, setable: false },
    target_temperature: { lastUpdated: 9_000_000, setable: true },
    onoff: { lastUpdated: 9_000_000, setable: true },
  });
  assert.equal(reportedAtMs, 1_000);
});

test('aucune capability datable : aucun signe de vie', () => {
  assert.equal(deviceReportedAtMs(undefined), null);
  assert.equal(deviceReportedAtMs({ measure_temperature: { lastUpdated: null } }), null);
});

test('un signe de vie ne rend pas frais un appareil indisponible', () => {
  const stale = computeStale({ atMs: 0, nowMs: 10 * MINUTE, freshnessMs: MINUTE, available: false, deviceReportedAtMs: 10 * MINUTE });
  assert.equal(stale, true);
});

test('un signe de vie plus ancien que la mesure ne la vieillit pas', () => {
  const stale = computeStale({ atMs: 10 * MINUTE, nowMs: 11 * MINUTE, freshnessMs: 5 * MINUTE, available: true, deviceReportedAtMs: 0 });
  assert.equal(stale, false);
});

test('appareil muet tout entier : la mesure se périme comme avant', () => {
  const stale = computeStale({ atMs: 0, nowMs: 90 * MINUTE, freshnessMs: 60 * MINUTE, available: true, deviceReportedAtMs: 5 * MINUTE });
  assert.equal(stale, true);
});

// --- deviceSeenAtMs ----------------------------------------------------------

test('détecteur frient vu il y a 5 min, 18,6 °C inchangé depuis 95 min : la mesure reste vraie', () => {
  const nowMs = 10 * 60 * MINUTE;
  const stale = computeStale({
    atMs: nowMs - 95 * MINUTE, nowMs, freshnessMs: 60 * MINUTE, available: true,
    deviceReportedAtMs: nowMs - 95 * MINUTE, deviceSeenAtMs: nowMs - 5 * MINUTE,
  });
  assert.equal(stale, false);
});

test('vu à la minute mais figé depuis six semaines : périmé quand même', () => {
  // La TRVZB du pilote Sonoff officiel : joignable, et morte.
  const nowMs = 43 * 24 * 60 * MINUTE;
  const stale = computeStale({
    atMs: 0, nowMs, freshnessMs: 60 * MINUTE, available: true, deviceSeenAtMs: nowMs - MINUTE,
  });
  assert.equal(stale, true);
});

test('la grâce de `lastSeenAt` s\'arrête net à six heures', () => {
  const nowMs = 24 * 60 * MINUTE;
  const at = (ageMs: number): boolean => computeStale({
    atMs: nowMs - ageMs, nowMs, freshnessMs: 60 * MINUTE, available: true, deviceSeenAtMs: nowMs,
  });
  assert.equal(at(SEEN_STABLE_MAX_MS), false);
  assert.equal(at(SEEN_STABLE_MAX_MS + 1), true);
});

test('un appareil qui n\'a pas été vu récemment n\'obtient aucune grâce', () => {
  const nowMs = 10 * 60 * MINUTE;
  const stale = computeStale({
    atMs: nowMs - 95 * MINUTE, nowMs, freshnessMs: 60 * MINUTE, available: true,
    deviceSeenAtMs: nowMs - 90 * MINUTE,
  });
  assert.equal(stale, true);
});

test('vu récemment mais indisponible : périmé', () => {
  const stale = computeStale({
    atMs: 0, nowMs: 90 * MINUTE, freshnessMs: 60 * MINUTE, available: false, deviceSeenAtMs: 90 * MINUTE,
  });
  assert.equal(stale, true);
});

test('horodatage aberrant : périmé plutôt que frais', () => {
  assert.equal(computeStale({ atMs: Number.NaN, nowMs: 0, freshnessMs: MINUTE, available: true }), true);
  assert.equal(computeStale({ atMs: 0, nowMs: Number.NaN, freshnessMs: MINUTE, available: true }), true);
});
