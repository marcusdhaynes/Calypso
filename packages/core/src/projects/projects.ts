import type { Project, ProjectId } from "@calypso/shared";
import type { CalypsoDatabase } from "../db/database.js";

export class ProjectRegistry {
  private projects = new Map<ProjectId, Project>();

  constructor(private database?: CalypsoDatabase) {
    if (database) {
      for (const p of database.listProjects()) this.projects.set(p.id, p);
    }
  }

  list(): Project[] {
    return [...this.projects.values()];
  }

  get(id: ProjectId): Project | undefined {
    return this.projects.get(id);
  }

  upsert(project: Project): Project {
    const full: Project = { ...project, updatedAt: project.updatedAt || Date.now() };
    this.projects.set(full.id, full);
    this.database?.upsertProject(full);
    return full;
  }

  delete(id: ProjectId): boolean {
    const ok = this.projects.delete(id);
    if (ok) this.database?.deleteProject(id);
    return ok;
  }
}
