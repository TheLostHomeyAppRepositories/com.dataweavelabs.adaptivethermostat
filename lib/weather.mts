/**
 * Météo de Homey comme source de température extérieure.
 *
 * Homey Pro connaît la météo de son emplacement (`ManagerWeather.getWeather()` de l'API web). Sans
 * capteur extérieur — ou avec un capteur resté dans la maison —, c'est la seule température
 * extérieure honnête dont dispose l'app : régulation, auto-régulation et préchauffe en ont besoin.
 *
 * Pur : le hub va chercher la réponse, ce module ne fait que la lire.
 */

/**
 * Identifiant réservé désignant la météo à la place d'un appareil. Il vit dans le `store` du
 * thermostat exactement comme un identifiant d'appareil : c'est le hub qui le reconnaît. Aucun
 * appareil Homey n'a d'identifiant de cette forme (ce sont des UUID).
 */
export const WEATHER_SOURCE_ID = 'homey:weather';

/** Intervalle entre deux interrogations. La météo de Homey ne bouge qu'à l'échelle de l'heure. */
export const WEATHER_POLL_MS = 10 * 60_000;

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
 * sous le seuil de fraîcheur comme un capteur muet. Sans `when` lisible, on date à la requête — la
 * valeur vient bien d'être servie. Un `when` dans le futur (horloge décalée) est ramené à la requête.
 */
export function parseWeatherReading(raw: unknown, fetchedAtMs: number): WeatherReading | null {
  if (!isRecord(raw)) return null;

  const celsius = typeof raw.temperatureCelsius === 'number' ? raw.temperatureCelsius : raw.temperature;
  if (typeof celsius !== 'number' || !Number.isFinite(celsius)) return null;
  if (celsius < PLAUSIBLE_MIN_C || celsius > PLAUSIBLE_MAX_C) return null;

  const when = typeof raw.when === 'string' ? Date.parse(raw.when) : Number.NaN;
  const atMs = Number.isFinite(when) ? Math.min(when, fetchedAtMs) : fetchedAtMs;

  return { value: Math.round(celsius * 10) / 10, atMs };
}
