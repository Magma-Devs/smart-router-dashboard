import { readAskSettings } from "./config.js";
import { AskFailure } from "./services/ask/errors.js";
import { foundationSmoke } from "./services/ask/foundation-smoke.js";

const settings = readAskSettings();
if (process.env.ASK_DATA_SMOKE !== "true" || !settings.enabled || settings.problem) {
  process.stderr.write(
    JSON.stringify({
      ok: false,
      code: "SMOKE_NOT_CONFIGURED",
      problem:
        settings.problem ?? "Explicit ASK_DATA_SMOKE=true and all availability gates are required",
    }) + "\n",
  );
  process.exitCode = 1;
} else {
  try {
    const result = await foundationSmoke(settings);
    // No question, raw customer values, answer body, subject or credential output.
    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          timestamp: new Date().toISOString(),
          customerId: result.customerId,
          sourceId: result.sourceId,
          model: result.model,
          region: result.region,
          tools: result.tools,
          catalogVersion: result.catalogVersion,
          usage: result.usage,
          answerValidated: true,
          sections: result.answer.sections.length,
          evidence: result.answer.evidence,
          limits: [
            "One metric query and one model call only",
            "No customer HTTP submission",
            "No budget/history/UI/pilot acceptance",
          ],
        },
        null,
        2,
      ) + "\n",
    );
  } catch (error) {
    process.stderr.write(
      JSON.stringify({
        ok: false,
        timestamp: new Date().toISOString(),
        code: error instanceof AskFailure ? error.code : "SMOKE_FAILED",
      }) + "\n",
    );
    process.exitCode = 1;
  }
}
