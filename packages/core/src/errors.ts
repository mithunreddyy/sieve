/** Lines that report a failure. Kept even from a dropped middle, because errors are never cut. */
export const ERROR_LINE =
  /\b(FAIL(ED|URE)?|ERROR|Error|error(\[E\d+\])?:|error TS\d+|panic|Traceback|Exception|fatal|AssertionError|Assertion failed|Segmentation fault)\b|[✗✘×✖]\s/;
