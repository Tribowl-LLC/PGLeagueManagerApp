// Season-label helper shared between the React client and the server.
//
// Originally lived at `client/src/lib/season-utils.ts` but the Square
// custom-attribute sync (task #429) needs the server to produce the
// EXACT same label users see in-app — otherwise admins filtering Smart
// Lists in Square Marketing on a label like "Fall '25 Season" wouldn't
// match a bowler whose league synced as "Fall 25" / something close.
//
// Client and server both import `getSeasonLabel` directly from this module so
// UI labels and Square custom attributes stay aligned.
export function getSeasonYearRange(seasonStart: Date | string, seasonEnd: Date | string): string {
  const start = new Date(seasonStart);
  const end = new Date(seasonEnd);
  const startYear = start.getFullYear();
  const endYear = end.getFullYear();

  const startYY = String(startYear).slice(-2);
  const endYY = String(endYear).slice(-2);
  return startYear === endYear ? startYY : `${startYY}/${endYY}`;
}

export type ProductSeason = "Winter" | "Spring" | "Summer" | "Fall";

/** Classify a validated stored calendar date without consulting the host timezone. */
export function getProductSeasonFromDateOnly(seasonStart: string): ProductSeason | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(seasonStart);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(0);
  probe.setUTCFullYear(year, month - 1, day);
  probe.setUTCHours(12, 0, 0, 0);
  if (year < 1 || probe.getUTCFullYear() !== year || probe.getUTCMonth() + 1 !== month || probe.getUTCDate() !== day) {
    return null;
  }
  if (month === 11 || month === 12 || month === 1 || month === 2) return "Winter";
  if (month === 3 || month === 4) return "Spring";
  if (month >= 5 && month <= 7) return "Summer";
  return "Fall";
}

export function getSeasonLabel(seasonStart: Date | string, _seasonEnd: Date | string): string {
  const start = new Date(seasonStart);
  const startYear = start.getFullYear();

  const month = start.getMonth();
  const yearSuffix = `'${String(startYear).slice(-2)}`;
  if (month === 10 || month === 11 || month === 0 || month === 1) {
    return `Winter ${yearSuffix} Season`;
  } else if (month >= 2 && month <= 3) {
    return `Spring ${yearSuffix} Season`;
  } else if (month >= 4 && month <= 6) {
    return `Summer ${yearSuffix} Season`;
  } else {
    return `Fall ${yearSuffix} Season`;
  }
}
