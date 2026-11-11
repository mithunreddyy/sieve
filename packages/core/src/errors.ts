/**
 * Named errors such as `TypeError: …` or `IllegalStateException: …`, which ERROR_LINE misses
 * (no word boundary before "Error"). The fold, the log extractor, the session log and recall
 * all use isErrorLine.
 */
export const NAMED_ERROR = /\b[A-Z][A-Za-z0-9]*(Error|Exception):/;
export const isErrorLine = (line: string) => ERROR_LINE.test(line) || NAMED_ERROR.test(line);

/** Lines that report a failure. Kept even from a dropped middle, because errors are never cut. */
export const ERROR_LINE =
  /\b(FAIL(ED|URE)?|ERROR|Error|error(\[E\d+\])?:|error TS\d+|panic|Traceback|Exception|fatal|AssertionError|Assertion failed|Segmentation fault)\b|[✗✘×✖]\s/;
