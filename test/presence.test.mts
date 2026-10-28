/**
 * Présence du logement : lecture de `users.getUsers()` et délai avant absence.
 *
 * PANNES EMPÊCHÉES : un radar choisi comme source de présence qui vide le logement dès que personne
 * ne bouge, un logement déclaré vide sur une réponse sans utilisateur, et une absence de vacances
 * qui deviendrait périmée — donc « présente » — au bout du seuil de fraîcheur.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVITY_STUCK_MS, detectorActivityAtMs, holdAbsence, isMotionOnlyCapability, isPresenceMisused, parseUsersPresence,
  PRESENCE_SOURCE_ID, trueSinceMs,
} from '../lib/presence.mjs';

const MIN = 60_000;
const NOW = Date.parse('2026-10-28T14:00:00Z');

test('un seul utilisateur à la maison suffit', () => {
  const users = {
    a: { name: 'Vincent', enabled: true, present: false },
    b: { name: 'Solène', enabled: true, present: true },
  };
  assert.deepEqual(parseUsersPresence(users, NOW), { value: true, atMs: NOW });
});

test('tout le monde parti : absent, daté à la requête', () => {
  const users = [{ enabled: true, present: false }, { enabled: true, present: false }];
  assert.deepEqual(parseUsersPresence(users, NOW), { value: false, atMs: NOW });
});

test('un utilisateur désactivé ne compte pas', () => {
  assert.deepEqual(
    parseUsersPresence({ a: { enabled: false, present: true }, b: { enabled: true, present: false } }, NOW),
    { value: false, atMs: NOW },
  );
});

test('une réponse sans présence exploitable ne vide pas le logement', () => {
  assert.equal(parseUsersPresence(null, NOW), null);
  assert.equal(parseUsersPresence({}, NOW), null);
  assert.equal(parseUsersPresence({ a: { name: 'x' } }, NOW), null);
  assert.equal(parseUsersPresence({ a: { present: null } }, NOW), null);
  assert.equal(parseUsersPresence({ a: { enabled: false, present: false } }, NOW), null);
});

test('la présence de Homey ne sert qu\'à la présence', () => {
  assert.equal(isPresenceMisused('presence', PRESENCE_SOURCE_ID), false);
  assert.equal(isPresenceMisused('motion', PRESENCE_SOURCE_ID), true);
  assert.equal(isPresenceMisused('room', PRESENCE_SOURCE_ID), true);
  assert.equal(isPresenceMisused('motion', 'uuid-radar'), false);
  assert.equal(isPresenceMisused('presence', null), false);
});

test('un « absent » récent vaut encore présent, et annonce sa bascule', () => {
  const reading = { value: false, atMs: NOW - 10 * MIN, stale: false };
  const held = holdAbsence(reading, NOW, 60 * MIN);
  assert.deepEqual(held.reading, { value: true, atMs: NOW - 10 * MIN, stale: false });
  assert.equal(held.wakeUpAtMs, NOW + 50 * MIN);
});

test('passé le délai, l\'absence s\'applique', () => {
  const reading = { value: false, atMs: NOW - 60 * MIN, stale: false };
  assert.deepEqual(holdAbsence(reading, NOW, 60 * MIN), { reading, wakeUpAtMs: null });
});

test('délai nul : le comportement d\'avant', () => {
  const reading = { value: false, atMs: NOW - 1_000, stale: false };
  assert.deepEqual(holdAbsence(reading, NOW, 0), { reading, wakeUpAtMs: null });
});

test('présent, périmé ou sans lecture : rien à retenir', () => {
  const present = { value: true, atMs: NOW - MIN, stale: false };
  const stale = { value: false, atMs: NOW - MIN, stale: true };
  assert.deepEqual(holdAbsence(present, NOW, 60 * MIN), { reading: present, wakeUpAtMs: null });
  assert.deepEqual(holdAbsence(stale, NOW, 60 * MIN), { reading: stale, wakeUpAtMs: null });
  assert.deepEqual(holdAbsence(null, NOW, 60 * MIN), { reading: null, wakeUpAtMs: null });
});

test('activité d\'un détecteur : retombé, voyant, bloqué, périmé ou muet', () => {
  assert.equal(detectorActivityAtMs({ value: false, atMs: NOW - 5 * MIN, stale: false }, NOW, null), NOW - 5 * MIN);
  assert.equal(detectorActivityAtMs({ value: true, atMs: NOW - 5 * MIN, stale: false }, NOW, NOW - 5 * MIN), NOW);
  assert.equal(
    detectorActivityAtMs({ value: true, atMs: NOW - MIN, stale: false }, NOW, NOW - 2 * ACTIVITY_STUCK_MS),
    NOW - ACTIVITY_STUCK_MS,
    'un « quelqu\'un » figé cesse de compter douze heures après le premier vrai vu, re-rapports ou non',
  );
  assert.equal(
    detectorActivityAtMs({ value: true, atMs: NOW - 2 * ACTIVITY_STUCK_MS, stale: false }, NOW, null), NOW,
    'sans borne (vrai capteur de présence), une nuit entière à vrai reste de l\'activité',
  );
  assert.equal(
    detectorActivityAtMs({ value: false, atMs: NOW - 5 * MIN, stale: true }, NOW, null), NOW - 5 * MIN,
    'hors ligne, il garde la dernière activité vue au lieu de l\'effacer',
  );
  assert.equal(detectorActivityAtMs(null, NOW, null), null);
});

test('mouvement seul : `alarm_motion` et ses sous-capabilities, rien d\'autre', () => {
  assert.equal(isMotionOnlyCapability('alarm_motion'), true);
  assert.equal(isMotionOnlyCapability('alarm_motion.person'), true);
  assert.equal(isMotionOnlyCapability('alarm_presence'), false);
  assert.equal(isMotionOnlyCapability('alarm_occupancy'), false);
  assert.equal(isMotionOnlyCapability('alarm_motion_sensitivity'), false);
  assert.equal(isMotionOnlyCapability(undefined), false);
});

test('« vrai depuis » : le premier vrai vu, effacé au premier faux, inchangé sans lecture', () => {
  const on = (atMs: number) => ({ value: true, atMs, stale: false });
  assert.equal(trueSinceMs(on(NOW), null), NOW);
  assert.equal(trueSinceMs(on(NOW + MIN), NOW), NOW, 'un re-rapport ne rajeunit pas');
  assert.equal(trueSinceMs({ value: false, atMs: NOW, stale: false }, NOW - MIN), null);
  assert.equal(trueSinceMs(null, NOW - MIN), NOW - MIN);
});
