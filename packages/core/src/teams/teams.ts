import type { Team, TeamId } from "@calypso/shared";
import type { CalypsoDatabase } from "../db/database.js";

export class TeamRegistry {
  private teams = new Map<TeamId, Team>();

  constructor(private database?: CalypsoDatabase) {
    if (database) {
      for (const t of database.listTeams()) this.teams.set(t.id, t);
    }
  }

  list(): Team[] {
    return [...this.teams.values()];
  }

  get(id: TeamId): Team | undefined {
    return this.teams.get(id);
  }

  upsert(team: Team): Team {
    const full: Team = { ...team, updatedAt: team.updatedAt || Date.now() };
    this.teams.set(full.id, full);
    this.database?.upsertTeam(full);
    return full;
  }

  delete(id: TeamId): boolean {
    const ok = this.teams.delete(id);
    if (ok) this.database?.deleteTeam(id);
    return ok;
  }
}
