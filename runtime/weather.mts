/**
 * `runtime/weather.mts` — la météo de Homey servie comme une source extérieure ordinaire.
 *
 * Voir `PolledFeed` pour le contrat : une requête pour toute l'app, une liaison en lecture seule.
 */

import {
  parseWeatherReading, WEATHER_FETCH_TIMEOUT_MS, WEATHER_POLL_MS, WEATHER_RETRY_MS,
} from '../lib/weather.mjs';
import { PolledFeed } from './polledFeed.mjs';

type Logger = (...args: unknown[]) => void;

export interface WeatherFeedOptions {
  /** Rend la réponse brute de `getWeather()`, ou lève si l'API n'est pas joignable. */
  fetch: () => Promise<unknown>;
  /** L'API météo est-elle montée ? Absent = toujours. */
  isReady?: () => boolean;
  pollMs?: number;
  retryMs?: number;
  timeoutMs?: number;
  error?: Logger;
}

export class WeatherFeed extends PolledFeed<number> {
  constructor(options: WeatherFeedOptions) {
    super({
      fetch: options.fetch,
      parse: parseWeatherReading,
      label: 'Météo de Homey',
      invalidMessage: 'réponse sans température datée en °C.',
      isReady: options.isReady ?? (() => true),
      pollMs: options.pollMs ?? WEATHER_POLL_MS,
      retryMs: options.retryMs ?? WEATHER_RETRY_MS,
      timeoutMs: options.timeoutMs ?? WEATHER_FETCH_TIMEOUT_MS,
      error: options.error,
    });
  }
}
