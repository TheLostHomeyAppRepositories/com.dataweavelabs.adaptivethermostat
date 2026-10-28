/**
 * `runtime/weather.mts` — la météo de Homey servie comme une source ordinaire.
 *
 * Les thermostats lient leur source extérieure par `hub.bind(id, capability)`. Pour l'identifiant
 * réservé `WEATHER_SOURCE_ID`, le hub rend une liaison d'ici : même contrat `SourceBinding`, donc
 * ni le participant ni le noyau ne savent que la température vient d'internet.
 *
 * Une seule interrogation pour toute l'app, quel que soit le nombre de thermostats liés, et
 * seulement tant qu'au moins l'un d'eux l'est. Pas de minuterie propre : le hub appelle
 * `maybeFetch()` depuis son `refresh()`, qui suit déjà le battement de l'ordonnanceur.
 */

import { computeStale } from '../lib/freshness.mjs';
import {
  parseWeatherReading, WEATHER_FETCH_TIMEOUT_MS, WEATHER_POLL_MS, WEATHER_RETRY_MS, type WeatherReading,
} from '../lib/weather.mjs';
import type { CapValue } from '../lib/writePolicy.mjs';
import type { Reading } from '../lib/types.mjs';
import type { SourceBinding, WriteRequest } from './hub.mjs';

type Logger = (...args: unknown[]) => void;

export interface WeatherFeedOptions {
  /** Rend la réponse brute de `getWeather()`, ou lève si l'API n'est pas joignable. */
  fetch: () => Promise<unknown>;
  pollMs?: number;
  retryMs?: number;
  timeoutMs?: number;
  error?: Logger;
}

export class WeatherFeed {
  private latest: WeatherReading | null = null;
  private lastFetchAtMs = Number.NEGATIVE_INFINITY;
  private inFlight: Promise<void> | null = null;
  private readonly subscribers = new Set<WeatherBinding>();
  private readonly pollMs: number;
  private readonly retryMs: number;
  private readonly timeoutMs: number;

  constructor(private readonly options: WeatherFeedOptions) {
    this.pollMs = options.pollMs ?? WEATHER_POLL_MS;
    this.retryMs = options.retryMs ?? WEATHER_RETRY_MS;
    this.timeoutMs = options.timeoutMs ?? WEATHER_FETCH_TIMEOUT_MS;
  }

  /** Vrai quand au moins une liaison existe ET qu'aucune lecture exploitable n'est arrivée. */
  get unavailable(): boolean {
    return this.latest === null;
  }

  /** La dernière température lue, `null` avant la première réponse exploitable. */
  get reading(): WeatherReading | null {
    return this.latest;
  }

  bind(onChange?: (reading: Reading<CapValue>) => void): SourceBinding {
    const binding = new WeatherBinding(this, onChange);
    this.subscribers.add(binding);
    // La première liaison n'attend pas dix minutes : elle déclenche la lecture tout de suite.
    void this.maybeFetch(Date.now());
    return binding;
  }

  /** @internal */
  forget(binding: WeatherBinding): void {
    this.subscribers.delete(binding);
  }

  /**
   * Interroge la météo si quelqu'un l'écoute et que la dernière lecture date de plus de `pollMs`.
   * Ne lève jamais : une météo injoignable laisse vieillir la dernière lecture, et le seuil de
   * fraîcheur de chaque thermostat fait le reste.
   */
  async maybeFetch(nowMs: number): Promise<void> {
    if (this.subscribers.size === 0) return;
    if (this.inFlight !== null) return this.inFlight;
    if (nowMs - this.lastFetchAtMs < this.pollMs) return;

    this.lastFetchAtMs = nowMs;
    // En cas d'échec, la prochaine tentative vient après `retryMs`, pas après `pollMs`.
    const retryAfterFailure = (): void => {
      this.lastFetchAtMs = nowMs - this.pollMs + this.retryMs;
    };
    this.inFlight = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const raw = await Promise.race([
          this.options.fetch(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('délai dépassé')), this.timeoutMs);
          }),
        ]);
        const reading = parseWeatherReading(raw, nowMs);
        if (reading === null) {
          this.options.error?.('Météo de Homey : réponse sans température datée en °C.');
          retryAfterFailure();
          return;
        }
        const changed = this.latest === null
          || this.latest.value !== reading.value
          || this.latest.atMs !== reading.atMs;
        this.latest = reading;
        if (changed) {
          for (const subscriber of this.subscribers) subscriber.notify(reading);
        }
      } catch (err) {
        this.options.error?.('Météo de Homey injoignable :', err);
        retryAfterFailure();
      } finally {
        clearTimeout(timer);
      }
    })().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  stop(): void {
    for (const subscriber of [...this.subscribers]) subscriber.destroy();
  }
}

class WeatherBinding implements SourceBinding {
  private destroyed = false;

  constructor(
    private readonly feed: WeatherFeed,
    private readonly onChange?: (reading: Reading<CapValue>) => void,
  ) {}

  read(nowMs: number, freshnessMs: number): Reading<CapValue> | null {
    if (this.destroyed) return null;
    const reading = this.feed.reading;
    if (reading === null) return null;
    const stale = computeStale({
      atMs: reading.atMs,
      nowMs,
      freshnessMs,
      available: true,
      deviceReportedAtMs: null,
      deviceSeenAtMs: null,
    });
    return { value: reading.value, atMs: reading.atMs, stale };
  }

  /** Une température météo ne s'écrit pas. Lever, et non rendre `false` : voir `SourceBinding`. */
  async write(_value: CapValue, _opts: WriteRequest): Promise<boolean> {
    throw new Error('La météo de Homey est une source en lecture seule.');
  }

  /**
   * @internal Prévient l'abonné qu'une nouvelle observation est arrivée. Le `Reading` transmis ne
   * porte pas de fraîcheur fiable — le seuil appartient au lecteur : l'abonné doit relire par
   * `read()`, comme le fait le participant, qui ne s'en sert que pour demander un tick.
   */
  notify(reading: WeatherReading): void {
    if (this.destroyed) return;
    this.onChange?.({ value: reading.value, atMs: reading.atMs, stale: false });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.feed.forget(this);
  }
}
