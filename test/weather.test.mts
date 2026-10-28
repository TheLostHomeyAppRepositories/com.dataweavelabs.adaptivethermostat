/**
 * Météo de Homey comme température extérieure : lecture d'une réponse `getWeather()`.
 *
 * La réponse de référence est celle d'un vrai Homey Pro (Paris, 2026-10-28), réduite aux champs lus.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWeatherReading } from '../lib/weather.mjs';

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

test('sans `when` lisible, datée à la requête ; un `when` futur est ramené à la requête', () => {
  assert.equal(parseWeatherReading({ temperature: 3 }, FETCHED)?.atMs, FETCHED);
  assert.equal(parseWeatherReading({ temperature: 3, when: 'hier' }, FETCHED)?.atMs, FETCHED);
  assert.equal(parseWeatherReading({ temperature: 3, when: '2026-10-28T14:00:00Z' }, FETCHED)?.atMs, FETCHED);
});

test('réponse inexploitable : null, jamais une température inventée', () => {
  assert.equal(parseWeatherReading(null, FETCHED), null);
  assert.equal(parseWeatherReading({ city: 'Paris' }, FETCHED), null);
  assert.equal(parseWeatherReading({ temperature: Number.NaN }, FETCHED), null);
  assert.equal(parseWeatherReading({ temperature: '14' }, FETCHED), null);
  assert.equal(parseWeatherReading({ temperatureCelsius: 400 }, FETCHED), null, 'hors de [−60 ; 60] °C');
});
