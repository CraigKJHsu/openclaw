import { jsonResult } from "openclaw/plugin-sdk/core";
import { Type } from "typebox";

export const RESULT_TOOL = "missioncrew_submit_result";

/** Delivery only. The poller's existing contract/effect audit still decides acceptance. */
export function createResultTool(sessionKey: string) {
  return {
    name: RESULT_TOOL,
    label: "Submit MissionCrew result",
    description:
      "Submit the final structured Loop Contract result. This only records a receipt; it does not publish, complete a task, or approve evidence. Correct validation errors here before finishing.",
    parameters: Type.Object(
      {
        result: Type.Object(
          {
            status: Type.Union([Type.Literal("succeeded"), Type.Literal("blocked")]),
            summary: Type.String(),
            acceptanceEvidence: Type.Union([
              Type.Record(Type.String(), Type.Unknown()),
              Type.Array(Type.Unknown()),
            ]),
            externalEffects: Type.Array(Type.Unknown()),
            metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
            domainMemoryDeltas: Type.Optional(Type.Array(Type.Unknown())),
          },
          { additionalProperties: true },
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const result = params.result as Record<string, unknown> | undefined;
      if (
        !result ||
        !["succeeded", "blocked"].includes(String(result.status)) ||
        typeof result.summary !== "string" ||
        !result.acceptanceEvidence ||
        typeof result.acceptanceEvidence !== "object" ||
        !Array.isArray(result.externalEffects)
      ) {
        throw new Error(
          "Result requires status, summary, acceptanceEvidence and externalEffects at the top level",
        );
      }
      // Zero-effect work cannot support canonical domain-memory mutations.
      // Fail here so the worker can correct its result before terminal polling.
      if (Array.isArray(result.domainMemoryDeltas) && result.domainMemoryDeltas.length > 0 && result.externalEffects.length === 0) {
        throw new Error("Zero-effect result must omit domainMemoryDeltas or return an empty array; put research notes in acceptanceEvidence. No memory promotion is authorized by this receipt.");
      }
      return jsonResult({ kind: "missioncrew_result_receipt", sessionKey, result });
    },
  };
}

/** Never treat assistant prose, browser content or a foreign session as a native receipt. */
export function submittedResultText(messages: unknown[], sessionKey: string): string | undefined {
  for (const raw of messages.toReversed()) {
    const message = raw as Record<string, unknown> | null;
    if (!message || message.role !== "toolResult") {
      continue;
    }
    // A later tool/error invalidates an earlier receipt as the final delivery.
    if (message.toolName !== RESULT_TOOL || message.isError || !Array.isArray(message.content)) {
      return undefined;
    }
    const text = message.content
      .filter((part) => part?.type === "text")
      .map((part) => part.text)
      .join("\n");
    try {
      const receipt = JSON.parse(text);
      if (
        receipt.kind === "missioncrew_result_receipt" &&
        receipt.sessionKey === sessionKey &&
        receipt.result &&
        typeof receipt.result === "object" &&
        !Array.isArray(receipt.result)
      ) {
        return JSON.stringify(receipt.result);
      }
    } catch {
      // An invalid receipt never replaces the final assistant result.
    }
    return undefined;
  }
  return undefined;
}
