import { describe, expect, it } from "vitest";
import { createResultTool, RESULT_TOOL, submittedResultText } from "./result-tool.js";

const session = "agent:missioncrew-executor:subagent:hermes-loop-test";
const result = {
  status: "blocked",
  summary: "Source unavailable",
  acceptanceEvidence: { blocker: { kind: "required_source_unavailable" } },
  externalEffects: [],
};

describe("structured result receipt", () => {
  it("serializes native fields even when final assistant prose has malformed JSON", async () => {
    const receipt = await createResultTool(session).execute("call", { result });
    const messages = [
      { role: "toolResult", toolName: RESULT_TOOL, ...receipt },
      { role: "assistant", content: [{ type: "text", text: '{"status":"succeeded"' }] },
    ];
    expect(JSON.parse(submittedResultText(messages, session)!)).toEqual(result);
  });
  it.each(["foreign-session", "browser", "assistant", "error", "later-tool"])(
    "refuses %s receipts",
    async (fault) => {
      const receipt = await createResultTool(session).execute("call", { result });
      const message = {
        role: fault === "assistant" ? "assistant" : "toolResult",
        toolName: fault === "browser" ? "browser" : RESULT_TOOL,
        isError: fault === "error",
        ...receipt,
      };
      const messages =
        fault === "later-tool" ? [message, { role: "toolResult", toolName: "browser" }] : [message];
      expect(
        submittedResultText(messages, fault === "foreign-session" ? "different" : session),
      ).toBeUndefined();
    },
  );
  it("rejects unsolicited memory promotion before issuing a zero-effect receipt", async () => {
    await expect(createResultTool(session).execute("call", { result: {
      ...result, status: "succeeded",
      domainMemoryDeltas: [{ namespace: "research", type: "note", promote_after_grace_acceptance: true, content: "research note" }],
    } })).rejects.toThrow("domainMemoryDeltas");
    const receipt = await createResultTool(session).execute("corrected", { result });
    expect(JSON.parse(submittedResultText([{ role: "toolResult", toolName: RESULT_TOOL, ...receipt }], session)!)).toEqual(result);
  });
  it("returns a tool validation error for misplaced required fields", async () => {
    await expect(
      createResultTool(session).execute("call", {
        result: {
          status: "blocked",
          summary: "broken",
          acceptanceEvidence: { externalEffects: [] },
        },
      }),
    ).rejects.toThrow("top level");
  });
});
