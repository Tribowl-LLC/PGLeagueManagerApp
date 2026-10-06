/** Association shape needed to reproduce the team-view roster ordering. */
export interface TeamRosterPresentationAssociation {
  id: number;
  bowlerId: number;
  order: number | null;
  joinedAt: string | Date;
}

function joinedAtMillis(value: string | Date): number {
  const millis = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(millis) ? millis : 0;
}

/**
 * Team view prefers the newest active association for a bowler, then renders
 * members by their saved order. Newest association time preserves the stable
 * tie order used by the team view; IDs make exact ties deterministic.
 */
export function orderTeamRosterAssociations<T extends TeamRosterPresentationAssociation>(
  associations: readonly T[],
): T[] {
  const newestByBowler = new Map<number, T>();
  const newestFirst = [...associations].sort((left, right) => (
    joinedAtMillis(right.joinedAt) - joinedAtMillis(left.joinedAt)
    || left.id - right.id
  ));

  for (const association of newestFirst) {
    if (!newestByBowler.has(association.bowlerId)) {
      newestByBowler.set(association.bowlerId, association);
    }
  }

  return [...newestByBowler.values()].sort((left, right) => (
    (left.order ?? 0) - (right.order ?? 0)
    || joinedAtMillis(right.joinedAt) - joinedAtMillis(left.joinedAt)
    || left.id - right.id
    || left.bowlerId - right.bowlerId
  ));
}

/** Compare roster members after current associations have been resolved. */
export function compareTeamRosterPresentationOrder(
  left: TeamRosterPresentationAssociation,
  right: TeamRosterPresentationAssociation,
): number {
  return (left.order ?? 0) - (right.order ?? 0)
    || joinedAtMillis(right.joinedAt) - joinedAtMillis(left.joinedAt)
    || left.id - right.id
    || left.bowlerId - right.bowlerId;
}
