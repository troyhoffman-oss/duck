import { expect, test } from "bun:test";
import { onlyAdded } from "./verify";

const step = (name: string, body = "  expect(await reply()).toBe(1);") =>
  [`  test.failing("${name}", async () => {`, body, "  });"].join("\n");
const journey = (...steps: string[]) =>
  ['import { test } from "bun:test";', "", 'describe("a day", () => {', ...steps, "});", ""].join("\n");
const before = journey(step("the first reply"), step("steer and wait"));

test("turning test.failing( into test( and adding steps after the last, or lines above describe(, is allowed", () => {
  expect(onlyAdded(before, before)).toBe(true);
  expect(onlyAdded(before, before.replace("test.failing(", "test("))).toBe(true);
  expect(onlyAdded(before, journey(step("the first reply"), step("steer and wait"), step("a third")))).toBe(
    true,
  );
  expect(onlyAdded(before, before.replace("\n\n", '\nimport { E2E } from "./kit";\n\n'))).toBe(true);
  const file = 'import { test } from "bun:test";\n\ntest("one", () => {});\n';
  expect(onlyAdded(file, `${file}\ntest("two", () => {});\n`)).toBe(true);
});

test("any other edit is refused", () => {
  expect(onlyAdded(before, before.replace("toBe(1)", "toBe(2)"))).toBe(false);
  expect(onlyAdded(before, before.replace("the first reply", "a first reply"))).toBe(false);
  expect(onlyAdded(before, journey(step("the first reply"), step("between"), step("steer and wait")))).toBe(
    false,
  );
  expect(onlyAdded(before, journey(step("the first reply")))).toBe(false);
  expect(
    onlyAdded(
      before,
      before.replace("  expect(await reply()).toBe(1);\n", "  return;\n  expect(await reply()).toBe(1);\n"),
    ),
  ).toBe(false);
  const on = before.replace("test.failing(", "test(");
  expect(onlyAdded(on, before)).toBe(false);
});
