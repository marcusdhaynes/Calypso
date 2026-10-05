import type { TeamMessage, TeamMessageArgs } from "@calypso/shared";

import { assertLocalOnly } from "./local.js";

export interface TeamMessageQuery {
  to?: string;
  planId?: string;
  stepId?: string;
}

/** In-process mailbox. Messages are not sent off-box. */
export class TeamMailbox {
  private readonly messages: TeamMessage[] = [];

  post(input: TeamMessageArgs & { id?: string; createdAt?: string }): TeamMessage {
    assertLocalOnly(input);
    const message: TeamMessage = {
      id: input.id?.trim() || `msg_${crypto.randomUUID()}`,
      to: input.to,
      body: input.body,
      ...(input.from ? { from: input.from } : {}),
      ...(input.planId ? { planId: input.planId } : {}),
      ...(input.stepId ? { stepId: input.stepId } : {}),
      createdAt: input.createdAt ?? new Date().toISOString(),
    };
    this.messages.push(message);
    return message;
  }

  list(query: TeamMessageQuery = {}): readonly TeamMessage[] {
    return this.messages.filter((message) => {
      if (query.to != null && message.to !== query.to) {
        return false;
      }
      if (query.planId != null && message.planId !== query.planId) {
        return false;
      }
      if (query.stepId != null && message.stepId !== query.stepId) {
        return false;
      }
      return true;
    });
  }
}
