/**
 * `runtime/weather.mts` — la météo servie comme une source extérieure ordinaire.
 *
 * PANNES EMPÊCHÉES : une requête météo par thermostat et par tick (quota de l'API), une météo figée
 * depuis des heures lue comme fraîche, et une liaison qui avale une écriture au lieu de lever.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WeatherFeed } from '../runtime/weather.mjs';

const MIN = 60_000;
const HOUR = 60 * MIN;

function feed(responses: unknown[]): { feed: WeatherFeed; calls: () => number } {
  let calls = 0;
  const weatherFeed = new WeatherFeed({
    fetch: async () => {
      const response = responses[Math.min(calls, responses.length - 1)];
      calls += 1;
      if (response instanceof Error) throw response;
      return response;
    },
  });
  return { feed: weatherFeed, calls: () => calls };
}

test('personne n\'écoute : aucune requête', async () => {
  const { feed: weather, calls } = feed([{ temperature: 5 }]);
  await weather.maybeFetch(Date.now());
  assert.equal(calls(), 0);
});

test('une seule requête pour tous les thermostats, puis au plus une toutes les 10 min', async () => {
  const { feed: weather, calls } = feed([{ temperature: 5, when: new Date(0).toISOString() }]);
  const a = weather.bind();
  const b = weather.bind();
  await weather.maybeFetch(Date.now());
  assert.equal(calls(), 1, 'la première liaison a lancé la lecture, la seconde l\'a partagée');

  const t0 = Date.now();
  await weather.maybeFetch(t0 + 5 * MIN);
  assert.equal(calls(), 1);
  await weather.maybeFetch(t0 + 11 * MIN);
  assert.equal(calls(), 2);
  a.destroy();
  b.destroy();
});

test('la lecture est datée de l\'observation : une météo figée devient périmée', async () => {
  const observedAt = Date.parse('2026-10-28T12:44:00Z');
  const { feed: weather } = feed([{ temperature: 14.4, when: new Date(observedAt).toISOString() }]);
  const binding = weather.bind();
  await weather.maybeFetch(Date.now());

  assert.deepEqual(binding.read(observedAt + 30 * MIN, 2 * HOUR), { value: 14.4, atMs: observedAt, stale: false });
  assert.equal(binding.read(observedAt + 3 * HOUR, 2 * HOUR)?.stale, true);
  binding.destroy();
});

test('un nouveau relevé prévient les thermostats ; un relevé identique, non', async () => {
  const { feed: weather } = feed([
    { temperature: 5, when: '2026-10-28T10:00:00Z' },
    { temperature: 5, when: '2026-10-28T10:00:00Z' },
    { temperature: 6, when: '2026-10-28T11:00:00Z' },
  ]);
  const seen: number[] = [];
  const binding = weather.bind((reading) => seen.push(reading.value as number));
  await weather.maybeFetch(Date.now());
  const t0 = Date.now();
  await weather.maybeFetch(t0 + 11 * MIN);
  await weather.maybeFetch(t0 + 22 * MIN);
  assert.deepEqual(seen, [5, 6]);
  binding.destroy();
});

test('API injoignable : la dernière lecture reste, et la requête n\'est pas martelée', async () => {
  const { feed: weather, calls } = feed([{ temperature: 5, when: '2026-10-28T10:00:00Z' }, new Error('hors ligne')]);
  const binding = weather.bind();
  await weather.maybeFetch(Date.now());
  const t0 = Date.now();
  await weather.maybeFetch(t0 + 11 * MIN);
  await weather.maybeFetch(t0 + 12 * MIN);
  assert.equal(calls(), 2);
  assert.equal(binding.read(Date.parse('2026-10-28T10:30:00Z'), 2 * HOUR)?.value, 5);
  binding.destroy();
});

test('écrire sur la météo lève, et une liaison détruite ne lit plus rien', async () => {
  const { feed: weather } = feed([{ temperature: 5 }]);
  const binding = weather.bind();
  await weather.maybeFetch(Date.now());
  await assert.rejects(binding.write(3, { nowMs: 0 }));
  binding.destroy();
  assert.equal(binding.read(Date.now(), 2 * HOUR), null);
});

test('stop() relâche toutes les liaisons : plus aucune requête ensuite', async () => {
  const { feed: weather, calls } = feed([{ temperature: 5 }]);
  weather.bind();
  await weather.maybeFetch(Date.now());
  weather.stop();
  await weather.maybeFetch(Date.now() + HOUR);
  assert.equal(calls(), 1);
});
