// Season-label helper shared between the React client and the server.
//
// Originally lived at `client/src/lib/season-utils.ts` but the Square
// custom-attribute sync (task #429) needs the server to produce the
// EXACT same label users see in-app — otherwise admins filtering Smart
// Lists in Square Marketing on a label like "Fall '25 Season" wouldn't
// match a bowler whose league synced as "Fall 25" / something close.
//
// Behavior is unchanged from the prior client-only version: same
// inputs, same outputs, no new branches. Client and server both import
// `getSeasonLabel` directly from this module.
export function getSeasonYearRange(seasonStart: Date | string, seasonEnd: Date | string): string {
  const start = new Date(seasonStart);
  const end = new Date(seasonEnd);
  const startYear = start.getFullYear();
  const endYear = end.getFullYear();

  const startYY = String(startYear).slice(-2);
  const endYY = String(endYear).slice(-2);
  return startYear === endYear ? startYY : `${startYY}/${endYY}`;
}

export function getSeasonLabel(seasonStart: Date | string, seasonEnd: Date | string): string {
  const start = new Date(seasonStart);
  const end = new Date(seasonEnd);
  const startYear = start.getFullYear();
  const endYear = end.getFullYear();

  if (startYear !== endYear) {
    return `${getSeasonYearRange(seasonStart, seasonEnd)} Season`;
  }

  const month = start.getMonth();
  const yearSuffix = `'${String(startYear).slice(-2)}`;
  if (month === 11 || month === 0 || month === 1) {
    return `Winter ${yearSuffix} Season`;
  } else if (month >= 2 && month <= 4) {
    return `Spring ${yearSuffix} Season`;
  } else if (month >= 5 && month <= 7) {
    return `Summer ${yearSuffix} Season`;
  } else {
    return `Fall ${yearSuffix} Season`;
  }
}
