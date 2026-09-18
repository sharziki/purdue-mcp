#!/usr/bin/env node
/**
 * Exam-parsing tests, run against rows captured verbatim from the Registrar's
 * Fall 2026 PDF.
 *
 * The live smoke test proves the tools answer; it cannot prove they answer
 * *correctly*. Attribution is the risk: within a subject block the report
 * prints the subject once and each course number once, so a parser that loses
 * track files MA 26200's exam under MA 26100 — a wrong date that still looks
 * like an answer. These rows are the exact shapes that broke earlier attempts.
 */
import assert from "node:assert/strict";
import { attributeExams, parseRoom, parseSitting } from "../dist/sources/exams.js";

let passed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed++;
  } catch (error) {
    console.error(`FAIL: ${name}\n  ${error.message}`);
    process.exitCode = 1;
  }
};

// Verbatim from current_evening_exam_schedule_PWL.pdf, Fall 2026.
const BLOCK = [
  "Subject Course   Section    Meeting Times                        Enrl  Date And Time                  Room          Cap ExCap",
  "------- -------- ---------- ----------------------------------- -----  ------------------------------ ----------- ----- -----",
  "MA      26100                                                    3054  Mon 10/05 08:00p - 09:00p      Loeb Plyhs   1016   508",
  "                                                                                                      WTHR  200     480   260",
  "                                                                                                      Hiler Thtr    329   177",
  "                                                                     3054  Wed 11/18 08:00p - 09:00p      WTHR  200     480   260",
  "            26200                                                     108  Tue 10/06 08:00p - 09:00p      UC    114     273   136",
  "                                                                      108  Wed 11/11 08:00p - 09:00p      UC    114     273   136",
  "            27101                                                      66  Wed 09/23 08:00p - 09:00p      ARMS  1010    200   100",
  "                                                                   Page 35                                          ",
  "UniTime 4.9.41 (Purdue)                                  SCHEDULE BY COURSE                                   ",
  "(MA Continued)",
  "Subject Course   Section    Meeting Times                        Enrl  Date And Time                  Room          Cap ExCap",
  "            30300    63224-430  MWF    8:30a -  9:20a                  33  Mon 09/21 06:30p - 07:30p      GRIS  103      50    25",
];

test("a course's own row is attributed to it", () => {
  const exams = attributeExams(BLOCK);
  const first = exams[0];
  assert.equal(first.subject, "MA");
  assert.equal(first.course, "26100");
  assert.equal(first.date, "10/05");
  assert.equal(first.enrolled, 3054);
});

test("a repeat sitting stays with the same course", () => {
  const exams = attributeExams(BLOCK).filter((e) => e.course === "26100");
  assert.equal(exams.length, 2, `expected 2 MA 26100 sittings, got ${exams.length}`);
  assert.deepEqual(exams.map((e) => e.date).sort(), ["10/05", "11/18"]);
});

test("a following course is NOT attributed to the previous one", () => {
  const exams = attributeExams(BLOCK);
  const ma26200 = exams.filter((e) => e.course === "26200");
  assert.equal(ma26200.length, 2);
  // The subject is printed once per block and must carry forward.
  assert.ok(ma26200.every((e) => e.subject === "MA"));
  assert.ok(
    !exams.some((e) => e.course === "26100" && (e.date === "10/06" || e.date === "11/11")),
    "MA 26200's dates leaked into MA 26100",
  );
});

test("every course in the block is found", () => {
  const courses = [...new Set(attributeExams(BLOCK).map((e) => e.course))].sort();
  assert.deepEqual(courses, ["26100", "26200", "27101", "30300"]);
});

test("page furniture never becomes an exam or a room", () => {
  const exams = attributeExams(BLOCK);
  assert.ok(!exams.some((e) => e.rooms.some((r) => /Page|UniTime|Continued/i.test(r))));
  assert.ok(!exams.some((e) => /Page|UniTime/i.test(e.course)));
});

test("continuation lines add rooms to the sitting above", () => {
  const first = attributeExams(BLOCK)[0];
  assert.deepEqual(first.rooms, ["Loeb Plyhs", "WTHR 200", "Hiler Thtr"]);
});

test("a section label is kept with its course", () => {
  const row =
    "            18000BLK  A         TR    10:30a - 11:20a                 437  Wed 09/30 06:30p - 07:30p      HAAS  G050     30    30";
  const sitting = parseSitting(row);
  assert.equal(sitting.course, "18000BLK");
  assert.equal(sitting.enrolled, 437);
  assert.equal(sitting.date, "09/30");
});

test("a bracketed designator does not break the row", () => {
  const row =
    "                    [Dist]                                         68  Thu 11/05 08:00p - 09:00p      WTHR  200     480   260";
  const sitting = parseSitting(row);
  assert.equal(sitting.enrolled, 68);
  assert.equal(sitting.day, "Thu");
  assert.equal(sitting.start, "08:00p");
});

test("capacity columns are not mistaken for room numbers", () => {
  // "Hiler Thtr 329 177" is a two-word building whose 329 is a capacity,
  // while "WTHR 200 480 260" is a building and a room.
  assert.equal(parseRoom("Hiler Thtr    329   177"), "Hiler Thtr");
  assert.equal(parseRoom("WTHR  200     480   260"), "WTHR 200");
  assert.equal(parseRoom("Loeb Plyhs   1016   508"), "Loeb Plyhs");
  assert.equal(parseRoom("MSEE  B012     96    48"), "MSEE B012");
  assert.equal(parseRoom("CL50  224     470   235"), "CL50 224");
});

test("a row with no course yet named is skipped rather than guessed", () => {
  const orphan = ["                        3054  Mon 10/05 08:00p - 09:00p      WTHR  200     480   260"];
  assert.deepEqual(attributeExams(orphan, 102), []);
});

console.log(`exam parser: ${passed} passed${process.exitCode ? " (with failures)" : ""}`);
