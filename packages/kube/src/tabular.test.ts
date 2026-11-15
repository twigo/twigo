import { expect, test } from "vitest";
import { isFigures, isTabular } from "./tabular";

test.each([
  "0",
  "16",
  "970m (6%)",
  "0 (0%)",
  "16355060Ki",
  "322Mi",
  "30 s",
  "2/2",
  "1.5Gi",
  "48s",
  "2m6s",
  "5h12m",
  "3y250d",
])("%s is figures", (value) => {
  expect(isFigures(value)).toBe(true);
});

test.each([
  "",
  "cpu",
  "80/TCP",
  "ReadWriteOnce",
  "1 Pod",
  "web-54454cf656",
  "2/x",
  "10.244.0.8",
  "2m6",
])("%s is not figures", (value) => {
  expect(isFigures(value)).toBe(false);
});

test.each([
  "40",
  "10.96.0.1",
  "203.0.113.7,203.0.113.8",
  "203.0.113.7, 203.0.113.8",
])("%s is tabular", (value) => {
  expect(isTabular(value)).toBe(true);
});

test.each([
  "auth-api-7f9c8d6b5-x2kq9",
  "Running",
  "CrashLoopBackOff",
  "<none>",
  "",
  "ReadWriteOnce",
  "10.96.0",
  "10.96.0.1.2",
  "10.96.0.1,",
  "v1.28.3",
  "fd00::1",
])("%s is not tabular", (value) => {
  expect(isTabular(value)).toBe(false);
});
