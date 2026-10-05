import type {
  ChatCompletionRequest,
  Plan,
  PlanStep,
  Task,
  TaskClass,
  Team,
  Worker,
  WorkerId,
} from "@calypso/shared";
import type { Orchestrator } from "../orchestrator/orchestrator.js";
import { newId } from "./ids.js";

const TASK_CLASSES: TaskClass[] = [
  "simple",
  "normal",
  "code",
  "vision",
  "reasoning",
  "frontier",
];

export interface PlanRequest {
  goal: string;
  title?: string;
  team?: Team;
  /** Fallback assignee when no team / no role match. */
  defaultWorkerId?: WorkerId;
  projectId?: string;
  conversationId?: string;
  createdBy?: Plan["createdBy"];
}

export interface PlanResult {
  plan: Plan;
  tasks: Task[];
}

/**
 * Leader/planner: ask the model for a structured Plan JSON, validate/repair,
 * materialize into the task graph, and assign steps to matching team members.
 */
export class Planner {
  constructor(private orch: Orchestrator) {}

  async planAndMaterialize(req: PlanRequest): Promise<PlanResult> {
    const members = req.team
      ? req.team.memberIds
          .map((id) => this.orch.workers.get(id))
          .filter((w): w is Worker => !!w)
      : [];

    const leader =
      (req.team?.leadId ? this.orch.workers.get(req.team.leadId) : undefined) ??
      members[0] ??
      (req.defaultWorkerId ? this.orch.workers.get(req.defaultWorkerId) : undefined);

    let steps: PlanStep[];
    if (this.orch.modelRouter && leader) {
      steps = await this.generateSteps(req.goal, leader, members);
    } else {
      steps = [
        {
          id: "step_1",
          title: req.title ?? "Do the work",
          description: req.goal,
          taskClass: "normal",
          dependsOnStepIds: [],
          suggestedWorkerId: req.defaultWorkerId,
        },
      ];
    }

    // Resolve assignees onto steps before materializing so the dispatcher
    // never sees unassigned / wrongly assigned children.
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      const assignee =
        (step.suggestedWorkerId && this.orch.workers.get(step.suggestedWorkerId)) ||
        pickAssignee(members, step) ||
        (req.defaultWorkerId ? this.orch.workers.get(req.defaultWorkerId) : undefined) ||
        leader;
      steps[i] = {
        ...step,
        suggestedWorkerId: assignee?.id ?? step.suggestedWorkerId,
      };
    }

    const plan: Plan = {
      id: newId("plan"),
      title: req.title ?? truncate(req.goal, 80),
      goal: req.goal,
      steps,
      status: "approved",
      createdBy: req.createdBy ?? (leader ? { type: "worker", workerId: leader.id } : { type: "system" }),
      projectId: req.projectId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const tasks = this.orch.materializePlan(plan, leader?.id ?? req.defaultWorkerId);
    const [root, ...stepTasks] = tasks;

    if (root) {
      tasks[0] = this.orch.tasks.upsert({
        ...root,
        status: "waiting",
        conversationId: req.conversationId,
        teamId: req.team?.id,
        assignedWorkerId: leader?.id ?? req.defaultWorkerId,
        updatedAt: Date.now(),
      });
    }
    for (let i = 0; i < stepTasks.length; i++) {
      const task = stepTasks[i]!;
      const step = plan.steps[i]!;
      const updated = this.orch.tasks.upsert({
        ...task,
        conversationId: req.conversationId,
        teamId: req.team?.id,
        projectId: req.projectId ?? task.projectId,
        updatedAt: Date.now(),
      });
      stepTasks[i] = updated;
      tasks[i + 1] = updated;
      plan.steps[i] = { ...step, taskId: updated.id };
    }

    this.orch.bus.publish({ type: "plan.updated", plan: { ...plan, status: "executing" } });
    this.orch.dispatcher.kick();
    return { plan, tasks };
  }

  private async generateSteps(
    goal: string,
    leader: Worker,
    members: Worker[]
  ): Promise<PlanStep[]> {
    const roster =
      members.length === 0
        ? `(solo) ${leader.name} role=${leader.role} skills=${leader.skills.join(",")}`
        : members
            .map(
              (m) =>
                `- id=${m.id} name=${m.name} role=${m.role} skills=${m.skills.join(",")}`
            )
            .join("\n");

    const prompt = [
      "You are a team lead. Produce a JSON plan for the goal.",
      "Respond with ONLY a JSON object: {\"steps\":[{\"id\":\"step_1\",\"title\":\"...\",\"description\":\"...\",\"taskClass\":\"normal\",\"dependsOnStepIds\":[],\"suggestedRole\":\"optional\",\"suggestedWorkerId\":\"optional\"}]}",
      `taskClass must be one of: ${TASK_CLASSES.join(", ")}`,
      "Keep 1-5 steps. Prefer parallel steps when independent.",
      `Team roster:\n${roster}`,
      `Goal: ${goal}`,
    ].join("\n\n");

    const { provider, model } = await this.orch.modelRouter!.resolve(
      "reasoning",
      leader.preferredModel
    );
    const request: ChatCompletionRequest = {
      model,
      messages: [
        { role: "system", content: "Output valid JSON only. No markdown fences." },
        { role: "user", content: prompt },
      ],
      temperature: 0.2,
      stream: false,
    };

    let raw = "";
    try {
      const resp = await provider.complete(request);
      const content = resp.choices?.[0]?.message?.content;
      raw = typeof content === "string" ? content : "";
    } catch {
      raw = "";
    }

    const parsed = parsePlanJson(raw);
    if (parsed.length) return parsed;

    // Repair: single fallback step
    return [
      {
        id: "step_1",
        title: "Execute goal",
        description: goal,
        taskClass: "normal",
        dependsOnStepIds: [],
        suggestedWorkerId: leader.id,
      },
    ];
  }
}

export function parsePlanJson(raw: string): PlanStep[] {
  const json = extractJson(raw);
  if (!json) return [];
  try {
    const obj = JSON.parse(json) as { steps?: unknown };
    if (!Array.isArray(obj.steps)) return [];
    const steps: PlanStep[] = [];
    for (let i = 0; i < obj.steps.length; i++) {
      const s = obj.steps[i] as Record<string, unknown>;
      if (!s || typeof s !== "object") continue;
      const title = String(s.title ?? `Step ${i + 1}`);
      const description = String(s.description ?? title);
      const taskClass = normalizeTaskClass(s.taskClass);
      const dependsOnStepIds = Array.isArray(s.dependsOnStepIds)
        ? s.dependsOnStepIds.map(String)
        : [];
      steps.push({
        id: String(s.id ?? `step_${i + 1}`),
        title,
        description,
        taskClass,
        dependsOnStepIds,
        suggestedRole: s.suggestedRole ? String(s.suggestedRole) : undefined,
        suggestedWorkerId: s.suggestedWorkerId ? String(s.suggestedWorkerId) : undefined,
      });
    }
    return steps;
  } catch {
    return [];
  }
}

function extractJson(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{")) return trimmed;
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) return fence[1].trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return null;
}

function normalizeTaskClass(v: unknown): TaskClass {
  const s = String(v ?? "normal");
  return (TASK_CLASSES as string[]).includes(s) ? (s as TaskClass) : "normal";
}

function pickAssignee(members: Worker[], step: PlanStep): Worker | undefined {
  if (!members.length) return undefined;
  if (step.suggestedRole) {
    const role = step.suggestedRole.toLowerCase();
    const byRole = members.find(
      (m) => m.role.toLowerCase() === role || m.role.toLowerCase().includes(role)
    );
    if (byRole) return byRole;
  }
  const classSkill = step.taskClass;
  const bySkill = members.find((m) =>
    m.skills.some((s) => s.toLowerCase().includes(classSkill) || classSkill.includes(s.toLowerCase()))
  );
  if (bySkill) return bySkill;
  return members[0];
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
