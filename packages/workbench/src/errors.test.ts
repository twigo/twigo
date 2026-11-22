import { expect, test } from "vitest";
import { errorDetails } from "./errors";

test("Copy details carries the code, the message, and the reason and causes the API server gave", () => {
  expect(
    errorDetails({
      code: "server.invalid",
      message: "Deployment web is invalid",
      server: {
        reason: "Invalid",
        causes: [
          {
            reason: "FieldValueInvalid",
            field: "spec.replicas",
            message: "must be non-negative",
          },
          { reason: "FieldValueRequired", field: "", message: "no selector" },
        ],
      },
    }),
  ).toBe(
    [
      "Code: server.invalid",
      "Message: Deployment web is invalid",
      "Server reason: Invalid",
      "Causes:",
      "- spec.replicas: must be non-negative (FieldValueInvalid)",
      "- no selector (FieldValueRequired)",
    ].join("\n"),
  );
});

test("an error the API server did not answer has no server lines, and an empty reason none", () => {
  expect(errorDetails({ code: "connect.refused", message: "refused" })).toBe(
    "Code: connect.refused\nMessage: refused",
  );
  expect(
    errorDetails({
      code: "server.other",
      message: "x",
      server: { reason: "", causes: [] },
    }),
  ).toBe("Code: server.other\nMessage: x");
});
