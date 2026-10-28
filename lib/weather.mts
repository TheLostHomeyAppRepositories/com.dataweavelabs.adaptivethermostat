/**
 * Météo de Homey comme source de température extérieure.
 *
 * Homey Pro connaît la météo de son emplacement (`ManagerWeather.getWeather()` de l'API web). Sans
 * capteur extérieur — ou avec un capteur resté dans la maison —, c'est la seule température
 * extérieure honnête dont dispose l'app : régulation, auto-régulation et préchauffe en ont besoin.
 *
 * Pur : le hub va chercher la réponse, ce module ne fait que la lire.
 */

import { toEpochMs } from './freshness.mjs';

/**
 * Identifiant réservé désignant la météo à la place d'un appareil. Il vit dans le `store` du
 * thermostat exactement comme un identifiant d'appareil : c'est le hub qui le reconnaît. Aucun
 * appareil Homey n'a d'identifiant de cette forme (ce sont des UUID).
 */
export const WEATHER_SOURCE_ID = 'homey:weather';

/** Intervalle entre deux interrogations. La météo de Homey ne bouge qu'à l'échelle de l'heure. */
export const WEATHER_POLL_MS = 10 * 60_000;

/**
 * Nouvelle tentative après un échec. Pas `WEATHER_POLL_MS` : au démarrage, la première requête part
 * presque toujours avant que l'API Homey soit montée, et attendre dix minutes laissait chaque
 * thermostat sans température extérieure après chaque redémarrage.
 */
export const WEATHER_RETRY_MS = 60_000;

/** Au-delà, la requête est abandonnée : une connexion à moitié ouverte ne doit pas la figer à vie. */
export const WEATHER_FETCH_TIMEOUT_MS = 30_000;

/** La météo ne peut tenir lieu QUE de température extérieure : jamais de pièce, jamais d'émetteur. */
export function isWeatherMisused(sourceKey: string, deviceId: string | null): boolean {
  return deviceId === WEATHER_SOURCE_ID && sourceKey !== 'outdoor';
}

/** Au-delà, ce n'est pas une température extérieure, c'est une réponse corrompue. */
const PLAUSIBLE_MIN_C = -60;
const PLAUSIBLE_MAX_C = 60;

export interface WeatherReading {
  value: number;
  /** Instant de l'observation météo (`when`), jamais postérieur à celui de la requête. */
  atMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * La température d'une réponse `getWeather()`, datée, ou `null` si elle est inexploitable.
 *
 * Datée par `when`, l'instant de l'observation, et non par celui de la requête : une météo que
 * Homey n'a plus rafraîchie depuis trois heures doit paraître vieille de trois heures, et tomber
 * sous le seuil de fraîcheur comme un capteur muet. Sans `when` lisible, la réponse est NON DATABLE,
 * donc rejetée : la dater à la requête la rajeunirait à chaque interrogation, et une météo figée ne
 * paraîtrait jamais périmée. Un `when` dans le futur (horloge décalée) est ramené à la requête.
 *
 * `temperatureCelsius` d'abord ; `temperature` seule n'est prise que si ses unités sont des °C —
 * elle suit l'unité choisie par l'utilisateur, et 41 °F lus comme 41 °C couperaient le chauffage.
 */
export function parseWeatherReading(raw: unknown, fetchedAtMs: number): WeatherReading | null {
  if (!isRecord(raw)) return null;

  const units = raw.temperatureUnits;
  const celsius = typeof raw.temperatureCelsius === 'number'
    ? raw.temperatureCelsius
    : units === undefined || units === '°C' ? raw.temperature : undefined;
  if (typeof celsius !== 'number' || !Number.isFinite(celsius)) return null;
  if (celsius < PLAUSIBLE_MIN_C || celsius > PLAUSIBLE_MAX_C) return null;

  const when = toEpochMs(raw.when);
  if (when === null) return null;
  const atMs = Math.min(when, fetchedAtMs);

  return { value: Math.round(celsius * 10) / 10, atMs };
}
