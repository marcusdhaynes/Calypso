import type { Team, TeamId } from "@calypso/shared";

export class TeamRegistry {
  private teams = new Map<TeamId, Team>();

  list(): Team[] {
    return [...this.teams.values()];
  }

  get(id: TeamId): Team | undefined {
    return this.teams.get(id);
  }

  upsert(team: Team): void {
    this.teams.set(team.id, team);
  }
}
