import { expect, test } from "vitest";
import type { ExecPlugin } from "@twigo/protocol";
import { hints, plain, remedy } from "./output";

const AWS: ExecPlugin = {
  command: "aws",
  args: ["eks", "get-token", "--cluster-name", "dev"],
  env: [{ name: "AWS_PROFILE", value: "dev-admin" }],
  digest: "aws",
  signsIn: false,
};

test("the device code and the link come out of the plugins' lines", () => {
  expect(
    hints(
      "To sign in, use a web browser to open the page https://microsoft.com/devicelogin and enter the code F3JQ7K9PL to authenticate.\n",
    ),
  ).toEqual({ url: "https://microsoft.com/devicelogin", code: "F3JQ7K9PL" });
  expect(
    hints(
      "Please visit the following URL in your browser: https://id.example.com/device\nPlease enter the following code when asked in your browser: WXYZ-1234\n",
    ),
  ).toEqual({ url: "https://id.example.com/device", code: "WXYZ-1234" });
  expect(
    hints(
      "If browser window does not open automatically, open it by clicking on the link:\r\n http://127.0.0.1:53712/2c9b0d6e\r\n",
    ),
  ).toEqual({ url: "http://127.0.0.1:53712/2c9b0d6e", code: undefined });
});

test("only https and the plugin's own local server open", () => {
  expect(hints("go to http://example.com/login").url).toBeUndefined();
  expect(hints("go to http://localhost:1@example.com/").url).toBeUndefined();
  expect(hints("go to http://localhost:8000/").url).toBe(
    "http://localhost:8000/",
  );
});

test("terminal escapes and carriage returns are dropped", () => {
  expect(plain("\u001b[1;32mready\u001b[0m\r\n")).toBe("ready\n");
});

test("a failed plugin's own fix is named, with its profile", () => {
  const expired =
    "aws: [ERROR]: The SSO session associated with this profile has expired or is otherwise invalid. To refresh this SSO session run aws sso login with the corresponding profile.";
  expect(remedy(expired, AWS)).toBe("aws sso login --profile dev-admin");
  expect(
    remedy(expired, { ...AWS, env: [], args: ["--profile=ops", "eks"] }),
  ).toBe("aws sso login --profile ops");
  expect(remedy("exit 1", AWS)).toBeUndefined();
});
