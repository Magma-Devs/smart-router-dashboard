import { ASK_CONTRACT_VERSION, askAnswerSchema, type AskAnswer } from "@sr/shared";

/** Only standalone clock questions qualify. Everything else keeps the normal
 * evidence-backed pipeline, including compound questions and timezone requests. */
export function clockAnswer(question: string, now = new Date()): AskAnswer | null {
  const text = question
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[?？.!]+$/, "")
    .replace(/^(?:please |בבקשה )/, "")
    .replace(/^(?:(?:can|could) you )?tell me /, "what is ")
    .replace(/(?: please| בבקשה)$/, "")
    .trim();
  const english = text.replace(/^what's /, "what is ");
  const date =
    /^(?:what is (?:the (?:current )?date(?: today)?|today's date)|what date is it(?: today)?)$/.test(
      english,
    );
  const time = /^what (?:is the (?:current )?time|time is it)(?: now)?(?: in utc)?$/.test(english);
  const both = /^(?:what is the (?:current )?date and time)(?: in utc)?$/.test(english);
  const hebrewDate = /^(?:מה (?:התאריך(?: היום)?|התאריך של היום)|איזה תאריך היום)$/.test(text);
  const hebrewTime = /^(?:מה השעה(?: עכשיו)?|מה השעה ב-?utc)$/.test(text);
  const hebrewBoth = /^מה התאריך והשעה(?: עכשיו)?$/.test(text);
  if (!date && !time && !both && !hebrewDate && !hebrewTime && !hebrewBoth) return null;

  const hebrew = hebrewDate || hebrewTime || hebrewBoth;
  const dateText = new Intl.DateTimeFormat(hebrew ? "he-IL" : "en-US", {
    dateStyle: "long",
    timeZone: "UTC",
  }).format(now);
  const timeText = now.toISOString().slice(11, 19);
  const summary = hebrew
    ? hebrewBoth
      ? `התאריך הוא ${dateText}, והשעה ${timeText} (UTC).`
      : hebrewDate
        ? `היום ${dateText} (UTC).`
        : `השעה ${timeText} (UTC).`
    : both
      ? `It is ${dateText}, ${timeText} UTC.`
      : date
        ? `Today is ${dateText} (UTC).`
        : `It is ${timeText} UTC.`;
  return askAnswerSchema.parse({
    contractVersion: ASK_CONTRACT_VERSION,
    summary,
    sections: [{ title: hebrew ? "שעון השרת" : "Server clock", body: summary }],
    answeredAt: now.toISOString(),
    evidence: [],
  });
}
