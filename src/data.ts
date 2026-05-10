import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(here, "..", "data");

export type IEPGoal = {
  id: number;
  area: string;
  baseline: string;
  goal: string;
  criteria?: string;
  method?: string;
  schedule?: string;
  owner?: string;
  benchmarks?: string[];
};

export type IEP = {
  id: string;
  student: { name: string; id: string; grade: string; [k: string]: unknown };
  disability: Record<string, unknown>;
  student_vision: Record<string, unknown>;
  present_levels: {
    ela?: Record<string, unknown>;
    math?: Record<string, unknown>;
    behavioral_social_emotional?: Record<string, unknown>;
    [k: string]: unknown;
  };
  accommodations: Record<string, string[]>;
  modifications: Record<string, string>;
  annual_goals: IEPGoal[];
  service_delivery: unknown[];
  placement: string;
  assessment_accommodations: Record<string, unknown>;
};

export type Lesson = {
  id: string;
  title: string;
  subject: string;
  grade: string;
  duration_min: number;
  standards: string[];
  text: string;
};

// ---- Loaders ----

function loadStudents(): Record<string, IEP> {
  const dir = resolve(dataDir, "students");
  const out: Record<string, IEP> = {};
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const raw = JSON.parse(readFileSync(resolve(dir, f), "utf8")) as IEP;
    out[raw.id] = raw;
  }
  return out;
}

function loadLessons(): Record<string, Lesson> {
  const dir = resolve(dataDir, "lessons");
  const out: Record<string, Lesson> = {};
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const meta = JSON.parse(readFileSync(resolve(dir, f), "utf8")) as Omit<Lesson, "text">;
    const text = readFileSync(resolve(dir, `${meta.id}.txt`), "utf8");
    out[meta.id] = { ...meta, text };
  }
  return out;
}

export const students = loadStudents();
const staticLessons = loadLessons();
export const uploadedLessons: Record<string, Lesson> = {};

// Combine static and uploaded lessons
export function getAllLessons(): Record<string, Lesson> {
  return { ...staticLessons, ...uploadedLessons };
}

export function addUploadedLesson(lesson: Lesson) {
  uploadedLessons[lesson.id] = lesson;
}

// For backward compat, initially expose static lessons
export const lessons = staticLessons;

// Default selection — used by tools that don't take an explicit id.
export const DEFAULT_STUDENT_ID =
  process.env.WAYPOINT_DEFAULT_STUDENT ?? Object.keys(students)[0];
export const DEFAULT_LESSON_ID =
  process.env.WAYPOINT_DEFAULT_LESSON ?? Object.keys(lessons)[0];

export function getStudent(id?: string): IEP {
  const sid = id ?? DEFAULT_STUDENT_ID;
  const s = students[sid];
  if (!s) throw new Error(`unknown student: ${sid}`);
  return s;
}

export function getLesson(id?: string): Lesson {
  const lid = id ?? DEFAULT_LESSON_ID;
  const all = getAllLessons();
  const l = all[lid];
  if (!l) throw new Error(`unknown lesson: ${lid}`);
  return l;
}

// ---- Section accessors ----

export const IEP_SECTION_NAMES = [
  "student",
  "disability",
  "student_vision",
  "present_levels",
  "present_levels.ela",
  "present_levels.math",
  "present_levels.behavioral",
  "accommodations",
  "modifications",
  "annual_goals",
  "service_delivery",
  "placement",
  "assessment_accommodations",
];

export function iepSection(name: string, studentId?: string): unknown {
  const iep = getStudent(studentId);
  const direct: Record<string, unknown> = {
    student: iep.student,
    disability: iep.disability,
    student_vision: iep.student_vision,
    present_levels: iep.present_levels,
    "present_levels.ela": iep.present_levels?.ela,
    "present_levels.math": iep.present_levels?.math,
    "present_levels.behavioral": iep.present_levels?.behavioral_social_emotional,
    accommodations: iep.accommodations,
    modifications: iep.modifications,
    annual_goals: iep.annual_goals,
    service_delivery: iep.service_delivery,
    placement: iep.placement,
    assessment_accommodations: iep.assessment_accommodations,
  };
  if (name in direct) return direct[name];
  // Goal aliases — "goal.1", "goal.2", ...
  const goal = name.match(/^goal\.(\d+)$/);
  if (goal) return iep.annual_goals.find((g) => g.id === Number(goal[1]));
  return undefined;
}
