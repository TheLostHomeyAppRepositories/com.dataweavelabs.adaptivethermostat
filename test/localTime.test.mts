/**
 * Heure locale → instant absolu (SPEC §14). Le processus Homey tourne en UTC : seul `Intl` avec le
 * fuseau du Homey donne la bonne heure, y compris aux changements d'heure.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatLocalHhMm, nextOccurrenceMs, parseHhMm } from '../lib/localTime.mjs';

const PARIS = 'Europe/Paris';
const at = (iso: string): number => Date.parse(iso);

test('critère 16 : à 06:59 CET, « 07:00 » est aujourd\'hui', () => {
  assert.equal(nextOccurrenceMs('07:00', at('2026-11-02T05:59:00Z'), PARIS), at('2026-11-02T06:00:00Z'));
});

test('critère 16 : à 07:00:00 pile, « 07:00 » est demain', () => {
  assert.equal(nextOccurrenceMs('07:00', at('2026-11-02T06:00:00.000Z'), PARIS), at('2026-11-03T06:00:00Z'));
});

test('critère 16 : 02:30 n\'existe pas au passage à l\'heure d\'été, décalée à 03:30 CEST', () => {
  assert.equal(nextOccurrenceMs('02:30', at('2027-03-27T19:00:00Z'), PARIS), at('2027-03-28T01:30:00Z'));
});

test('critère 16 : 02:30 existe deux fois au passage à l\'heure d\'hiver, la première occurrence', () => {
  assert.equal(nextOccurrenceMs('02:30', at('2026-10-24T18:00:00Z'), PARIS), at('2026-10-25T00:30:00Z'));
});

test('07:00 le lendemain d\'un changement d\'heure tombe à la bonne heure locale', () => {
  // Samedi soir en CEST, dimanche matin en CET.
  assert.equal(nextOccurrenceMs('07:00', at('2026-10-24T20:00:00Z'), PARIS), at('2026-10-25T06:00:00Z'));
});

test('fin de mois : 23:30 le 31 octobre au soir, « 07:00 » est le 1er novembre', () => {
  assert.equal(nextOccurrenceMs('07:00', at('2026-10-31T22:30:00Z'), PARIS), at('2026-11-01T06:00:00Z'));
});

test('une heure illisible rend null, jamais un instant inventé', () => {
  assert.equal(parseHhMm('7h'), null);
  assert.equal(parseHhMm('24:00'), null);
  assert.equal(parseHhMm('07:60'), null);
  assert.deepEqual(parseHhMm('7:05'), { hour: 7, minute: 5 });
  assert.equal(nextOccurrenceMs('demain', 0, PARIS), null);
});

test('formatLocalHhMm rend l\'heure locale, pas l\'heure UTC', () => {
  assert.equal(formatLocalHhMm(at('2026-11-02T06:00:00Z'), PARIS), '07:00');
  assert.equal(formatLocalHhMm(at('2026-07-02T05:05:00Z'), PARIS), '07:05');
});
