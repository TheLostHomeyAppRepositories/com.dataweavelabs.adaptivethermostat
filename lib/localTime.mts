/**
 * Heure locale ↔ instant absolu, pour les cartes de préchauffe (SPEC §14).
 *
 * Le processus d'une app Homey tourne en UTC : aucune méthode `Date` « locale » n'est juste ici.
 * Tout passe par `Intl.DateTimeFormat` avec le fuseau du Homey (`homey.clock.getTimezone()`), que
 * le Node du Homey Pro honore — il embarque l'ICU complet.
 *
 * Pur : le fuseau et l'instant sont des paramètres.
 */

const MS_PER_HOUR = 3_600_000;

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let existing = formatters.get(timeZone);
  if (existing === undefined) {
    existing = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, existing);
  }
  return existing;
}

function localParts(utcMs: number, timeZone: string): LocalParts & { second: number } {
  const parts: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(utcMs))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year ?? 0,
    month: parts.month ?? 0,
    day: parts.day ?? 0,
    hour: parts.hour ?? 0,
    minute: parts.minute ?? 0,
    second: parts.second ?? 0,
  };
}

/** Décalage du fuseau à cet instant, en ms (CEST : +2 h). */
function offsetMs(utcMs: number, timeZone: string): number {
  const p = localParts(utcMs, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

function sameLocal(utcMs: number, wanted: LocalParts, timeZone: string): boolean {
  const p = localParts(utcMs, timeZone);
  return p.year === wanted.year && p.month === wanted.month && p.day === wanted.day
    && p.hour === wanted.hour && p.minute === wanted.minute;
}

/**
 * L'instant où il est `wanted` à l'heure locale.
 *
 * Heure ambiguë (passage à l'heure d'hiver, 02:30 existe deux fois) : la PREMIÈRE occurrence.
 * Heure inexistante (passage à l'heure d'été, 02:30 n'existe pas) : décalée vers l'avant, 03:30 —
 * c'est l'heure que montrera l'horloge une heure « trop tard », la seule qui ait un sens.
 */
function localToUtc(wanted: LocalParts, timeZone: string): number {
  const naive = Date.UTC(wanted.year, wanted.month - 1, wanted.day, wanted.hour, wanted.minute);
  const before = offsetMs(naive - 12 * MS_PER_HOUR, timeZone);
  const after = offsetMs(naive + 12 * MS_PER_HOUR, timeZone);

  const candidates = [...new Set([naive - before, naive - after])]
    .filter((utcMs) => sameLocal(utcMs, wanted, timeZone))
    .sort((a, b) => a - b);
  if (candidates.length > 0) return candidates[0]!;

  // Dans le trou du passage à l'heure d'été : l'ancien décalage donne l'heure décalée d'autant.
  return naive - before;
}

/** `'07:00'` → `{ hour: 7, minute: 0 }`, ou `null` si ce n'est pas une heure. */
export function parseHhMm(value: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (match === null) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/**
 * Prochaine occurrence de `hhmm` STRICTEMENT après `nowMs`, dans `timeZone`.
 *
 * À 07:00:00 pile, « 07:00 », c'est demain : la cible d'aujourd'hui est déjà échue, et la poser
 * reviendrait à basculer tout de suite — ce que fait déjà la carte de preset ordinaire.
 */
export function nextOccurrenceMs(hhmm: string, nowMs: number, timeZone: string): number | null {
  const time = parseHhMm(hhmm);
  if (time === null) return null;

  const today = localParts(nowMs, timeZone);
  for (let offsetDays = 0; offsetDays <= 2; offsetDays += 1) {
    // `Date.UTC` normalise le jour qui déborde : le 32 octobre devient le 1er novembre.
    const day = new Date(Date.UTC(today.year, today.month - 1, today.day + offsetDays));
    const candidate = localToUtc({
      year: day.getUTCFullYear(),
      month: day.getUTCMonth() + 1,
      day: day.getUTCDate(),
      hour: time.hour,
      minute: time.minute,
    }, timeZone);
    if (candidate > nowMs) return candidate;
  }
  return null;
}

/** `atMs` → `'07:00'` à l'heure locale, pour les jetons de carte. */
export function formatLocalHhMm(atMs: number, timeZone: string): string {
  const p = localParts(atMs, timeZone);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}
