import { test, expect } from "bun:test";
import { automationTitle, copyHeaderFor, parseCopyHeader } from "../src/copyHeader";

const OP = 111;
const CLIENT = 222;
const cfg = { operatorUserIds: [OP], clientName: "Patrick" };

test("operator gets the header when the client also received the message", () => {
  expect(copyHeaderFor(cfg, OP, [CLIENT, OP], "Monday posting pack")).toBe(
    "↪ Copy · sent to Patrick · Monday posting pack\n\n",
  );
});

test("the client never gets a header", () => {
  expect(copyHeaderFor(cfg, CLIENT, [CLIENT, OP], "Monday posting pack")).toBe("");
});

test("no header when the operator is the only recipient", () => {
  expect(copyHeaderFor(cfg, OP, [OP], "medic")).toBe("");
});

test("no config, no header", () => {
  expect(copyHeaderFor(undefined, OP, [CLIENT, OP], "x")).toBe("");
});

test("ids compare as numbers even when settings hold strings", () => {
  const c = parseCopyHeader({ operatorUserIds: ["111"], clientName: "Joe" });
  expect(copyHeaderFor(c, 111, [222, 111], "Planner reminders")).toBe("↪ Copy · sent to Joe · Planner reminders\n\n");
});

test("parse rejects incomplete config", () => {
  expect(parseCopyHeader(undefined)).toBeUndefined();
  expect(parseCopyHeader({ operatorUserIds: [], clientName: "Joe" })).toBeUndefined();
  expect(parseCopyHeader({ operatorUserIds: [1], clientName: "  " })).toBeUndefined();
});

test("titles: explicit wins, else the job name humanised", () => {
  expect(automationTitle("planner-pings", "Planner reminders")).toBe("Planner reminders");
  expect(automationTitle("movement-inbox")).toBe("movement inbox");
  expect(automationTitle("", "")).toBe("Automation");
});
