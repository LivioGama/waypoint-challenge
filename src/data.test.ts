// Run: bun test
import { test, expect } from "bun:test";
import {
  students,
  lessons,
  getStudent,
  getLesson,
  iepSection,
  IEP_SECTION_NAMES,
} from "./data.js";

test("at least one student and one lesson are loaded", () => {
  expect(Object.keys(students).length).toBeGreaterThan(0);
  expect(Object.keys(lessons).length).toBeGreaterThan(0);
});

test("Jasmine loads with expected core fields", () => {
  const s = getStudent("jasmine");
  expect(s.id).toBe("jasmine");
  expect(s.student.name).toBe("Jasmine Regina Bailey");
  expect(s.student.grade).toBe("7");
});

test("multiple students supported — Marcus loads independently", () => {
  const m = getStudent("marcus");
  expect(m.student.name).toMatch(/Marcus/);
  expect(m.disability).toBeDefined();
  // Different disability category from Jasmine — proves the data shape generalizes.
  expect((m.disability as { category: string }).category).not.toBe(
    (getStudent("jasmine").disability as { category: string }).category,
  );
});

test("every named IEP section resolves for every student", () => {
  for (const sid of Object.keys(students)) {
    for (const name of IEP_SECTION_NAMES) {
      expect(iepSection(name, sid)).toBeDefined();
    }
  }
});

test("goal.<n> aliases resolve to a real goal", () => {
  const g = iepSection("goal.3", "jasmine") as { area: string; benchmarks: string[] };
  expect(g.area).toBe("ELA");
  expect(g.benchmarks.length).toBeGreaterThanOrEqual(3);
});

test("accommodations are split into the 4 IEP categories", () => {
  for (const sid of Object.keys(students)) {
    expect(Object.keys(getStudent(sid).accommodations).sort()).toEqual([
      "presentation_of_instruction",
      "response",
      "setting_environment",
      "timing_scheduling",
    ]);
  }
});

test("lesson loader returns metadata + full text", () => {
  const l = getLesson("community-essay");
  expect(l.title).toMatch(/community/i);
  expect(l.text.length).toBeGreaterThan(1000);
  expect(l.standards.length).toBeGreaterThan(0);
});

test("unknown section returns undefined (not throw)", () => {
  expect(iepSection("not_a_section", "jasmine")).toBeUndefined();
});

test("unknown student / lesson throws a clear error", () => {
  expect(() => getStudent("nope")).toThrow(/unknown student/);
  expect(() => getLesson("nope")).toThrow(/unknown lesson/);
});
