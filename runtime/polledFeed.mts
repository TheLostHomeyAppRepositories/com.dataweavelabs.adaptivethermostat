/**
 * `runtime/polledFeed.mts` — une API de Homey interrogée, servie comme une source ordinaire.
 *
 * Les thermostats lient leurs sources par `hub.bind(id, capability)`. Pour un identifiant réservé
 * (météo, présence de Homey), le hub rend une liaison d'ici : même contrat `SourceBinding`, donc ni
 * le participant ni le noyau ne savent que la valeur ne vient pas d'un appareil.
 *
 * Une seule interrogation pour toute l'app, quel que soit le nombre de thermostats liés, et
 * seulement tant qu'au moins l'un d'eux l'est. Pas de minuterie propre : le hub appelle
 * `maybeFetch()` depuis son `refresh()`, qui suit déjà le battement de l'ordonnanceur.
 */

import { computeStale } from '../lib/freshness.mjs';
import type { CapValue } from '../lib/writePolicy.mjs';
import type { Reading } from '../lib/types.mjs';
import type { SourceBinding, WriteRequest } from './hub.mjs';

type Logger = (...args: unknown[]) => void;

export interface PolledReading<V extends CapValue> {
  value: V;
  atMs: number;
}

export interface PolledFeedOptions<V extends CapValue> {
  /** Rend la réponse brute de l'API, ou lève si elle n'est pas joignable. */
  fetch: () => Promise<unknown>;
  /** Lit la réponse brute ; `null` quand elle est inexploitable. */
  parse: (raw: unknown, fetchedAtMs: number) => PolledReading<V> | null;
  /** Nom de la source dans les journaux, par exemple « Météo de Homey ». */
  label: string;
  /** Ce qui manque à une réponse que `parse` rejette, pour le journal. */
  invalidMessage: string;
  /**
   * L'API est-elle montée ? Tant qu'elle ne l'est pas, aucune requête ne part et l'intervalle n'est
   * pas consommé : la liaison faite au démarrage, avant l'API, ne doit ni journaliser une erreur à
   * chaque redémarrage ni faire ignorer la relance que le hub tente à sa connexion.
   */
  isReady: () => boolean;
  /** Intervalle entre deux interrogations réussies. */
  pollMs: number;
  /** Nouvelle tentative après un échec, plus tôt que `pollMs`. */
  retryMs: number;
  /** Au-delà, la requête est abandonnée : une connexion à moitié ouverte ne doit pas la figer. */
  timeoutMs: number;
  /**
   * La lecture est un état confirmé, qui n'a pas besoin du délai avant absence : vrai pour la
   * présence de Homey, dont l'absence vient de la géolocalisation et non d'un capteur immobile.
   */
  confirmedAbsence?: boolean;
  /**
   * Ne prévenir les abonnés que d'un changement de VALEUR. Une lecture datée à la requête change
   * d'horodatage à chaque interrogation : sans ce filtre, chaque thermostat lié recalculerait toutes
   * les minutes pour rien.
   */
  notifyOnValueChangeOnly?: boolean;
  error?: Logger;
}

export class PolledFeed<V extends CapValue> {
  private latest: PolledReading<V> | null = null;
  private lastFetchAtMs = Number.NEGATIVE_INFINITY;
  private inFlight: Promise<void> | null = null;
  private readonly subscribers = new Set<PolledBinding<V>>();
  private readonly pollMs: number;
  private readonly retryMs: number;
  private readonly timeoutMs: number;

  constructor(private readonly options: PolledFeedOptions<V>) {
    this.pollMs = options.pollMs;
    this.retryMs = options.retryMs;
    this.timeoutMs = options.timeoutMs;
  }

  /** Vrai quand au moins une liaison existe ET qu'aucune lecture exploitable n'est arrivée. */
  get unavailable(): boolean {
    return this.latest === null;
  }

  /** La dernière valeur lue, `null` avant la première réponse exploitable. */
  get reading(): PolledReading<V> | null {
    return this.latest;
  }

  bind(onChange?: (reading: Reading<CapValue>) => void): SourceBinding {
    const binding = new PolledBinding(this, this.options.label, this.options.confirmedAbsence === true, onChange);
    this.subscribers.add(binding);
    // La première liaison n'attend pas l'intervalle : elle déclenche la lecture tout de suite.
    void this.maybeFetch(Date.now());
    return binding;
  }

  /** @internal */
  forget(binding: PolledBinding<V>): void {
    this.subscribers.delete(binding);
  }

  /**
   * Interroge l'API si quelqu'un l'écoute et que la dernière lecture date de plus de `pollMs`.
   * Ne lève jamais : une API injoignable laisse vieillir la dernière lecture, et le seuil de
   * fraîcheur de chaque thermostat fait le reste.
   */
  async maybeFetch(nowMs: number): Promise<void> {
    if (this.subscribers.size === 0) return;
    if (this.inFlight !== null) return this.inFlight;
    if (!this.options.isReady()) return;
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
        const reading = this.options.parse(raw, nowMs);
        if (reading === null) {
          this.options.error?.(`${this.options.label} : ${this.options.invalidMessage}`);
          retryAfterFailure();
          return;
        }
        const changed = this.latest === null
          || this.latest.value !== reading.value
          || (this.options.notifyOnValueChangeOnly !== true && this.latest.atMs !== reading.atMs);
        this.latest = reading;
        if (changed) {
          for (const subscriber of this.subscribers) subscriber.notify(reading);
        }
      } catch (err) {
        this.options.error?.(`${this.options.label} injoignable :`, err);
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

class PolledBinding<V extends CapValue> implements SourceBinding {
  private destroyed = false;

  constructor(
    private readonly feed: PolledFeed<V>,
    private readonly label: string,
    readonly confirmedAbsence: boolean,
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

  /** Une source interrogée ne s'écrit pas. Lever, et non rendre `false` : voir `SourceBinding`. */
  async write(_value: CapValue, _opts: WriteRequest): Promise<boolean> {
    throw new Error(`${this.label} est une source en lecture seule.`);
  }

  /**
   * @internal Prévient l'abonné qu'une nouvelle observation est arrivée. Le `Reading` transmis ne
   * porte pas de fraîcheur fiable — le seuil appartient au lecteur : l'abonné doit relire par
   * `read()`, comme le fait le participant, qui ne s'en sert que pour demander un tick.
   */
  notify(reading: PolledReading<V>): void {
    if (this.destroyed) return;
    this.onChange?.({ value: reading.value, atMs: reading.atMs, stale: false });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.feed.forget(this);
  }
}
