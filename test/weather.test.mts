/**
 * Météo de Homey comme température extérieure : lecture d'une réponse `getWeather()`.
 *
 * La réponse de référence est celle d'un vrai Homey Pro (Paris, 2026-10-28), réduite aux champs lus.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isWeatherMisused, parseWeatherReading, WEATHER_SOURCE_ID } from '../lib/weather.mjs';

const FETCHED = Date.parse('2026-10-28T12:58:00Z');
const REAL = {
  city: 'Palais-Royal', state: 'Ciel Clair', id: 800,
  temperature: 14.4, temperatureCelsius: 14.4, temperatureUnits: '°C', when: '2026-10-28T12:44:43.256Z',
};

test('une vraie réponse Homey : 14,4 °C, datée de l\'observation et non de la requête', () => {
  assert.deepEqual(parseWeatherReading(REAL, FETCHED), { value: 14.4, atMs: Date.parse('2026-10-28T12:44:43.256Z') });
});

test('`temperatureCelsius` l\'emporte : `temperature` suit les unités choisies par l\'utilisateur', () => {
  const fahrenheit = { ...REAL, temperature: 57.9, temperatureUnits: '°F' };
  assert.equal(parseWeatherReading(fahrenheit, FETCHED)?.value, 14.4);
});

test('sans `when` lisible, non datable donc rejetée : la rajeunir à chaque requête masquerait une météo figée', () => {
  assert.equal(parseWeatherReading({ temperature: 3 }, FETCHED), null);
  assert.equal(parseWeatherReading({ temperature: 3, when: 'hier' }, FETCHED), null);
  assert.equal(parseWeatherReading({ temperature: 3, when: '1970-01-01T00:00:00Z' }, FETCHED), null);
});

test('`when` en nombre ou en Date est lu ; un `when` futur est ramené à la requête', () => {
  const at = Date.parse('2026-10-28T12:00:00Z');
  assert.equal(parseWeatherReading({ temperature: 3, when: at }, FETCHED)?.atMs, at);
  assert.equal(parseWeatherReading({ temperature: 3, when: new Date(at) }, FETCHED)?.atMs, at);
  assert.equal(parseWeatherReading({ temperature: 3, when: '2026-10-28T14:00:00Z' }, FETCHED)?.atMs, FETCHED);
});

test('`temperature` seule en °F est refusée : 41 °F lus comme 41 °C couperaient le chauffage', () => {
  const when = REAL.when;
  assert.equal(parseWeatherReading({ temperature: 41, temperatureUnits: '°F', when }, FETCHED), null);
  assert.equal(parseWeatherReading({ temperature: 5, temperatureUnits: '°C', when }, FETCHED)?.value, 5);
});

test('la météo ne tient lieu que de température extérieure', () => {
  assert.equal(isWeatherMisused('outdoor', WEATHER_SOURCE_ID), false);
  assert.equal(isWeatherMisused('room', WEATHER_SOURCE_ID), true);
  assert.equal(isWeatherMisused('emitter', WEATHER_SOURCE_ID), true);
  assert.equal(isWeatherMisused('room', 'uuid-capteur'), false);
  assert.equal(isWeatherMisused('room', null), false);
});

test('réponse inexploitable : null, jamais une température inventée', () => {
  assert.equal(parseWeatherReading(null, FETCHED), null);
  assert.equal(parseWeatherReading({ city: 'Paris' }, FETCHED), null);
  assert.equal(parseWeatherReading({ temperature: Number.NaN }, FETCHED), null);
  assert.equal(parseWeatherReading({ temperature: '14' }, FETCHED), null);
  assert.equal(parseWeatherReading({ temperatureCelsius: 400 }, FETCHED), null, 'hors de [−60 ; 60] °C');
});
