export function normalizeAnswer(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Grading is string comparison only; AI is never called to judge a guess.
export function gradeRiddle(
  response: string,
  acceptedAnswers: readonly string[],
): boolean {
  const normalizedResponse = normalizeAnswer(response);
  return acceptedAnswers.some(
    (accepted) => normalizeAnswer(accepted) === normalizedResponse,
  );
}
